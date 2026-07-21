// @aso/server/orchestrator — run state machine (port of aso-util pipeline/orchestrator.ts,
// 1339 lines) with INVERTED CONTROL FLOW (BUILD-PLAN §7): Apple I/O is no longer inline fetch
// but async job dispatch via AppleGateway (Probe/Serp/Hints). LLM goes through LlmProxy (per-attempt
// metrics, micro-reserve, llm_steps, D4/D7). Events are event-sourced in run_events.
// Pure metric/assembly functions are 1:1 from @aso/core.
//
// BILLING (D4 v4): real-time debit — as soon as a keyword becomes a verified keyphrase
// (rated, R≥1) — immediately charge pricePerKeyphrase[model] (deps.chargeKeyphrase). At zero
// — hard-stop paused (resumable). The orchestrator caps exploration at sampleSize×(1+OVERSHOOT_PCT),
// but whatever was produced is paid for. Internal per-attempt COGS (llm_steps) is the safety fuse.
//
// REPLAY (D7): on restart, state is reconstructed by RE-RUNNING (replayFromLogs), feeding
// LLM from llm_steps and Apple from apple_cache; first log miss = frontier → stop, resumable.
//
// probe→rate order is sequential (deterministic); background interleaving of rate during
// probe (aso-util rateInFlight) is deliberately NOT ported: it complicates replay/pause-at-job-boundary
// with no gain for a throttle-bound run (spec 04.6) — rate runs as a batch AFTER probe.

import {
  normalizeKeyword, sampleCount, STOREFRONTS,
  type BusinessContext, type KeywordEntry, type KeywordSource, type RunConfig,
  type Violation, type AssemblyBucket, type AssemblyResult, type CoverageRow,
} from "@aso/shared";
import { computePopularity } from "../core/metrics/popularity.ts";
import { computeDifficulty, isDeadBrandQuery } from "../core/metrics/difficulty.ts";
import { opportunityScore, compareKeywords } from "../core/metrics/score.ts";
import { serpFitOf, finalR, RELEVANCE } from "../core/metrics/relevance.ts";
import { phraseKeys } from "../core/assembly/select.ts";
import { optimizeAssembly, orderForField, glueField, type BucketWordPlan, type OptPhrase } from "../core/assembly/optimize.ts";
import { placementWeight, type Placement } from "../core/assembly/place.ts";
import { validate, bucketFoldKeys, wordsOf } from "../core/assembly/validate.ts";
import { foldKey } from "../core/assembly/folding.ts";
import { planWave, harvestWaveResults, type ExpansionTask } from "../core/expander.ts";
import { extraLocaleFor, serpLangFor } from "../core/locales.ts";
import { renderPrompt } from "../core/prompts.ts";
import { schemas } from "../core/llm-schemas.ts";
import type { AppleGateway } from "../apple-dispatch/gateway.ts";
import { JobError } from "../apple-dispatch/hub.ts";
import { LlmProxy } from "../llm-proxy/proxy.ts";
import { LlmAuthError } from "../llm-proxy/client.ts";
import { InsufficientCredits, CogsExceededCeiling } from "../billing/service.ts";
import { OVERSHOOT_PCT } from "../billing/prices.ts";
import { ReplayFrontier } from "../replay.ts";
import type { ServerRunState } from "./state.ts";

class PauseInterrupt extends Error {}

const AUX_WORDS = new Set([
  "how", "what", "when", "where", "why", "who", "which", "can", "could", "should",
  "would", "may", "might", "will", "much", "many", "more", "most", "after", "before",
  "until", "till", "than", "then", "them", "they", "this", "that", "these", "those",
  "your", "yours", "our", "ours", "you", "get", "got", "has", "have", "had", "does",
  "did", "not", "now", "just", "very", "here", "there", "into", "onto", "about",
]);

export interface OrchestratorDeps {
  gateway: AppleGateway;
  proxy: LlmProxy;
  /** Persist the read projection of state (runs.state). */
  persist: (s: ServerRunState) => Promise<void>;
  /** Append an event to run_events; returns seq. */
  emitEvent: (runId: string, kind: string, text: string) => Promise<void>;
  /** REAL debit of one verified keyphrase (D4 v4). ok=false → hard-stop paused. */
  chargeKeyphrase: (keyword: string) => Promise<{ ok: boolean; balance: number; price: number }>;
  /** Pause → run.paused to the client with a reason code (credits_out when credits run out, D4 v4). */
  onPaused?: (reason: string, code?: "credits_out" | "provider_error" | "client_offline" | "user") => void;
  /** Final balance broadcast + event on completion (no settle — usage-based). */
  onDone?: (s: ServerRunState) => Promise<void>;
}

export class Orchestrator {
  private pauseRequested = false;
  private stopAndAssembleRequested = false;
  private hintFailStreak = 0;
  private replaying = false;
  running = false;

  constructor(public state: ServerRunState, private deps: OrchestratorDeps) {}

  private get config(): RunConfig { return this.state.config; }
  /** Overshoot cap (D4 v4): no new branches after sampleSize×(1+OVERSHOOT_PCT). */
  private get overshootCap(): number { return Math.floor(this.config.sampleSize * (1 + OVERSHOOT_PCT)); }
  private atOvershootCap(): boolean { return sampleCount(this.state.keywords) >= this.overshootCap; }
  private get storefront(): number {
    const sf = STOREFRONTS[this.config.country];
    if (!sf) throw new Error(`unknown country: ${this.config.country}`);
    return sf.id;
  }

  // ---------- public controls (spec 04.4) ----------

  requestPause() { this.pauseRequested = true; }

  requestStopAndAssemble() {
    if (sampleCount(this.state.keywords) < 30) throw new Error("Early assembly requires a sample of ≥ 30");
    this.stopAndAssembleRequested = true;
    if (!this.running) void this.run("assembling");
  }

  excludeKeyword(keyword: string) {
    const k = this.state.keywords.find((x) => x.keyword === normalizeKeyword(keyword));
    if (!k) throw new Error(`Keyword not found: ${keyword}`);
    k.status = "excluded";
    void this.event("⛔", `${k.keyword} excluded manually`);
  }

  editContext(patch: Partial<BusinessContext>) {
    if (!this.state.context) throw new Error("Context not extracted yet");
    this.state.context = { ...this.state.context, ...patch };
    void this.event("✏️", "context edited by user");
  }

  async start() {
    if (this.running) return;
    if (this.state.phase === "created") await this.run("context");
  }

  async confirmContext() {
    if (this.state.phase !== "context_review") throw new Error("Run is not awaiting context confirmation");
    await this.run("seeding");
  }

  async resume() {
    if (this.running) return;
    this.state.paused = false;
    this.state.notice = null;
    this.pauseRequested = false;
    this.state.hintsEndpointDown = false;
    this.hintFailStreak = 0;
    await this.save();
    const resumePhase = this.state.phase === "created" ? "context" : this.state.phase;
    if (resumePhase === "context_review" || resumePhase === "done") return;
    await this.run(resumePhase);
  }

