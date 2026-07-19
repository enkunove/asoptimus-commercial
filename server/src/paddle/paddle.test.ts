// PaddleService: webhook signature verification (ts;h1 HMAC over `ts:rawBody`), grant flow
// idempotent twice over (processed_events by event_id + ledger by TRANSACTION id — Paddle
// re-delivers events under fresh ids and a purchase must never grant twice), dev mock flow.

import { describe, test, expect, beforeAll } from "bun:test";
import { createHmac } from "node:crypto";

process.env.DEV = "1";
delete process.env.TOPUP_PACKAGES_JSON;

const { verifyPaddleSignature, parsePaddleSignature, PaddleService } = await import("./service.ts");
const { MemoryStore } = await import("../db/memory-store.ts");
const { BillingService } = await import("../billing/service.ts");

const SECRET = "pdl_ntfset_test_secret";

function sign(body: string, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

describe("Paddle webhook signature", () => {
  const body = '{"event_type":"transaction.completed"}';

  test("valid ts;h1 verifies; wrong secret / tampered body do not", () => {
    expect(verifyPaddleSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyPaddleSignature(body, sign(body), "other_secret")).toBe(false);
    expect(verifyPaddleSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  test("stale timestamp is rejected (replay guard)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyPaddleSignature(body, sign(body, oldTs), SECRET)).toBe(false);
  });

  test("multiple h1 (secret rotation): any match passes", () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex");
    expect(verifyPaddleSignature(body, `ts=${ts};h1=${"0".repeat(64)};h1=${good}`, SECRET)).toBe(true);
  });

  test("malformed headers are rejected", () => {
    expect(parsePaddleSignature(null)).toBeNull();
    expect(parsePaddleSignature("h1=abc")).toBeNull();
    expect(parsePaddleSignature("ts=123")).toBeNull();
    expect(verifyPaddleSignature(body, "garbage", SECRET)).toBe(false);
  });
});

describe("PaddleService grant flow (DEV mock — unsigned bodies)", () => {
  const store = new MemoryStore();
  const billing = new BillingService(store);
  const email = { async sendActivationKey() {}, async sendReceipt() {} } as any;
  let svc: InstanceType<typeof PaddleService>;

  beforeAll(async () => {
    delete process.env.PADDLE_API_KEY; // force mock branch
    svc = new PaddleService(store, billing, email);
    await store.createUser({ id: "u1", email: "u1@test.dev", paddle_customer_id: null });
    await store.ensureWallet("u1", 0);
  });

  const event = (eventId: string, txnId: string) => JSON.stringify({
    event_id: eventId, event_type: "transaction.completed",
    data: { id: txnId, custom_data: { userId: "u1", packageId: "p10" } },
  });

  test("transaction.completed grants the package credits", async () => {
    const r = await svc.handleWebhook(event("evt_1", "txn_1"), null);
    expect(r.ok).toBe(true);
    expect(await billing.balance("u1")).toBe(10);
  });

  test("same event re-delivered → absorbed by ledger idempotency (never double-grants)", async () => {
    const r = await svc.handleWebhook(event("evt_1", "txn_1"), null);
    expect(r.ok).toBe(true);
    expect(r.note).toContain("idempotent");
    expect(await billing.balance("u1")).toBe(10);
  });

  test("same TRANSACTION under a fresh event_id → ledger idempotency blocks the double grant", async () => {
    const r = await svc.handleWebhook(event("evt_2", "txn_1"), null);
    expect(r.ok).toBe(true);
    expect(r.note).toContain("idempotent");
    expect(await billing.balance("u1")).toBe(10);
  });

  test("other event types are ignored; unroutable custom_data is ACKed with 200 (not ours)", async () => {
    const other = await svc.handleWebhook(JSON.stringify({ event_id: "evt_3", event_type: "transaction.created", data: {} }), null);
    expect(other.note).toContain("ignoring");
    // A dashboard invoice / another product on the account: must ACK, or Paddle counts a
    // delivery failure and retries toward the endpoint's auto-deactivation threshold.
    const missing = await svc.handleWebhook(JSON.stringify({ event_id: "evt_4", event_type: "transaction.completed", data: { id: "txn_9" } }), null);
    expect(missing.ok).toBe(true);
    expect(missing.note).toContain("not ours");
    expect(await billing.balance("u1")).toBe(10);
  });

  test("transient grant failure does NOT lose the purchase: retry with the same event grants", async () => {
    class FlakyStore extends MemoryStore {
      failNext = false;
      async grantCredits(userId: string, credits: number, key: string | null) {
        if (this.failNext) { this.failNext = false; throw new Error("transient db error"); }
        return super.grantCredits(userId, credits, key);
      }
    }
    const flaky = new FlakyStore();
    const flakyBilling = new BillingService(flaky);
    const flakySvc = new PaddleService(flaky, flakyBilling, email);
    await flaky.createUser({ id: "u2", email: "u2@test.dev", paddle_customer_id: null });
    await flaky.ensureWallet("u2", 0);
    const body = JSON.stringify({
      event_id: "evt_retry", event_type: "transaction.completed",
      data: { id: "txn_retry", custom_data: { userId: "u2", packageId: "p10" } },
    });
    flaky.failNext = true;
    // First delivery: the grant throws → the webhook 500s, NOTHING is marked processed.
    await expect(flakySvc.handleWebhook(body, null)).rejects.toThrow("transient");
    expect(await flakyBilling.balance("u2")).toBe(0);
    // Paddle retries the SAME event_id — the mark-then-grant order would skip it as a
    // duplicate forever (paid, never credited). Grant-first makes the retry succeed.
    const retry = await flakySvc.handleWebhook(body, null);
    expect(retry.ok).toBe(true);
    expect(await flakyBilling.balance("u2")).toBe(10);
  });

  test("non-mock without PADDLE_WEBHOOK_SECRET: webhook rejected (no empty-key HMAC), devComplete still works", async () => {
    process.env.PADDLE_API_KEY = "pdl_sdbx_test";
    delete process.env.PADDLE_WEBHOOK_SECRET;
    try {
      const store2 = new MemoryStore();
      const billing2 = new BillingService(store2);
      const sandbox = new PaddleService(store2, billing2, email);
      await store2.createUser({ id: "u3", email: "u3@test.dev", paddle_customer_id: null });
      await store2.ensureWallet("u3", 0);
      // An unsigned (or any) webhook must be rejected — HMAC with "" is forgeable by anyone.
      const rejected = await sandbox.handleWebhook(JSON.stringify({
        event_id: "evt_forged", event_type: "transaction.completed",
        data: { id: "txn_forged", custom_data: { userId: "u3", packageId: "p100" } },
      }), `ts=${Math.floor(Date.now() / 1000)};h1=${"0".repeat(64)}`);
      expect(rejected.ok).toBe(false);
      expect(await billing2.balance("u3")).toBe(0);
      // The documented dev grant path bypasses the signature (DEV-gated) and keeps working.
      const dev = await sandbox.devComplete("u3", { packageId: "p10" });
      expect(dev.ok).toBe(true);
      expect(await billing2.balance("u3")).toBe(10);
    } finally {
      delete process.env.PADDLE_API_KEY;
    }
  });

  test("devComplete grants through the same webhook path", async () => {
    const r = await svc.devComplete("u1", { packageId: "p25" });
    expect(r.ok).toBe(true);
    expect(await billing.balance("u1")).toBe(36); // 10 + 26
  });

  test("mock checkout returns the dev completion URL", async () => {
    const { checkoutUrl } = await svc.createCheckout("u1", "u1@test.dev", { packageId: "p10" }, "http://x.test");
    expect(checkoutUrl).toContain("/checkout/success?dev=1&package=p10&user=u1");
  });

  test("custom amounts: catalog range, checkout URL, webhook grant, bounds enforced", async () => {
    const range = svc.customRange();
    expect(range).toEqual({ minCredits: 5, maxCredits: 500, usdPerCredit: 1 });

    const { checkoutUrl } = await svc.createCheckout("u1", "u1@test.dev", { customCredits: 42 }, "http://x.test");
    expect(checkoutUrl).toContain("credits=42");

    const before = await billing.balance("u1");
    const r = await svc.devComplete("u1", { customCredits: 42 });
    expect(r.ok).toBe(true);
    expect(await billing.balance("u1")).toBe(before + 42);

    // bounds: below min, above max, non-integer, both/neither selection
    await expect(svc.createCheckout("u1", "e", { customCredits: 4 }, "http://x")).rejects.toThrow("between");
    await expect(svc.createCheckout("u1", "e", { customCredits: 501 }, "http://x")).rejects.toThrow("between");
    await expect(svc.createCheckout("u1", "e", { customCredits: 10.5 }, "http://x")).rejects.toThrow("between");
    await expect(svc.createCheckout("u1", "e", { packageId: "p10", customCredits: 10 }, "http://x")).rejects.toThrow("exactly one");
    await expect(svc.createCheckout("u1", "e", {}, "http://x")).rejects.toThrow("exactly one");
  });

  test("customRange survives env typos (NaN must not disable the money guard) and caps max at 1M", async () => {
    process.env.TOPUP_CUSTOM_MIN = "abc";
    process.env.TOPUP_CUSTOM_MAX = "1,000";
    try {
      expect(svc.customRange()).toEqual({ minCredits: 5, maxCredits: 500, usdPerCredit: 1 });
      // With NaN bounds every comparison is false — the old code accepted ANY integer here.
      await expect(svc.createCheckout("u1", "e", { customCredits: 1_000_000 }, "http://x")).rejects.toThrow("between");
      await expect(svc.createCheckout("u1", "e", { customCredits: 0 }, "http://x")).rejects.toThrow("between");
      process.env.TOPUP_CUSTOM_MAX = "99999999";
      expect(svc.customRange()!.maxCredits).toBe(1_000_000); // stays below the webhook's 10M sanity ceiling
    } finally {
      delete process.env.TOPUP_CUSTOM_MIN;
      delete process.env.TOPUP_CUSTOM_MAX;
    }
  });

  test("paid transaction with unresolvable custom_data is NOT silently ACKed (Paddle must retry)", async () => {
    const before = await billing.balance("u1");
    // userId present + garbage amount → our transaction, refuse the ACK.
    const garbage = await svc.handleWebhook(JSON.stringify({
      event_id: "evt_bad1", event_type: "transaction.completed",
      data: { id: "txn_bad1", custom_data: { userId: "u1", customCredits: "garbage" } },
    }), null);
    expect(garbage.ok).toBe(false);
    // userId present + unknown packageId → same refusal.
    const unknown = await svc.handleWebhook(JSON.stringify({
      event_id: "evt_bad2", event_type: "transaction.completed",
      data: { id: "txn_bad2", custom_data: { userId: "u1", packageId: "p_gone" } },
    }), null);
    expect(unknown.ok).toBe(false);
    expect(await billing.balance("u1")).toBe(before);
  });

  test("a checkout-accepted amount above the old 100k clamp still grants (ceilings never cross)", async () => {
    const before = await billing.balance("u1");
    const r = await svc.handleWebhook(JSON.stringify({
      event_id: "evt_big", event_type: "transaction.completed",
      data: { id: "txn_big", custom_data: { userId: "u1", customCredits: 150_000 } },
    }), null);
    expect(r.ok).toBe(true);
    expect(await billing.balance("u1")).toBe(before + 150_000);
  });

  test("webhook grants a custom transaction via custom_data.customCredits", async () => {
    const before = await billing.balance("u1");
    const r = await svc.handleWebhook(JSON.stringify({
      event_id: "evt_custom", event_type: "transaction.completed",
      data: { id: "txn_custom", custom_data: { userId: "u1", customCredits: 7 } },
    }), null);
    expect(r.ok).toBe(true);
    expect(r.note).toContain("granted 7");
    expect(await billing.balance("u1")).toBe(before + 7);
  });
});
