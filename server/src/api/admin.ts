// @aso/server/api — admin panel: static SPA under /admin + JSON API under /admin/api/*.
// The CONTRACT is admin/SPEC.md §3 — the SPA is built against that document alone; every
// response shape here must match it exactly.
//
// Auth: single ADMIN_TOKEN (env), Bearer on every API request, timing-safe compare, failed
// attempts rate-limited per IP. No ADMIN_TOKEN set → the whole /admin surface is 404 (off).
// The SPA static files carry no data — only the API is token-gated.

import { createHash, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import type { App } from "../app.ts";
import { hashKey, generateKey } from "../auth/service.ts";
import { optionalEnv } from "../env.ts";
import { log } from "../log.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── auth ─────────────────────────────────────────────────────────────────────

const failures = new Map<string, { count: number; resetAt: number }>();
const FAIL_LIMIT = 20;

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

function checkAdminAuth(req: Request, token: string): Response | null {
  const ip = clientIp(req);
  const f = failures.get(ip);
  const now = Date.now();
  if (f && f.resetAt > now && f.count >= FAIL_LIMIT) return err("too many attempts — try later", 429);

  const h = req.headers.get("authorization");
  const presented = h?.startsWith("Bearer ") ? h.slice(7) : "";
  // Compare digests: constant-time regardless of length differences.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  if (presented && timingSafeEqual(a, b)) return null;

  const cur = f && f.resetAt > now ? f : { count: 0, resetAt: now + 60_000 };
  cur.count += 1;
  failures.set(ip, cur);
  return err("unauthorized", 401);
}

// ── static SPA (admin/ui) ────────────────────────────────────────────────────

const STATIC_FILES: Record<string, string> = {
  "": "index.html",
  "index.html": "index.html",
  "app.js": "app.js",
  "styles.css": "styles.css",
  "fixtures.json": "fixtures.json",
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function adminUiDir(): string {
  return resolve(optionalEnv("ADMIN_UI_DIR", "../admin/ui"));
}

async function serveStatic(rel: string): Promise<Response> {
  const name = STATIC_FILES[rel];
  if (!name) return new Response("not found", { status: 404 });
  const file = Bun.file(join(adminUiDir(), name));
  if (!(await file.exists())) {
    return new Response("admin UI not built yet (admin/ui missing on this deployment)", { status: 404 });
  }
  const ext = name.slice(name.lastIndexOf("."));
  return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
}

// ── entry ────────────────────────────────────────────────────────────────────

/** Handles every request under /admin. Returns null only when the path is not /admin*. */
export async function handleAdmin(app: App, req: Request, url: URL, path: string): Promise<Response | null> {
  if (path !== "/admin" && !path.startsWith("/admin/")) return null;
  const token = optionalEnv("ADMIN_TOKEN");
  if (!token) return new Response("not found", { status: 404 }); // admin surface disabled

  if (!path.startsWith("/admin/api/")) {
    const rel = path === "/admin" ? "" : path.slice("/admin/".length);
    return serveStatic(rel);
  }

  const denied = checkAdminAuth(req, token);
  if (denied) return denied;

  const sub = path.slice("/admin/api".length); // e.g. "/overview"
  const method = req.method;
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  try {
    // ── misc ────────────────────────────────────────────────────────────────
    if (sub === "/me" && method === "GET") return json({ ok: true });
    if (sub === "/beta" && method === "GET") {
      return json({
        gated: optionalEnv("BETA_GATED") === "1",
        grantCredits: Math.max(0, Math.round(Number(optionalEnv("BETA_GRANT_CREDITS", "30")) || 0)),
      });
    }

    // ── overview (§3.1) ─────────────────────────────────────────────────────
    if (sub === "/overview" && method === "GET") {
      const now = Date.now();
      const iso30 = new Date(now - 30 * 864e5).toISOString();
      const iso7 = new Date(now - 7 * 864e5).toISOString();
      const [users, runs, totals, cogs, wl] = await Promise.all([
        app.store.adminUsers(),
        app.store.adminRuns(),
        app.store.adminLedgerTotals(),
        app.store.adminCogsTotals(iso30),
        app.store.listWaitlist("all", 0, 1),
      ]);
      const byPhase: Record<string, number> = {};
      for (const r of runs) byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;
      const createdAfter = (isoTs: string) => users.filter((u) => (iso(u.created_at) ?? "") >= isoTs).length;
      return json({
        users: { total: users.length, new7d: createdAfter(iso7), new30d: createdAfter(iso30) },
        waitlist: wl.counts,
        runs: { total: runs.length, active: app.manager.activeOrchestrators().length, byPhase },
        credits: {
          granted: round2(totals.granted), grantedPaid: round2(totals.grantedPaid),
          grantedFree: round2(totals.granted - totals.grantedPaid),
          spent: round2(totals.spent), outstanding: round2(totals.granted - totals.spent),
        },
        finance: {
          approxRevenueUsd: round2(totals.grantedPaid), cogsUsd: round2(cogs.totalUsd),
          cogs30dUsd: round2(cogs.last30dUsd), approxMarginUsd: round2(totals.grantedPaid - cogs.totalUsd),
        },
        live: {
          connectedClients: app.hub.connectedClients().length,
          activeOrchestrators: app.manager.activeOrchestrators().length,
        },
      });
    }

    // ── users (§3.2) ────────────────────────────────────────────────────────
    if (sub === "/users" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
      const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));
      let users = await app.store.adminUsers();
      if (q) users = users.filter((u) => u.email.toLowerCase().includes(q));
      const items = await Promise.all(users.slice(page * pageSize, (page + 1) * pageSize)
        .map((u) => projectAdminUser(app, u)));
      return json({ total: users.length, page, pageSize, items });
    }

    // ── user detail + actions (§3.3, §3.9) ──────────────────────────────────
    const userMatch = sub.match(/^\/users\/([^/]+)(\/[a-z-]+)?$/);
    if (userMatch) {
      const userId = decodeURIComponent(userMatch[1]);
      const action = userMatch[2];
      const user = await app.store.getUserById(userId);
      if (!user) return err("user not found", 404);

      if (!action && method === "GET") {
        const [aggAll, licenses, ledger, runsAll] = await Promise.all([
          app.store.adminUsers(),
          app.store.listLicensesForUser(userId),
          app.store.listLedger(userId, 10_000),
          app.store.adminRuns(),
        ]);
        const agg = aggAll.find((u) => u.id === userId);
        const myRuns = runsAll.filter((r) => r.user_id === userId);
        return json({
          user: agg ? await projectAdminUser(app, agg) : null,
          cogsUsd: round2(myRuns.reduce((s, r) => s + r.cogs_usd, 0)),
          licenses: licenses.map((l) => ({
            keyHash: l.key_hash, keyHashPrefix: l.key_hash.slice(0, 8),
            status: l.status, deviceBound: !!l.device_fp, revokedAt: iso(l.revoked_at),
          })),
          ledger: ledger.map((l) => ({
            ts: iso(l.ts) ?? "", type: l.type, delta: Number(l.delta),
            runId: l.run_id, ref: l.paddle_event_id, note: l.note ?? null,
          })),
          runs: myRuns.map(projectAdminRun),
        });
      }

      if (action === "/grant" && method === "POST") {
        const b = await body();
        const credits = Number(b.credits);
        const note = String(b.note ?? "").trim();
        if (!Number.isInteger(credits) || credits < 1 || credits > 1000) return err("credits must be a whole number between 1 and 1000");
        if (!note) return err("note is required (why is this grant happening?)");
        const ref = `admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await app.billing.grant(userId, credits, ref, note);
        const balance = await app.billing.balance(userId);
        app.hub.broadcast(userId, { t: "balance", credits: balance }); // live tick in the user's app
        log.info("[admin] manual grant", { userId, credits, note });
        return json({ ok: true, balance: round2(balance) });
      }

      if (action === "/reissue-key" && method === "POST") {
        const key = generateKey();
        await app.store.createLicense({ key_hash: hashKey(key), user_id: userId, device_fp: null, status: "active", revoked_at: null });
        await app.email.sendActivationKey(user.email, key);
        log.info("[admin] key reissued", { userId });
        return json({ ok: true });
      }

      if (action === "/revoke-license" && method === "POST") {
        const b = await body();
        const keyHash = String(b.keyHash ?? "");
        const owned = (await app.store.listLicensesForUser(userId)).some((l) => l.key_hash === keyHash);
        if (!owned) return err("license does not belong to this user", 404);
        await app.store.revokeLicense(keyHash);
        await app.store.deleteSessionsForUser(userId);
        log.info("[admin] license revoked", { userId });
        return json({ ok: true });
      }
    }

    // ── runs (§3.4, §3.5) ───────────────────────────────────────────────────
    if (sub === "/runs" && method === "GET") {
      const phase = url.searchParams.get("phase") ?? "";
      const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
      const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));
      let runs = await app.store.adminRuns();
      if (phase) runs = runs.filter((r) => r.phase === phase);
      const emails = await emailIndex(app);
      const items = runs.slice(page * pageSize, (page + 1) * pageSize).map((r) => ({
        ...projectAdminRun(r), userEmail: emails.get(r.user_id) ?? r.user_id,
      }));
      return json({ total: runs.length, page, pageSize, items });
    }

    const runMatch = sub.match(/^\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") {
      const runId = decodeURIComponent(runMatch[1]);
      const snapshot = await app.manager.runSnapshot(runId);
      if (!snapshot) return err("run not found", 404);
      const owner = await app.manager.ownerOf(runId);
      const emails = await emailIndex(app);
      const steps = await app.store.listLlmSteps(runId);
      const llm = steps.reduce((acc, s) => ({
        calls: acc.calls + 1,
        inputTokens: acc.inputTokens + s.usage.inputTokens,
        outputTokens: acc.outputTokens + s.usage.outputTokens,
        costUsd: acc.costUsd + (s.cost_usd ?? 0),
      }), { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      const debitRows = owner
        ? (await app.store.listLedger(owner, 10_000)).filter((l) => l.run_id === runId && l.type === "debit").length
        : 0;
      return json({
        userEmail: (owner && emails.get(owner)) ?? owner ?? "?",
        cogsUsd: round2(llm.costUsd),
        llm: { ...llm, costUsd: round2(llm.costUsd) },
        debits: debitRows,
        snapshot,
      });
    }

    // ── waitlist (§3.6) ─────────────────────────────────────────────────────
    if (sub === "/waitlist" && method === "GET") {
      const status = (url.searchParams.get("status") ?? "all") as "all" | "pending" | "invited" | "signed_up";
      const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
      const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get("pageSize") ?? 100)));
      const r = await app.store.listWaitlist(status, page, pageSize);
      return json({
        total: r.total, counts: r.counts, page, pageSize,
        items: r.items.map((w) => ({
          email: w.email, addedAt: iso(w.added_at), invitedAt: iso(w.invited_at),
          signedUpAt: iso(w.signed_up_at), note: w.note,
        })),
      });
    }

    if (sub === "/waitlist/import" && method === "POST") {
      const b = await body();
      const raw: unknown[] = Array.isArray(b.emails) ? b.emails : [];
      const note = b.note ? String(b.note).slice(0, 200) : null;
      const valid: string[] = [];
      let invalid = 0;
      const seen = new Set<string>();
      for (const e of raw.slice(0, 10_000)) {
        const email = String(e).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { if (email) invalid++; continue; }
        if (seen.has(email)) continue;
        seen.add(email);
        valid.push(email);
      }
      const r = await app.store.waitlistImport(valid, note);
      return json({ added: r.added, duplicates: r.duplicates, invalid });
    }

    if (sub === "/waitlist/invite" && method === "POST") {
      const b = await body();
      const grantCredits = Math.max(0, Math.round(Number(optionalEnv("BETA_GRANT_CREDITS", "30")) || 0));
      let targets: string[];
      if (Array.isArray(b.emails) && b.emails.length) {
        targets = b.emails.map((e: unknown) => String(e).trim().toLowerCase());
      } else {
        const all = await app.store.listWaitlist("pending", 0, 10_000);
        targets = all.items.map((w) => w.email);
      }
      let invited = 0;
      const failed: Array<{ email: string; error: string }> = [];
      for (const email of targets) {
        const entry = await app.store.getWaitlistEntry(email);
        if (!entry) { failed.push({ email, error: "not on the waitlist" }); continue; }
        try {
          await app.email.sendBetaInvite(email, grantCredits);
          await app.store.markWaitlistInvited(email); // keeps the original invitedAt on re-invites
          invited++;
        } catch (e: any) {
          failed.push({ email, error: String(e?.message ?? e) });
        }
      }
      log.info("[admin] beta invites sent", { invited, failed: failed.length });
      return json({ invited, failed });
    }

    const wlDelete = sub.match(/^\/waitlist\/(.+)$/);
    if (wlDelete && method === "DELETE") {
      await app.store.deleteWaitlistEntry(decodeURIComponent(wlDelete[1]).toLowerCase());
      return json({ ok: true });
    }

    // ── finance (§3.7) ──────────────────────────────────────────────────────
    if (sub === "/finance" && method === "GET") {
      const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
      const since = new Date(Date.now() - (days - 1) * 864e5);
      since.setUTCHours(0, 0, 0, 0);
      const sinceIso = since.toISOString();
      const [ledger, cogsRows, emails] = await Promise.all([
        app.store.adminLedgerSince(sinceIso),
        app.store.adminCogsSince(sinceIso),
        emailIndex(app),
      ]);
      const series = new Map<string, { granted: number; grantedPaid: number; spent: number; cogsUsd: number }>();
      for (let i = 0; i < days; i++) {
        series.set(new Date(since.getTime() + i * 864e5).toISOString().slice(0, 10), { granted: 0, grantedPaid: 0, spent: 0, cogsUsd: 0 });
      }
      for (const l of ledger) {
        const day = (iso(l.ts) ?? "").slice(0, 10);
        const s = series.get(day);
        if (!s) continue;
        if (l.type === "grant") {
          s.granted += Number(l.delta);
          if (String(l.paddle_event_id ?? "").startsWith("txn_")) s.grantedPaid += Number(l.delta);
        } else if (l.type === "debit") s.spent += Math.abs(Number(l.delta));
      }
      for (const c of cogsRows) {
        const s = series.get((iso(c.ts) ?? "").slice(0, 10));
        if (s) s.cogsUsd += c.costUsd;
      }
      const recentTopups = ledger
        .filter((l) => l.type === "grant" && String(l.paddle_event_id ?? "").startsWith("txn_"))
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        .slice(0, 20)
        .map((l) => ({ ts: iso(l.ts) ?? "", email: emails.get(l.user_id) ?? l.user_id, credits: Number(l.delta), ref: l.paddle_event_id }));
      return json({
        series: [...series.entries()].map(([date, s]) => ({
          date, granted: round2(s.granted), grantedPaid: round2(s.grantedPaid),
          spent: round2(s.spent), cogsUsd: round2(s.cogsUsd),
        })),
        recentTopups,
      });
    }

    // ── live (§3.8) ─────────────────────────────────────────────────────────
    if (sub === "/live" && method === "GET") {
      const emails = await emailIndex(app);
      return json({
        clients: app.hub.connectedClients().map((c) => ({
          userId: c.userId, email: emails.get(c.userId) ?? "?", deviceFp: c.deviceFp.slice(0, 16),
        })),
        orchestrators: app.manager.activeOrchestrators().map((o) => ({
          runId: o.runId, userEmail: emails.get(o.userId) ?? o.userId,
          phase: o.phase, paused: o.paused, sampleCount: o.sampleCount,
        })),
      });
    }

    return err("not found", 404);
  } catch (e: any) {
    log.error("[admin] handler error", { path: sub, err: String(e?.message ?? e) });
    return err(e?.message ?? String(e), 500);
  }
}

// ── projections ──────────────────────────────────────────────────────────────

async function projectAdminUser(app: App, u: import("../db/types.ts").AdminUserRow) {
  const wl = await app.store.getWaitlistEntry(u.email);
  return {
    id: u.id, email: u.email, createdAt: iso(u.created_at),
    balance: round2(u.balance), granted: round2(u.granted), spent: round2(u.spent),
    runs: u.runs, lastRunAt: iso(u.last_run_at), licenses: u.licenses,
    activeSessions: u.active_sessions, paddleCustomerId: u.paddle_customer_id,
    waitlist: wl && wl.invited_at ? { invitedAt: iso(wl.invited_at), signedUpAt: iso(wl.signed_up_at) } : null,
  };
}

function projectAdminRun(r: import("../db/types.ts").AdminRunRow) {
  return {
    runId: r.id, brand: r.brand, country: r.country, phase: r.phase, paused: r.paused,
    sampleCount: r.sample_count, sampleSize: r.sample_size,
    creditsSpent: round2(r.credits_spent), cogsUsd: round2(r.cogs_usd),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

async function emailIndex(app: App): Promise<Map<string, string>> {
  const users = await app.store.adminUsers();
  return new Map(users.map((u) => [u.id, u.email]));
}
