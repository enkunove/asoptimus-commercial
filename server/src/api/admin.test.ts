// Admin foundation (admin/SPEC.md §3): token auth, waitlist import → invite → beta-gated
// signup with the free welcome grant, manual grants, aggregates. Runs against a FRESH
// in-process app (no shared singleton — other test files must not pollute the counts).

import { describe, test, expect, beforeAll } from "bun:test";

process.env.DEV = "1";
delete process.env.PADDLE_API_KEY;
delete process.env.PADDLE_WEBHOOK_SECRET;
delete process.env.TOPUP_PACKAGES_JSON;
process.env.ADMIN_TOKEN = "test-admin-token-123";
process.env.BETA_GATED = "1";
process.env.BETA_GRANT_CREDITS = "30";

const { MemoryStore } = await import("../db/memory-store.ts");
const { BillingService } = await import("../billing/service.ts");
const { AuthService } = await import("../auth/service.ts");
const { PaddleService } = await import("../paddle/service.ts");
const { createEmailService } = await import("../email/service.ts");
const { ClientHub } = await import("../apple-dispatch/hub.ts");
const { RunManager } = await import("../orchestrator/manager.ts");
const { handleHttp } = await import("./http.ts");

const store = new MemoryStore();
const billing = new BillingService(store);
const auth = new AuthService(store);
const email = createEmailService();
const payments = new PaddleService(store, billing, email);
const hub = new ClientHub();
const stubLlm = { kind: "mock", callOnce: async () => ({ text: "{}", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } as any;
const manager = new RunManager(store, billing, stubLlm, hub, { allowLoopback: true });
const app = { store, billing, auth, email, payments, hub, manager } as any;

const ADMIN = "test-admin-token-123";
async function http(method: string, path: string, body?: unknown, token?: string) {
  return handleHttp(app, new Request("http://t.test" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
}
const adm = (method: string, path: string, body?: unknown) => http(method, "/admin/api" + path, body, ADMIN);

describe("admin auth", () => {
  test("no/wrong token → 401; right token → ok; unset ADMIN_TOKEN → 404", async () => {
    expect((await http("GET", "/admin/api/me")).status).toBe(401);
    expect((await http("GET", "/admin/api/me", undefined, "nope")).status).toBe(401);
    expect((await adm("GET", "/me")).status).toBe(200);
    const saved = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    expect((await http("GET", "/admin/api/me", undefined, ADMIN)).status).toBe(404);
    expect((await http("GET", "/admin")).status).toBe(404);
    process.env.ADMIN_TOKEN = saved;
  });
});

describe("waitlist → invite → beta-gated signup", () => {
  test("import validates and dedupes", async () => {
    const r = await (await adm("POST", "/waitlist/import", {
      emails: ["Alpha@Beta.dev", "alpha@beta.dev", "not-an-email", "second@list.io"],
      note: "batch-1",
    })).json();
    expect(r).toEqual({ added: 2, duplicates: 0, invalid: 1 });
    const again = await (await adm("POST", "/waitlist/import", { emails: ["alpha@beta.dev"] })).json();
    expect(again.duplicates).toBe(1);
  });

  test("stranger signup is blocked while gated; pending (uninvited) too", async () => {
    expect((await http("POST", "/signup", { email: "stranger@no.list" })).status).toBe(403);
    expect((await http("POST", "/signup", { email: "alpha@beta.dev" })).status).toBe(403);
  });

  test("invite all pending marks them invited and 'sends' emails", async () => {
    const r = await (await adm("POST", "/waitlist/invite", {})).json();
    expect(r.invited).toBe(2);
    expect(r.failed).toEqual([]);
    const wl = await (await adm("GET", "/waitlist?status=invited")).json();
    expect(wl.counts.invited).toBe(2);
    expect(wl.counts.pending).toBe(0);
  });

  test("invited email signs up → devKey + $30 welcome grant with note", async () => {
    const r = await (await http("POST", "/signup", { email: "alpha@beta.dev" })).json();
    expect(r.devKey).toMatch(/^asop_live_/);
    const userId = r.userId as string;
    expect(await billing.balance(userId)).toBe(30);
    const ledger = await store.listLedger(userId, 10);
    expect(ledger[0].note).toBe("beta welcome grant");
    expect(ledger[0].paddle_event_id).toBe(`beta_${userId}`);
    const wl = await (await adm("GET", "/waitlist?status=signed_up")).json();
    expect(wl.counts.signedUp).toBe(1);
  });

  test("waitlist delete removes an entry", async () => {
    await adm("POST", "/waitlist/import", { emails: ["temp@rm.io"] });
    expect((await (await adm("DELETE", "/waitlist/temp%40rm.io")).json()).ok).toBe(true);
    const wl = await (await adm("GET", "/waitlist?status=all")).json();
    expect(wl.items.some((w: any) => w.email === "temp@rm.io")).toBe(false);
  });
});

describe("user management + transparency", () => {
  let userId = "";
  beforeAll(async () => {
    const users = await (await adm("GET", "/users?q=alpha")).json();
    userId = users.items[0].id;
  });

  test("users list carries the aggregates", async () => {
    const users = await (await adm("GET", "/users?q=alpha")).json();
    expect(users.total).toBe(1);
    const u = users.items[0];
    expect(u.email).toBe("alpha@beta.dev");
    expect(u.balance).toBe(30);
    expect(u.granted).toBe(30);
    expect(u.spent).toBe(0);
    expect(u.waitlist.signedUpAt).toBeTruthy();
  });

  test("manual grant: validation + balance + live push + ledger note", async () => {
    expect((await adm("POST", `/users/${userId}/grant`, { credits: 0, note: "x" })).status).toBe(400);
    expect((await adm("POST", `/users/${userId}/grant`, { credits: 10 })).status).toBe(400); // note required
    const pushes: number[] = [];
    hub.register({ userId, deviceFp: "fp", send: (m: any) => { if (m.t === "balance") pushes.push(m.credits); } });
    const r = await (await adm("POST", `/users/${userId}/grant`, { credits: 25, note: "support comp" })).json();
    expect(r).toEqual({ ok: true, balance: 55 });
    expect(pushes).toEqual([55]);
    const detail = await (await adm("GET", `/users/${userId}`)).json();
    expect(detail.ledger[0].note).toBe("support comp");
    expect(detail.ledger[0].ref).toMatch(/^admin_/);
    hub.unregister(userId);
  });

  test("reissue-key adds a license; revoke-license flips it and kills sessions", async () => {
    expect((await (await adm("POST", `/users/${userId}/reissue-key`)).json()).ok).toBe(true);
    let detail = await (await adm("GET", `/users/${userId}`)).json();
    expect(detail.licenses.length).toBe(2);
    const target = detail.licenses.find((l: any) => l.status === "active");
    expect((await (await adm("POST", `/users/${userId}/revoke-license`, { keyHash: target.keyHash })).json()).ok).toBe(true);
    detail = await (await adm("GET", `/users/${userId}`)).json();
    expect(detail.licenses.filter((l: any) => l.status === "revoked").length).toBe(1);
    // foreign hash → 404
    expect((await adm("POST", `/users/${userId}/revoke-license`, { keyHash: "f".repeat(64) })).status).toBe(404);
  });

  test("overview + finance shapes are consistent with the ledger", async () => {
    const o = await (await adm("GET", "/overview")).json();
    expect(o.users.total).toBe(1);
    expect(o.credits.granted).toBe(55);
    expect(o.credits.grantedFree).toBe(55); // beta + admin grants, nothing paid
    expect(o.credits.outstanding).toBe(55);
    expect(o.waitlist.signedUp).toBe(1);
    const f = await (await adm("GET", "/finance?days=7")).json();
    expect(f.series.length).toBe(7);
    const today = f.series[f.series.length - 1];
    expect(today.granted).toBe(55);
    expect(today.grantedPaid).toBe(0);
    expect(f.recentTopups).toEqual([]);
  });

  test("runs list + live are well-shaped when empty", async () => {
    const runs = await (await adm("GET", "/runs")).json();
    expect(runs).toEqual({ total: 0, page: 0, pageSize: 50, items: [] });
    const live = await (await adm("GET", "/live")).json();
    expect(live).toEqual({ clients: [], orchestrators: [] });
  });

  test("beta endpoint reflects env", async () => {
    expect(await (await adm("GET", "/beta")).json()).toEqual({ gated: true, grantCredits: 30 });
  });
});
