// @aso/server/api — WSS router (BUILD-PLAN §4): client commands, job dispatch, raw-data intake,
// read-path query/query.result. Every client→server message is wrapped in a SignedEnvelope
// (per-message HMAC + ts ±5m + nonce anti-replay, ARCHITECTURE §5) — verified on EVERY
// message via auth.verifyMessage. DEV=1 allows a bare (unsigned) message for debugging.
//
// Client→server: hello / run.create / run.control / job.result / job.error / query.
// Server→client: job.dispatch / run.progress / run.phase / run.paused / balance / run.created /
//                query.result / query.error (via hub).

import type { App } from "../app.ts";
import type { ClientToServer, ServerToClient, SignedEnvelope, BalanceView } from "@aso/shared";
import type { ClientConnection } from "../apple-dispatch/hub.ts";
import { defaultRunConfig, validateRunConfig } from "../config.ts";
import { modelInfos } from "../billing/prices.ts";
import { topupCatalog } from "../billing/packages.ts";
import { IS_DEV } from "../env.ts";
import { log } from "../log.ts";

export interface WsData {
  userId?: string;
  deviceFp?: string;
  token?: string;
  conn?: ClientConnection;
}

/** Bun ServerWebSocket-compatible interface (minimal subset needed). */
export interface WsLike {
  data: WsData;
  send(s: string): void;
  close(code?: number, reason?: string): void;
}

function send(ws: WsLike, msg: ServerToClient) {
  ws.send(JSON.stringify(msg));
}

export function wssMessage(app: App, ws: WsLike, raw: string | Buffer) {
  let parsed: any;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    send(ws, { t: "run.paused", run_id: "", reason: "invalid JSON" } as ServerToClient);
    return;
  }

  // ── SignedEnvelope transport wrapper: HMAC + ts(±5m) + nonce on EVERY message ──
  let msg: ClientToServer;
  const enveloped = parsed && typeof parsed === "object" && "mac" in parsed && "body" in parsed;
  if (enveloped) {
    const env = parsed as SignedEnvelope;
    const token = env.body?.t === "hello" ? env.body.session_token : ws.data.token;
    if (!token) { ws.close(4401, "no session"); return; }
    // mac = HMAC_sha256(hmac_secret, `${ts}.${nonce}.${JSON.stringify(body)}`) — see NOTES.md.
    if (!app.auth.verifyMessage(token, JSON.stringify(env.body), env.ts, env.nonce, env.mac)) {
      ws.close(4401, "invalid signature/nonce/ts");
      return;
    }
    msg = env.body;
  } else if (IS_DEV) {
    msg = parsed as ClientToServer; // DEV: bare unsigned message (debugging)
  } else {
    ws.close(4401, "SignedEnvelope required"); // prod: unenveloped messages rejected
    return;
  }

  // ── Authentication: before hello, only hello is accepted ──
  if (msg.t === "hello") {
    const sess = app.auth.verifySession(msg.session_token, msg.device_fp);
    if (!sess) { ws.close(4401, "unauthorized"); return; }
    if (!app.auth.allow(sess.userId)) { ws.close(4429, "rate limited"); return; }
    const conn: ClientConnection = { userId: sess.userId, deviceFp: msg.device_fp, send: (m) => send(ws, m) };
    ws.data.userId = sess.userId;
    ws.data.deviceFp = msg.device_fp;
    ws.data.token = msg.session_token;
    ws.data.conn = conn;
    app.hub.register(conn);
    // Hello ack: current balance (run.created arrives on run.create with client_ref).
    void app.billing.balance(sess.userId).then((credits) => send(ws, { t: "balance", credits }));
    return;
  }

  const userId = ws.data.userId;
  if (!userId) { ws.close(4401, "hello first"); return; }
  if (!app.auth.allow(userId)) { ws.close(4429, "rate limited"); return; }

  switch (msg.t) {
    case "run.create": {
      const config = defaultRunConfig((msg.config ?? {}) as any);
      const verrs = validateRunConfig(config);
      if (Object.keys(verrs).length) {
        send(ws, { t: "query.error", query_id: msg.client_ref, reason: `config invalid: ${Object.values(verrs).join("; ")}` });
        break;
      }
      void app.manager.createRun(userId, msg.brief, config).then((runId) => {
        send(ws, { t: "run.created", client_ref: msg.client_ref, run_id: runId }); // ack links client_ref ↔ run_id
        void app.manager.startRun(runId);
      });
      break;
    }
    case "run.control":
      // Same authoritative ownership gate as the query path — control (pause/resume/delete/
      // exclude/confirmContext) must never act on another user's run.
      void (async () => {
        if ((await app.manager.ownerOf(msg.run_id)) !== userId) throw new Error("not your run");
        await app.manager.control(msg.run_id, msg.action);
      })().catch((e) =>
        send(ws, { t: "run.paused", run_id: msg.run_id, reason: e?.message ?? String(e) }));
      break;
    case "job.result":
      if (msg.http) app.manager.noteClientHttp(userId, msg.http);
      app.manager.resolveJob(msg.result);
      break;
    case "job.error":
      app.manager.rejectJob(msg.job_id, msg.reason, msg.throttle);
      break;
    case "query":
      void handleQuery(app, ws, userId, msg).catch((e) =>
        send(ws, { t: "query.error", query_id: (msg as any).query_id, reason: e?.message ?? String(e) }));
      break;
    default:
      break;
  }
}

