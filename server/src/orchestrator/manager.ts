// @aso/server/orchestrator — run manager: wires Store + billing + llm-proxy +
// apple-dispatch + hub into one Orchestrator per run. Owns the event bus (run.progress →
// WSS client + browser SSE relay).
//
// D4 v4: NO upfront reserve and no end-of-run settle. startRun only checks that the balance covers
// at least one keyphrase (does not hold it). Debiting happens in real time in the orchestrator
// (deps.chargeKeyphrase). D7: cold resume reconstructs state via event replay from the logs.

import { randomUUID } from "node:crypto";
import type {
  RunConfig, RunState, ProgressEvent, RunAction, RunSummary, LlmLogPublic,
  RunSnapshot, KeywordPage, LlmLogPage, KeywordEntry,
  KeywordsLiteView, CompetitorsView, ExportFormat, ExportArtifact,
  ProjectOp, ProjectCard, ProjectView, ProjectBankPage, ProjectPositionsView, MetadataLocaleFields,
} from "@aso/shared";
import { toLite, aggregateCompetitors, buildExport } from "./insights.ts";
import { sampleCount, normalizeKeyword, STOREFRONTS } from "@aso/shared";
import type { Store, RunRow, ProjectRow, ProjectPositionRow } from "../db/index.ts";
import { BillingService } from "../billing/service.ts";
import { quoteFor, runFees, positionsFee } from "../billing/prices.ts";
import type { LlmClient } from "../llm-proxy/client.ts";
import { LlmProxy } from "../llm-proxy/proxy.ts";
import { ClientHub, ClientGoneError } from "../apple-dispatch/hub.ts";
import { AppleGateway } from "../apple-dispatch/gateway.ts";
import { LoopbackJobChannel, WssJobChannel, type JobChannel } from "../apple-dispatch/channel.ts";
import { Orchestrator } from "./orchestrator.ts";
import { initialState, projectRunState, type ServerRunState } from "./state.ts";
import { serpLangFor } from "../core/locales.ts";
import {
  parseAppStoreId, buildProjectCard, buildProjectView, bankPage, positionsView, exportProject,
  trackedPhrases, proposalLocales, mergeLocales, lastRunModel, runSlug,
} from "./projects.ts";
import { log } from "../log.ts";

export type ProgressListener = (runId: string, seq: number, event: ProgressEvent) => void;

export class RunManager {
  private proxy: LlmProxy;
  private orchestrators = new Map<string, Orchestrator>();
  private runUsers = new Map<string, string>();
  private listeners = new Set<ProgressListener>();

  constructor(
    private store: Store,
    private billing: BillingService,
    private client: LlmClient,
    private hub: ClientHub,
    private opts: { allowLoopback: boolean },
  ) {
    this.proxy = new LlmProxy(store, client, (runId) => this.assertLiveClient(runId));
  }

  onProgress(l: ProgressListener) { this.listeners.add(l); return () => this.listeners.delete(l); }

  /** Snapshot of in-memory orchestrators (admin Live screen). */
  activeOrchestrators(): Array<{ runId: string; userId: string; phase: string; paused: boolean; sampleCount: number }> {
    return [...this.orchestrators.values()].map((o) => ({
      runId: o.state.runId, userId: o.state.userId, phase: o.state.phase,
      paused: o.state.paused, sampleCount: sampleCount(o.state.keywords),
    }));
  }
  userOf(runId: string): string | undefined { return this.runUsers.get(runId); }

  /** AUTHORITATIVE ownership: in-memory map first, else the store row (cold runs after a
   *  restart). Every run-scoped read/write MUST gate on this, never on the fail-open
   *  `userOf() === undefined` pattern — that hole let any authenticated user read cold runs. */
  async ownerOf(runId: string): Promise<string | undefined> {
    const cached = this.runUsers.get(runId);
    if (cached) return cached;
    const row = await this.store.getRun(runId);
    if (row) this.runUsers.set(runId, row.user_id);
    return row?.user_id;
  }

  /** Live client-connection gate (D7): a real client exists → ok; otherwise DEV loopback only. */
  private assertLiveClient(runId: string) {
    const userId = this.runUsers.get(runId);
    if (userId && this.hub.hasClient(userId)) return;
    if (this.opts.allowLoopback) return; // DEV: no real client, but loopback executes jobs
    throw new ClientGoneError();
  }

  private channelFor(userId: string): JobChannel {
    if (this.hub.hasClient(userId)) return new WssJobChannel(this.hub, userId);
    if (this.opts.allowLoopback) return new LoopbackJobChannel();
    return new WssJobChannel(this.hub, userId); // no client and no loopback → dispatch will be rejected (ClientGone)
  }

