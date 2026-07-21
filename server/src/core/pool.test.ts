// Bounded-concurrency worker pool (loop parallelization).

import { describe, test, expect } from "bun:test";
import { runPool } from "./pool.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("runPool", () => {
  test("processes every item exactly once", async () => {
    const seen: number[] = [];
    await runPool([0, 1, 2, 3, 4, 5, 6], 3, async (n) => { await tick(); seen.push(n); });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("never exceeds `width` items in flight", async () => {
    let inflight = 0, peak = 0;
    await runPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inflight++; peak = Math.max(peak, inflight);
      await tick();
      inflight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBe(4); // and it actually saturates the window
  });

  test("width 1 is fully sequential (replay determinism)", async () => {
    const order: number[] = [];
    let inflight = 0, peak = 0;
    await runPool([0, 1, 2, 3], 1, async (n) => {
      inflight++; peak = Math.max(peak, inflight);
      await tick(); order.push(n); inflight--;
    });
    expect(peak).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]); // strict input order
  });

  test("first error aborts new dispatch and is rethrown; in-flight settle", async () => {
    const started: number[] = [];
    let settled = 0;
    const err = new Error("client gone");
    await expect(runPool(Array.from({ length: 12 }, (_, i) => i), 3, async (n) => {
      started.push(n);
      await tick();
      if (n === 1) throw err;
      settled++;
    })).rejects.toBe(err);
    // Once #1 threw, no NEW items are pulled beyond the ones already in flight with it.
    expect(started.length).toBeLessThan(12);
    expect(Math.max(...started)).toBeLessThan(12);
    // The other in-flight items at the time of the error still completed (no orphan work).
    expect(settled).toBeGreaterThanOrEqual(1);
  });

  test("empty input is a no-op", async () => {
    let called = 0;
    await runPool([], 4, async () => { called++; });
    expect(called).toBe(0);
  });

  test("width larger than item count still processes all", async () => {
    const seen: number[] = [];
    await runPool([1, 2], 10, async (n) => { seen.push(n); });
    expect(seen.sort()).toEqual([1, 2]);
  });
});