/** Read path (reconcile v2/v5): browser reads are relayed request-response as query → query.result.
 *  data shapes strictly follow @aso/shared (RunSnapshot/KeywordPage/{item}/LlmLogPage/…). */
async function handleQuery(app: App, ws: WsLike, userId: string, q: Extract<ClientToServer, { t: "query" }>) {
  const runId = String(q.params?.runId ?? "");
  // AUTHORITATIVE ownership (manager.ownerOf hits the store for cold runs). Fail-closed:
  // unknown run → "not your run" (does not leak run existence). The old in-memory-only check
  // failed OPEN after a server restart, exposing cold runs cross-tenant.
  const ownsRun = async () => (await app.manager.ownerOf(runId)) === userId;
  let data: unknown;
  switch (q.kind) {
    case "runs":
      data = await app.manager.listRuns(userId); // RunSummary[]
      break;
    case "run":
      if (!(await ownsRun())) throw new Error("not your run");
      data = await app.manager.runSnapshot(runId); // RunSnapshot
      break;
    case "keywords":
      if (!(await ownsRun())) throw new Error("not your run");
      data = await app.manager.keywordPage(runId, q.params ?? {}); // KeywordPage
      break;
    case "keyword":
      if (!(await ownsRun())) throw new Error("not your run");
      data = await app.manager.keywordItem(runId, String(q.params?.keyword ?? "")); // { item }
      break;
    case "llm-log":
      if (!(await ownsRun())) throw new Error("not your run");
      data = await app.manager.llmLogPage(runId, q.params ?? {}); // LlmLogPage (D9)
      break;
    // ── spec 09: insights & exports — re-projections only (no Apple/LLM calls, no debits) ──
    case "keywords-lite":
      if (!(await ownsRun())) throw new Error("not your run");
      data = await app.manager.keywordsLite(runId); // KeywordsLiteView
      break;
    case "competitors":
      if (!(await ownsRun())) throw new Error("not your run");
      data = await app.manager.competitors(runId); // CompetitorsView
      break;
    case "export": {
      if (!(await ownsRun())) throw new Error("not your run");
      const format = String(q.params?.format ?? "");
      if (!["csv", "md", "json", "html"].includes(format)) throw new Error(`unknown export format: ${format}`);
      // pinned/notes = the user's LOCAL annotations, used transiently for rendering (spec 09 §7).
      const pinned = Array.isArray(q.params?.pinned) ? (q.params!.pinned as unknown[]).map(String).slice(0, 2000) : undefined;
      const rawNotes = q.params?.notes;
      const notes = rawNotes && typeof rawNotes === "object" && !Array.isArray(rawNotes)
        ? Object.fromEntries(Object.entries(rawNotes as Record<string, unknown>).slice(0, 2000).map(([k, v]) => [k, String(v).slice(0, 500)]))
        : undefined;
      const artifact = await app.manager.exportArtifact(runId, format as "csv" | "md" | "json" | "html", { pinned, notes });
      if (!artifact) throw new Error("run not found");
      data = artifact; // ExportArtifact
      break;
    }
    case "balance": {
      const credits = await app.billing.balance(userId);
      const ledger = await app.store.listLedger(userId, 50);
      const view: BalanceView = { credits, ledger: ledger.map((l) => ({ ts: l.ts ?? "", type: l.type, delta: Number(l.delta), runId: l.run_id ?? undefined })) };
      data = view;
      break;
    }
    case "models":
      data = modelInfos(); // ModelInfo[]
      break;
    case "packages":
      data = { packages: topupCatalog(), custom: app.payments.customRange() }; // TopupCatalog
      break;
    default:
      throw new Error(`unknown query kind: ${(q as any).kind}`);
  }
  send(ws, { t: "query.result", query_id: q.query_id, data });
}

export function wssClose(app: App, ws: WsLike) {
  const userId = ws.data.userId;
  if (userId) app.hub.unregister(userId); // client dropped → jobs abort → paused (D7)
  log.debug("[wss] connection closed", { userId });
}
