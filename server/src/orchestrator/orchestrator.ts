// @aso/server/orchestrator — машина состояний прогона (порт aso-util pipeline/orchestrator.ts,
// 1339 стр) с ИНВЕРСИЕЙ ПОТОКА УПРАВЛЕНИЯ (BUILD-PLAN §7): Apple-I/O больше не inline-fetch,
// а async job-dispatch через AppleGateway (Probe/Serp/Hints). LLM — через LlmProxy (метрик
// каждой попытки, микро-резерв, llm_steps, D4/D7). Событийность — в run_events (event-sourced).
// Pure-функции метрик/сборки — 1:1 из @aso/core.
//
// БИЛЛИНГ (D4 v4): списание в реальном времени — как только кейворд становится проверенной
// кейфразой (rated, R≥1) — сразу charge pricePerKeyphrase[model] (deps.chargeKeyphrase). На нуле
// — hard-stop paused (резюмируемо). Оркестратор кэпит перебор на sampleSize×(1+OVERSHOOT_PCT),
// но что произведено — то оплачено. Внутренний per-attempt COGS (llm_steps) — предохранитель.
//
// REPLAY (D7): при рестарте состояние реконструируется РЕ-ПРОГОНОМ (replayFromLogs) с подачей
// LLM из llm_steps и Apple из apple_cache; первый лог-промах = фронтир → останов, resumable.
//
// Порядок probe→rate — последовательный (детерминированный); фоновый интерливинг rate во время
// probe (aso-util rateInFlight) намеренно НЕ переносим: он усложняет реплей/паузу-на-границе-джобы
// без выигрыша для throttle-bound прогона (spec 04.6) — rate идёт пакетом ПОСЛЕ probe.

