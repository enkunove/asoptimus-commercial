// Projects manager-level integration (spec 10 §9): fresh in-process app (no shared singleton,
// same pattern as admin.test.ts) on MemoryStore + mock LLM + Apple loopback, driven through
// the REAL HTTP handler. Covers: project lifecycle, run gating (project required, foreign
// rejected), context seeding + save-on-confirm, finishRun bank upsert, apply/rollback/markLive
// version semantics, positions fee idempotency, and the loopback positions check.

import { describe, test, expect } from "bun:test";

process.env.DEV = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.REQUIRE_CLIENT;
delete process.env.DATABASE_URL;
delete process.env.PADDLE_API_KEY;
delete process.env.PADDLE_WEBHOOK_SECRET;
delete process.env.BETA_GATED;
delete process.env.ADMIN_TOKEN;
delete process.env.POSITIONS_FEE;

const { MemoryStore } = await import("./db/memory-store.ts");
const { BillingService } = await import("./billing/service.ts");
const { AuthService } = await import("./auth/service.ts");
const { PaddleService } = await import("./paddle/service.ts");
const { createEmailService } = await import("./email/service.ts");
const { ClientHub } = await import("./apple-dispatch/hub.ts");
const { RunManager } = await import("./orchestrator/manager.ts");
const { MockLlmClient } = await import("./llm-proxy/mock.ts");
const { handleHttp } = await import("./api/http.ts");
const { positionsFee } = await import("./billing/prices.ts");
const { MARKETS } = await import("./core/locales.ts");
const { STOREFRONTS } = await import("@aso/shared");

const store = new MemoryStore();
const billing = new BillingService(store);
const auth = new AuthService(store);
const email = createEmailService();
const payments = new PaddleService(store, billing, email);
const hub = new ClientHub();
const manager = new RunManager(store, billing, new MockLlmClient(), hub, { allowLoopback: true });
const app = { store, billing, auth, email, payments, paddle: payments, tbc: null, hub, manager } as any;

