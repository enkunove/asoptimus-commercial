// cloud-link — единственная нога наружу (D1). WSS-клиент к облаку по РЕКОНСИЛИРОВАННОМУ
// контракту @aso/shared:
//   • каждое клиент→сервер сообщение обёрнуто в SignedEnvelope (HMAC по per-session секрету,
//     ts ±5м, nonce — ARCHITECTURE §5 / reconcile v2);
//   • hello{session_token, device_fp, resume_job_ids};
//   • приём job.dispatch → apple-exec → job.result / job.error{throttle};
//   • run.create{client_ref} → ack run.created{client_ref, run_id} (run_id узнаём в ответе);
//   • браузерные чтения — query{query_id, kind, params} → query.result / query.error;
//   • релей run.progress/phase/paused/balance в локальный UI; реконнект с resume_job_ids (D7).
// top-up идёт по HTTPS (§4), не по WSS.
//
// Здесь НЕТ проприетарной логики — только транспорт джоб/сырья, релей прогресса и подпись.

import { createHmac, randomBytes } from "node:crypto";
import type {
  RunSummary, RunAction, BalanceView, TopupResponse, Job, JobResult, ModelInfo, TopupPackage,
  ServerToClient, ClientToServer, SignedEnvelope, QueryKind,
} from "@aso/shared";
import type { AppleHttp } from "./apple/http";
import type { Session } from "./activation";
import type { KeywordPage, LlmLogPage, RunSnapshot, KeywordHit, QueryData } from "./wire-local";
import { executeJob } from "./apple-exec";
import { isThrottle } from "./apple/http";
import { makeStubBackend } from "./cloud-link.stub";
import { isDev, wssUrl, httpsBase } from "./config";

export type RelayEvent =
  | { type: "run-changed"; slug: string }
  | { type: "balance"; credits: number }
  | { type: "run-paused"; slug: string; reason: string; code?: string }
  | { type: "phase"; slug: string; phase: string }
  | { type: "feed"; slug: string; ts: string; kind: string; text: string }
  | { type: "connection"; connected: boolean };

export interface CloudStatus {
  mode: "stub" | "wss";
  connected: boolean;
  balance: number | null;
}

export interface CloudLink {
  start(): Promise<void>;
  stop(): void;
  status(): CloudStatus;
  /** Подписка на события для релея в браузерный SSE. Возвращает отписку. */
  subscribe(cb: (ev: RelayEvent) => void): () => void;

  // Релей REST (браузер → localhost → WSS/HTTPS):
  listRuns(): Promise<RunSummary[]>;
  createRun(brief: string, config: unknown): Promise<{ run_id: string }>;
  getRun(runId: string): Promise<RunSnapshot>;
  listKeywords(runId: string, query: Record<string, string>): Promise<KeywordPage>;
  getKeyword(runId: string, keyword: string): Promise<KeywordHit>;
  getLlmLog(runId: string, page: number): Promise<LlmLogPage>;
  controlRun(runId: string, action: RunAction): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  getBalance(): Promise<BalanceView>;
  getModels(): Promise<ModelInfo[]>;
  getPackages(): Promise<TopupPackage[]>;
  topup(packageId: string): Promise<TopupResponse>;
}

export interface CloudLinkDeps {
  session: Session;
  http: AppleHttp;
}

/** Фабрика: прод-путь — реальный WSS (дефолт api.asoptimus.com). DEV=1 → оффлайн-стаб. */
export function makeCloudLink(deps: CloudLinkDeps): CloudLink {
  if (isDev() && !process.env.ASO_CLOUD_WSS) return new StubCloudLink(deps);
  return new WssCloudLink(wssUrl(), deps);
}

// ── Общая шина событий ───────────────────────────────────────────────────────

class Emitter {
  private subs = new Set<(ev: RelayEvent) => void>();
  subscribe(cb: (ev: RelayEvent) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(ev: RelayEvent) {
    for (const cb of [...this.subs]) {
      try { cb(ev); } catch { /* подписчик не должен ронять эмиттер */ }
    }
  }
}

// ── Реальный WSS-клиент ───────────────────────────────────────────────────────

interface Pending { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout>; }

const REQUEST_TIMEOUT_MS = 20_000;

class WssCloudLink implements CloudLink {
  private ws: WebSocket | null = null;
  private emitter = new Emitter();
  private connected = false;
  private balance: number | null = null;
  private completedJobIds = new Set<string>();
  /** in-flight запрос-ответы: query_id и client_ref делят пространство корреляции. */
  private pending = new Map<string, Pending>();
  private seq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private url: string, private deps: CloudLinkDeps) {}