import {
  normalizeKeyword, sampleCount, STOREFRONTS,
  type BusinessContext, type KeywordEntry, type KeywordSource, type RunConfig,
  type Violation, type AssemblyBucket, type AssemblyResult, type CoverageRow,
} from "@aso/shared";
import { computePopularity } from "../core/metrics/popularity.ts";
import { computeDifficulty, isDeadBrandQuery } from "../core/metrics/difficulty.ts";
import { opportunityScore, compareKeywords } from "../core/metrics/score.ts";
import { selectWords, phraseKeys } from "../core/assembly/select.ts";
import { placementWeight, type Placement } from "../core/assembly/place.ts";
import { validate, bucketFoldKeys, wordsOf } from "../core/assembly/validate.ts";
import { foldKey } from "../core/assembly/folding.ts";
import { planWave, harvestWaveResults, type ExpansionTask } from "../core/expander.ts";
import { extraLocaleFor } from "../core/locales.ts";
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
  /** Персист read-проекции состояния (runs.state). */
  persist: (s: ServerRunState) => Promise<void>;
  /** Добавить событие в run_events; вернуть seq. */
  emitEvent: (runId: string, kind: string, text: string) => Promise<void>;
  /** РЕАЛЬНОЕ списание одной проверенной кейфразы (D4 v4). ok=false → hard-stop paused. */
  chargeKeyphrase: (keyword: string) => Promise<{ ok: boolean; balance: number; price: number }>;
  /** Пауза → run.paused клиенту с кодом причины (credits_out при исчерпании кредитов, D4 v4). */
  onPaused?: (reason: string, code?: "credits_out" | "provider_error" | "client_offline" | "user") => void;
  /** Финальный broadcast баланса + событие при завершении (без settle — usage-based). */
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
  /** Кэп перебора (D4 v4): не заводим новые ветки после sampleSize×(1+OVERSHOOT_PCT). */
  private get overshootCap(): number { return Math.floor(this.config.sampleSize * (1 + OVERSHOOT_PCT)); }
  private atOvershootCap(): boolean { return sampleCount(this.state.keywords) >= this.overshootCap; }
  private get storefront(): number {
    const sf = STOREFRONTS[this.config.country];
    if (!sf) throw new Error(`неизвестная страна: ${this.config.country}`);
    return sf.id;
  }

  // ---------- публичное управление (spec 04.4) ----------

  requestPause() { this.pauseRequested = true; }

  requestStopAndAssemble() {
    if (sampleCount(this.state.keywords) < 30) throw new Error("Досрочная сборка доступна при выборке ≥ 30");
    this.stopAndAssembleRequested = true;
    if (!this.running) void this.run("assembling");
  }

  excludeKeyword(keyword: string) {
    const k = this.state.keywords.find((x) => x.keyword === normalizeKeyword(keyword));
    if (!k) throw new Error(`Кейворд не найден: ${keyword}`);
    k.status = "excluded";
    void this.event("⛔", `${k.keyword} исключён вручную`);
  }

  editContext(patch: Partial<BusinessContext>) {
    if (!this.state.context) throw new Error("Контекст ещё не извлечён");
    this.state.context = { ...this.state.context, ...patch };
    void this.event("✏️", "контекст отредактирован пользователем");
  }

  async start() {
    if (this.running) return;
    if (this.state.phase === "created") await this.run("context");
  }

  async confirmContext() {
    if (this.state.phase !== "context_review") throw new Error("Прогон не ждёт подтверждения контекста");
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
    if (this.state.phase !== "done") throw new Error("Пересборка доступна после завершения");
    for (const k of this.state.keywords) if (k.status === "selected" || k.status === "bench") k.status = "rated";
    await this.run("assembling");
  }

  // ---------- главный цикл фаз ----------

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
            return; // единственная блокирующая на пользователе фаза
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
            await this.event("🏁", "прогон завершён — метаданные собраны");
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
      if (e instanceof ReplayFrontier) throw e; // реплей: наверх, реконструкция остановлена на фронтире
      let pauseCode: "credits_out" | "provider_error" | "client_offline" | "user" | undefined;
      if (e instanceof PauseInterrupt) {
        this.state.paused = true;
        this.state.notice = "Прогон на паузе.";
        pauseCode = "user";
        await this.event("⏸", "пауза");
      } else if (e instanceof InsufficientCredits) {
        this.state.paused = true;
        this.state.notice = `Кредиты кончились (кейфраза стоит ${e.needCredits}, на балансе ${e.haveCredits.toFixed(2)}). Пополните — продолжим с этого места.`;
        pauseCode = "credits_out";
        await this.event("💳", this.state.notice);
      } else if (e instanceof CogsExceededCeiling) {
        this.state.paused = true;
        this.state.notice = `Прогон приостановлен предохранителем себестоимости. ${e.message}`;
        await this.event("🛑", this.state.notice);
      } else if (e instanceof LlmAuthError) {
        this.state.paused = true;
        this.state.notice = `Проблема с провайдером: ${e.message}.`;
        pauseCode = "provider_error";
        await this.event("⚠️", this.state.notice);
      } else if (e?.name === "ClientGoneError" || e instanceof JobError) {
        this.state.paused = true;
        this.state.notice = `Клиент отключился — прогон на паузе (D7). ${e?.message ?? ""}`;
        pauseCode = "client_offline";
        await this.event("🔌", this.state.notice);
      } else {
        this.state.paused = true;
        this.state.notice = `Ошибка: ${e?.message ?? e}. Нажмите «Возобновить».`;
        await this.event("⚠️", this.state.notice);
      }
      await this.save();
      this.deps.onPaused?.(this.state.notice ?? "Прогон на паузе.", pauseCode);
    } finally {
      this.running = false;
      await this.save();
    }
  }

  // ---------- фазы ----------

  private async phaseContext() {
    await this.event("🧠", "извлекаю бизнес-контекст из брифа");
    const system = renderPrompt("context", {
      COUNTRY: this.config.country,
      SEMANTIC_LANGUAGE: this.config.semanticLanguage,
    });
    const res = await this.llm<BusinessContext>("context", system, `Бриф продукта:\n\n${this.state.brief}`, undefined);
    const ctx = { ...res, targetLanguage: this.config.semanticLanguage };
    if (ctx.jobsToBeDone.length < 3) throw new Error("контекст: слишком мало jobsToBeDone");
    this.state.context = ctx;
    await this.event("✅", "контекст извлечён — подтвердите или отредактируйте");
  }

  private async phaseSeeding() {
    this.mustContext();
    await this.event("🌱", "генерирую сид-гипотезы");
    const system = renderPrompt("seeds", {
      SEMANTIC_LANGUAGE: this.config.semanticLanguage,
      COUNTRY: this.config.country,
      STOPWORDS: this.config.stopwords.join(", "),
      BATCH_SIZE: this.config.batchSize,
    });
    const res = await this.llm<{ keywords: { keyword: string; type: string }[] }>(
      "seeds", system, `Сгенерируй ${this.config.batchSize} сид-гипотез.`, this.contextBlock(),
    );
    const added = await this.addCandidates(res.keywords.map((k) => ({ ...k, source: "seed" as const })));
    await this.event("🌱", `посев: +${added} гипотез`);
  }

  private async phaseLoop() {
    for (;;) {
      this.checkPause();
      await this.probeAll(true);
      await this.rateAll();
      const count = sampleCount(this.state.keywords);
      await this.event("📊", `выборка: ${count}/${this.config.sampleSize}`);
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
      if (this.atOvershootCap()) return; // кэп перебора (D4 v4)
      await this.event("🔁", `раунд улучшения ${this.state.improvementState.roundsSpent + 1}/${this.config.improvementRounds}`);
      await this.hypothesize();
      await this.probeAll();
      await this.rateAll();
      const newTop = this.top20().map((k) => k.keyword);
      const snapshot = new Set(this.state.improvementState.topSnapshot);
      const changed = newTop.some((k) => !snapshot.has(k));
      if (changed) {
        this.state.improvementState.roundsSpent = 0;
        await this.event("📈", "топ-20 обновился — счётчик раундов сброшен");
      } else {
        this.state.improvementState.roundsSpent += 1;
        await this.event("🔁", "раунд без обновления топ-20");
      }
      this.state.improvementState.topSnapshot = newTop;
      await this.save();
    }
  }

  // ---------- probe/rate (инвертированный I/O) ----------

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
        await this.event("📊", "выборка набрана — остальные подождут раундов улучшения");
        break;
      }
      try {
        // P — через ProbeJob (клиент фетчит; сервер считает над prefill∪fetched, D2/D3).
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
              await this.event("⚠️", `эндпоинт подсказок недоступен (${e?.message ?? e}) — Popularity в деградации (P=50)`);
            } else {
              throw e;
            }
          }
        }
        if (this.state.hintsEndpointDown) {
          k.metrics.P = null; k.metrics.L = null; k.metrics.rank = null;
          k.metrics.unsuggested = false; k.degraded = true;
        }
        // D — через SerpJob.
        const serp = await this.deps.gateway.serp(k.keyword, this.storefront, this.config.language);
        const diff = computeDifficulty(k.keyword, serp.results, serp.resultCount, this.config.serpTop, this.config.weights.difficulty);
        k.metrics.D = diff.D;
        k.metrics.serpSize = diff.serpSize;
        k.metrics.topApps = diff.topApps;
        k.metrics.brandQuery = isDeadBrandQuery(k.keyword, diff.topApps);
        if (k.metrics.brandQuery) {
          await this.event("🏷", `${k.keyword}: имя непопулярной апки — Score занулён`);
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
        await this.event("✗", `${k.keyword}: ошибка Apple (${k.error}) — продолжаю`);
      }
      await this.save();
    }
    // rate вызывается фазой (phaseLoop/phaseImproving) ПОСЛЕ probe — последовательно и
    // детерминированно (см. решение об отказе от rateInFlight в шапке файла).
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
      const res = await this.llm<{ ratings: { keyword: string; r: number; reason: string }[] }>(
        "rate", system, `ПРЕСКРИН (P/D ещё не измерены) — оцени чисто семантически:\n${JSON.stringify(items, null, 2)}`,
        this.contextBlock(),
      );
      let accepted = 0;
      const drop = new Set<string>();
      for (const rating of res.ratings) {
        const k = batch.find((x) => x.keyword === normalizeKeyword(rating.keyword));
        if (!k || k.status !== "candidate") continue;
        if (!rating.reason?.trim()) continue;
        k.metrics.R = rating.r;
        k.metrics.reason = `[прескрин] ${rating.reason.slice(0, 180)}`;
        accepted++;
        if (rating.r === 0) drop.add(k.keyword);
      }
      if (drop.size > 0) {
        this.state.keywords = this.state.keywords.filter((k) => !drop.has(k.keyword));
        this.state.rejected.push(...drop);
      }
      await this.save();
      if (accepted > 0) await this.event("🧹", `прескрин: ${accepted} оценено, ${drop.size} снесено (R=0)`);
      if (accepted === 0) {
        missRounds++;
        if (missRounds >= 2) {
          for (const k of batch) {
            if (k.status === "candidate" && k.metrics.R === null) {
              k.metrics.R = 1;
              k.metrics.reason = "[прескрин] оценка не получена — пропущен в probe";
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

  private async rateOneBatch(): Promise<number> {
    const system = renderPrompt("rate", { SEMANTIC_LANGUAGE: this.config.semanticLanguage });
    const batch = this.state.keywords.filter((k) => k.status === "verified").slice(0, 25);
    if (batch.length === 0) return 0;
    this.checkPause();
    const items = batch.map((k) => ({
      keyword: k.keyword,
      P: k.degraded ? null : k.metrics.P,
      D: k.metrics.D,
      top3: k.metrics.topApps.slice(0, 3).map((a) => a.trackName),
    }));
    const res = await this.llm<{ ratings: { keyword: string; r: number; reason: string }[] }>(
      "rate", system, `Оцени пакет кейвордов:\n${JSON.stringify(items, null, 2)}`, this.contextBlock(),
    );
    let ratedCount = 0;
    for (const rating of res.ratings) {
      const k = batch.find((x) => x.keyword === normalizeKeyword(rating.keyword));
      if (!k || k.status !== "verified") continue;
      if (!rating.reason?.trim()) continue;
      if (rating.r >= 1) {
        // Кэп перебора (D4 v4): не набираем сверх sampleSize×(1+OVERSHOOT_PCT).
        if (this.atOvershootCap()) break;
        // РЕАЛЬНОЕ списание проверенной кейфразы (D4 v4). Не хватило → hard-stop (paused, резюмируемо).
        const charge = await this.deps.chargeKeyphrase(k.keyword);
        if (!charge.ok) throw new InsufficientCredits(charge.price, charge.balance);
      }
      k.metrics.R = rating.r;
      k.metrics.reason = rating.reason.slice(0, 200);
      k.status = rating.r === 0 ? "excluded" : "rated";
      this.recomputeScore(k);
      ratedCount++;
      await this.event("★", `${k.keyword} → R=${rating.r}, Score=${k.metrics.score ?? 0}`);
    }
    await this.save();
    return ratedCount;
  }

  private async rateAll() {
    let missRounds = 0;
    while (this.state.keywords.some((k) => k.status === "verified")) {
      this.checkPause();
      const batch = this.state.keywords.filter((k) => k.status === "verified").slice(0, 25);
      const ratedCount = await this.rateOneBatch();
      if (ratedCount === 0) {
        missRounds++;
        if (missRounds >= 3) {
          for (const k of batch) { k.status = "error"; k.error = "LLM не вернул оценку R"; }
          await this.save();
          missRounds = 0;
        }
      } else {
        missRounds = 0;
      }
    }
  }

  // ---------- расширение suggest-графа (runWave → job-emit) ----------

  private async expansionWave(): Promise<number> {
    if (this.state.hintsEndpointDown) return 0;
    if (this.atOvershootCap()) return 0; // кэп перебора (D4 v4): не заводим новые ветки
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

    // ЭМИТ HintsJob на каждую задачу; «break on throttle» = серверный back-pressure.
    const results: { task: ExpansionTask; terms: string[] | null; permanentError?: boolean }[] = [];
    for (const task of tasks) {
      if (this.pauseRequested) break;
      try {
        const terms = await this.deps.gateway.hints(task.term, this.storefront);
        results.push({ task, terms });
      } catch (e: any) {
        if (e instanceof ReplayFrontier) throw e;
        if (e instanceof JobError && e.throttle) break; // back-pressure: остаток на след. волну
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
      await this.event("🕸", `расширение suggest-графа: ${result.requestsSpent} запросов → +${added} кандидатов`);
    }
    await this.save();
    return added;
  }

  private async hypothesize() {
    if (this.atOvershootCap()) return; // кэп перебора (D4 v4): не набираем сверх +10%
    await this.expansionWave();

    let top = this.top20().filter((k) => (k.metrics.R ?? 0) >= 2);
    if (top.length === 0) top = this.top20();
    const worst = this.state.keywords
      .filter((k) => k.status === "rated" || k.status === "excluded")
      .sort((a, b) => (a.metrics.score ?? 0) - (b.metrics.score ?? 0))
      .slice(0, 10);

    // «Дети» лидеров — через HintsJob (не inline fetch).
    const children: Record<string, string[]> = {};
    if (!this.state.hintsEndpointDown) {
      for (const k of top.slice(0, 10)) {
        if ((k.metrics.childCount ?? 0) > 0) {
          try {
            const terms = await this.deps.gateway.hints(k.keyword + " ", this.storefront);
            children[k.keyword] = terms.filter((t) => normalizeKeyword(t).startsWith(k.keyword + " ")).slice(0, 10);
          } catch (e) { if (e instanceof ReplayFrontier) throw e; /* иначе не критично */ }
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
      `Лидеры для развития (только R≥2): ${JSON.stringify(top.map((k) => ({ keyword: k.keyword, score: k.metrics.score, P: k.metrics.P, D: k.metrics.D, R: k.metrics.R, childCount: k.metrics.childCount })))}`,
      `Худшие (антипримеры): ${JSON.stringify(worst.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0, R: k.metrics.R, reason: k.metrics.reason })))}`,
      `Отклонено прескрином: ${JSON.stringify(this.state.rejected.slice(-30))}`,
      `Уже раскрытые краулером направления: ${JSON.stringify(expandedRoots.slice(-60))}`,
      `Направления в очереди краулера: ${JSON.stringify(queuedRoots)}`,
      `«Дети» лидеров: ${JSON.stringify(children)}`,
      `Заголовки слабых конкурентов: ${JSON.stringify([...weakTitles].slice(0, 25))}`,
      `ВСЕ известные кейворды: ${JSON.stringify(known)}`,
    ].join("\n\n");

    await this.event("🧠", "hypothesize: направления для графа + короткие гипотезы");
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
    await this.event("🧠", `hypothesize: +${newRoots} направлений, +${added} гипотез`);
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
      if (added > 0) await this.event("🔦", `подсказки при probe «${sourceKeyword}»: +${added} (suggest)`);
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

  // ---------- сборка (spec 05) ----------

  private async phaseAssembling() {
    this.mustContext();
    await this.event("🧩", "собираю метаданные: фразы ядра — в title/subtitle, слова — в keywords");
    const brandWords = wordsOf(this.config.brand);
    const lang = this.config.semanticLanguage;
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));

    const universe = this.state.keywords.filter((k) => (k.metrics.R ?? 0) >= 1 && (k.metrics.score ?? 0) > 0);
    const phrases = universe.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0 }));
    const scoreTotal = phrases.reduce((s, p) => s + p.score, 0);

    const budgets = {
      titleSloganMax: this.config.limits.title - this.config.brand.length - 3,
      subtitleMax: this.config.limits.subtitle,
      keywordsMax: this.config.limits.keywords,
    };

    const primaryLocale = `${lang}-${this.config.country.toUpperCase()}`;
    const bucket1 = await this.buildBucket(universe, budgets, primaryLocale, new Set());

    const buckets: AssemblyBucket[] = [bucket1];
    const keys1 = bucketFoldKeys(
      { title: bucket1.title ?? "", subtitle: bucket1.subtitle ?? "", keywords: bucket1.keywordFieldDraft, titleWords: [], subtitleWords: [] },
      this.config.brand, lang,
    );
    for (const bw of brandWords) keys1.add(foldKey(bw, lang));

    const extra = extraLocaleFor(this.config.country);
    if (this.config.extraLocale) {
      if (!extra) {
        await this.event("ℹ️", `для ${this.config.country} доп. локаль неизвестна — проход 2 пропущен`);
      } else {
        const universe2 = universe.filter((k) => {
          const keys = phraseKeys(k.keyword, stopSet, lang);
          return !keys.every((x) => keys1.has(x));
        });
        if (universe2.length === 0) {
          await this.event("ℹ️", "всё покрыто первой корзиной — проход 2 пропущен");
        } else {
          const bucket2 = await this.buildBucket(universe2, budgets, extra, keys1);
          buckets.push(bucket2);
        }
      }
    }

    const allKeys = new Set<string>(keys1);
    if (buckets[1]) {
      for (const k of bucketFoldKeys(
        { title: buckets[1].title ?? "", subtitle: buckets[1].subtitle ?? "", keywords: buckets[1].keywordFieldDraft, titleWords: [], subtitleWords: [] },
        this.config.brand, lang,
      )) allKeys.add(k);
    }
    const brandKeys = new Set(brandWords.map((w) => foldKey(w, lang)));

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
    await this.event("✅", `сборка готова: покрыто ${phrasesCovered} фраз, ${Math.round(this.state.assembly.coverage.coveredShare * 100)}% Score`);
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

  private async buildBucket(
    universe: KeywordEntry[],
    budgets: { titleSloganMax: number; subtitleMax: number; keywordsMax: number },
    locale: string,
    otherBucketKeys: Set<string>,
  ): Promise<AssemblyBucket> {
    const lang = this.config.semanticLanguage;
    const stopSet = new Set(this.config.stopwords.map((s) => s.toLowerCase()));
    const brandKeys = new Set(wordsOf(this.config.brand).map((w) => foldKey(w, lang)));
    const sig = (text: string) => wordsOf(text).filter((w) => !stopSet.has(w));
    const keysOf = (text: string) => sig(text).map((w) => foldKey(w, lang));
    const scoreOf = new Map(universe.map((k) => [k.keyword, k.metrics.score ?? 0]));

    const disjoint = (kw: string, taken: Set<string>) => keysOf(kw).every((x) => !taken.has(x) && !brandKeys.has(x));
    const rPool = (minR: number) =>
      universe
        .filter((k) => (k.metrics.R ?? 0) >= minR)
        .sort((a, b) => compareKeywords(
          { score: a.metrics.score ?? 0, P: a.metrics.P ?? 0, D: a.metrics.D ?? 0, keyword: a.keyword },
          { score: b.metrics.score ?? 0, P: b.metrics.P ?? 0, D: b.metrics.D ?? 0, keyword: b.keyword },
        ))
        .map((k) => k.keyword);
    const corePool = rPool(3);
    const pool = corePool.length > 0 ? corePool : rPool(2);

    const titleCands = pool.filter((kw) => kw.length <= budgets.titleSloganMax && disjoint(kw, otherBucketKeys)).slice(0, 5);
    const subPool = pool.filter((kw) => kw.length <= budgets.subtitleMax && disjoint(kw, otherBucketKeys)).slice(0, 10);

    const tc = (t: string) => t.split(" ").map((w) => (stopSet.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
    const fbTitle = titleCands[0] ?? "";
    const fbTitleKeys = new Set(keysOf(fbTitle));
    const fbCombo = this.bestSubtitleCombo(subPool.filter((kw) => disjoint(kw, fbTitleKeys)), scoreOf, budgets.subtitleMax, keysOf);

    const doValidate = (t: string, s: string, tw: string[], sw: string[], kwDraft: string) =>
      validate({
        bucket: { title: t, subtitle: s, keywords: kwDraft, titleWords: tw, subtitleWords: sw },
        brand: this.config.brand, language: lang, stopwords: this.config.stopwords,
        competitors: this.mustContext().competitors, limits: this.config.limits, otherBucketKeys,
      });

    const checkLlm = (slog: string, sub: string) => {
      const errors: string[] = [];
      const slogLower = slog.toLowerCase();
      const chosenTitle = titleCands.find((c) => slogLower.includes(c)) ?? "";
      if (!chosenTitle) errors.push("слоган не содержит целиком ни одну фразу-кандидат");
      else {
        const allowed = new Set(keysOf(chosenTitle));
        for (const w of sig(slog)) if (!allowed.has(foldKey(w, lang))) errors.push(`лишнее слово в слогане: "${w}"`);
      }
      const subLower = sub.toLowerCase();
      const found = subPool.filter((c) => subLower.includes(c));
      const usedSub = found.filter((c) => !found.some((o) => o !== c && o.includes(c)));
      if (usedSub.length === 0) errors.push("subtitle не содержит целиком ни одну фразу из пула");
      const allowedSub = new Set(usedSub.flatMap((c) => keysOf(c)));
      for (const w of sig(sub)) if (!allowedSub.has(foldKey(w, lang))) errors.push(`лишнее слово в subtitle: "${w}"`);
      return { errors, chosenTitle, usedSub };
    };

    const system = renderPrompt("phrase", {
      BRAND: this.config.brand, LOCALE: locale,
      TITLE_BUDGET: budgets.titleSloganMax, SUBTITLE_BUDGET: budgets.subtitleMax,
    });

    let title: string | null = null;
    let subtitle: string | null = null;
    let titleWords: string[] = [];
    let subtitleWords: string[] = [];
    let ok = false;
    const MAX_PHRASE_ATTEMPTS = 3;

    if (titleCands.length > 0) {
      let note = "";
      for (let attempt = 1; attempt <= MAX_PHRASE_ATTEMPTS && !ok; attempt++) {
        this.checkPause();
        const prompt =
          `Кандидаты для title-слогана — реальные топ-запросы; выбери ОДИН:\n${JSON.stringify(titleCands.map((c) => ({ phrase: c, score: scoreOf.get(c) })))}\n\n` +
          `Пул фраз для subtitle — 1–3 фразы ЦЕЛИКОМ:\n${JSON.stringify(subPool.map((c) => ({ phrase: c, score: scoreOf.get(c) })))}\n\n` +
          `Локаль: ${locale}. Бюджеты: слоган ≤ ${budgets.titleSloganMax}, subtitle ≤ ${budgets.subtitleMax}.` +
          (note ? `\n\nПредыдущая попытка отклонена:\n${note}\nИсправь.` : "");
        const res = await this.llm<{ titleSlogan: string; subtitle: string }>("phrase", system, prompt, this.contextBlock());
        const slog = res.titleSlogan.trim();
        const sub = res.subtitle.trim();
        const check = checkLlm(slog, sub);
        const t = `${this.config.brand} - ${slog}`;
        const structuralErrors = check.errors.length === 0
          ? doValidate(t, sub, sig(check.chosenTitle), check.usedSub.flatMap((c) => sig(c)), "")
              .filter((v) => v.level === "error" && v.code !== "W1").map((v) => `${v.code}: ${v.message}`)
          : [];
        const allErrors = [...check.errors, ...structuralErrors];
        if (allErrors.length === 0) {
          title = t; subtitle = sub;
          titleWords = sig(check.chosenTitle);
          subtitleWords = check.usedSub.flatMap((c) => sig(c));
          ok = true;
        } else {
          note = allErrors.join("\n");
          await this.event("♻️", `phrase (${locale}) попытка ${attempt}/${MAX_PHRASE_ATTEMPTS}: отклонено — ${allErrors.join("; ")}`);
        }
      }
    }

    if (!ok) {
      title = `${this.config.brand} - ${tc(fbTitle)}`;
      subtitle = fbCombo.map(tc).join(" & ");
      titleWords = sig(fbTitle);
      subtitleWords = fbCombo.flatMap((c) => sig(c));
      if (titleCands.length > 0) await this.event("🛟", `phrase (${locale}): детерминированный вариант — «${title}» / «${subtitle}»`);
    }

    const usedKeys = new Set<string>([...keysOf(title ?? ""), ...keysOf(subtitle ?? ""), ...otherBucketKeys, ...brandKeys]);
    const rWeight = (r: number | null) => ((r ?? 0) >= 3 ? 1 : (r ?? 0) === 2 ? 0.35 : 0.1);
    const selPhrases = universe.map((k) => ({
      keyword: k.keyword,
      score: Math.max(1, Math.round((k.metrics.score ?? 0) * rWeight(k.metrics.R))),
    }));
    const mustCover = pool.filter((kw) => !phraseKeys(kw, stopSet, lang).every((x) => usedKeys.has(x))).slice(0, 5);
    const kwSel = selectWords({
      phrases: selPhrases, stopwords: this.config.stopwords, brandWords: wordsOf(this.config.brand),
      language: lang, budgetTotal: budgets.keywordsMax, excludedFoldKeys: usedKeys, mustCover,
    });
    const kwWords = [...kwSel.words];
    while (kwWords.length && kwWords.reduce((s, w) => s + w.length, 0) + kwWords.length - 1 > budgets.keywordsMax) kwWords.pop();
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

    const violations = doValidate(title ?? "", subtitle ?? "", titleWords, subtitleWords, keywordFieldDraft);
    const finalErrors = violations.filter((v) => v.level === "error");
    if (finalErrors.length > 0) {
      throw new Error(`Сборка корзины ${locale} не прошла валидацию: ${finalErrors.map((v) => `${v.code}: ${v.message}`).join("; ")}`);
    }

    return { locale, titleWords, subtitleWords, keywordFieldDraft, title, subtitle, budgets, speculativeWords, violations };
  }

  private bestSubtitleCombo(pool: string[], scoreOf: Map<string, number>, budget: number, keysOf: (t: string) => string[]): string[] {
    const items = pool.slice(0, 10);
    let best: string[] = [];
    let bestScore = -1;
    const joinedLen = (combo: string[]) => combo.reduce((s, c) => s + c.length, 0) + 3 * Math.max(0, combo.length - 1);
    const rec = (start: number, combo: string[], keys: Set<string>) => {
      if (combo.length > 0) {
        const s = combo.reduce((acc, c) => acc + (scoreOf.get(c) ?? 0), 0);
        if (s > bestScore || (s === bestScore && combo.length < best.length)) { best = [...combo]; bestScore = s; }
      }
      if (combo.length >= 3) return;
      for (let i = start; i < items.length; i++) {
        const ks = keysOf(items[i]);
        if (ks.some((k) => keys.has(k))) continue;
        if (joinedLen([...combo, items[i]]) > budget) continue;
        rec(i + 1, [...combo, items[i]], new Set([...keys, ...ks]));
      }
    };
    rec(0, [], new Set());
    return best;
  }

  // ---------- утилиты ----------

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
    if (!this.state.context) throw new Error("Контекст не извлечён");
    return this.state.context;
  }

  private contextBlock(): string {
    return `Бизнес-контекст приложения:\n${JSON.stringify(this.mustContext(), null, 2)}`;
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
        // Предохранитель маржи (D4 v4): реальный COGS не должен вылезать за оценочный потолок.
        if (!this.replaying && this.state.usage.costUsd !== null && this.state.usage.costUsd > this.state.estimateCredits) {
          throw new CogsExceededCeiling(this.state.usage.costUsd, this.state.estimateCredits);
        }
        return res.data;
      } catch (e: any) {
        if (e instanceof ReplayFrontier || e instanceof InsufficientCredits || e instanceof CogsExceededCeiling) throw e;
        if (e instanceof LlmAuthError || e instanceof PauseInterrupt) throw e;
        if (e?.name === "ClientGoneError") throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        await this.event("⚠️", `LLM ${task} не удался (${lastError.message}) — попытка ${attempt + 1}/3`);
        await new Promise((r) => setTimeout(r, [2000, 8000, 20000][attempt]));
      }
    }
    throw lastError ?? new Error("LLM-вызов не удался");
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
    if (this.replaying) return; // реплей не дублирует прогресс-ленту/SSE
    await this.deps.emitEvent(this.state.runId, kind, text);
  }

  private async save() {
    if (this.replaying) return; // реплей не пишет проекцию (реконструкция в памяти)
    this.state.updatedAt = new Date().toISOString();
    await this.deps.persist(this.state);
  }

  // ---------- event-replay (D7): реконструкция из durable-логов ----------

  /**
   * Реконструировать состояние РЕ-ПРОГОНОМ пайплайна с подачей side-effects из логов:
   * LLM — из llm_steps (proxy.replay), Apple — из apple_cache (gateway.setReplay). Первый
   * лог-промах = ReplayFrontier → останов на границе resumable. Списания идемпотентны
   * (уже в ledger), поэтому реплей их не двоит.
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
        // Достигнута граница durable-истории — состояние реконструировано до этой точки (resumable).
      } else if (e instanceof InsufficientCredits) {
        this.state.paused = true;
        this.state.notice = "Кредиты кончились. Пополните — продолжим с этого места.";
      } else if (e instanceof CogsExceededCeiling) {
        this.state.paused = true;
      } else if (e instanceof LlmAuthError || e instanceof PauseInterrupt || e?.name === "ClientGoneError" || e instanceof JobError) {
        this.state.paused = true;
      } else {
        throw e; // неожиданная — getOrchestrator откатится на снапшот-fallback
      }
    } finally {
      this.replaying = false;
      this.deps.gateway.setReplay(false);
      this.running = false;
      this.pauseRequested = false;
    }
  }
}
