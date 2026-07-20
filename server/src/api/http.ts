// @aso/server/api — REST (public landing endpoints + activation/account + run endpoints) + SSE.
// In prod the browser hits localhost, the app relays commands to the cloud over WSS; here the same
// contract is available directly under a session-token (for tests/dev-UI/landing). D9: LLM log exposed
// externally — outputs+numbers only (LlmLogPublic), NEVER prompts.

import type { App } from "../app.ts";
import { handleAdmin } from "./admin.ts";
import { rateLimited } from "./ratelimit.ts";
import { defaultRunConfig, validateRunConfig } from "../config.ts";
import { topupCatalog } from "../billing/packages.ts";
import { modelInfos, quoteFor, pricePerKeyphrase, OVERSHOOT_PCT, knownModel, DEFAULT_MODEL } from "../billing/prices.ts";
import { IS_DEV, optionalEnv } from "../env.ts";
import { isPaddleIp } from "../paddle/service.ts";
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

/** Tiny self-contained brand page for Paddle checkout redirects (no assets, inline styles). */
function checkoutPage(title: string, note: string): Response {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — ASOptimus</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#FDF3DA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#191D3A">
<div style="max-width:440px;background:#fff;border:2.5px solid #191D3A;border-radius:16px;box-shadow:6px 6px 0 #191D3A;padding:32px 36px;margin:20px;text-align:center">
<div style="width:52px;height:52px;margin:0 auto;background:#F86C1A;border:2.5px solid #191D3A;border-radius:14px;box-shadow:3px 3px 0 #191D3A;color:#fff;font-weight:800;font-size:28px;line-height:48px">A</div>
<h1 style="font-size:24px;margin:14px 0 8px;letter-spacing:-0.01em">${title}</h1>
<p style="color:#565B76;margin:0">${note}</p>
<p style="color:#565B76;margin:14px 0 0">You can close this tab and return to <b>ASOptimus</b>.</p>
</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function balanceView(credits: number, ledger: Awaited<ReturnType<App["store"]["listLedger"]>>): BalanceView {
  return {
    credits,
    ledger: ledger.map((l) => ({
      ts: l.ts ?? "", type: l.type, delta: Number(l.delta), runId: l.run_id ?? undefined,
    })),
  };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "https://asoptimus.com",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;
/** Landing-page fetches (download popup → /signup) come cross-origin from asoptimus.com. */
function withCors(resp: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
  return resp;
}

export async function handleHttp(app: App, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS" && (path === "/signup" || path === "/checkout")) {
    return withCors(new Response(null, { status: 204 }));
  }

  // ── health ───────────────────────────────────────────────────────────────
  if (path === "/health") return json({ ok: true, ts: new Date().toISOString() });

  // ── /: humans and payment-domain reviewers land here (Paddle reviews the host that
  //    serves /buy — a bare 404 at the root reads as "site offline"). The storefront is
  //    asoptimus.com; this page says so and links the docs reviewers check. ──
  if (path === "/" && method === "GET") {
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>ASOptimus — checkout &amp; API host</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#FDF3DA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#191D3A">
<div style="max-width:480px;background:#fff;border:2.5px solid #191D3A;border-radius:16px;box-shadow:6px 6px 0 #191D3A;padding:32px 36px;margin:20px">
<div style="width:52px;height:52px;background:#F86C1A;border:2.5px solid #191D3A;border-radius:14px;box-shadow:3px 3px 0 #191D3A;color:#fff;font-weight:800;font-size:28px;line-height:48px;text-align:center">A</div>
<h1 style="font-size:24px;margin:14px 0 8px;letter-spacing:-0.01em">ASOptimus — checkout &amp; API host</h1>
<p style="color:#565B76;margin:0 0 14px">This subdomain serves the secure checkout and the API for the
<b>ASOptimus</b> desktop app — a keyword-research (ASO) tool for app developers. Usage is billed in
prepaid credits (1&nbsp;credit&nbsp;=&nbsp;$1). Payments are processed by <b>Paddle.com</b> as merchant of record.</p>
<p style="margin:0 0 4px">Product, pricing and legal documents live on the main site:</p>
<ul style="color:#191D3A;margin:6px 0 14px;padding-left:22px;line-height:1.9">
<li><a href="https://asoptimus.com/" style="color:#0244B5">Product &amp; pricing — asoptimus.com</a></li>
<li><a href="https://asoptimus.com/terms" style="color:#0244B5">Terms of Service</a></li>
<li><a href="https://asoptimus.com/privacy" style="color:#0244B5">Privacy Policy</a></li>
<li><a href="https://asoptimus.com/refunds" style="color:#0244B5">Refund Policy</a></li>
</ul>
<p style="color:#565B76;margin:0">Operated by Individual Entrepreneur EGOR SHEVKUNOV ·
<a href="mailto:hello@asoptimus.com" style="color:#0244B5">hello@asoptimus.com</a></p>
</div></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // ── admin panel (SPA + API; ADMIN_TOKEN-gated, off when unset) ───────────
  const adminResp = await handleAdmin(app, req, url, path);
  if (adminResp) return adminResp;

  // ── Paddle checkout return pages (success/cancel redirects point here).
  //    Prod: granting happens in the webhook — this page only tells the user to go back.
  //    DEV (dev=1): no Paddle, so the "payment" is completed right here. ──
  if (path === "/checkout/success" && method === "GET") {
    let note = "Credits will appear in the app within a few seconds.";
    if (IS_DEV && url.searchParams.get("dev") === "1") {
      const user = url.searchParams.get("user") ?? "";
      const pkg = url.searchParams.get("package");
      const credits = url.searchParams.get("credits");
      if (user && (pkg || credits)) {
        try {
          const r = await app.payments.devComplete(user, pkg ? { packageId: pkg } : { customCredits: Number(credits) });
          note = `DEV checkout: ${r.note ?? "granted"}.`;
        } catch (e: any) {
          note = `DEV checkout failed: ${e?.message ?? e}`;
        }
      } else {
        note = "DEV checkout: unknown package or user — nothing granted.";
      }
    }
    return checkoutPage("Payment received", note);
  }
  if (path === "/checkout/cancel" && method === "GET") {
    return checkoutPage("Payment canceled", "No charge was made.");
  }

  // ── /buy: the page the Paddle "default payment link" points at. Paddle.js reads the
  //    ?_ptxn=<txn id> param and opens the overlay checkout. Needs PADDLE_CLIENT_TOKEN
  //    (public client-side token; test_… auto-selects the sandbox environment). Lives on
  //    the API host so the marketing landing stays free of third-party scripts. ──
  if (path === "/buy" && method === "GET") {
    const token = optionalEnv("PADDLE_CLIENT_TOKEN");
    if (!token) {
      return checkoutPage("Payments not configured", "PADDLE_CLIENT_TOKEN is not set on this server yet.");
    }
    const sandbox = token.startsWith("test_");
    // Paddle Retain: pwCustomer must be the PADDLE customer id (ctm_…), never our internal
    // id or email. The page itself is anonymous, but the transaction in ?_ptxn= knows its
    // customer — look it up server-side. Best-effort: null → initialize without it.
    const ptxn = url.searchParams.get("_ptxn") ?? "";
    const pwCustomerId = ptxn ? await app.payments.transactionCustomer(ptxn) : null;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Checkout — ASOptimus</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#FDF3DA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#191D3A">
<div style="max-width:440px;background:#fff;border:2.5px solid #191D3A;border-radius:16px;box-shadow:6px 6px 0 #191D3A;padding:32px 36px;margin:20px;text-align:center">
<div style="width:52px;height:52px;margin:0 auto;background:#F86C1A;border:2.5px solid #191D3A;border-radius:14px;box-shadow:3px 3px 0 #191D3A;color:#fff;font-weight:800;font-size:28px;line-height:48px">A</div>
<h1 style="font-size:24px;margin:14px 0 8px;letter-spacing:-0.01em">Opening secure checkout…</h1>
<p id="msg" style="color:#565B76;margin:0">Payment is handled by Paddle${sandbox ? " (sandbox — test mode, no real charges)" : ""}.</p>
</div>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  (function () {
    var msg = document.getElementById("msg");
    if (!new URLSearchParams(location.search).get("_ptxn")) {
      msg.textContent = "No transaction in the link — start the top-up from the ASOptimus app.";
      return;
    }
    try {
      ${sandbox ? 'Paddle.Environment.set("sandbox");' : ""}
      // Paddle.js auto-detects ?_ptxn= and opens the overlay checkout after Initialize.
      Paddle.Initialize({
        token: ${JSON.stringify(token)},
        ${pwCustomerId ? `pwCustomer: { id: ${JSON.stringify(pwCustomerId)} },` : ""}
        eventCallback: function (ev) {
          if (ev.name === "checkout.completed") {
            msg.textContent = "Payment received — credits land in the app within a few seconds. You can close this tab.";
          }
        },
      });
    } catch (e) {
      msg.textContent = "Could not start the checkout: " + e.message;
    }
  })();
</script>
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // ── public (landing) ────────────────────────────────────────────────────
  if (path === "/signup" && method === "POST") {
    const limited = rateLimited(req, "signup", 5, 10 * 60_000);
    if (limited) return withCors(limited);
    const b = await body(req);
    if (!b.email || typeof b.email !== "string") return withCors(err("email is required"));
    const email = b.email.trim().toLowerCase();

    // Beta gate (BETA_GATED=1): only invited waitlist emails may sign up; each such signup
    // receives the free welcome grant (BETA_GRANT_CREDITS, default 30) — no card needed.
    const gated = optionalEnv("BETA_GATED") === "1";
    if (gated) {
      const wl = await app.store.getWaitlistEntry(email);
      if (!wl || !wl.invited_at) {
        return withCors(err("the beta is invite-only right now — join the waitlist at asoptimus.com and we'll email your invite", 403));
      }
    }

    const r = await app.auth.signup(email);
    if (r.existed) return withCors(json({ message: "account already exists — key was sent earlier (use /account/resend-key)" }));

    let freeCredits: number | undefined;
    if (gated) {
      const amount = Math.max(0, Math.round(Number(optionalEnv("BETA_GRANT_CREDITS", "30")) || 0));
      // Idempotent by ref: one beta grant per user, ever.
      if (amount > 0 && await app.billing.grant(r.userId, amount, `beta_${r.userId}`, "beta welcome grant")) {
        freeCredits = amount;
      }
      await app.store.markWaitlistSignedUp(email);
    }

    try {
      await app.email.sendActivationKey(email, r.key, freeCredits);
    } catch (e: any) {
      log.warn("[signup] key email not sent", { email, err: String(e?.message ?? e) });
      return withCors(json({ error: "failed to send key email — try /account/resend-key" }, 502));
    }
    return withCors(json({ message: "check your email — activation key sent", userId: r.userId, ...(IS_DEV ? { devKey: r.key } : {}) }));
  }

  if (path === "/account/resend-key" && method === "POST") {
    const limited = rateLimited(req, "resend", 3, 10 * 60_000);
    if (limited) return limited;
    const b = await body(req);
    const user = b.email ? await app.store.getUserByEmail(String(b.email).toLowerCase()) : null;
    if (!user) return err("account not found", 404);
    const key = await app.auth.reissueKey(user.id);
    try {
      await app.email.sendActivationKey(user.email, key);
    } catch (e: any) {
      log.warn("[resend-key] email not sent", { userId: user.id, err: String(e?.message ?? e) });
      return json({ error: "failed to send key email" }, 502);
    }
    return json({ message: "new key sent to your email", ...(IS_DEV ? { devKey: key } : {}) });
  }

  if (path === "/checkout" && method === "POST") {
    const limited = rateLimited(req, "checkout", 15, 10 * 60_000);
    if (limited) return withCors(limited);
    const b = await body(req);
    let userId: string | undefined = b.userId;
    let email = b.email;
    if (!userId && email) { const u = await app.store.getUserByEmail(String(email).toLowerCase()); userId = u?.id; email = u?.email; }
    if (!userId) return err("userId or a known email is required");
    try {
      const r = await app.payments.createCheckout(userId, email ?? "", { packageId: b.packageId, customCredits: b.customCredits }, url.origin);
      return json(r);
    } catch (e: any) { return err(e?.message ?? String(e)); }
  }

  if (path === "/webhooks/paddle" && method === "POST") {
    // Source-IP allowlist (Paddle's published egress IPs) in FRONT of the signature check.
    // The IP is the LAST X-Forwarded-For entry — the one appended by OUR proxy (Caddy/Fly);
    // the first entry is client-supplied and spoofable. Prod always sits behind that proxy,
    // so an empty header is also rejected. Skipped in DEV (local tunnels, tests, mock);
    // if the allowlist cannot be fetched, the HMAC signature alone gates (fail-open there,
    // never on a definitive non-Paddle IP).
    if (!IS_DEV && !app.payments.mock) {
      const xff = req.headers.get("x-forwarded-for") ?? "";
      const ip = xff.split(",").pop()?.trim() ?? "";
      if ((await isPaddleIp(ip)) === false) {
        log.warn("[paddle] webhook from non-Paddle IP rejected", { ip });
        return json({ ok: false, note: "source IP not in Paddle's published ranges" }, 403);
      }
    }
    const raw = await req.text();
    const sig = req.headers.get("paddle-signature");
    const r = await app.payments.handleWebhook(raw, sig);
    return json(r, r.ok ? 200 : 400);
  }

  if (path === "/download/manifest" && method === "GET") {
    // Real client release artifacts (signed macOS .dmg + sha256) are set via config when the
    // build is published: env CLIENT_DOWNLOAD_MANIFEST_JSON. Before publication — 503.
    const raw = optionalEnv("CLIENT_DOWNLOAD_MANIFEST_JSON");
    if (raw) {
      try { return json(JSON.parse(raw)); } catch { return err("CLIENT_DOWNLOAD_MANIFEST_JSON is malformed", 500); }
    }
    return json({ message: "client release not published yet" }, 503);
  }

  // ── public pricing/estimate (for the run form) ──────────────────────────────
  if (path === "/api/models" && method === "GET") {
    return json({ models: modelInfos(), defaultModel: DEFAULT_MODEL });
  }
  if (path === "/api/packages" && method === "GET") {
    // TopupCatalog: fixed packages + the custom-amount config (null → custom disabled).
    return json({ packages: topupCatalog(), custom: app.payments.customRange() });
  }
  if (path === "/api/quote" && method === "GET") {
    const sampleSize = Number(url.searchParams.get("sampleSize") ?? 150);
    const model = url.searchParams.get("model") ?? DEFAULT_MODEL;
    if (!knownModel(model)) return err(`unknown model: ${model}`);
    if (!(sampleSize >= 30 && sampleSize <= 500)) return err("sampleSize must be in [30, 500]");
    const q: RunQuote = { sampleSize, model, pricePerKeyphrase: pricePerKeyphrase(model), quote: quoteFor(sampleSize, model), overshootPct: OVERSHOOT_PCT };
    return json(q);
  }

  // ── activation (key → session-token) ──────────────────────────────────────
  if (path === "/activate" && method === "POST") {
    const limited = rateLimited(req, "activate", 10, 10 * 60_000);
    if (limited) return limited;
    const b = await body(req);
    if (!b.key || !b.device_fp) return err("key and device_fp are required");
    const r = await app.auth.activate(String(b.key), String(b.device_fp));
    if ("error" in r) return err(r.error, 401);
    const resp: ActivateResponse = { session_token: r.token, expires_at: r.expiresAt, hmac_secret: r.hmacSecret };
    return json(resp);
  }

  if (path === "/session/refresh" && method === "POST") {
    const limited = rateLimited(req, "refresh", 30, 10 * 60_000);
    if (limited) return limited;
    const b = await body(req);
    if (!b.session_token || !b.device_fp) return err("session_token and device_fp are required");
    const r = await app.auth.refresh(String(b.session_token), String(b.device_fp));
    if ("error" in r) return err(r.error, 401);
    const resp: ActivateResponse = { session_token: r.token, expires_at: r.expiresAt, hmac_secret: r.hmacSecret };
    return json(resp);
  }

  // ── account (session-token auth) ─────────────────────────────────────────
  if (path === "/account" && method === "GET") {
    const token = bearer(req);
    const sess = token ? await app.auth.verifySessionAsync(token) : null;
    if (!sess) return err("valid token required", 401);
    const credits = await app.billing.balance(sess.userId);
    const ledger = await app.store.listLedger(sess.userId, 50);
    return json(balanceView(credits, ledger));
  }

  // ── run endpoints (session-token auth) ──────────────────────────────────────
  const token = bearer(req);
  const sess = token ? await app.auth.verifySessionAsync(token) : null;

  if (path === "/api/balance" && method === "GET") {
    if (!sess) return err("unauthorized", 401);
    const credits = await app.billing.balance(sess.userId);
    const ledger = await app.store.listLedger(sess.userId, 50);
    return json(balanceView(credits, ledger));
  }

  if (path === "/api/topup" && method === "POST") {
    if (!sess) return err("unauthorized", 401);
    const b = await body(req);
    const user = await app.store.getUserById(sess.userId);
    try {
      const r = await app.payments.createCheckout(sess.userId, user?.email ?? "", { packageId: b.packageId, customCredits: b.customCredits }, url.origin);
      return json(r);
    } catch (e: any) { return err(e?.message ?? String(e)); }
  }

  // DEV helper: simulate a successful payment (DEV=1 only).
  if (path === "/api/dev/complete-checkout" && method === "POST") {
    if (!IS_DEV) return err("unavailable outside DEV=1", 404);
    if (!sess) return err("unauthorized", 401);
    const b = await body(req);
    try {
      const sel = b.customCredits !== undefined ? { customCredits: Number(b.customCredits) } : { packageId: String(b.packageId ?? "p10") };
      return json(await app.payments.devComplete(sess.userId, sel));
    } catch (e: any) { return err(e?.message ?? String(e)); }
  }

  if (path === "/api/runs" && method === "POST") {
    if (!sess) return err("unauthorized", 401);
    const b = await body(req);
    if (!b.brief || typeof b.brief !== "string") return err("brief is required");
    const config: RunConfig = defaultRunConfig((b.config ?? {}) as Partial<RunConfig>);
    const verrs = validateRunConfig(config);
    if (Object.keys(verrs).length) return json({ error: "config invalid", fields: verrs }, 400);
    const runId = await app.manager.createRun(sess.userId, b.brief, config);
    void app.manager.startRun(runId); // background: context → context_review
    return json({ runId });
  }

  if (path === "/api/runs" && method === "GET") {
    if (!sess) return err("unauthorized", 401);
    return json({ runs: await app.manager.listRuns(sess.userId) });
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/[^/]+)?$/);
  if (runMatch) {
    if (!sess) return err("unauthorized", 401);
    const runId = runMatch[1];
    const sub = runMatch[2];
    // AUTHORITATIVE ownership via manager.ownerOf (store-backed for cold runs) — fail-closed.
    // The old `userOf() && userOf() !== user` check failed OPEN after a restart (cross-tenant read).
    if ((await app.manager.ownerOf(runId)) !== sess.userId) return err("not your run", 403);

    if (!sub && method === "GET") {
      const state = await app.manager.getState(runId);
      return state ? json(state) : err("run not found", 404);
    }
    if (sub === "/keywords" && method === "GET") {
      const state = await app.manager.getState(runId);
      return state ? json({ keywords: state.keywords }) : err("run not found", 404);
    }
    if (sub === "/llm-log" && method === "GET") {
      // D9: outputs+numbers only (LlmLogPublic).
      return json({ log: await app.manager.llmLog(runId) });
    }
    // ── spec 09: insights & exports (direct REST mirror of the WSS query kinds; tests/dev-UI) ──
    if (sub === "/keywords-lite" && method === "GET") {
      return json(await app.manager.keywordsLite(runId));
    }
    if (sub === "/competitors" && method === "GET") {
      return json(await app.manager.competitors(runId));
    }
    if (sub === "/export" && method === "GET") {
      const format = url.searchParams.get("format") ?? "";
      if (!["csv", "md", "json", "html"].includes(format)) return err(`unknown export format: ${format}`);
      const artifact = await app.manager.exportArtifact(runId, format as "csv" | "md" | "json" | "html");
      if (!artifact) return err("run not found", 404);
      return new Response(artifact.content, {
        headers: {
          "content-type": artifact.mime,
          "content-disposition": `attachment; filename="${artifact.filename}"`,
        },
      });
    }
    if (sub === "/snapshot" && method === "GET") {
      const snap = await app.manager.runSnapshot(runId);
      return snap ? json(snap) : err("run not found", 404);
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

/** Run progress SSE stream: replay-then-tail (D7: Last-Event-ID → run_events.seq). */
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
