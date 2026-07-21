// DEV-mode integration test (spec 09 cross-cutting): the single test that would have caught
// every contract/billing bug found on 2026-07-19. Full in-process stack — MemoryStore, mock
// LLM, Apple loopback — driven through the REAL HTTP handler (no sockets):
//   signup → activate → zero-balance gate (create paused; resume blocked; confirmContext
//   blocked; zero LLM calls) → dev top-up → run to done on mocks → export all four formats
//   → diff a run against itself (all-zeros) → competitors aggregation non-empty.

import { describe, test, expect } from "bun:test";

// Force the mock branches BEFORE the app modules are imported (bun auto-loads .env, which in
// dev machines carries a live ANTHROPIC_API_KEY and REQUIRE_CLIENT=1 — both must not leak in).
process.env.DEV = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.REQUIRE_CLIENT;
delete process.env.DATABASE_URL;
delete process.env.TOPUP_PACKAGES_JSON;
delete process.env.PADDLE_API_KEY;
delete process.env.PADDLE_WEBHOOK_SECRET;
delete process.env.PADDLE_CREDIT_PRICE_ID;
delete process.env.BETA_GATED;   // admin.test.ts sets it — signups here must stay open
delete process.env.ADMIN_TOKEN;

const { createApp } = await import("./app.ts");
const { handleHttp } = await import("./api/http.ts");

const app = createApp();
const BASE = "http://server.test";

