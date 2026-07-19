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
} from "@aso/shared";
import { toLite, aggregateCompetitors, buildExport } from "./insights.ts";
import { sampleCount, normalizeKeyword } from "@aso/shared";
import type { Store } from "../db/index.ts";
import { BillingService } from "../billing/service.ts";
import { pricePerKeyphrase, quoteFor } from "../billing/prices.ts";
import type { LlmClient } from "../llm-proxy/client.ts";
import { LlmProxy } from "../llm-proxy/proxy.ts";
import { ClientHub, ClientGoneError } from "../apple-dispatch/hub.ts";
import { AppleGateway } from "../apple-dispatch/gateway.ts";
import { LoopbackJobChannel, WssJobChannel, type JobChannel } from "../apple-dispatch/channel.ts";
import { Orchestrator } from "./orchestrator.ts";
import { initialState, projectRunState, type ServerRunState } from "./state.ts";
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

  /** REAL keyphrase debit (D4 v4) + live balance push to the client. */
  private async chargeKeyphrase(userId: string, runId: string, model: string, keyword: string) {
    const price = pricePerKeyphrase(model);
    const r = await this.billing.chargeKeyphrase(userId, runId, keyword, price);
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
      chargeKeyphrase: (keyword) => this.chargeKeyphrase(s.userId, s.runId, s.config.model, keyword),
      onPaused: (reason, code) => this.broadcastPaused(s.runId, reason, code),
      onDone: (st) => this.finishRun(st),
    });
  }

  /** Run completion (D4 v4: no settle — usage-based, everything debited in real time). */
  private async finishRun(s: ServerRunState) {
    await this.broadcastBalance(s.userId);
    const charged = await this.store.sumDebitsForRun(s.runId);
    await this.emitEvent(s.runId, "💰", `run finished: ${charged.toFixed(2)} cr debited for ${sampleCount(s.keywords)} keyphrases`);
  }

  // ---------- public API ----------

  async createRun(userId: string, brief: string, config: RunConfig): Promise<string> {
    const runId = `run_${randomUUID()}`;
    this.runUsers.set(runId, userId);
    const estimate = quoteFor(config.sampleSize, config.model);
    const state = initialState(runId, userId, brief, config, estimate);
    await this.store.createRun({
      id: runId, user_id: userId, phase: "created", config, brief, estimate_credits: estimate,
      context: null, final: null, usage: state.usage, state,
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
    const price = pricePerKeyphrase(orch.state.config.model);
    const balance = await this.billing.balance(userId);
    if (balance >= price) return true;
    const verb = orch.state.phase === "created" ? "start" : "continue";
    orch.state.paused = true;
    orch.state.notice = `Not enough credits to ${verb} (a keyphrase costs ${price}, balance is ${balance.toFixed(2)}). Top up your balance.`;
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
    const orch = this.buildOrchestrator(state);
    try {
      await orch.replayFromLogs(row.phase as ServerRunState["phase"]);
    } catch (e: any) {
      // Unexpected replay failure — safety net: hydrate internal fields from the snapshot projection.
      log.warn("[replay] reconstruction from logs failed — falling back to the snapshot projection", { runId, err: String(e?.message ?? e) });
      if (row.state) Object.assign(state, row.state, { runId, userId: row.user_id, config: row.config, brief: row.brief ?? "" });
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
      case "confirmContext": if (await this.creditsCoverWork(runId, orch)) void orch.confirmContext(); break;
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

  async listRuns(userId: string): Promise<RunSummary[]> {
    const rows = await this.store.listRunsByUser(userId);
    return rows.map((row) => {
      const s = row.state as ServerRunState | null;
      const kws = s?.keywords ?? [];
      const top = [...kws].filter((k) => (k.metrics.score ?? 0) > 0).sort((a, b) => (b.metrics.score ?? 0) - (a.metrics.score ?? 0)).slice(0, 3);
      return {
        runId: row.id, brand: row.config.brand, country: row.config.country,
        phase: row.phase as RunState["phase"], paused: s?.paused ?? false, failed: s?.failed ?? null,
        sampleCount: sampleCount(kws), sampleSize: row.config.sampleSize,
        updatedAt: row.updated_at ?? new Date().toISOString(),
        usage: { calls: row.usage?.calls ?? 0, totalTokens: (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0), costUsd: row.usage?.costUsd ?? null },
        topKeywords: top.map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0 })),
      };
    });
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
}
