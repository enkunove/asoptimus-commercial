// Billing D4 v4: atomic real-time debiting, idempotency by (run_id,keyword),
// hard-stop at zero (never go negative), grant idempotency by stripe_event_id.

import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../db/memory-store.ts";
import { BillingService } from "./service.ts";
import { quoteFor, pricePerKeyphrase } from "./prices.ts";

describe("wallet: keyphrase debit (D4 v4)", () => {
  const setup = async () => {
    const store = new MemoryStore();
    await store.createUser({ id: "u1", email: "a@b.c", stripe_customer_id: null });
    await store.ensureWallet("u1", 0);
    const billing = new BillingService(store);
    return { store, billing };
  };

  test("grant credits; repeating the same stripe_event_id is idempotent", async () => {
    const { billing } = await setup();
    expect(await billing.grant("u1", 10, "evt_1")).toBe(true);
    expect(await billing.grant("u1", 10, "evt_1")).toBe(false); // duplicate
    expect(await billing.balance("u1")).toBe(10);
  });

  test("keyphrase debit is atomic and idempotent by (run_id, keyword)", async () => {
    const { billing } = await setup();
    await billing.grant("u1", 1, "g");
    const r1 = await billing.chargeKeyphrase("u1", "run_x", "habit tracker", 0.02);
    expect(r1.charged).toBe(true);
    expect(r1.balance).toBeCloseTo(0.98, 6);
    const r2 = await billing.chargeKeyphrase("u1", "run_x", "habit tracker", 0.02); // same keyphrase again
    expect(r2.alreadyCharged).toBe(true);
    expect(r2.charged).toBe(false);
    expect(await billing.balance("u1")).toBeCloseTo(0.98, 6); // not debited twice
  });

  test("hard-stop: balance too low → not debited, never go negative", async () => {
    const { billing } = await setup();
    await billing.grant("u1", 0.03, "g"); // enough for 1 keyphrase (0.02), not 2
    const a = await billing.chargeKeyphrase("u1", "r", "kw1", 0.02);
    expect(a.charged).toBe(true);
    const b = await billing.chargeKeyphrase("u1", "r", "kw2", 0.02); // remainder 0.01 < 0.02
    expect(b.charged).toBe(false);
    expect(b.alreadyCharged).toBe(false);
    expect(await billing.balance("u1")).toBeCloseTo(0.01, 6); // did not go negative
  });
});

describe("pricing/estimate (D4 v4)", () => {
  test("quote = ceil(sampleSize × pricePerKeyphrase); pricier model — pricier keyphrase", () => {
    expect(quoteFor(150, "claude-haiku-4-5")).toBe(Math.ceil(150 * pricePerKeyphrase("claude-haiku-4-5")));
    expect(pricePerKeyphrase("claude-opus-4-8")).toBeGreaterThan(pricePerKeyphrase("claude-haiku-4-5"));
    expect(quoteFor(40, "claude-haiku-4-5")).toBe(1); // 40×0.02=0.8 → ceil 1
  });
});
