// Биллинг D4 v4: атомарное списание в реальном времени, идемпотентность по (run_id,keyword),
// hard-stop на нуле (в минус не уходим), идемпотентность грантов по stripe_event_id.

import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../db/memory-store.ts";
import { BillingService } from "./service.ts";
import { quoteFor, pricePerKeyphrase } from "./prices.ts";

describe("wallet: списание за кейфразу (D4 v4)", () => {
  const setup = async () => {
    const store = new MemoryStore();
    await store.createUser({ id: "u1", email: "a@b.c", stripe_customer_id: null });
    await store.ensureWallet("u1", 0);
    const billing = new BillingService(store);
    return { store, billing };
  };

  test("грант начисляет; повтор того же stripe_event_id — идемпотентен", async () => {
    const { billing } = await setup();
    expect(await billing.grant("u1", 10, "evt_1")).toBe(true);
    expect(await billing.grant("u1", 10, "evt_1")).toBe(false); // дубль
    expect(await billing.balance("u1")).toBe(10);
  });

  test("списание за кейфразу атомарно и идемпотентно по (run_id, keyword)", async () => {
    const { billing } = await setup();
    await billing.grant("u1", 1, "g");
    const r1 = await billing.chargeKeyphrase("u1", "run_x", "habit tracker", 0.02);
    expect(r1.charged).toBe(true);
    expect(r1.balance).toBeCloseTo(0.98, 6);
    const r2 = await billing.chargeKeyphrase("u1", "run_x", "habit tracker", 0.02); // повтор той же кейфразы
    expect(r2.alreadyCharged).toBe(true);
    expect(r2.charged).toBe(false);
    expect(await billing.balance("u1")).toBeCloseTo(0.98, 6); // не списали дважды
  });

  test("hard-stop: баланса не хватает → не списано, в минус не уходим", async () => {
    const { billing } = await setup();
    await billing.grant("u1", 0.03, "g"); // хватает на 1 кейфразу (0.02), не на 2
    const a = await billing.chargeKeyphrase("u1", "r", "kw1", 0.02);
    expect(a.charged).toBe(true);
    const b = await billing.chargeKeyphrase("u1", "r", "kw2", 0.02); // остаток 0.01 < 0.02
    expect(b.charged).toBe(false);
    expect(b.alreadyCharged).toBe(false);
    expect(await billing.balance("u1")).toBeCloseTo(0.01, 6); // не ушли в минус
  });
});

describe("прайс/оценка (D4 v4)", () => {
  test("quote = ceil(sampleSize × pricePerKeyphrase); дороже модель — дороже кейфраза", () => {
    expect(quoteFor(150, "claude-haiku-4-5")).toBe(Math.ceil(150 * pricePerKeyphrase("claude-haiku-4-5")));
    expect(pricePerKeyphrase("claude-opus-4-8")).toBeGreaterThan(pricePerKeyphrase("claude-haiku-4-5"));
    expect(quoteFor(40, "claude-haiku-4-5")).toBe(1); // 40×0.02=0.8 → ceil 1
  });
});