  async reassemble() {
    if (this.state.phase !== "done") throw new Error("Reassembly is only available after completion");
    for (const k of this.state.keywords) if (k.status === "selected" || k.status === "bench") k.status = "rated";
    await this.run("assembling");
  }

  // ---------- main phase loop ----------

  private async run(fromPhase: ServerRunState["phase"]) {
    this.running = true;
    this.pauseRequested = false;
    this.state.paused = false;
    this.state.failed = null;
    try {
      let phase = fromPhase;
      for (;;) {
        this.state.phase = phase;
        await this.save();
        switch (phase) {
          case "context":
            await this.phaseContext();
            phase = "context_review";
            this.state.phase = phase;
            await this.save();
            return; // the only phase that blocks on the user
          case "seeding":
            await this.phaseSeeding();
            phase = "loop";
            break;
          case "loop":
            await this.phaseLoop();
            phase = "improving";
            break;
          case "improving":
            await this.phaseImproving();
            phase = "assembling";
            break;
          case "assembling":
            await this.phaseAssembling();
            phase = "done";
            this.state.phase = phase;
            await this.event("🏁", "run finished — metadata assembled");
            await this.save();
            await this.deps.onDone?.(this.state);
            return;
          default:
            return;
        }
        if (this.stopAndAssembleRequested && phase !== "assembling") {
          phase = "assembling";
          this.stopAndAssembleRequested = false;
        }
      }
    } catch (e: any) {
      if (e instanceof ReplayFrontier) throw e; // replay: rethrow, reconstruction stopped at the frontier
      let pauseCode: "credits_out" | "provider_error" | "client_offline" | "user" | undefined;
      if (e instanceof PauseInterrupt) {
        this.state.paused = true;
        this.state.notice = "Run paused.";
        pauseCode = "user";
        await this.event("⏸", "paused");
      } else if (e instanceof InsufficientCredits) {
        this.state.paused = true;
        this.state.notice = `Out of credits (a keyphrase costs ${e.needCredits}, balance is ${e.haveCredits.toFixed(2)}). Top up and we'll resume from here.`;
        pauseCode = "credits_out";
        await this.event("💳", this.state.notice);
      } else if (e instanceof CogsExceededCeiling) {
        this.state.paused = true;
        this.state.notice = `Run paused by the COGS safety fuse. ${e.message}`;
        await this.event("🛑", this.state.notice);
      } else if (e instanceof LlmAuthError) {
        this.state.paused = true;
        this.state.notice = `Provider issue: ${e.message}.`;
        pauseCode = "provider_error";
        await this.event("⚠️", this.state.notice);
      } else if (e?.name === "ClientGoneError" || e instanceof JobError) {
        this.state.paused = true;
        this.state.notice = `Client disconnected — run paused (D7). ${e?.message ?? ""}`;
        pauseCode = "client_offline";
        await this.event("🔌", this.state.notice);
      } else {
        this.state.paused = true;
        this.state.notice = `Error: ${e?.message ?? e}. Press "Resume".`;
        await this.event("⚠️", this.state.notice);
      }
      await this.save();
      this.deps.onPaused?.(this.state.notice ?? "Run paused.", pauseCode);
    } finally {
      this.running = false;
      await this.save();
    }
  }

  // ---------- phases ----------

  private async phaseContext() {
    await this.event("🧠", "extracting business context from the brief");
    const system = renderPrompt("context", {
      COUNTRY: this.config.country,
      SEMANTIC_LANGUAGE: this.config.semanticLanguage,
    });
    const res = await this.llm<BusinessContext>("context", system, `Product brief:\n\n${this.state.brief}`, undefined);
    const ctx = { ...res, targetLanguage: this.config.semanticLanguage };
    if (ctx.jobsToBeDone.length < 3) throw new Error("context: too few jobsToBeDone");
    this.state.context = ctx;
    await this.event("✅", "context extracted — confirm or edit");
  }

  private async phaseSeeding() {
    this.mustContext();
    await this.event("🌱", "generating seed hypotheses");
    const system = renderPrompt("seeds", {
      SEMANTIC_LANGUAGE: this.config.semanticLanguage,
      COUNTRY: this.config.country,
      STOPWORDS: this.config.stopwords.join(", "),
      BATCH_SIZE: this.config.batchSize,
    });
    const res = await this.llm<{ keywords: { keyword: string; type: string }[] }>(
      "seeds", system, `Generate ${this.config.batchSize} seed hypotheses.`, this.contextBlock(),
    );
    const added = await this.addCandidates(res.keywords.map((k) => ({ ...k, source: "seed" as const })));
    await this.event("🌱", `seeding: +${added} hypotheses`);
  }

  private async phaseLoop() {
    for (;;) {
      this.checkPause();
      await this.probeAll(true);
      await this.rateAll();
      const count = sampleCount(this.state.keywords);
      await this.event("📊", `sample: ${count}/${this.config.sampleSize}`);
      if (this.stopAndAssembleRequested) return;
      if (count >= this.config.sampleSize) return;
      await this.hypothesize();
    }
  }

  private async phaseImproving() {
    this.state.improvementState.topSnapshot = this.top20().map((k) => k.keyword);
    while (this.state.improvementState.roundsSpent < this.config.improvementRounds) {
      this.checkPause();
      if (this.stopAndAssembleRequested) return;
      if (this.atOvershootCap()) return; // overshoot cap (D4 v4)
      await this.event("🔁", `improving round ${this.state.improvementState.roundsSpent + 1}/${this.config.improvementRounds}`);
      await this.hypothesize();
      await this.probeAll();
      await this.rateAll();
      const newTop = this.top20().map((k) => k.keyword);
      const snapshot = new Set(this.state.improvementState.topSnapshot);
      const changed = newTop.some((k) => !snapshot.has(k));
      if (changed) {
        this.state.improvementState.roundsSpent = 0;
        await this.event("📈", "top-20 changed — round counter reset");
      } else {
        this.state.improvementState.roundsSpent += 1;
        await this.event("🔁", "round with no top-20 change");
      }
      this.state.improvementState.topSnapshot = newTop;
      await this.save();
    }
  }

  // ---------- probe/rate (inverted I/O) ----------