  private async emitEvent(runId: string, kind: string, text: string) {
    const event: ProgressEvent = { ts: new Date().toISOString(), kind, text };
    const seq = await this.store.appendRunEvent(runId, event);
    const userId = this.runUsers.get(runId);
    if (userId) this.hub.broadcast(userId, { t: "run.progress", run_id: runId, seq, event });
    for (const l of this.listeners) l(runId, seq, event);
  }

  private async persist(s: ServerRunState) {
    await this.store.updateRun({
      id: s.runId, phase: s.phase, context: s.context, final: s.assembly, usage: s.usage, state: s,
    });
    // run.phase → to the client (sample counters).
    this.hub.broadcast(s.userId, {
      t: "run.phase", run_id: s.runId, phase: s.phase,
      counters: { sampleCount: sampleCount(s.keywords), sampleSize: s.config.sampleSize, requestsMade: s.http?.requestsMade ?? 0, cacheHits: s.http?.cacheHits ?? 0, calls: s.usage.calls },
    });
  }

  private async broadcastBalance(userId: string, credits?: number) {
    const c = credits ?? (await this.billing.balance(userId));
    this.hub.broadcast(userId, { t: "balance", credits: c });
  }

  private broadcastPaused(runId: string, reason: string, code?: "credits_out" | "provider_error" | "client_offline" | "user") {
    const userId = this.runUsers.get(runId);
    if (userId) this.hub.broadcast(userId, { t: "run.paused", run_id: runId, reason, ...(code ? { code } : {}) });
  }

  /** REAL work-unit debit (D4 v5) + live balance push to the client. `key` is the ledger
   *  idempotency key within the run (keyword or synthetic stage key), `amount` in credits. */
  private async charge(userId: string, runId: string, key: string, amount: number) {
    const price = Math.round(amount * 10_000) / 10_000;
    const r = await this.billing.chargeKeyphrase(userId, runId, key, price);
    await this.broadcastBalance(userId, r.balance);
    return { ok: r.charged || r.alreadyCharged, balance: r.balance, price };
  }

  private buildOrchestrator(s: ServerRunState): Orchestrator {
    const channel = this.channelFor(s.userId);
    const gateway = new AppleGateway(this.store, channel, s.runId, s.config.country);
    return new Orchestrator(s, {
      gateway,
      proxy: this.proxy,
      persist: (st) => this.persist(st),
      emitEvent: (rid, k, t) => this.emitEvent(rid, k, t),
      charge: (key, amount) => this.charge(s.userId, s.runId, key, amount),
      onPaused: (reason, code) => this.broadcastPaused(s.runId, reason, code),
      onDone: (st) => this.finishRun(st),
    });
  }

  /** Run completion (D4 v4: no settle — usage-based, everything debited in real time). */
  private async finishRun(s: ServerRunState) {
    await this.broadcastBalance(s.userId);
    const charged = await this.store.sumDebitsForRun(s.runId);
    await this.emitEvent(s.runId, "💰", `run finished: ${charged.toFixed(2)} cr debited for ${sampleCount(s.keywords)} keyphrases`);
    await this.projectAfterRun(s);
  }

  /** spec 10 §2: on completion, upsert every MEASURED keyword (metrics.D ≠ null, any status)
   *  into the project bank and surface the apply proposal. Must never fail the run. */
  private async projectAfterRun(s: ServerRunState) {
    try {
      if (!s.projectId) return;
      const project = await this.store.getProject(s.projectId);
      if (!project) return; // project deleted mid-run — the run stays orphaned
      const ts = new Date().toISOString();
      const measured = s.keywords.filter((k) => k.metrics.D != null);
      if (measured.length) {
        await this.store.upsertProjectKeywords(s.projectId, s.config.country, s.config.semanticLanguage,
          measured.map((k) => ({
            keyword: k.keyword,
            metrics: {
              P: k.metrics.P, D: k.metrics.D, R: k.metrics.R, score: k.metrics.score,
              status: k.status, reason: k.metrics.reason, runId: s.runId, ts,
            },
          })));
      }
      if (s.assembly) {
        await this.emitEvent(s.runId, "📦", "metadata proposal ready — review & save on the project page");
      }
    } catch (e: any) {
      log.warn("[projects] post-run bank upsert failed", { runId: s.runId, err: String(e?.message ?? e) });
    }
  }

  // ---------- public API ----------

