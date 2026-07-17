// @aso/server/api — REST (публичные лендинг-эндпоинты + активация/аккаунт + run-эндпоинты) + SSE.
// В проде браузер бьёт localhost, программа релеит команды в облако по WSS; здесь тот же контракт
// доступен напрямую под session-token (для тестов/дев-UI/лендинга). D9: LLM-журнал наружу —
// только выходы+числа (LlmLogPublic), НИКОГДА не промпты.

import type { App } from "../app.ts";
import { defaultRunConfig, validateRunConfig } from "../config.ts";
import { packages, topupCatalog } from "../stripe/service.ts";
import { modelInfos, quoteFor, pricePerKeyphrase, OVERSHOOT_PCT, knownModel, DEFAULT_MODEL } from "../billing/prices.ts";
import { IS_DEV, optionalEnv } from "../env.ts";
import { log } from "../log.ts";
import type { RunConfig, RunAction, BalanceView, ActivateResponse, RunQuote } from "@aso/shared";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}
async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function balanceView(credits: number, ledger: Awaited<ReturnType<App["store"]["listLedger"]>>): BalanceView {
  return {
    credits,
    ledger: ledger.map((l) => ({
      ts: l.ts ?? "", type: l.type, delta: Number(l.delta), runId: l.run_id ?? undefined,
    })),
  };
}