  private async probeAll(stopAtSample = false) {
    const sampleFull = () => sampleCount(this.state.keywords) >= this.config.sampleSize;
    if (stopAtSample && sampleFull()) return;
    await this.prescreenCandidates();

    const sourceRank: Record<string, number> = { suggest: 0, seed: 1, competitor: 2, expansion: 3 };
    const candidates = () =>
      this.state.keywords
        .filter((k) => k.status === "candidate" || k.status === "error")
        .sort((a, b) => (sourceRank[a.source] ?? 9) - (sourceRank[b.source] ?? 9));

    for (const k of candidates()) {
      this.checkPause();
      if (stopAtSample && sampleFull()) {
        await this.event("📊", "sample complete — the rest will wait for improving rounds");
        break;
      }
      try {
        // P — via ProbeJob (client fetches; server computes over prefill∪fetched, D2/D3).
        if (!this.state.hintsEndpointDown) {
          try {
            const raw = await this.deps.gateway.probe(k.keyword, this.storefront);
            const pop = computePopularity(k.keyword, raw.prefixHints, raw.childTerms, raw.unsuggested, this.config.weights.popularity);
            this.hintFailStreak = 0;
            k.metrics.P = pop.P;
            k.metrics.L = pop.L;
            k.metrics.rank = pop.rank;
            k.metrics.unsuggested = pop.unsuggested;
            k.metrics.childCount = pop.childCount;
            k.degraded = false;
            await this.harvestSuggestions(k.keyword, pop.seenTerms);
          } catch (e: any) {
            if (e instanceof ReplayFrontier) throw e;
            this.hintFailStreak++;
            if (this.hintFailStreak >= 3) {
              this.state.hintsEndpointDown = true;
              await this.event("⚠️", `hints endpoint unavailable (${e?.message ?? e}) — Popularity degraded (P=50)`);
            } else {
              throw e;
            }
          }
        }
        if (this.state.hintsEndpointDown) {
          k.metrics.P = null; k.metrics.L = null; k.metrics.rank = null;
          k.metrics.unsuggested = false; k.degraded = true;
        }
        // D — via SerpJob. lang = the STOREFRONT's primary locale (config.language carries the
        // semantic language, which Apple 400s in unknown combos like ru_us).
        const serp = await this.deps.gateway.serp(k.keyword, this.storefront, serpLangFor(this.config.country));
        const diff = computeDifficulty(k.keyword, serp.results, serp.resultCount, this.config.serpTop, this.config.weights.difficulty);
        k.metrics.D = diff.D;
        k.metrics.serpSize = diff.serpSize;
        k.metrics.topApps = diff.topApps;
        k.metrics.brandQuery = isDeadBrandQuery(k.keyword, diff.topApps);
        if (k.metrics.brandQuery) {
          await this.event("🏷", `${k.keyword}: name of an unpopular app — Score zeroed`);
        }
        k.status = "verified";
        k.probedAt = new Date().toISOString();
        k.error = undefined;
        if (k.metrics.R !== null) this.recomputeScore(k);
        const pShown = k.degraded ? "—" : String(k.metrics.P);
        await this.event("✓", `${k.keyword} → P=${pShown} D=${k.metrics.D}${k.metrics.score !== null ? ` Score=${k.metrics.score}` : ""}`);
      } catch (e: any) {
        if (e instanceof ReplayFrontier || e instanceof InsufficientCredits || e instanceof CogsExceededCeiling) throw e;
        if (e instanceof PauseInterrupt || e instanceof LlmAuthError) throw e;
        if (e?.name === "ClientGoneError") throw e;
        k.status = "error";
        k.error = String(e?.message ?? e);
        await this.event("✗", `${k.keyword}: Apple error (${k.error}) — continuing`);
      }
      await this.save();
    }
    // rate is invoked by the phase (phaseLoop/phaseImproving) AFTER probe — sequentially and
    // deterministically (see the decision to drop rateInFlight in the file header).
  }

  private async prescreenCandidates() {
    let missRounds = 0;
    for (;;) {
      const batch = this.state.keywords
        .filter((k) => k.status === "candidate" && k.metrics.R === null)
        .slice(0, 25);
      if (batch.length === 0) return;
      this.checkPause();
      const system = renderPrompt("rate", { SEMANTIC_LANGUAGE: this.config.semanticLanguage });
      const items = batch.map((k) => ({ keyword: k.keyword, P: null, D: null, top3: [] }));
      const res = await this.llm<{ ratings: { keyword: string; r: number; reason: string; brand?: boolean }[] }>(
        "rate", system, `PRESCREEN (P/D not measured yet) — rate purely semantically:\n${JSON.stringify(items, null, 2)}`,
        this.contextBlock(),
      );
      let accepted = 0;
      const drop = new Set<string>();
      for (const rating of res.ratings) {
        const k = batch.find((x) => x.keyword === normalizeKeyword(rating.keyword));
        if (!k || k.status !== "candidate") continue;
        if (!rating.reason?.trim()) continue;
        k.metrics.R = rating.r;
        k.metrics.semR = rating.r; // semantic half of R (spec 03.3v2) — survives final rating
        k.metrics.reason = `[prescreen] ${rating.reason.slice(0, 180)}`;
        if (rating.brand === true) k.metrics.brandQuery = true; // rater-detected live brand (rate.md rule 7)
        accepted++;
        if (rating.r === 0) drop.add(k.keyword);
      }
      if (drop.size > 0) {
        this.state.keywords = this.state.keywords.filter((k) => !drop.has(k.keyword));
        this.state.rejected.push(...drop);
      }
      await this.save();
      if (accepted > 0) await this.event("🧹", `prescreen: ${accepted} rated, ${drop.size} dropped (R=0)`);
      if (accepted === 0) {
        missRounds++;
        if (missRounds >= 2) {
          for (const k of batch) {
            if (k.status === "candidate" && k.metrics.R === null) {
              k.metrics.R = 1;
              k.metrics.semR = 1;
              k.metrics.reason = "[prescreen] no rating received — passed through to probe";
            }
          }
          await this.save();
          missRounds = 0;
        }
      } else {
        missRounds = 0;
      }
    }
  }

  /**
   * Classify every SERP app seen but not yet judged (spec 03.3v2). ONE verdict per app,
   * cached in state.appNiche and reused by every keyword whose top results include it — this
   * is what makes R stable across keywords and across runs (the question "is this OUR kind of
   * app?" is far more reproducible than "is this query core/adjacent?"). Also the niche map
   * for the Competitors tab. No per-keyword LLM call and no charge here — pure COGS, capped by
   * the margin fuse. Batches of 50 short name→id records.
   */
  private async classifyNewApps(): Promise<number> {
    const seen = this.state.appNiche;
    const pending = new Map<number, string>();
    for (const k of this.state.keywords) {
      if (k.status !== "verified" && k.status !== "rated" && k.status !== "excluded") continue;
      for (const a of k.metrics.topApps.slice(0, this.config.serpTop)) {
        if (seen[String(a.trackId)] === undefined && !pending.has(a.trackId)) pending.set(a.trackId, a.trackName);
      }
    }
    if (pending.size === 0) return 0;
    const system = renderPrompt("classify", { SEMANTIC_LANGUAGE: this.config.semanticLanguage });
    const entries = [...pending.entries()];
    let classified = 0;
    if (entries.length > 50) await this.event("🔎", `classifying ${entries.length} store apps by niche…`);
    for (let i = 0; i < entries.length; i += 50) {
      this.checkPause();
      const chunk = entries.slice(i, i + 50);
      const items = chunk.map(([trackId, trackName]) => ({ trackId, trackName }));
      const res = await this.llm<{ apps: { trackId: number; match: number; reason: string }[] }>(
        "classify", system, `Classify these apps by niche fit:\n${JSON.stringify(items, null, 2)}`, this.contextBlock(),
      );
      for (const a of res.apps) {
        if (!pending.has(a.trackId)) continue;
        const match = a.match === 1 ? 1 : a.match === 0.5 ? 0.5 : 0;
        seen[String(a.trackId)] = { match, reason: (a.reason ?? "").slice(0, 100) };
        classified++;
      }
      // Any app the model skipped: assume adjacent (0.5) so serpFit is never blocked on a
      // missing verdict, and record it so we don't re-ask next round.
      for (const [trackId] of chunk) {
        if (seen[String(trackId)] === undefined) seen[String(trackId)] = { match: 0.5, reason: "not classified — assumed adjacent" };
      }
      await this.save();
      if (entries.length > 50) await this.event("🔎", `niche classified: ${Math.min(i + 50, entries.length)}/${entries.length} apps`);
    }
    if (classified > 0) await this.event("🔎", `classified ${classified} store apps by niche — the measured basis for R`);
    return classified;
  }

