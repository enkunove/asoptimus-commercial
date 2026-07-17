// @aso/server/api — WSS-роутер (BUILD-PLAN §4): команды клиента, диспатч джоб, приём сырья,
// read-path query/query.result. Каждое клиент→сервер сообщение обёрнуто в SignedEnvelope
// (per-message HMAC + ts ±5м + nonce анти-replay, ARCHITECTURE §5) — проверяется на КАЖДОМ
// сообщении через auth.verifyMessage. DEV=1 допускает bare-сообщение (без подписи) для отладки.
//
// Клиент→сервер: hello / run.create / run.control / job.result / job.error / query.
// Сервер→клиент: job.dispatch / run.progress / run.phase / run.paused / balance / run.created /
//                query.result / query.error (через hub).

import type { App } from "../app.ts";
import type { ClientToServer, ServerToClient, SignedEnvelope, BalanceView } from "@aso/shared";
import type { ClientConnection } from "../apple-dispatch/hub.ts";
import { defaultRunConfig, validateRunConfig } from "../config.ts";
import { modelInfos } from "../billing/prices.ts";
import { topupCatalog } from "../stripe/service.ts";
import { IS_DEV } from "../env.ts";
import { log } from "../log.ts";

export interface WsData {
  userId?: string;
  deviceFp?: string;
  token?: string;
  conn?: ClientConnection;
}

/** Bun ServerWebSocket-совместимый интерфейс (минимально нужный). */
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
    send(ws, { t: "run.paused", run_id: "", reason: "невалидный JSON" } as ServerToClient);
    return;
  }

  // ── Транспортная обёртка SignedEnvelope: HMAC + ts(±5м) + nonce на КАЖДОМ сообщении ──
  let msg: ClientToServer;
  const enveloped = parsed && typeof parsed === "object" && "mac" in parsed && "body" in parsed;
  if (enveloped) {
    const env = parsed as SignedEnvelope;
    const token = env.body?.t === "hello" ? env.body.session_token : ws.data.token;
    if (!token) { ws.close(4401, "нет сессии"); return; }
    // mac = HMAC_sha256(hmac_secret, `${ts}.${nonce}.${JSON.stringify(body)}`) — см. NOTES.md.
    if (!app.auth.verifyMessage(token, JSON.stringify(env.body), env.ts, env.nonce, env.mac)) {
      ws.close(4401, "подпись/nonce/ts невалидны");
      return;
    }
    msg = env.body;
  } else if (IS_DEV) {
    msg = parsed as ClientToServer; // DEV: bare-сообщение без подписи (отладка)
  } else {
    ws.close(4401, "требуется SignedEnvelope"); // прод: без конверта не принимаем
    return;
  }

  // ── Аутентификация: до hello принимаем только hello ──
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
    // Приветствие-ack: текущий баланс (run.created приходит на run.create с client_ref).
    void app.billing.balance(sess.userId).then((credits) => send(ws, { t: "balance", credits }));
    return;
  }

  const userId = ws.data.userId;
  if (!userId) { ws.close(4401, "сначала hello"); return; }
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
        send(ws, { t: "run.created", client_ref: msg.client_ref, run_id: runId }); // ack связывает client_ref ↔ run_id
        void app.manager.startRun(runId);
      });
      break;
    }
    case "run.control":
      void app.manager.control(msg.run_id, msg.action).catch((e) =>
        send(ws, { t: "run.paused", run_id: msg.run_id, reason: e?.message ?? String(e) }));
      break;
    case "job.result":
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

/** Read-path (reconcile v2/v5): браузерные чтения релеятся запрос-ответом query → query.result.
 *  Формы data строго по @aso/shared (RunSnapshot/KeywordPage/{item}/LlmLogPage/…). */
async function handleQuery(app: App, ws: WsLike, userId: string, q: Extract<ClientToServer, { t: "query" }>) {
  const runId = String(q.params?.runId ?? "");
  const ownsRun = () => !app.manager.userOf(runId) || app.manager.userOf(runId) === userId;
  let data: unknown;
  switch (q.kind) {
    case "runs":
      data = await app.manager.listRuns(userId); // RunSummary[]
      break;
    case "run":
      if (!ownsRun()) throw new Error("чужой прогон");
      data = await app.manager.runSnapshot(runId); // RunSnapshot
      break;
    case "keywords":
      if (!ownsRun()) throw new Error("чужой прогон");
      data = await app.manager.keywordPage(runId, q.params ?? {}); // KeywordPage
      break;
    case "keyword":
      if (!ownsRun()) throw new Error("чужой прогон");
      data = await app.manager.keywordItem(runId, String(q.params?.keyword ?? "")); // { item }
      break;
    case "llm-log":
      if (!ownsRun()) throw new Error("чужой прогон");
      data = await app.manager.llmLogPage(runId, q.params ?? {}); // LlmLogPage (D9)
      break;
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
      data = topupCatalog(); // TopupPackage[]
      break;
    default:
      throw new Error(`неизвестный query kind: ${(q as any).kind}`);
  }
  send(ws, { t: "query.result", query_id: q.query_id, data });
}

export function wssClose(app: App, ws: WsLike) {
  const userId = ws.data.userId;
  if (userId) app.hub.unregister(userId); // клиент отвалился → джобы обрываются → paused (D7)
  log.debug("[wss] соединение закрыто", { userId });
}