  /** spec 10 §2: runs REQUIRE a project. Foreign/missing project → fail-closed "project not
   *  found" (does not leak existence). A set project context seeds the run and skips extraction. */
  async createRun(userId: string, brief: string, config: RunConfig, projectId: string): Promise<string> {
    const project = projectId ? await this.store.getProject(projectId) : null;
    if (!project || project.user_id !== userId) throw new Error("project not found");
    const runId = `run_${randomUUID()}`;
    this.runUsers.set(runId, userId);
    const estimate = quoteFor(config.sampleSize, config.model);
    const state = initialState(runId, userId, brief, config, estimate);
    state.projectId = projectId;
    if (project.context) {
      state.context = { ...project.context, targetLanguage: config.semanticLanguage };
      state.contextSeeded = true;
    }
    await this.store.createRun({
      id: runId, user_id: userId, project_id: projectId, phase: "created", config, brief,
      estimate_credits: estimate, context: state.context, final: null, usage: state.usage, state,
    });
    const orch = this.buildOrchestrator(state);
    this.orchestrators.set(runId, orch);
    return runId;
  }

  /** Gate shared by every transition into active work (start/resume/confirmContext):
   *  the balance must cover at least 1 keyphrase (NOT a reserve, D4 v4). Insufficient →
   *  the run is (kept) paused with a credits_out notice, and the caller must not proceed. */
  private async creditsCoverWork(runId: string, orch: Orchestrator): Promise<boolean> {
    const userId = this.runUsers.get(runId)!;
    // D4 v5: the gate only requires the balance to cover the next sliver of work.
    const price = Math.max(0.05, runFees(orch.state.config.model).inclusionBase);
    const balance = await this.billing.balance(userId);
    if (balance >= price) return true;
    const verb = orch.state.phase === "created" ? "start" : "continue";
    orch.state.paused = true;
    orch.state.notice = `Not enough credits to ${verb} (balance is ${balance.toFixed(2)}). Top up your balance.`;
    await this.persist(orch.state);
    await this.emitEvent(runId, "💳", orch.state.notice);
    this.hub.broadcast(userId, { t: "run.paused", run_id: runId, reason: orch.state.notice, code: "credits_out" });
    return false;
  }

  /** Start: gated on credits; insufficient → paused. */
  async startRun(runId: string): Promise<void> {
    const orch = await this.getOrchestrator(runId);
    if (!(await this.creditsCoverWork(runId, orch))) return;
    await orch.start();
  }

  /** Get the orchestrator: in memory — as is; cold — reconstruction via event replay from the logs (D7). */
  async getOrchestrator(runId: string): Promise<Orchestrator> {
    const existing = this.orchestrators.get(runId);
    if (existing) return existing;
    const row = await this.store.getRun(runId);
    if (!row) throw new Error(`run not found: ${runId}`);
    this.runUsers.set(runId, row.user_id);
    const state = initialState(runId, row.user_id, row.brief ?? "", row.config, Number(row.estimate_credits ?? 0));
    if (row.project_id) state.projectId = row.project_id;
    // A project-seeded run has NO llm_steps "context" entry — re-seed before replay so
    // phaseContext takes the same skip path it took live (deterministic reconstruction).
    const snap = row.state as ServerRunState | null;
    if (snap?.contextSeeded) {
      state.contextSeeded = true;
      state.context = row.context ?? snap.context ?? null;
    }
    const orch = this.buildOrchestrator(state);
    const hydrateFromSnapshot = () => {
      if (row.state) Object.assign(state, row.state, { runId, userId: row.user_id, config: row.config, brief: row.brief ?? "" });
    };
    try {
      await orch.replayFromLogs(row.phase as ServerRunState["phase"]);
      // replayFromLogs swallows ReplayFrontier and lands state at wherever the durable history
      // ends. If that is EARLIER than the persisted phase, replay could not re-derive a run that
      // is durably recorded — almost always because the pipeline changed since it ran (new/renamed
      // LLM steps ⇒ a frontier at the first divergence). The snapshot is authoritative then; trust
      // it. For a genuinely in-flight run replay reaches row.phase exactly, so this never fires.
      if (state.phase !== (row.phase as ServerRunState["phase"]) && row.state) {
        log.warn("[replay] did not reach the persisted phase — using the snapshot (pipeline drift?)", { runId, replayed: state.phase, persisted: row.phase });
        hydrateFromSnapshot();
      }
    } catch (e: any) {
      // Unexpected replay failure — safety net: hydrate internal fields from the snapshot projection.
      log.warn("[replay] reconstruction from logs failed — falling back to the snapshot projection", { runId, err: String(e?.message ?? e) });
      hydrateFromSnapshot();
    }
    this.orchestrators.set(runId, orch);
    return orch;
  }

  /** Client-session Apple HTTP stats (job.result.http): fold the cumulative snapshot into every
   *  live orchestrator of the user. Monotonic max per field — snapshots are cumulative and jobs
   *  may arrive out of order; a client restart (snapshot reset) then never regresses the numbers.
   *  Note: with several concurrent runs the session totals show on each — acceptable for v1. */
  noteClientHttp(userId: string, http: { requestsMade: number; cacheHits: number; throttleWaitMs: number }): void {
    for (const orch of this.orchestrators.values()) {
      if (orch.state.userId !== userId) continue;
      const h = orch.state.http;
      h.requestsMade = Math.max(h.requestsMade, http.requestsMade);
      h.cacheHits = Math.max(h.cacheHits, http.cacheHits);
      h.throttleWaitMs = Math.max(h.throttleWaitMs, http.throttleWaitMs);
    }
  }

