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
} from "@aso/shared";
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
      counters: { sampleCount: sampleCount(s.keywords), sampleSize: s.config.sampleSize, requestsMade: 0, cacheHits: 0, calls: s.usage.calls },
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
    const charged = (await this.store.listLedger(s.userId, 1000))
      .filter((r) => r.run_id === s.runId && r.type === "debit")
      .reduce((sum, r) => sum + Math.abs(Number(r.delta)), 0);
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

  /** Start: gate "balance covers at least 1 keyphrase" (NOT a reserve, D4 v4); insufficient → paused. */
  async startRun(runId: string): Promise<void> {
    const orch = await this.getOrchestrator(runId);
    const userId = this.runUsers.get(runId)!;
    const price = pricePerKeyphrase(orch.state.config.model);
    const balance = await this.billing.balance(userId);
    if (balance < price) {
      orch.state.paused = true;
      orch.state.notice = `Not enough credits to start (a keyphrase costs ${price}, balance is ${balance.toFixed(2)}). Top up your balance.`;
      await this.persist(orch.state);
      await this.emitEvent(runId, "💳", orch.state.notice);
      this.hub.broadcast(userId, { t: "run.paused", run_id: runId, reason: orch.state.notice, code: "credits_out" });
      return;
    }
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

  async control(runId: string, action: RunAction): Promise<void> {
    const orch = await this.getOrchestrator(runId);
    switch (action.type) {
      case "pause": orch.requestPause(); break;
      case "resume": void orch.resume(); break;
      case "stopAndAssemble": orch.requestStopAndAssemble(); break;
      case "reassemble": void orch.reassemble(); break;
      case "confirmContext": void orch.confirmContext(); break;
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
    };
  }

  /** query kind="keywords": SERVER-SIDE pagination/sort/filter (spec 07: don't load 500+ rows wholesale). */
  async keywordPage(runId: string, params: Record<string, unknown> = {}): Promise<KeywordPage> {
    const state = await this.getState(runId);
    let items: KeywordEntry[] = state?.keywords ? [...state.keywords] : [];
    const status = params.status ? String(params.status) : "";
    if (status) items = items.filter((k) => k.status === status);
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