  /** Human-readable, code-generated R trail (spec 03.3v2): the semantic prior, the measured
   *  store fit, and evidence confidence — every factor traces to raw data. */
  private relevanceReason(semReason: string, sem: number, fit: number, conf: number, R: number): string {
    const semTxt = semReason.replace(/^\[prescreen\]\s*/, "").trim();
    const confNote = conf < 1 ? `, thin SERP (${Math.round(conf * 100)}% of top-${this.config.serpTop})` : "";
    return `R ${R} = semantic ${sem}/3 × store-fit ${Math.round(fit * 100)}%${confNote}. ${semTxt}`.slice(0, 240);
  }

  /**
   * Final Relevance (spec 03.3v2). R is COMPUTED, not asked: sem = the prescreen rating (the
   * only place an LLM judges the query), fit = the in-niche share of the MEASURED top SERP
   * (from classifyNewApps). No per-keyword LLM call → the number no longer swings run-to-run.
   * Charges each INCLUDED keyphrase (D4 v4, capped at the overshoot cap); beyond the cap an
   * included phrase stays rated but free, so the charge count never exceeds the cap.
   */
  private async rateAll() {
    await this.classifyNewApps();
    const serpTop = this.config.serpTop;
    const pending = this.state.keywords.filter((k) => k.status === "verified");
    for (const k of pending) {
      this.checkPause();
      const sem = k.metrics.semR ?? k.metrics.R ?? 1;
      const { fit, conf } = serpFitOf(k.metrics.topApps, this.state.appNiche, serpTop);
      const R = finalR(sem, fit, conf);
      const included = R >= RELEVANCE.includeThreshold;
      if (included && !this.atOvershootCap()) {
        // REAL debit of a verified keyphrase (D4 v4). Insufficient → hard-stop (paused, resumable).
        const charge = await this.deps.chargeKeyphrase(k.keyword);
        if (!charge.ok) throw new InsufficientCredits(charge.price, charge.balance);
      }
      k.metrics.semR = sem;
      k.metrics.serpFit = Math.round(fit * 100) / 100;
      k.metrics.R = R;
      k.metrics.reason = this.relevanceReason(k.metrics.reason ?? "", sem, fit, conf, R);
      k.status = included ? "rated" : "excluded";
      this.recomputeScore(k);
      await this.event("★", `${k.keyword} → R=${R} (sem ${sem}/3 · fit ${Math.round(fit * 100)}%), Score=${k.metrics.score ?? 0}`);
      await this.save();
    }
  }

  // ---------- suggest-graph expansion (runWave → job-emit) ----------