async function http(method: string, path: string, body?: unknown, token?: string) {
  return handleHttp(app, new Request("http://projects.test" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
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

let token = "";
let userId = "";
let attackerToken = "";
let projectId = "";
let runId = "";

async function signupAndActivate(mail: string, device: string): Promise<string> {
  const su = await http("POST", "/signup", { email: mail });
  const key = (await su.json()).devKey as string;
  const act = await http("POST", "/activate", { key, device_fp: device });
  return (await act.json()).session_token as string;
}

async function getProject(): Promise<any> {
  const res = await http("GET", `/api/projects/${projectId}`, undefined, token);
  expect(res.status).toBe(200);
  return res.json();
}

describe("MARKETS table", () => {
  test("every entry's country exists in STOREFRONTS; priority order starts at en-US", () => {
    expect(MARKETS.length).toBeGreaterThanOrEqual(10);
    for (const m of MARKETS) expect(m.country in STOREFRONTS).toBe(true);
    expect(MARKETS[0].locale).toBe("en-US");
  });
});

describe("projects: lifecycle + run gating", () => {
  test("setup: two tenants, credits for the first", async () => {
    token = await signupAndActivate("proj@test.dev", "proj-device");
    attackerToken = await signupAndActivate("intruder@test.dev", "intruder-device");
    userId = auth.verifySession(token)!.userId;
    const topup = await http("POST", "/api/dev/complete-checkout", { packageId: "p10" }, token);
    expect(topup.status).toBe(200);
  });

  test("create project parses the App Store URL; card shows on home", async () => {
    const bad = await http("POST", "/api/projects/op",
      { kind: "create", name: "Somna", brand: "Somna", appStoreUrl: "not a url" }, token);
    expect(bad.status).toBe(400);

    const res = await http("POST", "/api/projects/op",
      { kind: "create", name: "Somna", brand: "Somna", appStoreUrl: "https://apps.apple.com/us/app/somna/id6448311069" }, token);
    expect(res.status).toBe(200);
    projectId = (await res.json()).data.projectId;
    expect(projectId).toMatch(/^proj_/);

    const cards = (await (await http("GET", "/api/projects", undefined, token)).json()).projects;
    expect(cards.length).toBe(1);
    expect(cards[0].appStoreId).toBe(6448311069);
    expect(cards[0].localesCovered).toEqual([]);

    // link-app is NOT suggested (already linked); the grid still shows uncovered market slots.
    const view = await getProject();
    expect(view.suggestions.some((s: any) => s.kind === "link-app")).toBe(false);
    expect(view.coverage.filter((c: any) => !c.covered).length).toBeGreaterThan(0);
    expect(view.coverage.filter((c: any) => !c.covered)[0].estimateCredits).toBeGreaterThan(0);
  });

  test("run.create without a project or with a foreign project is rejected", async () => {
    const noProject = await http("POST", "/api/runs", { brief: BRIEF, config: { brand: "Somna" } }, token);
    expect(noProject.status).toBe(400);

    const foreign = await http("POST", "/api/runs",
      { brief: BRIEF, project_id: projectId, config: { brand: "Somna" } }, attackerToken);
    expect(foreign.status).toBe(404); // fail-closed: does not reveal the project exists

    const ghost = await http("POST", "/api/runs",
      { brief: BRIEF, project_id: "proj_nope", config: { brand: "Somna" } }, token);
    expect(ghost.status).toBe(404);
  });

  test("foreign project reads/ops are fail-closed 404/400", async () => {
    expect((await http("GET", `/api/projects/${projectId}`, undefined, attackerToken)).status).toBe(404);
    expect((await http("GET", `/api/projects/${projectId}/bank`, undefined, attackerToken)).status).toBe(404);
    const op = await http("POST", "/api/projects/op",
      { kind: "archive", projectId, archived: true }, attackerToken);
    expect(op.status).toBe(400);
    expect((await getProject()).archived).toBe(false); // untouched
  });

  test("run to done: context saved to project on confirm; bank upserted on finish", async () => {
    const created = await http("POST", "/api/runs", {
      brief: BRIEF,
      project_id: projectId,
      config: { brand: "Somna", sampleSize: 30, batchSize: 10, improvementRounds: 0 },
    }, token);
    expect(created.status).toBe(200);
    runId = (await created.json()).runId;

    const state = async () => (await (await http("GET", `/api/runs/${runId}`, undefined, token)).json());
    await waitFor(async () => (await state()).phase === "context_review", 30_000, "context_review");
    expect((await getProject()).context).toBeNull(); // saved on CONFIRM, not on extraction

    await http("POST", `/api/runs/${runId}/control`, { action: { type: "confirmContext" } }, token);
    await waitFor(async () => (await getProject()).context !== null, 10_000, "context saved to project");
    await waitFor(async () => (await state()).phase === "done", 120_000, "run done");

    // Bank: every measured keyword (D ≠ null) landed under (us, en) with latest metrics.
    const bank = await (await http("GET", `/api/projects/${projectId}/bank?pageSize=200`, undefined, token)).json();
    expect(bank.total).toBeGreaterThan(0);
    expect(bank.buckets).toEqual([{ storefront: "us", language: "en", count: bank.total }]);
    expect(bank.items[0].metrics.runId).toBe(runId);

    // The done run surfaces as an apply proposal + apply-run suggestion.
    const view = await getProject();
    expect(view.proposals.length).toBe(1);
    expect(view.proposals[0].runId).toBe(runId);
    expect(Object.keys(view.proposals[0].locales)).toContain("en-US");
    expect(view.suggestions.some((s: any) => s.kind === "apply-run")).toBe(true);

    // Project-scoped run list + RunSummary.projectId.
    const runsScoped = await (await http("GET", `/api/projects/${projectId}/runs`, undefined, token)).json();
    expect(runsScoped.runs.length).toBe(1);
    expect(runsScoped.runs[0].projectId).toBe(projectId);
  }, 180_000);

  test("second run seeds the confirmed project context (no LLM extraction)", async () => {
    const created = await http("POST", "/api/runs", {
      brief: BRIEF,
      project_id: projectId,
      config: { brand: "Somna", sampleSize: 30, batchSize: 10, improvementRounds: 0 },
    }, token);
    const run2 = (await created.json()).runId as string;
    const state = async () => (await (await http("GET", `/api/runs/${run2}`, undefined, token)).json());
    await waitFor(async () => (await state()).phase === "context_review", 15_000, "seeded context_review");
    const s = await state();
    expect(s.context.productSummary).toBe((await getProject()).context.productSummary);
    // No "context" LLM step was billed or logged for the seeded run.
    const log = await (await http("GET", `/api/runs/${run2}/llm-log`, undefined, token)).json();
    expect(log.log.filter((l: any) => l.task === "context").length).toBe(0);
    // Cleanup: keep this run inert (paused at review) — later tests only look at run 1.
  }, 30_000);
});

describe("projects: versions (apply → edit carry-over → rollback → markLive)", () => {
  let proposed: Record<string, { title: string; subtitle: string; keywords: string }> = {};

  test("applyMetadata builds v1 from the selection", async () => {
    const view = await getProject();
    proposed = view.proposals[0].locales;
    const locales = Object.keys(proposed);
    const selection = Object.fromEntries(locales.map((l) => [l, { title: true, subtitle: true, keywords: true }]));
    const res = await http("POST", "/api/projects/op",
      { kind: "applyMetadata", projectId, runId, selection }, token);
    expect(res.status).toBe(200);
    const { version } = (await res.json()).data;
    expect(version.v).toBe(1);
    expect(version.source).toEqual({ type: "run", runId });
    expect(version.note).toContain("from run");
    expect(version.locales["en-US"]).toEqual(proposed["en-US"]);

    const after = await getProject();
    expect(after.latestVersion).toBe(1);
    expect(after.proposals.length).toBe(0); // applied → no longer a pending proposal
    expect(after.coverage.find((c: any) => c.locale === "en-US")?.covered).toBe(true);
    expect(after.coverage.find((c: any) => c.locale === "en-US")?.sourceRunId).toBe(runId);
  });

  test("second apply (title only, with an inline edit) builds v2 carrying untouched fields", async () => {
    const res = await http("POST", "/api/projects/op", {
      kind: "applyMetadata", projectId, runId,
      selection: { "en-US": { title: true } },
      edits: { "en-US": { title: "Somna — Habit Tracker" } },
      note: "title iteration",
    }, token);
    expect(res.status).toBe(200);
    const { version } = (await res.json()).data;
    expect(version.v).toBe(2);
    expect(version.note).toBe("title iteration");
    expect(version.locales["en-US"].title).toBe("Somna — Habit Tracker");
    // Untouched fields carried over from v1 — and every other v1 locale survives whole.
    expect(version.locales["en-US"].subtitle).toBe(proposed["en-US"].subtitle);
    expect(version.locales["en-US"].keywords).toBe(proposed["en-US"].keywords);
    for (const l of Object.keys(proposed)) expect(version.locales[l]).toBeDefined();
  });

  test("rollback creates v3 = a copy of v1 (append-only, no rewrites)", async () => {
    const res = await http("POST", "/api/projects/op", { kind: "rollback", projectId, toV: 1 }, token);
    expect(res.status).toBe(200);
    const { version } = (await res.json()).data;
    expect(version.v).toBe(3);
    expect(version.source).toEqual({ type: "rollback", fromV: 1 });
    expect(version.locales["en-US"]).toEqual(proposed["en-US"]);
    expect((await getProject()).versionsSummary.length).toBe(3); // v1 and v2 still in history
  });

  test("markLive sets the pointer; editMetadata makes a manual v4", async () => {
    expect((await http("POST", "/api/projects/op", { kind: "markLive", projectId, v: 99 }, token)).status).toBe(400);
    expect((await http("POST", "/api/projects/op", { kind: "markLive", projectId, v: 3 }, token)).status).toBe(200);
    expect((await getProject()).liveVersion).toBe(3);

    const res = await http("POST", "/api/projects/op", {
      kind: "editMetadata", projectId,
      locales: { "en-US": { title: "Somna: Habits", subtitle: "Small steps daily", keywords: "habit,routine,streak" } },
    }, token);
    const { version } = (await res.json()).data;
    expect(version.v).toBe(4);
    expect(version.source.type).toBe("manual");
    const view = await getProject();
    expect(view.liveVersion).toBe(3); // live pointer survives new versions
    expect(view.latestVersion).toBe(4);
  });

  test("project export carries the current version and the bank", async () => {
    const csv = await http("GET", `/api/projects/${projectId}/export?format=csv`, undefined, token);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain("locale,title,subtitle,keywords");
    expect(text).toContain("en-US");
    expect(text).toContain("# keyword bank");
    const json = await (await http("GET", `/api/projects/${projectId}/export?format=json`, undefined, token)).json();
    expect(json.version.v).toBe(4);
    expect(json.bank.length).toBeGreaterThan(0);
  });
});

describe("projects: bank curation + positions", () => {
  test("bankFlag pin/hide survives a re-upsert (finishRun refresh)", async () => {
    const bank = await (await http("GET", `/api/projects/${projectId}/bank`, undefined, token)).json();
    const kw = bank.items[0].keyword;
    const res = await http("POST", "/api/projects/op",
      { kind: "bankFlag", projectId, storefront: "us", language: "en", keyword: kw, pinned: true }, token);
    expect(res.status).toBe(200);
    // Re-upsert the same keyword (what the next finishRun does) — the pin must survive.
    await store.upsertProjectKeywords(projectId, "us", "en",
      [{ keyword: kw, metrics: { P: 1, D: 2, R: 3, score: 99, status: "rated", reason: null, runId: "run_next", ts: "t" } }]);
    const after = await (await http("GET", `/api/projects/${projectId}/bank?pinned=1`, undefined, token)).json();
    expect(after.items.map((i: any) => i.keyword)).toContain(kw);
    expect(after.items.find((i: any) => i.keyword === kw).metrics.score).toBe(99);
  });

  test("positions fee debit is one idempotent ledger row keyed pos:<checkId>", async () => {
    const before = await billing.balance(userId);
    const a = await billing.chargeKeyphrase(userId, `proj:${projectId}`, "pos:fixed-check", 0.1);
    expect(a.charged).toBe(true);
    const b = await billing.chargeKeyphrase(userId, `proj:${projectId}`, "pos:fixed-check", 0.1);
    expect(b.alreadyCharged).toBe(true);
    expect(await billing.balance(userId)).toBeCloseTo(before - 0.1, 6);
  });

  test("checkPositions (loopback): debits n×fee, appends history rows, view renders", async () => {
    const before = await billing.balance(userId);
    const res = await http("POST", "/api/projects/op", { kind: "checkPositions", projectId, storefront: "us" }, token);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.tracked).toBeGreaterThan(0);
    expect(data.credits).toBeCloseTo(data.tracked * positionsFee(), 6);
    expect(await billing.balance(userId)).toBeCloseTo(before - data.credits, 4);

    const view = await (await http("GET", `/api/projects/${projectId}/positions?storefront=us`, undefined, token)).json();
    expect(view.storefront).toBe("us");
    expect(view.items.length).toBeGreaterThan(0);
    // Loopback mockSerp never contains our real trackId — honest "not ranked" rows with history.
    const checked = view.items.filter((i: any) => i.checkedAt);
    expect(checked.length).toBe(data.tracked);
    expect(checked[0].history.length).toBe(1);
    expect(checked[0].serpSize).toBeGreaterThan(0);

    const summary = (await getProject()).positionsSummary;
    expect(summary?.[0].storefront).toBe("us");
    expect(summary?.[0].tracked).toBe(data.tracked);
  });

  test("checkPositions without an app id is rejected with a settings nudge", async () => {
    const res = await http("POST", "/api/projects/op", { kind: "update", projectId, appStoreUrl: null }, token);
    expect(res.status).toBe(200);
    const check = await http("POST", "/api/projects/op", { kind: "checkPositions", projectId, storefront: "us" }, token);
    expect(check.status).toBe(400);
    expect((await check.json()).error).toMatch(/link your app store/i);
    await http("POST", "/api/projects/op", { kind: "update", projectId, appStoreUrl: "id6448311069" }, token);
  });
});

describe("projects: archive + delete", () => {
  test("archive is reversible and reflected on cards", async () => {
    await http("POST", "/api/projects/op", { kind: "archive", projectId, archived: true }, token);
    let cards = (await (await http("GET", "/api/projects", undefined, token)).json()).projects;
    expect(cards[0].archived).toBe(true);
    await http("POST", "/api/projects/op", { kind: "archive", projectId, archived: false }, token);
    cards = (await (await http("GET", "/api/projects", undefined, token)).json()).projects;
    expect(cards[0].archived).toBe(false);
  });

  test("delete needs the exact name; runs stay as rows but leave the lists", async () => {
    const wrong = await http("POST", "/api/projects/op", { kind: "delete", projectId, confirmName: "somna " }, token);
    expect(wrong.status).toBe(400);
    const right = await http("POST", "/api/projects/op", { kind: "delete", projectId, confirmName: "Somna" }, token);
    expect(right.status).toBe(200);

    expect((await http("GET", `/api/projects/${projectId}`, undefined, token)).status).toBe(404);
    // The run row survives (orphaned) but is hidden from the flat list.
    expect(await store.getRun(runId)).not.toBeNull();
    const runs = (await (await http("GET", "/api/runs", undefined, token)).json()).runs;
    expect(runs.some((r: any) => r.runId === runId)).toBe(false);
  });
});
