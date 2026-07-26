// Billing D4 v4: atomic real-time debiting, idempotency by (run_id,keyword),
// hard-stop at zero (never go negative), grant idempotency by paddle_event_id (transaction id).

import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../db/memory-store.ts";
import { BillingService } from "./service.ts";
import { quoteFor, pricePerKeyphrase, runFees } from "./prices.ts";

describe("wallet: keyphrase debit (D4 v4)", () => {
  const setup = async () => {
    const store = new MemoryStore();
    await store.createUser({ id: "u1", email: "a@b.c", paddle_customer_id: null });
    await store.ensureWallet("u1", 0);
    const billing = new BillingService(store);
    return { store, billing };
  };

  test("grant credits; repeating the same paddle_event_id is idempotent", async () => {
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

describe("pricing/estimate (D4 v5: workload quote)", () => {
  test("calibration anchors: ≈6 cr at S=200, ≈17 cr at S=500 (haiku)", () => {
    expect(quoteFor(200, "claude-haiku-4-5")).toBe(6);
    expect(quoteFor(500, "claude-haiku-4-5")).toBe(17);
  });

  test("superlinear in sampleSize: the per-slot average grows with S", () => {
    const s200 = quoteFor(200, "claude-haiku-4-5") / 200;
    const s500 = quoteFor(500, "claude-haiku-4-5") / 500;
    expect(s500).toBeGreaterThan(s200);
  });

  test("pricier model — pricier run; fee schedule scales the same way", () => {
    expect(quoteFor(200, "claude-opus-4-8")).toBeGreaterThan(quoteFor(200, "claude-haiku-4-5"));
    expect(runFees("claude-sonnet-5").probePerKeyword).toBeGreaterThan(runFees("claude-haiku-4-5").probePerKeyword);
  });

  test("progressive inclusion: the k-th keyphrase costs more than the first", () => {
    const f = runFees("claude-haiku-4-5");
    const first = f.inclusionBase;
    const k400 = f.inclusionBase + f.inclusionSlope * 400;
    expect(k400).toBeGreaterThan(first * 2);
  });

  test("legacy per-keyphrase price still resolves (billing v1 runs)", () => {
    expect(pricePerKeyphrase("claude-opus-4-8")).toBeGreaterThan(pricePerKeyphrase("claude-haiku-4-5"));
  });
});

describe("workload debits (D4 v5)", () => {
  test("synthetic stage keys are idempotent like keywords", async () => {
    const store = new MemoryStore();
    const billing = new BillingService(store);
    await billing.grant("u9", 10, null);
    const a = await billing.chargeKeyphrase("u9", "run_z", "probe#1", 0.4);
    expect(a.charged).toBe(true);
    const b = await billing.chargeKeyphrase("u9", "run_z", "probe#1", 0.4); // replay of the same wave
    expect(b.alreadyCharged).toBe(true);
    expect(await billing.balance("u9")).toBeCloseTo(9.6, 6);
  });
});