  private async expansionWave(): Promise<number> {
    if (this.state.hintsEndpointDown) return 0;
    if (this.atOvershootCap()) return 0; // overshoot cap (D4 v4): no new branches
    const exp = this.state.expansion;
    if (this.state.phase === "improving") {
      if ((exp.improvingWaves ?? 0) >= this.config.improvementRounds) return 0;
      exp.improvingWaves = (exp.improvingWaves ?? 0) + 1;
    }
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));
    const lang = this.config.semanticLanguage;

    const provenHeads = this.state.keywords
      .filter((k) => (k.metrics.R ?? 0) >= 3 && (k.metrics.P ?? 0) > 0)
      .sort((a, b) => (b.metrics.score ?? 0) - (a.metrics.score ?? 0))
      .map((k) => k.keyword);
    const headWords: string[] = [];
    const seenW = new Set<string>();
    for (const k of this.state.keywords.filter((x) => (x.metrics.R ?? 0) >= 2)) {
      for (const w of k.keyword.split(" ")) {
        if (w.length >= 3 && !stopSet.has(w) && !seenW.has(w)) { seenW.add(w); headWords.push(w); }
      }
    }
    for (const w of this.productVocabWords()) if (!seenW.has(w)) { seenW.add(w); headWords.push(w); }
    const letterFreq = new Map<string, number>();
    for (const w of seenW) letterFreq.set(w[0], (letterFreq.get(w[0]) ?? 0) + 1);
    const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
    const soupLetters = [...alphabet].sort((a, b) => (letterFreq.get(b) ?? 0) - (letterFreq.get(a) ?? 0));

    const tasks = planWave({
      provenHeads, headWords,
      llmRoots: exp.roots.map((r) => normalizeKeyword(r)).filter(Boolean),
      soupLetters: soupLetters.slice(0, 12),
      done: exp.done, budget: 24,
    });
    if (tasks.length === 0) return 0;

    // EMIT a HintsJob per task; "break on throttle" = server-side back-pressure.
    const results: { task: ExpansionTask; terms: string[] | null; permanentError?: boolean }[] = [];
    for (const task of tasks) {
      if (this.pauseRequested) break;
      try {
        const terms = await this.deps.gateway.hints(task.term, this.storefront);
        results.push({ task, terms });
      } catch (e: any) {
        if (e instanceof ReplayFrontier) throw e;
        if (e instanceof JobError && e.throttle) break; // back-pressure: remainder goes to the next wave
        if (e?.name === "ClientGoneError") throw e;
        results.push({ task, terms: null, permanentError: true });
      }
    }
    const result = harvestWaveResults(results);
    for (const d of result.done) (exp.done[d.root] ??= []).push(d.opKey);
    exp.roots = exp.roots.filter((r) => {
      const doneOps = exp.done[normalizeKeyword(r)] ?? [];
      return !(doneOps.includes("complete") && doneOps.includes("children"));
    });

    const known = new Set([...this.state.keywords.map((k) => k.keyword), ...this.state.rejected]);
    const headKeySet = new Set(
      provenHeads.flatMap((h) => h.split(" ")).filter((w) => !stopSet.has(w)).map((w) => foldKey(w, lang)),
    );
    const pool = [...new Set([...exp.pending, ...result.discovered])]
      .filter((t) => !known.has(t))
      .sort((a, b) => {
        const aShares = a.split(" ").some((w) => headKeySet.has(foldKey(w, lang))) ? 0 : 1;
        const bShares = b.split(" ").some((w) => headKeySet.has(foldKey(w, lang))) ? 0 : 1;
        return aShares - bShares || a.length - b.length;
      });
    const fresh = pool.slice(0, 40);
    exp.pending = pool.slice(40, 240);
    const added = await this.addCandidates(
      fresh.map((keyword) => ({ keyword, source: "suggest" as const })),
      { relaxWordLength: true },
    );
    if (result.requestsSpent > 0) {
      await this.event("🕸", `suggest-graph expansion: ${result.requestsSpent} requests → +${added} candidates`);
    }
    await this.save();
    return added;
  }

  private async hypothesize() {
    if (this.atOvershootCap()) return; // overshoot cap (D4 v4): don't accumulate beyond +10%
    await this.expansionWave();

    let top = this.top20().filter((k) => (k.metrics.R ?? 0) >= 2);
    if (top.length === 0) top = this.top20();
    const worst = this.state.keywords
      .filter((k) => k.status === "rated" || k.status === "excluded")
      .sort((a, b) => (a.metrics.score ?? 0) - (b.metrics.score ?? 0))
      .slice(0, 10);

    // Leaders' "children" — via HintsJob (not inline fetch).
    const children: Record<string, string[]> = {};
    if (!this.state.hintsEndpointDown) {
      for (const k of top.slice(0, 10)) {
        if ((k.metrics.childCount ?? 0) > 0) {
          try {
            const terms = await this.deps.gateway.hints(k.keyword + " ", this.storefront);
            children[k.keyword] = terms.filter((t) => normalizeKeyword(t).startsWith(k.keyword + " ")).slice(0, 10);
          } catch (e) { if (e instanceof ReplayFrontier) throw e; /* otherwise non-critical */ }
        }
      }
    }

    const weakTitles = new Set<string>();
    for (const k of top) for (const a of k.metrics.topApps) if (a.strength < 40 && a.trackName) weakTitles.add(a.trackName);

    const known = [...this.state.keywords.map((k) => k.keyword), ...this.state.rejected];
    const explorePct = Math.round(this.config.exploreRatio * 100);
    const system = renderPrompt("hypothesize", {
      SEMANTIC_LANGUAGE: this.config.semanticLanguage,
      STOPWORDS: this.config.stopwords.join(", "),
      BATCH_SIZE: this.config.batchSize,
      EXPLORE_SHARE: explorePct,
      EXPLOIT_SHARE: 100 - explorePct,
    });
    const expandedRoots = Object.keys(this.state.expansion.done);
    const queuedRoots = this.state.expansion.roots;
    const prompt = [
      `Leaders to develop (R≥2 only): ${JSON.stringify(top.map((k) => ({ keyword: k.keyword, score: k.metrics.score, P: k.metrics.P, D: k.metrics.D, R: k.metrics.R, childCount: k.metrics.childCount })))}`,
      `Worst (anti-examples): ${JSON.stringify(worst.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0, R: k.metrics.R, reason: k.metrics.reason })))}`,
      `Rejected by prescreen: ${JSON.stringify(this.state.rejected.slice(-30))}`,
      `Directions already expanded by the crawler: ${JSON.stringify(expandedRoots.slice(-60))}`,
      `Directions queued for the crawler: ${JSON.stringify(queuedRoots)}`,
      `Leaders' "children": ${JSON.stringify(children)}`,
      `Weak competitors' titles: ${JSON.stringify([...weakTitles].slice(0, 25))}`,
      `ALL known keywords: ${JSON.stringify(known)}`,
    ].join("\n\n");

    await this.event("🧠", "hypothesize: graph directions + short hypotheses");
    const res = await this.llm<{ roots: string[]; keywords: { keyword: string; type: string; strategy: "exploit" | "explore" }[] }>(
      "hypothesize", system, prompt, this.contextBlock(),
    );
    const exp = this.state.expansion;
    const knownRoots = new Set([...exp.roots, ...Object.keys(exp.done)]);
    let newRoots = 0;
    for (const r of res.roots ?? []) {
      if (exp.roots.length >= 30) break;
      const root = normalizeKeyword(r);
      if (!root || root.split(" ").length > 2 || knownRoots.has(root)) continue;
      exp.roots.push(root);
      knownRoots.add(root);
      newRoots++;
    }
    const added = await this.addCandidates(
      res.keywords.map((k) => ({ keyword: k.keyword, type: k.type, strategy: k.strategy, source: "expansion" as const })),
    );
    await this.event("🧠", `hypothesize: +${newRoots} directions, +${added} hypotheses`);
  }

  private async harvestSuggestions(sourceKeyword: string, seenTerms: string[]) {
    const pendingSuggest = this.state.keywords.filter((k) => k.source === "suggest" && k.status === "candidate").length;
    if (pendingSuggest >= 40) return;
    const lang = this.config.semanticLanguage;
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));
    const sourceKeys = new Set(sourceKeyword.split(" ").filter((w) => !stopSet.has(w)).map((w) => foldKey(w, lang)));
    const vocab = this.productVocabKeys();
    const known = new Set([...this.state.keywords.map((k) => k.keyword), ...this.state.rejected]);
    const picked: string[] = [];
    for (const term of seenTerms) {
      if (picked.length >= 3) break;
      const t = normalizeKeyword(term);
      if (known.has(t) || picked.includes(t)) continue;
      if (!/^[\p{L}\p{N} ]+$/u.test(t) || t.length > 40) continue;
      const words = t.split(" ");
      if (words.length > 4) continue;
      if (words.some((w) => w.length < 3)) continue;
      if (words.every((w) => stopSet.has(w))) continue;
      const keys = words.filter((w) => !stopSet.has(w)).map((w) => foldKey(w, lang));
      if (words.length === 1 && !vocab.has(keys[0])) continue;
      const shared = keys.filter((k) => sourceKeys.has(k));
      const isChild = t.includes(sourceKeyword);
      const anchored = shared.some((k) => vocab.has(k));
      if (!isChild && shared.length < 2 && !anchored) continue;
      picked.push(t);
    }
    if (picked.length > 0) {
      const added = await this.addCandidates(picked.map((keyword) => ({ keyword, source: "suggest" as const })));
      if (added > 0) await this.event("🔦", `hints during probe of "${sourceKeyword}": +${added} (suggest)`);
    }
  }

  private productVocabWords(): string[] {
    if (!this.state.context) return [];
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));
    const out = new Set<string>();
    for (const phrase of [...this.state.context.featureVocabulary, ...this.state.context.jobsToBeDone]) {
      for (const w of phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (w.length >= 3 && !stopSet.has(w)) out.add(w);
      }
    }
    return [...out];
  }
  private productVocabKeys(): Set<string> {
    return new Set(this.productVocabWords().map((w) => foldKey(w, this.config.semanticLanguage)));
  }

  // ---------- assembly (spec 05) ----------

  private async phaseAssembling() {
    this.mustContext();
    await this.event("🧩", "assembling metadata: optimizer picks the words, composer writes the lines");
    const brandWords = wordsOf(this.config.brand);
    const lang = this.config.semanticLanguage;
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));

    const universe = this.state.keywords.filter((k) => (k.metrics.R ?? 0) >= 1 && (k.metrics.score ?? 0) > 0);
    const phrases = universe.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0 }));
    const optPhrases: OptPhrase[] = universe.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0, R: k.metrics.R }));
    const scoreTotal = phrases.reduce((s, p) => s + p.score, 0);

    const budgets = {
      titleSloganMax: this.config.limits.title - this.config.brand.length - 3,
      subtitleMax: this.config.limits.subtitle,
      keywordsMax: this.config.limits.keywords,
    };

    const extra = extraLocaleFor(this.config.country);
    const wantBuckets: 1 | 2 = this.config.extraLocale && extra ? 2 : 1;
    if (this.config.extraLocale && !extra) {
      await this.event("ℹ️", `no extra locale known for ${this.config.country} — single bucket`);
    }

    // Anchors: the leading verb of each job-to-be-done. A title slot holding one reads as a
    // product statement ("Stop Sports Betting"), not a word pile — the optimizer gets a small
    // bonus for that, the composer does the rest.
    const anchorKeys = new Set(
      this.mustContext().jobsToBeDone
        .map((j) => wordsOf(j)[0])
        .filter((w): w is string => !!w && !stopSet.has(w))
        .map((w) => foldKey(w, lang)),
    );

    // Words living ONLY inside brand queries for other products (metrics.brandQuery) must not
    // occupy budget: indexing them buys competitor-brand traffic that converts against us.
    const brandOnly = new Map<string, boolean>();
    for (const k of universe) {
      const isBrand = k.metrics.brandQuery === true;
      for (const key of phraseKeys(k.keyword, stopSet, lang)) {
        brandOnly.set(key, (brandOnly.get(key) ?? true) && isBrand);
      }
    }
    const bannedKeys = new Set([...brandOnly.entries()].filter(([, only]) => only).map(([k]) => k));

    const plan = optimizeAssembly({
      phrases: optPhrases, stopwords: this.config.stopwords, brandWords,
      language: lang, budgets, bucketCount: wantBuckets, anchorKeys, bannedKeys,
    });

    const primaryLocale = `${lang}-${this.config.country.toUpperCase()}`;
    const buckets: AssemblyBucket[] = [];
    const takenKeys = new Set<string>();
    for (let bi = 0; bi < plan.buckets.length; bi++) {
      const bp = plan.buckets[bi];
      if (bp.title.length + bp.subtitle.length + bp.keywords.length === 0) {
        if (bi > 0) await this.event("ℹ️", "nothing left for the cross-locale bucket — pass 2 skipped");
        continue;
      }
      const locale = bi === 0 ? primaryLocale : extra!;
      const bucket = await this.composeBucket(locale, bp, budgets, optPhrases, new Set(takenKeys));
      buckets.push(bucket);
      for (const k of bucketFoldKeys(
        { title: bucket.title ?? "", subtitle: bucket.subtitle ?? "", keywords: bucket.keywordFieldDraft, titleWords: [], subtitleWords: [] },
        this.config.brand, lang,
      )) takenKeys.add(k);
    }

    const brandKeys = new Set(brandWords.map((w) => foldKey(w, lang)));
    const allKeys = new Set<string>(takenKeys);

    const rows: CoverageRow[] = [];
    let phrasesCovered = 0;
    let scoreCovered = 0;
    const topUncovered: AssemblyResult["topUncovered"] = [];
    const sortedPhrases = [...phrases].sort((a, b) => b.score - a.score);
    for (const p of sortedPhrases) {
      const keys = phraseKeys(p.keyword, stopSet, lang);
      const covered = keys.every((k) => allKeys.has(k) || brandKeys.has(k));
      if (covered) { phrasesCovered += 1; scoreCovered += p.score; }
      else if (topUncovered.length < 20) {
        topUncovered.push({ keyword: p.keyword, score: p.score, missingWords: keys.filter((k) => !allKeys.has(k) && !brandKeys.has(k)) });
      }
      if (rows.length < 50) {
        const { bucket, fields, weight } = this.coverageDetail(p.keyword, buckets, stopSet, brandKeys, lang);
        rows.push({ keyword: p.keyword, score: p.score, covered, bucket, fields, placementWeight: weight });
      }
    }

    this.state.assembly = {
      buckets,
      coverage: {
        phrasesCovered, scoreCovered, scoreTotal,
        coveredShare: scoreTotal > 0 ? Math.round((scoreCovered / scoreTotal) * 100) / 100 : 0,
        rows,
      },
      topUncovered,
    };

    for (const k of this.state.keywords) {
      if (k.status !== "rated") continue;
      if ((k.metrics.R ?? 0) < 1) continue;
      const keys = phraseKeys(k.keyword, stopSet, lang);
      const covered = keys.every((x) => allKeys.has(x) || brandKeys.has(x));
      k.status = covered && (k.metrics.score ?? 0) > 0 ? "selected" : "bench";
    }
    await this.save();
    await this.event("✅", `assembly ready: ${phrasesCovered} phrases covered, ${Math.round(this.state.assembly.coverage.coveredShare * 100)}% of Score`);
  }

  private coverageDetail(keyword: string, buckets: AssemblyBucket[], stopSet: Set<string>, brandKeys: Set<string>, lang: string) {
    for (let bi = 0; bi < buckets.length; bi++) {
      const b = buckets[bi];
      const placement: Placement = {
        titleWords: wordsOf(b.title ?? ""),
        subtitleWords: wordsOf(b.subtitle ?? ""),
        keywordWords: b.keywordFieldDraft ? b.keywordFieldDraft.split(",") : [],
      };
      const w = placementWeight(keyword, placement, stopSet, brandKeys, lang);
      if (w > 0) {
        const keys = phraseKeys(keyword, stopSet, lang);
        const fields = new Set<string>();
        for (const k of keys) {
          if (brandKeys.has(k)) continue;
          if (placement.titleWords.some((x) => foldKey(x, lang) === k)) fields.add("T");
          else if (placement.subtitleWords.some((x) => foldKey(x, lang) === k)) fields.add("S");
          else fields.add("K");
        }
        return { bucket: bi, fields: [...fields], weight: w };
      }
    }
    return { bucket: null as number | null, fields: [] as string[], weight: 0 };
  }

  /** Compose one bucket from the optimizer word plan (spec 05v2): the LLM writes the human
   *  lines from the EXACT word sets (validator-gated, 3 attempts), deterministic contiguity
   *  ordering as the fallback; the keyword field is the plan plus speculative fill
   *  (unsuggested R=3 words, spec 05.6) up to the 92-char comfort floor. */
  private async composeBucket(
    locale: string,
    plan: BucketWordPlan,
    budgets: { titleSloganMax: number; subtitleMax: number; keywordsMax: number },
    optPhrases: OptPhrase[],
    otherBucketKeys: Set<string>,
  ): Promise<AssemblyBucket> {
    const lang = this.config.semanticLanguage;
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));
    const brandKeys = new Set(wordsOf(this.config.brand).map((w) => foldKey(w, lang)));
    const sig = (text: string) => wordsOf(text).filter((w) => !stopSet.has(w));
    const keysOf = (text: string) => sig(text).map((w) => foldKey(w, lang));

    const titleOrder = orderForField(plan.title, optPhrases, this.config.stopwords, lang);
    const subOrder = orderForField(plan.subtitle, optPhrases, this.config.stopwords, lang);
    const wantTitle = new Set(plan.title.map((w) => foldKey(w, lang)));
    const wantSub = new Set(plan.subtitle.map((w) => foldKey(w, lang)));

    const checkCompose = (slog: string, sub: string): string[] => {
      const errors: string[] = [];
      const gotT = keysOf(slog);
      const gotS = keysOf(sub);
      if (new Set(gotT).size !== gotT.length) errors.push("repeated word in slogan");
      if (new Set(gotS).size !== gotS.length) errors.push("repeated word in subtitle");
      for (const k of gotT) if (!wantTitle.has(k)) errors.push(`extra word in slogan (key "${k}")`);
      for (const k of wantTitle) if (!gotT.includes(k)) errors.push(`slogan is missing a required word (key "${k}")`);
      for (const k of gotS) if (!wantSub.has(k)) errors.push(`extra word in subtitle (key "${k}")`);
      for (const k of wantSub) if (!gotS.includes(k)) errors.push(`subtitle is missing a required word (key "${k}")`);
      if (slog.length > budgets.titleSloganMax) errors.push(`slogan longer than ${budgets.titleSloganMax}: ${slog.length}`);
      if (sub.length > budgets.subtitleMax) errors.push(`subtitle longer than ${budgets.subtitleMax}: ${sub.length}`);
      return errors;
    };

    const doValidate = (t: string, s: string, kwDraft: string) =>
      validate({
        bucket: { title: t, subtitle: s, keywords: kwDraft, titleWords: plan.title, subtitleWords: plan.subtitle },
        brand: this.config.brand, language: lang, stopwords: this.config.stopwords,
        competitors: this.mustContext().competitors, limits: this.config.limits, otherBucketKeys,
      });

    let title = "";
    let subtitle = "";
    let ok = false;
    const MAX_COMPOSE_ATTEMPTS = 3;
    if (plan.title.length > 0 || plan.subtitle.length > 0) {
      const system = renderPrompt("compose", {
        BRAND: this.config.brand, LOCALE: locale,
        TITLE_BUDGET: budgets.titleSloganMax, SUBTITLE_BUDGET: budgets.subtitleMax,
        TITLE_WORDS: JSON.stringify(titleOrder), SUBTITLE_WORDS: JSON.stringify(subOrder),
        STOPWORDS: this.config.stopwords.join(", "),
      });
      let note = "";
      for (let attempt = 1; attempt <= MAX_COMPOSE_ATTEMPTS && !ok; attempt++) {
        this.checkPause();
        const prompt =
          `Compose the two lines for locale ${locale}.\n` +
          `Slogan word set: ${JSON.stringify(titleOrder)} (suggested order — reorder freely).\n` +
          `Subtitle word set: ${JSON.stringify(subOrder)}.` +
          (note ? `\n\nPrevious attempt was rejected:\n${note}\nFix it.` : "");
        const res = await this.llm<{ titleSlogan: string; subtitle: string }>("compose", system, prompt, this.contextBlock());
        const slog = res.titleSlogan.trim();
        const sub = res.subtitle.trim();
        const errors = checkCompose(slog, sub);
        const t = `${this.config.brand} - ${slog}`;
        const structural = errors.length === 0
          ? doValidate(t, sub, "").filter((v) => v.level === "error" && v.code !== "W1").map((v) => `${v.code}: ${v.message}`)
          : [];
        const all = [...errors, ...structural];
        if (all.length === 0) {
          title = t; subtitle = sub; ok = true;
        } else {
          note = all.join("\n");
          await this.event("♻️", `compose (${locale}) attempt ${attempt}/${MAX_COMPOSE_ATTEMPTS}: rejected — ${all.join("; ")}`);
        }
      }
    }
    if (!ok) {
      const slog = glueField(titleOrder, optPhrases, this.config.stopwords, lang, budgets.titleSloganMax);
      title = `${this.config.brand} - ${slog}`;
      subtitle = glueField(subOrder, optPhrases, this.config.stopwords, lang, budgets.subtitleMax);
      if (plan.title.length > 0) await this.event("🛟", `compose (${locale}): deterministic fallback — "${title}" / "${subtitle}"`);
    }

    const usedKeys = new Set<string>([...keysOf(title), ...keysOf(subtitle), ...otherBucketKeys, ...brandKeys]);
    const kwWords = [...plan.keywords];
    for (const w of kwWords) usedKeys.add(foldKey(w, lang));
    const speculativeWords: string[] = [];
    const draftLen = () => kwWords.reduce((s, w) => s + w.length, 0) + Math.max(0, kwWords.length - 1);
    if (draftLen() < 92) {
      const freq = new Map<string, number>();
      for (const k of this.state.keywords) {
        if (!(k.metrics.unsuggested && (k.metrics.R ?? 0) === 3 && k.status !== "excluded")) continue;
        for (const w of k.keyword.split(" ")) {
          if (w.length < 3 || stopSet.has(w)) continue;
          if (lang.startsWith("en") && AUX_WORDS.has(w)) continue;
          freq.set(w, (freq.get(w) ?? 0) + 1);
        }
      }
      const specCandidates = [...freq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
        .map(([w]) => w);
      for (const w of specCandidates) {
        const key = foldKey(w, lang);
        if (usedKeys.has(key)) continue;
        if (draftLen() + w.length + 1 > budgets.keywordsMax) continue;
        kwWords.push(w);
        usedKeys.add(key);
        speculativeWords.push(w);
        if (draftLen() >= 92) break;
      }
    }
    const keywordFieldDraft = kwWords.join(",");

    const violations = doValidate(title, subtitle, keywordFieldDraft);
    const finalErrors = violations.filter((v) => v.level === "error");
    if (finalErrors.length > 0) {
      throw new Error(`Bucket assembly for ${locale} failed validation: ${finalErrors.map((v) => `${v.code}: ${v.message}`).join("; ")}`);
    }

    return { locale, titleWords: plan.title, subtitleWords: plan.subtitle, keywordFieldDraft, title, subtitle, budgets, speculativeWords, violations };
  }

  // ---------- utilities ----------

  private async addCandidates(
    items: { keyword: string; type?: string; strategy?: "exploit" | "explore"; source: KeywordSource }[],
    opts: { relaxWordLength?: boolean } = {},
  ): Promise<number> {
    const ctx = this.mustContext();
    const known = new Set([...this.state.keywords.map((k) => k.keyword), ...this.state.rejected]);
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));
    const competitors = ctx.competitors.map((c) => c.toLowerCase().trim()).filter(Boolean);
    const minWordLen = opts.relaxWordLength ? 2 : 3;
    let added = 0;
    for (const item of items) {
      const kw = normalizeKeyword(item.keyword);
      if (!kw || known.has(kw)) continue;
      const words = kw.split(" ");
      if (words.some((w) => w.length < minWordLen)) continue;
      if (words.every((w) => stopSet.has(w))) continue;
      if (competitors.some((c) => kw.includes(c))) continue;
      known.add(kw);
      this.state.keywords.push({
        keyword: kw, status: "candidate", source: item.source,
        strategy: item.strategy, type: item.type, addedAt: new Date().toISOString(),
        metrics: { P: null, L: null, rank: null, unsuggested: false, childCount: 0, D: null, serpSize: null, topApps: [], R: null, reason: null, score: null },
        degraded: false,
      });
      added++;
    }
    await this.save();
    return added;
  }

  private recomputeScore(k: KeywordEntry) {
    const R = k.metrics.R ?? 0;
    if (k.metrics.brandQuery) { k.metrics.score = 0; return; }
    if (k.metrics.unsuggested) { k.metrics.score = 0; return; }
    const P = k.degraded ? 50 : (k.metrics.P ?? 0);
    k.metrics.score = opportunityScore(P, k.metrics.D ?? 0, R, this.config.weights.opportunity);
  }

  private top20(): KeywordEntry[] {
    return this.state.keywords
      .filter((k) => (k.metrics.score ?? 0) > 0)
      .sort((a, b) => compareKeywords(
        { score: a.metrics.score ?? 0, P: a.metrics.P ?? 0, D: a.metrics.D ?? 0, keyword: a.keyword },
        { score: b.metrics.score ?? 0, P: b.metrics.P ?? 0, D: b.metrics.D ?? 0, keyword: b.keyword },
      ))
      .slice(0, 20);
  }

  private mustContext(): BusinessContext {
    if (!this.state.context) throw new Error("Context not extracted");
    return this.state.context;
  }

  private contextBlock(): string {
    return `App business context:\n${JSON.stringify(this.mustContext(), null, 2)}`;
  }

  private async llm<T>(task: string, system: string, prompt: string, contextBlock?: string): Promise<T> {
    const n = (this.state.stepCounters[task] = (this.state.stepCounters[task] ?? 0) + 1);
    const logicalStep = `${task}#${n}`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.checkPause();
      try {
        const res = await this.deps.proxy.complete<T>({
          runId: this.state.runId, userId: this.state.userId, task, logicalStep,
          system, contextBlock, prompt, schema: schemas[task], model: this.config.model,
          replay: this.replaying,
        });
        this.trackUsage(task, res.usage, res.costUsd);
        // Margin fuse (D4 v4): actual COGS must not exceed the estimate ceiling.
        if (!this.replaying && this.state.usage.costUsd !== null && this.state.usage.costUsd > this.state.estimateCredits) {
          throw new CogsExceededCeiling(this.state.usage.costUsd, this.state.estimateCredits);
        }
        return res.data;
      } catch (e: any) {
        if (e instanceof ReplayFrontier || e instanceof InsufficientCredits || e instanceof CogsExceededCeiling) throw e;
        if (e instanceof LlmAuthError || e instanceof PauseInterrupt) throw e;
        if (e?.name === "ClientGoneError") throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        await this.event("⚠️", `LLM ${task} failed (${lastError.message}) — attempt ${attempt + 1}/3`);
        await new Promise((r) => setTimeout(r, [2000, 8000, 20000][attempt]));
      }
    }
    throw lastError ?? new Error("LLM call failed");
  }

  private trackUsage(task: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, costUsd: number | null) {
    const u = this.state.usage;
    u.calls += 1;
    u.inputTokens += usage.inputTokens;
    u.outputTokens += usage.outputTokens;
    u.cacheReadTokens += usage.cacheReadTokens;
    u.cacheWriteTokens += usage.cacheWriteTokens;
    if (costUsd !== null) u.costUsd = Math.round(((u.costUsd ?? 0) + costUsd) * 10_000) / 10_000;
    const bt = (u.byTask[task] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null });
    bt.calls += 1;
    bt.inputTokens += usage.inputTokens;
    bt.outputTokens += usage.outputTokens;
    bt.cacheReadTokens += usage.cacheReadTokens;
    if (costUsd !== null) bt.costUsd = Math.round(((bt.costUsd ?? 0) + costUsd) * 10_000) / 10_000;
  }

  private checkPause() {
    if (this.pauseRequested) throw new PauseInterrupt();
  }

  private async event(kind: string, text: string) {
    if (this.replaying) return; // replay does not duplicate the progress feed/SSE
    await this.deps.emitEvent(this.state.runId, kind, text);
  }

  private async save() {
    if (this.replaying) return; // replay does not write the projection (in-memory reconstruction)
    this.state.updatedAt = new Date().toISOString();
    await this.deps.persist(this.state);
  }

  // ---------- event-replay (D7): reconstruction from durable logs ----------

  /**
   * Reconstruct state by RE-RUNNING the pipeline with side effects fed from logs:
   * LLM from llm_steps (proxy.replay), Apple from apple_cache (gateway.setReplay). First
   * log miss = ReplayFrontier → stop at a resumable boundary. Debits are idempotent
   * (already in the ledger), so replay does not double-charge them.
   */
  async replayFromLogs(persistedPhase: ServerRunState["phase"]): Promise<void> {
    if (persistedPhase === "created") return;
    this.replaying = true;
    this.deps.gateway.setReplay(true);
    try {
      await this.phaseContext();
      this.state.phase = "context_review";
      if (persistedPhase === "context_review") return;
      await this.phaseSeeding();
      this.state.phase = "loop";
      await this.phaseLoop();
      this.state.phase = "improving";
      await this.phaseImproving();
      this.state.phase = "assembling";
      await this.phaseAssembling();
      this.state.phase = "done";
    } catch (e: any) {
      if (e instanceof ReplayFrontier) {
        // Reached the edge of durable history — state reconstructed up to this point (resumable).
      } else if (e instanceof InsufficientCredits) {
        this.state.paused = true;
        this.state.notice = "Out of credits. Top up and we'll resume from here.";
      } else if (e instanceof CogsExceededCeiling) {
        this.state.paused = true;
      } else if (e instanceof LlmAuthError || e instanceof PauseInterrupt || e?.name === "ClientGoneError" || e instanceof JobError) {
        this.state.paused = true;
      } else {
        throw e; // unexpected — getOrchestrator falls back to the snapshot
      }
    } finally {
      this.replaying = false;
      this.deps.gateway.setReplay(false);
      this.running = false;
      this.pauseRequested = false;
    }
  }
}