async function http(method: string, path: string, body?: unknown, token?: string) {
  const req = new Request(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return handleHttp(app, req);
}

async function getState(runId: string, token: string): Promise<any> {
  const res = await http("GET", `/api/runs/${runId}`, undefined, token);
  return res.json();
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const BRIEF = "Somna is a habit tracking app that helps people build healthy daily routines: " +
  "streaks, gentle reminders, morning and evening rituals, water intake, sleep hygiene and focus " +
  "sessions. For young professionals who abandon their goals; competitors are Streaks and Habitica. " +
  "The market is the US App Store, English speaking users, wellness and productivity categories.";

describe("DEV integration: signup → gates → run to done → insights & exports", () => {
  let token = "";
  let runId = "";

  test("signup issues a dev key; activation exchanges it for a session", async () => {
    const su = await http("POST", "/signup", { email: "it@test.dev" });
    expect(su.status).toBe(200);
    const key = (await su.json()).devKey as string;
    expect(key).toMatch(/^asop_(live|test)_/);

    const act = await http("POST", "/activate", { key, device_fp: "it-device-fp" });
    expect(act.status).toBe(200);
    token = (await act.json()).session_token;
    expect(token.length).toBeGreaterThan(10);
  });

  test("zero balance: create pauses at the gate; resume and confirmContext stay blocked; zero LLM calls", async () => {
    expect(await app.billing.balance((app.auth.verifySession(token))!.userId)).toBe(0);

    const created = await http("POST", "/api/runs", {
      brief: BRIEF,
      config: { brand: "Somna", sampleSize: 30, batchSize: 10, improvementRounds: 0 },
    }, token);
    expect(created.status).toBe(200);
    runId = (await created.json()).runId;

    // The background start must hit the credit gate: paused, still phase=created.
    await waitFor(async () => (await getState(runId, token)).paused === true, 5000, "credit-gate pause on start");
    let s = await getState(runId, token);
    expect(s.phase).toBe("created");
    expect(s.notice).toMatch(/credit/i);
    expect(s.usage.calls).toBe(0);

    // resume must NOT slip past the paywall (the 2026-07-19 bug).
    await http("POST", `/api/runs/${runId}/control`, { action: { type: "resume" } }, token);
    await new Promise((r) => setTimeout(r, 400));
    s = await getState(runId, token);
    expect(s.phase).toBe("created");
    expect(s.usage.calls).toBe(0);

    // confirmContext is a transition into paid work too.
    await http("POST", `/api/runs/${runId}/control`, { action: { type: "confirmContext" } }, token);
    await new Promise((r) => setTimeout(r, 400));
    s = await getState(runId, token);
    expect(s.phase).toBe("created");
    expect(s.usage.calls).toBe(0);
  }, 20_000);

  test("dev top-up unblocks; the run reaches done on mock LLM + Apple loopback", async () => {
    const topup = await http("POST", "/api/dev/complete-checkout", { packageId: "p10" }, token);
    expect(topup.status).toBe(200);

    await http("POST", `/api/runs/${runId}/control`, { action: { type: "resume" } }, token);
    await waitFor(async () => (await getState(runId, token)).phase === "context_review", 30_000, "context_review");

    await http("POST", `/api/runs/${runId}/control`, { action: { type: "confirmContext" } }, token);
    await waitFor(async () => (await getState(runId, token)).phase === "done", 120_000, "run done");

    const s = await getState(runId, token);
    expect(s.failed).toBeNull();
    expect(s.usage.calls).toBeGreaterThan(0);
    expect(s.assembly).not.toBeNull();
  }, 180_000);

  test("custom top-up: dev complete grants the exact custom amount", async () => {
    const userId = (app.auth.verifySession(token))!.userId;
    const before = await app.billing.balance(userId);
    const r = await http("POST", "/api/dev/complete-checkout", { customCredits: 7 }, token);
    expect(r.status).toBe(200);
    expect(await app.billing.balance(userId)).toBeCloseTo(before + 7, 6);
    // catalog advertises the custom range so the UI can render the input
    const cat = await (await http("GET", "/api/packages")).json();
    expect(cat.custom).toEqual({ minCredits: 5, maxCredits: 500, usdPerCredit: 1 });
  });

  test("snapshot carries creditsSpent equal to the ledger's per-run debits", async () => {
    const snapRes = await http("GET", `/api/runs/${runId}/snapshot`, undefined, token);
    expect(snapRes.status).toBe(200);
    const snap = await snapRes.json();
    expect(snap.creditsSpent).toBeGreaterThan(0);
    const userId = (app.auth.verifySession(token))!.userId;
    const ledgerSum = (await app.store.listLedger(userId, 10_000))
      .filter((r) => r.run_id === runId && r.type === "debit")
      .reduce((sum, r) => sum + Math.abs(Number(r.delta)), 0);
    expect(snap.creditsSpent).toBeCloseTo(ledgerSum, 2);
  });

  test("all four exports build; export is free (no debits) and calls nothing", async () => {
    const userId = (app.auth.verifySession(token))!.userId;
    const balanceBefore = await app.billing.balance(userId);
    const callsBefore = (await getState(runId, token)).usage.calls;

    for (const format of ["csv", "md", "json", "html"] as const) {
      const res = await http("GET", `/api/runs/${runId}/export?format=${format}`, undefined, token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const text = await res.text();
      expect(text.length).toBeGreaterThan(100);
      if (format === "csv") expect(text.startsWith("keyword,score,P,D,R,status,source,")).toBe(true);
      if (format === "json") {
        const parsed = JSON.parse(text);
        expect(parsed.keywords.length).toBeGreaterThan(0);
        expect(parsed.creditsSpent).toBeGreaterThan(0);
      }
      if (format === "html") {
        expect(text).toContain("asoptimus.com");
        expect(text).not.toMatch(/costUsd|tokens/i);
      }
      if (format === "md") expect(text).toContain("## Formulas");
    }

    // spec 09 acceptance: no credits debited, no LLM calls during export.
    expect(await app.billing.balance(userId)).toBe(balanceBefore);
    expect((await getState(runId, token)).usage.calls).toBe(callsBefore);
  }, 30_000);

  test("keywords-lite: diff of a run against itself is all-zeros", async () => {
    const res = await http("GET", `/api/runs/${runId}/keywords-lite`, undefined, token);
    const lite = await res.json();
    expect(lite.items.length).toBeGreaterThan(0);

    const a = new Map(lite.items.map((i: any) => [i.keyword, i]));
    let gained = 0, lost = 0, moved = 0;
    for (const item of lite.items) {
      const other: any = a.get(item.keyword);
      if (!other) { gained++; continue; }
      if ((other.score ?? 0) !== (item.score ?? 0)) moved++;
    }
    for (const kw of a.keys()) if (!lite.items.some((i: any) => i.keyword === kw)) lost++;
    expect({ gained, lost, moved }).toEqual({ gained: 0, lost: 0, moved: 0 });
  });

  test("competitors aggregation is non-empty and internally consistent", async () => {
    const res = await http("GET", `/api/runs/${runId}/competitors`, undefined, token);
    const comp = await res.json();
    expect(comp.items.length).toBeGreaterThan(0);
    expect(comp.summary.keywordsWithSerp).toBeGreaterThan(0);
    for (const row of comp.items) {
      expect(row.keywords).toBe(row.appearances.length);
      expect(row.share).toBeCloseTo(row.keywords / comp.summary.keywordsWithSerp, 10);
      expect(row.weakSpots).toBe(row.appearances.filter((x: any) => x.strength < 40).length);
    }
  });

  test("ownership is enforced for warm AND cold runs (fail-closed, cross-tenant)", async () => {
    // Second tenant.
    const su = await http("POST", "/signup", { email: "attacker@test.dev" });
    const key = (await su.json()).devKey as string;
    const act = await http("POST", "/activate", { key, device_fp: "attacker-device" });
    const attackerToken = (await act.json()).session_token as string;

    // Warm run (in runUsers): every read/export path must 403.
    for (const path of ["", "/export?format=json", "/keywords-lite", "/competitors", "/snapshot"]) {
      const res = await http("GET", `/api/runs/${runId}${path}`, undefined, attackerToken);
      expect(res.status).toBe(403);
    }

    // Simulate a server restart: the in-memory owner map is empty, the run is only in the store.
    // The old `userOf() === undefined → allow` guard failed OPEN here — must stay 403 now.
    (app.manager as any).runUsers.clear();
    (app.manager as any).orchestrators.clear();
    for (const path of ["", "/export?format=json", "/keywords-lite", "/competitors", "/snapshot"]) {
      const res = await http("GET", `/api/runs/${runId}${path}`, undefined, attackerToken);
      expect(res.status).toBe(403);
    }
    // Control is gated the same way (pause/delete of a foreign run must not be possible).
    const ctl = await http("POST", `/api/runs/${runId}/control`, { action: { type: "pause" } }, attackerToken);
    expect(ctl.status).toBe(403);

    // The rightful owner still reads their run after the "restart".
    const own = await http("GET", `/api/runs/${runId}/snapshot`, undefined, token);
    expect(own.status).toBe(200);

    // run.json export never carries internal usage COGS.
    const exp = await http("GET", `/api/runs/${runId}/export?format=json`, undefined, token);
    const parsed = JSON.parse(await exp.text());
    expect(parsed.state.usage).toBeUndefined();
  });

  test("keyword page filters: insight + only allowlist (spec 09 §4/§7 server side)", async () => {
    const liteRes = await http("GET", `/api/runs/${runId}/keywords-lite`, undefined, token);
    const lite = await liteRes.json();
    const some = lite.items.slice(0, 3).map((i: any) => i.keyword);
    const page = await app.manager.keywordPage(runId, { only: some, pageSize: 50 });
    expect(page.total).toBe(some.length);
    expect(page.items.every((k) => some.includes(k.keyword))).toBe(true);

    const phantoms = lite.items.filter((i: any) => i.unsuggested).length;
    const insightPage = await app.manager.keywordPage(runId, { insight: "unsuggested", pageSize: 200 });
    expect(insightPage.total).toBe(phantoms);
  });

  // Regression: a DONE run recorded by an older pipeline could not be re-loaded once the pipeline
  // changed — replay hit a frontier at the first renamed/new LLM step and left the orchestrator
  // stuck before "done", so reassemble threw "only available after completion". A done run's
  // snapshot is authoritative; when replay can't reach the persisted phase, hydrate from it.
  test("done run whose logs can't replay (pipeline drift) loads from snapshot; reassemble works", async () => {
    // Simulate a restart under drifted code: evict the cached orchestrator and wipe this run's
    // llm_steps so replay hits a frontier at the very first LLM call and stops far short of "done".
    (app.manager as any).orchestrators.delete(runId);
    (app.store as any).llmSteps = (app.store as any).llmSteps.filter((s: any) => s.run_id !== runId);

    const orch = await app.manager.getOrchestrator(runId);
    // Without the fix this would be "created"/"context" (partial replay); with it, the authoritative
    // snapshot wins.
    expect(orch.state.phase).toBe("done");
    expect(orch.state.assembly).not.toBeNull();

    // The actual reported symptom: reassemble must not throw now.
    await orch.reassemble();
    expect(orch.state.phase).toBe("done");
    expect(orch.state.assembly).not.toBeNull();
  });
});