  status(): CloudStatus {
    return { mode: "wss", connected: this.connected, balance: this.balance };
  }
  subscribe(cb: (ev: RelayEvent) => void) { return this.emitter.subscribe(cb); }

  async start(): Promise<void> {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.connected = true;
      this.emitter.emit({ type: "connection", connected: true });
      // hello с device-binding и resume_job_ids (D7).
      this.send({
        t: "hello",
        session_token: this.deps.session.sessionToken,
        device_fp: this.deps.session.deviceFp,
        resume_job_ids: [...this.completedJobIds],
      });
    });
    ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener("close", () => {
      this.connected = false;
      this.ws = null;
      this.emitter.emit({ type: "connection", connected: false });
      this.failAllPending(new Error("соединение с облаком разорвано"));
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // 'close' последует за 'error' — реконнект там.
    });
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    // Прогон на сервере авто-паузится, пока клиента нет (D7) — просто переподключаемся.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  /** Подписать каждое клиент→сервер сообщение (SignedEnvelope) и отправить. */
  private send(msg: ClientToServer): boolean {
    if (!this.ws || !this.connected) return false;
    const env = signEnvelope(msg, this.deps.session.hmacSecret);
    this.ws.send(JSON.stringify(env));
    return true;
  }

  private failAllPending(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async onMessage(data: string) {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    const m = msg as ServerToClient;
    switch (m.t) {
      case "query.result": {
        const p = this.pending.get(m.query_id);
        if (p) { clearTimeout(p.timer); this.pending.delete(m.query_id); p.resolve(m.data); }
        break;
      }
      case "query.error": {
        const p = this.pending.get(m.query_id);
        if (p) { clearTimeout(p.timer); this.pending.delete(m.query_id); p.reject(new Error(m.reason || "ошибка запроса")); }
        break;
      }
      case "run.created": {
        const p = this.pending.get(m.client_ref);
        if (p) { clearTimeout(p.timer); this.pending.delete(m.client_ref); p.resolve({ run_id: m.run_id }); }
        this.emitter.emit({ type: "run-changed", slug: m.run_id });
        break;
      }
      case "job.dispatch":
        await this.runJob(m.job);
        break;
      case "run.progress":
        this.emitter.emit({ type: "feed", slug: m.run_id, ts: m.event.ts, kind: m.event.kind, text: m.event.text });
        this.emitter.emit({ type: "run-changed", slug: m.run_id });
        break;
      case "run.phase":
        this.emitter.emit({ type: "phase", slug: m.run_id, phase: m.phase });
        this.emitter.emit({ type: "run-changed", slug: m.run_id });
        break;
      case "run.paused":
        this.emitter.emit({ type: "run-paused", slug: m.run_id, reason: m.reason, code: m.code });
        this.emitter.emit({ type: "run-changed", slug: m.run_id });
        break;
      case "balance":
        this.balance = m.credits;
        this.emitter.emit({ type: "balance", credits: m.credits });
        break;
    }
  }

  private async runJob(job: Job) {
    if (this.completedJobIds.has(job.job_id)) return; // уже сделано — сервер дедупнёт по hello
    try {
      const result: JobResult = await executeJob(this.deps.http, job);
      this.completedJobIds.add(job.job_id);
      this.send({ t: "job.result", result });
    } catch (e: any) {
      this.send({
        t: "job.error",
        job_id: job.job_id,
        reason: e?.message ?? String(e),
        throttle: isThrottle(e),
      });
    }
  }

  /** Запрос-ответ по контракту query/query.result (correlation по query_id). */
  private query<K extends QueryKind>(kind: K, params?: Record<string, unknown>): Promise<QueryData[K]> {
    const query_id = `q${++this.seq}`;
    return this.awaitCorrelated(query_id, () => this.send({ t: "query", query_id, kind, params }));
  }

  private awaitCorrelated<T>(id: string, send: () => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("таймаут ответа облака"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      if (!send()) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("нет соединения с облаком"));
      }
    });
  }

  async listRuns() { return this.query("runs"); }
  async getRun(runId: string) { return this.query("run", { run_id: runId }); }
  async listKeywords(runId: string, q: Record<string, string>) {
    return this.query("keywords", { run_id: runId, ...q, page: Number(q.page ?? 0) });
  }
  async getKeyword(runId: string, keyword: string) { return this.query("keyword", { run_id: runId, keyword }); }
  async getLlmLog(runId: string, page: number) { return this.query("llm-log", { run_id: runId, page }); }
  async getBalance() { return this.query("balance"); }
  async getModels() { return this.query("models"); }
  async getPackages() { return this.query("packages"); }

  async createRun(brief: string, config: unknown) {
    const client_ref = `c${++this.seq}`;
    return this.awaitCorrelated<{ run_id: string }>(
      client_ref,
      () => this.send({ t: "run.create", client_ref, brief, config }),
    );
  }
  async controlRun(runId: string, action: RunAction) {
    if (!this.send({ t: "run.control", run_id: runId, action })) throw new Error("нет соединения с облаком");
  }
  async deleteRun(runId: string) {
    // reconcile v2: удаление — это run.control с action {type:"delete"} (не отдельная команда).
    if (!this.send({ t: "run.control", run_id: runId, action: { type: "delete" } })) {
      throw new Error("нет соединения с облаком");
    }
  }

  async topup(packageId: string): Promise<TopupResponse> {
    // top-up идёт по HTTPS (§4), не по WSS: сервер (POST /api/topup) отдаёт Stripe Checkout URL.
    const res = await fetch(new URL("/api/topup", httpsBase()), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.deps.session.sessionToken}`,
      },
      body: JSON.stringify({ packageId }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<TopupResponse> & { error?: string };
    if (!res.ok) throw new Error(data?.error || `Пополнение не удалось (HTTP ${res.status}).`);
    if (!data?.checkoutUrl) throw new Error("Облако не вернуло ссылку на оплату.");
    return { checkoutUrl: data.checkoutUrl };
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.failAllPending(new Error("клиент остановлен"));
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

/** Каноническая строка подписи: `ts.nonce.<json body>` (см. NOTES.md — сервер должен верифицировать так же). */
function signEnvelope(body: ClientToServer, secret: string): SignedEnvelope {
  const ts = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", secret).update(`${ts}.${nonce}.${JSON.stringify(body)}`).digest("hex");
  return { mac, ts, nonce, body };
}

// ── DEV-стаб облака (за DEV=1): мок, чтобы UI поднялся и apple-exec можно было гонять ──
// Реализация вынесена в cloud-link.stub.ts, чтобы этот файл держал только транспорт.

class StubCloudLink implements CloudLink {
  private emitter = new Emitter();
  private backend = makeStubBackend((ev) => this.emitter.emit(ev));

  constructor(private deps: CloudLinkDeps) {}

  status(): CloudStatus { return { mode: "stub", connected: true, balance: this.backend.balanceCredits() }; }
  subscribe(cb: (ev: RelayEvent) => void) { return this.emitter.subscribe(cb); }
  async start() { /* stub всегда «на связи» */ }
  stop() { /* нечего закрывать */ }

  listRuns() { return this.backend.listRuns(); }
  createRun(brief: string, config: unknown) { return this.backend.createRun(brief, config); }
  getRun(runId: string) { return this.backend.getRun(runId); }
  listKeywords(runId: string, query: Record<string, string>) { return this.backend.listKeywords(runId, query); }
  getKeyword(runId: string, keyword: string) { return this.backend.getKeyword(runId, keyword); }
  getLlmLog(runId: string, page: number) { return this.backend.getLlmLog(runId, page); }
  controlRun(runId: string, action: RunAction) { return this.backend.controlRun(runId, action); }
  deleteRun(runId: string) { return this.backend.deleteRun(runId); }
  getBalance() { return this.backend.getBalance(); }
  getModels() { return this.backend.getModels(); }
  getPackages() { return this.backend.getPackages(); }
  topup(packageId: string) { return this.backend.topup(packageId); }

  /** Dev-хук: прогнать одну Apple-джобу через apple-exec (для оффлайн-проверки исполнителей). */
  execJob(job: Job): Promise<JobResult> { return executeJob(this.deps.http, job); }
}

export { StubCloudLink };