  async control(runId: string, action: RunAction): Promise<void> {
    const orch = await this.getOrchestrator(runId);
    switch (action.type) {
      case "pause": orch.requestPause(); break;
      // resume/confirmContext transition into active (LLM/Apple) work — same credit gate as start,
      // otherwise a zero-balance user resumes straight past the paywall and burns provider tokens.
      case "resume": if (await this.creditsCoverWork(runId, orch)) void orch.resume(); break;
      case "stopAndAssemble": orch.requestStopAndAssemble(); break;
      case "reassemble": void orch.reassemble(); break;
      case "confirmContext":
        if (await this.creditsCoverWork(runId, orch)) {
          await this.saveContextToProject(orch.state); // spec 10 §2: first confirm seeds the project
          void orch.confirmContext();
        }
        break;
      case "editContext": orch.editContext(action.patch as any); break;
      case "exclude": orch.excludeKeyword(action.keyword); break;
      case "delete": await this.deleteRun(runId); break;
      default: throw new Error(`unknown action: ${(action as any).type}`);
    }
  }

  private async deleteRun(runId: string): Promise<void> {
    // D4 v4: deletion refunds nothing to the wallet (debits are usage-based and already final).
    this.orchestrators.delete(runId);
    await this.store.updateRun({ id: runId, phase: "done" });
  }

  async getState(runId: string): Promise<RunState | null> {
    const orch = this.orchestrators.get(runId);
    if (orch) return projectRunState(orch.state);
    const row = await this.store.getRun(runId);
    if (!row || !row.state) return null;
    return projectRunState(row.state as ServerRunState);
  }