export async function handleHttp(app: App, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // ── health ───────────────────────────────────────────────────────────────
  if (path === "/health") return json({ ok: true, ts: new Date().toISOString() });

  // ── публичные (лендинг) ────────────────────────────────────────────────────
  if (path === "/signup" && method === "POST") {
    const b = await body(req);
    if (!b.email || typeof b.email !== "string") return err("email обязателен");
    const email = b.email.trim().toLowerCase();
    const r = await app.auth.signup(email);
    if (r.existed) return json({ message: "аккаунт уже существует — ключ выслан ранее (используйте /account/resend-key)" });
    try {
      await app.email.sendActivationKey(email, r.key);
    } catch (e: any) {
      log.warn("[signup] письмо с ключом не отправлено", { email, err: String(e?.message ?? e) });
      return json({ error: "не удалось отправить письмо с ключом — попробуйте /account/resend-key" }, 502);
    }
    return json({ message: "проверьте почту — выслан активационный ключ", userId: r.userId, ...(IS_DEV ? { devKey: r.key } : {}) });
  }

  if (path === "/account/resend-key" && method === "POST") {
    const b = await body(req);
    const user = b.email ? await app.store.getUserByEmail(String(b.email).toLowerCase()) : null;
    if (!user) return err("аккаунт не найден", 404);
    const key = await app.auth.reissueKey(user.id);
    try {
      await app.email.sendActivationKey(user.email, key);
    } catch (e: any) {
      log.warn("[resend-key] письмо не отправлено", { userId: user.id, err: String(e?.message ?? e) });
      return json({ error: "не удалось отправить письмо с ключом" }, 502);
    }
    return json({ message: "новый ключ выслан на почту", ...(IS_DEV ? { devKey: key } : {}) });
  }

  if (path === "/checkout" && method === "POST") {
    const b = await body(req);
    const pkg = String(b.packageId ?? "");
    if (!packages()[pkg]) return err(`неизвестный пакет; доступны: ${Object.keys(packages()).join(", ")}`);
    let userId: string | undefined = b.userId;
    let email = b.email;
    if (!userId && email) { const u = await app.store.getUserByEmail(String(email).toLowerCase()); userId = u?.id; email = u?.email; }
    if (!userId) return err("нужен userId или известный email");
    const r = await app.stripe.createCheckout(userId, email ?? "", pkg, url.origin);
    return json(r);
  }

  if (path === "/webhooks/stripe" && method === "POST") {
    const raw = await req.text();
    const sig = req.headers.get("stripe-signature");
    const r = await app.stripe.handleWebhook(raw, sig);
    return json(r, r.ok ? 200 : 400);
  }

  if (path === "/download/manifest" && method === "GET") {
    // Реальные артефакты релиза клиента (подписанный macOS .dmg + sha256) задаются конфигом
    // при публикации сборки: env CLIENT_DOWNLOAD_MANIFEST_JSON. До публикации — 503.
    const raw = optionalEnv("CLIENT_DOWNLOAD_MANIFEST_JSON");
    if (raw) {
      try { return json(JSON.parse(raw)); } catch { return err("CLIENT_DOWNLOAD_MANIFEST_JSON повреждён", 500); }
    }
    return json({ message: "релиз клиента ещё не опубликован" }, 503);
  }

  // ── публичный прайс/оценка (для формы прогона) ──────────────────────────────
  if (path === "/api/models" && method === "GET") {
    return json({ models: modelInfos(), defaultModel: DEFAULT_MODEL });
  }
  if (path === "/api/packages" && method === "GET") {
    return json({ packages: topupCatalog() }); // TopupPackage[] — каталог из конфига
  }
  if (path === "/api/quote" && method === "GET") {
    const sampleSize = Number(url.searchParams.get("sampleSize") ?? 150);
    const model = url.searchParams.get("model") ?? DEFAULT_MODEL;
    if (!knownModel(model)) return err(`неизвестная модель: ${model}`);
    if (!(sampleSize >= 30 && sampleSize <= 500)) return err("sampleSize в [30, 500]");
    const q: RunQuote = { sampleSize, model, pricePerKeyphrase: pricePerKeyphrase(model), quote: quoteFor(sampleSize, model), overshootPct: OVERSHOOT_PCT };
    return json(q);
  }

  // ── activation (ключ → session-token) ──────────────────────────────────────
  if (path === "/activate" && method === "POST") {
    const b = await body(req);
    if (!b.key || !b.device_fp) return err("нужны key и device_fp");
    const r = await app.auth.activate(String(b.key), String(b.device_fp));
    if ("error" in r) return err(r.error, 401);
    const resp: ActivateResponse = { session_token: r.token, expires_at: r.expiresAt, hmac_secret: r.hmacSecret };
    return json(resp);
  }

  if (path === "/session/refresh" && method === "POST") {
    const b = await body(req);
    if (!b.session_token || !b.device_fp) return err("нужны session_token и device_fp");
    const r = await app.auth.refresh(String(b.session_token), String(b.device_fp));
    if ("error" in r) return err(r.error, 401);
    const resp: ActivateResponse = { session_token: r.token, expires_at: r.expiresAt, hmac_secret: r.hmacSecret };
    return json(resp);
  }

  // ── account (по session-token) ─────────────────────────────────────────────
  if (path === "/account" && method === "GET") {
    const token = bearer(req);
    const sess = token ? app.auth.verifySession(token) : null;
    if (!sess) return err("нужен валидный токен", 401);
    const credits = await app.billing.balance(sess.userId);
    const ledger = await app.store.listLedger(sess.userId, 50);
    return json(balanceView(credits, ledger));
  }

  // ── run-эндпоинты (под session-token) ──────────────────────────────────────
  const token = bearer(req);
  const sess = token ? app.auth.verifySession(token) : null;

  if (path === "/api/balance" && method === "GET") {
    if (!sess) return err("не авторизован", 401);
    const credits = await app.billing.balance(sess.userId);
    const ledger = await app.store.listLedger(sess.userId, 50);
    return json(balanceView(credits, ledger));
  }

  if (path === "/api/topup" && method === "POST") {
    if (!sess) return err("не авторизован", 401);
    const b = await body(req);
    if (!packages()[String(b.packageId ?? "")]) return err(`неизвестный пакет; доступны: ${Object.keys(packages()).join(", ")}`);
    const user = await app.store.getUserById(sess.userId);
    const r = await app.stripe.createCheckout(sess.userId, user?.email ?? "", String(b.packageId ?? ""), url.origin);
    return json(r);
  }

  // DEV-хелпер: смоделировать успешную оплату (только DEV=1).
  if (path === "/api/dev/complete-checkout" && method === "POST") {
    if (!IS_DEV) return err("недоступно вне DEV=1", 404);
    if (!sess) return err("не авторизован", 401);
    const b = await body(req);
    const r = await app.stripe.devComplete(sess.userId, String(b.packageId ?? "p10"));
    return json(r);
  }

  if (path === "/api/runs" && method === "POST") {
    if (!sess) return err("не авторизован", 401);
    const b = await body(req);
    if (!b.brief || typeof b.brief !== "string") return err("brief обязателен");
    const config: RunConfig = defaultRunConfig((b.config ?? {}) as Partial<RunConfig>);
    const verrs = validateRunConfig(config);
    if (Object.keys(verrs).length) return json({ error: "config invalid", fields: verrs }, 400);
    const runId = await app.manager.createRun(sess.userId, b.brief, config);
    void app.manager.startRun(runId); // фон: context → context_review
    return json({ runId });
  }

  if (path === "/api/runs" && method === "GET") {
    if (!sess) return err("не авторизован", 401);
    return json({ runs: await app.manager.listRuns(sess.userId) });
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/[^/]+)?$/);
  if (runMatch) {
    if (!sess) return err("не авторизован", 401);
    const runId = runMatch[1];
    const sub = runMatch[2];
    if (app.manager.userOf(runId) && app.manager.userOf(runId) !== sess.userId) return err("чужой прогон", 403);

    if (!sub && method === "GET") {
      const state = await app.manager.getState(runId);
      return state ? json(state) : err("прогон не найден", 404);
    }
    if (sub === "/keywords" && method === "GET") {
      const state = await app.manager.getState(runId);
      return state ? json({ keywords: state.keywords }) : err("прогон не найден", 404);
    }
    if (sub === "/llm-log" && method === "GET") {
      // D9: только выходы+числа (LlmLogPublic).
      return json({ log: await app.manager.llmLog(runId) });
    }
    if (sub === "/control" && method === "POST") {
      const b = await body(req);
      try { await app.manager.control(runId, b.action as RunAction); return json({ ok: true }); }
      catch (e: any) { return err(e?.message ?? String(e)); }
    }
    if (sub === "/events" && method === "GET") {
      return sseStream(app, runId, Number(url.searchParams.get("after") ?? req.headers.get("last-event-id") ?? 0));
    }
  }

  return err("not found", 404);
}

/** SSE-стрим прогресса прогона: replay-then-tail (D7: Last-Event-ID → run_events.seq). */
function sseStream(app: App, runId: string, afterSeq: number): Response {
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const push = (seq: number, data: unknown) =>
        controller.enqueue(encoder.encode(`id: ${seq}\nevent: progress\ndata: ${JSON.stringify(data)}\n\n`));
      const past = await app.manager.listEvents(runId, afterSeq);
      for (const e of past) push(e.seq, e.event);
      unsub = app.manager.onProgress((rid, seq, event) => { if (rid === runId) push(seq, event); });
      controller.enqueue(encoder.encode(`: keep-alive\n\n`));
    },
    cancel() { unsub?.(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