  private runSummary(row: RunRow): RunSummary {
    const s = row.state as ServerRunState | null;
    const kws = s?.keywords ?? [];
    const top = [...kws].filter((k) => (k.metrics.score ?? 0) > 0).sort((a, b) => (b.metrics.score ?? 0) - (a.metrics.score ?? 0)).slice(0, 3);
    return {
      runId: row.id, projectId: row.project_id ?? null, brand: row.config.brand, country: row.config.country,
      phase: row.phase as RunState["phase"], paused: s?.paused ?? false, failed: s?.failed ?? null,
      sampleCount: sampleCount(kws), sampleSize: row.config.sampleSize,
      updatedAt: row.updated_at ?? new Date().toISOString(),
      usage: { calls: row.usage?.calls ?? 0, totalTokens: (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0), costUsd: row.usage?.costUsd ?? null },
      topKeywords: top.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0 })),
    };
  }

  async listRuns(userId: string): Promise<RunSummary[]> {
    const rows = await this.store.listRunsByUser(userId);
    // spec 10 §2: runs of a DELETED project keep their rows but are hidden from lists.
    const projectIds = new Set((await this.store.listProjectsByUser(userId)).map((p) => p.id));
    return rows
      .filter((row) => !row.project_id || projectIds.has(row.project_id))
      .map((row) => this.runSummary(row));
  }

  async listEvents(runId: string, afterSeq = 0) {
    return this.store.listRunEvents(runId, afterSeq);
  }

  /** Credits actually debited for a run so far (spec 09 §3): run-scoped ledger aggregate
   *  (NOT a listLedger window — that under-reports old runs once the ledger grows).
   *  User-facing money — honest by design (unlike internal token COGS, which never leaves). */
  async creditsSpentFor(runId: string): Promise<number> {
    return Math.round((await this.store.sumDebitsForRun(runId)) * 100) / 100;
  }

  /** query kind="run": RunSnapshot (RunState + config + event feed + counters) for the initial load. */
  async runSnapshot(runId: string): Promise<RunSnapshot | null> {
    const state = await this.getState(runId);
    if (!state) return null;
    const row = await this.store.getRun(runId);
    if (!row) return null;
    const events = (await this.store.listRunEvents(runId, 0)).map((e) => e.event);
    const { keywords, ...stateNoKeywords } = state;
    return {
      state: stateNoKeywords,
      config: row.config,
      context: state.context,
      events,
      assembly: state.assembly,
      keywordCount: keywords.length,
      sampleCount: sampleCount(keywords),
      creditsSpent: await this.creditsSpentFor(runId),
    };
  }

  // ── spec 09: insights & exports (re-projections only — no Apple/LLM calls, no debits) ──

  /** query kind="keywords-lite": the whole keyword list as a light projection (charts/diff). */
  async keywordsLite(runId: string): Promise<KeywordsLiteView> {
    const state = await this.getState(runId);
    return toLite(state?.keywords ?? []);
  }

  /** query kind="competitors": SERP top-10 aggregation across the run (spec 09 §2). */
  async competitors(runId: string): Promise<CompetitorsView> {
    const state = await this.getState(runId);
    return aggregateCompetitors(state?.keywords ?? []);
  }

  /** query kind="export": build a downloadable artifact string (spec 09 §1/§6).
   *  pinned/notes are the user's LOCAL annotations, passed transiently for rendering only. */
  async exportArtifact(
    runId: string,
    format: ExportFormat,
    ann: { pinned?: string[]; notes?: Record<string, string> } = {},
  ): Promise<ExportArtifact | null> {
    const snapshot = await this.runSnapshot(runId);
    const state = await this.getState(runId);
    if (!snapshot || !state) return null;
    return buildExport(format, {
      config: snapshot.config,
      phase: state.phase,
      createdAt: state.createdAt,
      keywords: state.keywords,
      assembly: state.assembly,
      sampleCount: snapshot.sampleCount,
      pinned: ann.pinned,
      notes: ann.notes,
    }, snapshot);
  }

  /** query kind="keywords": SERVER-SIDE pagination/sort/filter (spec 07: don't load 500+ rows wholesale). */
  async keywordPage(runId: string, params: Record<string, unknown> = {}): Promise<KeywordPage> {
    const state = await this.getState(runId);
    let items: KeywordEntry[] = state?.keywords ? [...state.keywords] : [];
    const status = params.status ? String(params.status) : "";
    if (status) items = items.filter((k) => k.status === status);
    const source = params.source ? String(params.source) : "";
    if (source) items = items.filter((k) => k.source === source);
    // spec 09 §4: insight filter — the findings-strip cards land on a pre-filtered table.
    const insight = params.insight ? String(params.insight) : "";
    if (insight === "brandQuery") items = items.filter((k) => k.metrics.brandQuery === true);
    else if (insight === "unsuggested") items = items.filter((k) => k.metrics.unsuggested === true);
    else if (insight === "degraded") items = items.filter((k) => k.degraded === true);
    // spec 09 §7: keyword allowlist — the relay translates the local "pinned" filter into this;
    // the server knows nothing about pins themselves.
    if (Array.isArray(params.only)) {
      const only = new Set((params.only as unknown[]).map((s) => normalizeKeyword(String(s))));
      items = items.filter((k) => only.has(k.keyword));
    }
    const q = params.q ? normalizeKeyword(String(params.q)) : "";
    if (q) items = items.filter((k) => k.keyword.includes(q));

    const sort = String(params.sort ?? "score");
    const dir = String(params.dir ?? "desc") === "asc" ? 1 : -1;
    const val = (k: KeywordEntry): number | string => {
      switch (sort) {
        case "keyword": return k.keyword;
        case "P": return k.metrics.P ?? -1;
        case "D": return k.metrics.D ?? -1;
        case "R": return k.metrics.R ?? -1;
        case "addedAt": return k.addedAt;
        default: return k.metrics.score ?? -1;
      }
    };
    items.sort((a, b) => { const va = val(a), vb = val(b); return va < vb ? -dir : va > vb ? dir : 0; });

    const total = items.length;
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize ?? 50)));
    const page = Math.max(0, Number(params.page ?? 0));
    const start = page * pageSize;
    return { total, page, pageSize, items: items.slice(start, start + pageSize) };
  }

  /** query kind="keyword": a single entry by params.keyword (not the whole array). */
  async keywordItem(runId: string, keyword: string): Promise<{ item: KeywordEntry | null }> {
    const state = await this.getState(runId);
    const kw = normalizeKeyword(keyword);
    return { item: state?.keywords.find((k) => k.keyword === kw) ?? null };
  }

  /** query kind="llm-log": paginated D9 log (outputs+numbers only). */
  async llmLogPage(runId: string, params: Record<string, unknown> = {}): Promise<LlmLogPage> {
    const all = await this.llmLog(runId);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize ?? 100)));
    const page = Math.max(0, Number(params.page ?? 0));
    const start = page * pageSize;
    return { total: all.length, page, items: all.slice(start, start + pageSize) };
  }

  /** D9 LLM log: ONLY outputs+numbers (LlmLogPublic). Prompts are physically absent (not stored in llm_steps). */
  async llmLog(runId: string): Promise<LlmLogPublic[]> {
    const steps = await this.store.listLlmSteps(runId);
    return steps.map((s) => ({
      ts: s.ts ?? "",
      task: s.logical_step.split("#")[0],
      model: s.model ?? "",
      stage: s.logical_step,
      output: s.valid ? s.result_json : null,
      tokens: { input: s.usage.inputTokens, output: s.usage.outputTokens, cacheRead: s.usage.cacheReadTokens },
      costUsd: s.cost_usd,
      durationMs: s.duration_ms ?? 0,
      ...(s.valid ? {} : { error: "response failed schema validation (retried)" }),
    }));
  }

  /** Client returned a job result/error → route it to the awaiting dispatch. */
  resolveJob = (result: Parameters<ClientHub["resolveJob"]>[0]) => this.hub.resolveJob(result);
  rejectJob = (jobId: string, reason: string, throttle?: boolean) => this.hub.rejectJob(jobId, reason, throttle);

  // ══════════════════ Projects (spec 10) ══════════════════

  /** Owner gate: fail-closed "project not found" (never reveals a foreign project exists). */
  private async mustOwnProject(userId: string, projectId: string): Promise<ProjectRow> {
    const p = projectId ? await this.store.getProject(projectId) : null;
    if (!p || p.user_id !== userId) throw new Error("project not found");
    return p;
  }

  /** spec 10 §2: the FIRST confirmed context seeds the project — only while the project's is
   *  still null (Settings is the only place that mutates it afterwards; no clobber here). */
  private async saveContextToProject(s: ServerRunState) {
    try {
      if (!s.projectId || !s.context) return;
      const project = await this.store.getProject(s.projectId);
      if (!project || project.context) return;
      await this.store.updateProject({ id: s.projectId, context: s.context });
    } catch (e: any) {
      log.warn("[projects] context save failed", { runId: s.runId, err: String(e?.message ?? e) });
    }
  }

  /** query kind="projects" → ProjectCard[] (home grid; archived included — the UI toggles). */
  async projectCards(userId: string): Promise<ProjectCard[]> {
    const projects = await this.store.listProjectsByUser(userId);
    const cards: ProjectCard[] = [];
    for (const p of projects) {
      const [bankCount, runs] = await Promise.all([
        this.store.countProjectKeywords(p.id),
        this.store.listRunsByProject(p.id),
      ]);
      cards.push(buildProjectCard(p, bankCount, runs));
    }
    return cards.sort((a, b) => b.lastActivityTs.localeCompare(a.lastActivityTs));
  }

  /** query kind="project" → ProjectView (Overview: coverage, versions, suggestions, proposals). */
  async projectView(userId: string, projectId: string): Promise<ProjectView> {
    const p = await this.mustOwnProject(userId, projectId);
    const [runs, bank, positions, bankCount] = await Promise.all([
      this.store.listRunsByProject(p.id),
      this.store.listProjectKeywords(p.id),
      this.store.listProjectPositions(p.id),
      this.store.countProjectKeywords(p.id),
    ]);
    return buildProjectView({
      project: p, runs, bankCount, bank, positions,
      quote: quoteFor(150, lastRunModel(runs)),
      positionsFee: positionsFee(),
      context: p.context,
    });
  }

  /** query kind="project-bank" → paged/sorted/filtered bank rows. */
  async projectBank(userId: string, projectId: string, params: Record<string, unknown> = {}): Promise<ProjectBankPage> {
    const p = await this.mustOwnProject(userId, projectId);
    const rows = await this.store.listProjectKeywords(p.id);
    return bankPage(rows, params);
  }

  /** query kind="project-positions" → latest ranks + per-keyword history (last 10 checks). */
  async projectPositions(userId: string, projectId: string, storefront?: string): Promise<ProjectPositionsView> {
    const p = await this.mustOwnProject(userId, projectId);
    const [positions, bank] = await Promise.all([
      this.store.listProjectPositions(p.id),
      this.store.listProjectKeywords(p.id),
    ]);
    return positionsView({ project: p, positions, bank, storefront, fee: positionsFee() });
  }

  /** query kind="project-export" → current version + bank as csv/json. */
  async projectExport(userId: string, projectId: string, format: string): Promise<ExportArtifact> {
    const p = await this.mustOwnProject(userId, projectId);
    if (format !== "csv" && format !== "json") throw new Error(`unknown export format: ${format}`);
    const bank = await this.store.listProjectKeywords(p.id);
    return exportProject(p, bank, format);
  }

  async listRunsForProject(userId: string, projectId: string): Promise<RunSummary[]> {
    await this.mustOwnProject(userId, projectId);
    const rows = await this.store.listRunsByProject(projectId);
    return rows.map((row) => this.runSummary(row));
  }

  /** The single write path (spec 10 §5): validates + owner-gates every op. */
  async projectOp(userId: string, op: ProjectOp): Promise<unknown> {
    if (!op || typeof op !== "object" || typeof (op as any).kind !== "string") throw new Error("invalid project op");
    switch (op.kind) {
      case "create": {
        const name = String(op.name ?? "").trim();
        const brand = String(op.brand ?? "").trim();
        if (!name) throw new Error("name is required");
        if (!brand) throw new Error("brand is required");
        const appStoreId = op.appStoreUrl?.trim() ? parseAppStoreId(op.appStoreUrl) : null;
        const id = `proj_${randomUUID()}`;
        await this.store.createProject({
          id, user_id: userId, name, brand, app_store_id: appStoreId,
          context: null, versions: [], live_version: null, archived: false,
        });
        return { projectId: id };
      }
      case "update": {
        const p = await this.mustOwnProject(userId, op.projectId);
        const patch: Partial<ProjectRow> & { id: string } = { id: p.id };
        if (op.name !== undefined) {
          const name = String(op.name).trim();
          if (!name) throw new Error("name cannot be empty");
          patch.name = name;
        }
        if (op.brand !== undefined) {
          const brand = String(op.brand).trim();
          if (!brand) throw new Error("brand cannot be empty");
          patch.brand = brand;
        }
        if (op.appStoreUrl !== undefined) {
          patch.app_store_id = op.appStoreUrl === null || !String(op.appStoreUrl).trim()
            ? null : parseAppStoreId(String(op.appStoreUrl));
        }
        await this.store.updateProject(patch);
        return { ok: true };
      }
      case "updateContext": {
        const p = await this.mustOwnProject(userId, op.projectId);
        const c = op.context;
        if (!c || typeof c !== "object" || typeof c.productSummary !== "string") throw new Error("invalid context");
        await this.store.updateProject({
          id: p.id,
          context: {
            productSummary: String(c.productSummary ?? ""),
            category: String(c.category ?? ""),
            jobsToBeDone: Array.isArray(c.jobsToBeDone) ? c.jobsToBeDone.map(String) : [],
            audience: String(c.audience ?? ""),
            featureVocabulary: Array.isArray(c.featureVocabulary) ? c.featureVocabulary.map(String) : [],
            competitors: Array.isArray(c.competitors) ? c.competitors.map(String) : [],
            antiSemantics: String(c.antiSemantics ?? ""),
            targetLanguage: String(c.targetLanguage ?? ""),
          },
        });
        return { ok: true };
      }
      case "applyMetadata": {
        const p = await this.mustOwnProject(userId, op.projectId);
        const run = await this.store.getRun(op.runId);
        if (!run || run.user_id !== userId || run.project_id !== p.id) throw new Error("run not found in this project");
        const proposed = proposalLocales(run.final);
        if (!proposed) throw new Error("this run has no assembled metadata yet");
        if (!op.selection || typeof op.selection !== "object") throw new Error("selection is required");
        // Per-field selection ⊕ inline edits over the PROPOSED values (spec 10 §2) — nothing
        // is applied implicitly; unselected fields keep the previous version's values.
        const patch: Record<string, Partial<MetadataLocaleFields>> = {};
        for (const [locale, pick] of Object.entries(op.selection)) {
          const prop = proposed[locale];
          if (!prop || !pick || typeof pick !== "object") continue;
          const edits = op.edits?.[locale] ?? {};
          const fields: Partial<MetadataLocaleFields> = {};
          if (pick.title) fields.title = edits.title !== undefined ? String(edits.title) : prop.title;
          if (pick.subtitle) fields.subtitle = edits.subtitle !== undefined ? String(edits.subtitle) : prop.subtitle;
          if (pick.keywords) fields.keywords = edits.keywords !== undefined ? String(edits.keywords) : prop.keywords;
          if (Object.keys(fields).length) patch[locale] = fields;
        }
        if (!Object.keys(patch).length) throw new Error("nothing selected to apply");
        const version = await this.store.appendProjectVersion(p.id, (prev, v) => ({
          v, ts: new Date().toISOString(),
          note: op.note?.trim() || `from run ${runSlug(op.runId)}`,
          source: { type: "run", runId: op.runId },
          locales: mergeLocales(prev, patch),
        }));
        return { version };
      }
      case "editMetadata": {
        const p = await this.mustOwnProject(userId, op.projectId);
        if (!op.locales || typeof op.locales !== "object" || !Object.keys(op.locales).length) throw new Error("locales are required");
        const version = await this.store.appendProjectVersion(p.id, (prev, v) => ({
          v, ts: new Date().toISOString(),
          note: op.note?.trim() || "manual edit",
          source: { type: "manual" },
          locales: mergeLocales(prev, op.locales),
        }));
        return { version };
      }
      case "rollback": {
        const p = await this.mustOwnProject(userId, op.projectId);
        const target = p.versions.find((v) => v.v === Number(op.toV));
        if (!target) throw new Error(`version v${op.toV} not found`);
        // Append-only history: restore COPIES the old snapshot forward, never rewrites.
        const version = await this.store.appendProjectVersion(p.id, (_prev, v) => ({
          v, ts: new Date().toISOString(),
          note: `rollback of v${target.v}`,
          source: { type: "rollback", fromV: target.v },
          locales: JSON.parse(JSON.stringify(target.locales)),
        }));
        return { version };
      }
      case "markLive": {
        const p = await this.mustOwnProject(userId, op.projectId);
        if (!p.versions.some((v) => v.v === Number(op.v))) throw new Error(`version v${op.v} not found`);
        await this.store.updateProject({ id: p.id, live_version: Number(op.v) });
        return { ok: true };
      }
      case "bankFlag": {
        const p = await this.mustOwnProject(userId, op.projectId);
        const flags: { pinned?: boolean; hidden?: boolean } = {};
        if (typeof op.pinned === "boolean") flags.pinned = op.pinned;
        if (typeof op.hidden === "boolean") flags.hidden = op.hidden;
        if (!Object.keys(flags).length) throw new Error("nothing to flag");
        await this.store.setProjectKeywordFlags(p.id, String(op.storefront), String(op.language), normalizeKeyword(String(op.keyword)), flags);
        return { ok: true };
      }
      case "checkPositions": {
        const p = await this.mustOwnProject(userId, op.projectId);
        return this.checkPositions(userId, p, String(op.storefront));
      }
      case "archive": {
        const p = await this.mustOwnProject(userId, op.projectId);
        await this.store.updateProject({ id: p.id, archived: op.archived === true });
        return { ok: true };
      }
      case "delete": {
        const p = await this.mustOwnProject(userId, op.projectId);
        // Typed-name confirmation is enforced server-side too — the bank + position history die here.
        if (String(op.confirmName ?? "").trim() !== p.name) throw new Error("confirmation name does not match the project name");
        await this.store.deleteProject(p.id);
        return { ok: true };
      }
      default:
        throw new Error(`unknown project op: ${(op as any).kind}`);
    }
  }

  /** spec 10 §3: rank verification. Debits ONE ledger row up front (idempotent by pos:<checkId>);
   *  insufficient balance → rejected with a top-up nudge, no partial checks. SERPs are fetched
   *  FRESH through the user's client in the background; rows land as the batch completes. */
  private async checkPositions(userId: string, project: ProjectRow, storefront: string) {
    if (!project.app_store_id) throw new Error("link your App Store listing first (Settings → App Store URL)");
    const sf = STOREFRONTS[storefront];
    if (!sf) throw new Error(`unknown storefront: ${storefront}`);
    if (!this.hub.hasClient(userId) && !this.opts.allowLoopback) {
      throw new Error("the desktop client must be connected — position checks run from your own IP");
    }
    const bank = await this.store.listProjectKeywords(project.id);
    const tracked = trackedPhrases(project, storefront, bank);
    if (!tracked.length) throw new Error("nothing to track: save metadata for this storefront or pin bank keywords first");

    const fee = positionsFee();
    const total = Math.round(tracked.length * fee * 10_000) / 10_000;
    const checkId = randomUUID();
    // One ledger row via the D4 v5 engine; ledger.run_id carries the proj: pseudo-id (TEXT, no FK).
    const charge = await this.billing.chargeKeyphrase(userId, `proj:${project.id}`, `pos:${checkId}`, total);
    if (!charge.charged && !charge.alreadyCharged) {
      throw new Error(`not enough credits for this check (${total.toFixed(2)} cr for ${tracked.length} phrases) — top up your balance`);
    }
    await this.broadcastBalance(userId, charge.balance);

    const appId = Number(project.app_store_id);
    const gateway = new AppleGateway(this.store, this.channelFor(userId), `proj:${project.id}`, storefront);
    const lang = serpLangFor(storefront);
    const rows: ProjectPositionRow[] = [];
    // Background: a real client is rate-limited (~18 req/min) — a 50-phrase check outlives any
    // request-response window. The UI polls project-positions; partial batches still insert.
    const work = (async () => {
      try {
        for (const keyword of tracked) {
          const raw = await gateway.serp(keyword, sf.id, lang, { fresh: true });
          const idx = (raw.results ?? []).findIndex((r) => Number(r.trackId) === appId);
          rows.push({
            project_id: project.id, storefront, keyword,
            position: idx >= 0 ? idx + 1 : null,
            serp_size: raw.results?.length ?? null,
          });
        }
      } catch (e: any) {
        log.warn("[projects] positions check stopped early", { projectId: project.id, fetched: rows.length, err: String(e?.message ?? e) });
      } finally {
        if (rows.length) await this.store.insertProjectPositions(rows).catch(() => {});
      }
    })();
    // DEV loopback resolves instantly — awaiting keeps tests and the stubless dev flow synchronous.
    if (this.opts.allowLoopback && !this.hub.hasClient(userId)) await work;
    return { checkId, storefront, tracked: tracked.length, credits: total, started: true };
  }
}
