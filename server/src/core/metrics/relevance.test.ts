// Final Relevance v2: computed R = semantic prior × measured store fit (spec 03.3v2).

import { describe, test, expect } from "bun:test";
import { serpFitOf, finalR, RELEVANCE } from "./relevance.ts";

const niche = {
  "1": { match: 1, reason: "same" },
  "2": { match: 1, reason: "same" },
  "3": { match: 0.5, reason: "adjacent" },
  "4": { match: 0, reason: "different" },
};

describe("serpFitOf", () => {
  test("all top apps in niche → fit 1, full confidence", () => {
    const top = Array.from({ length: 10 }, (_, i) => ({ trackId: (i % 2) + 1 })); // 1 and 2, both match 1
    const r = serpFitOf(top, niche, 10);
    expect(r.fit).toBeCloseTo(1, 5);
    expect(r.conf).toBe(1);
  });

  test("off-niche results pull fit down, weighted by position", () => {
    const top = [{ trackId: 4 }, { trackId: 4 }, { trackId: 4 }]; // top-3 all different niche
    const r = serpFitOf(top, niche, 10);
    expect(r.fit).toBe(0);
    expect(r.conf).toBeCloseTo(0.3, 5); // only 3 of top-10 observed
  });

  test("thin SERP lowers confidence", () => {
    const r = serpFitOf([{ trackId: 1 }], niche, 10);
    expect(r.conf).toBeCloseTo(0.1, 5);
  });
});

describe("finalR", () => {
  test("strong semantic + strong fit → near 3", () => {
    expect(finalR(3, 0.85, 1)).toBeGreaterThan(2.5);
  });

  test("strong semantic but off-niche SERP → collapses (the 'gambling' case)", () => {
    // sem 2, store shows the query is casinos (fit ~0.05) → should be well below 1.
    expect(finalR(2, 0.05, 1)).toBeLessThan(1);
  });

  test("inflated semantic but wrong store fit → demoted (the 'clarity cbt' case)", () => {
    // A word-salad the LLM over-rated 3, store fit ~0.3 → store-driven R demotes it (≈0.9).
    expect(finalR(3, 0.3, 1)).toBeLessThan(1.1);
  });

  test("store RESCUES a core term the LLM under-rated (the 'gambling ban' case)", () => {
    // LLM rated it 1 (tangential) but the store strongly backs it (fit 0.80) → R must be clearly
    // relevant, not dragged down by the bad rating.
    expect(finalR(1, 0.8, 1)).toBeGreaterThan(2);
  });

  test("store-confirmed core outranks a store-mismatched feature (the reported inversion)", () => {
    // gambling addiction: LLM under-rated it 2, store backs it (fit 0.75).
    // panic button: LLM over-rated it 3, store shows mostly a different niche (fit 0.32).
    expect(finalR(2, 0.75, 1)).toBeGreaterThan(finalR(3, 0.32, 1));
  });

  test("sem 0 is a hard veto regardless of fit (anti-semantics)", () => {
    expect(finalR(0, 1, 1)).toBe(0);
  });

  test("the LLM rating cannot lift a store-mismatched query: R is store-driven above the veto", () => {
    // sem 3 vs sem 2 at the same fit → identical R (the LLM only vetoes, it does not grade).
    expect(finalR(3, 0.5, 1)).toBe(finalR(2, 0.5, 1));
  });

  test("thin evidence returns the semantic prior (no store data)", () => {
    // conf 0 → fitAdj = sem/3, so R = 3·(sem/3) = sem.
    expect(finalR(2, 0, 0)).toBeCloseTo(2, 5);
    expect(finalR(3, 0, 0)).toBeCloseTo(3, 5);
  });

  test("monotonic in fit", () => {
    expect(finalR(2, 0.8, 1)).toBeGreaterThan(finalR(2, 0.3, 1));
    expect(finalR(1, 0.9, 1)).toBeGreaterThan(finalR(1, 0.2, 1));
  });

  test("rounded to one decimal, within [0,3]", () => {
    const r = finalR(3, 0.85, 1);
    expect(r).toBe(Math.round(r * 10) / 10);
    expect(r).toBeLessThanOrEqual(3);
    expect(finalR(2.5, 0.6, 1)).toBeGreaterThanOrEqual(0);
  });

  test("includeThreshold gates metadata membership at R≥1", () => {
    expect(finalR(2, 0.05, 1)).toBeLessThan(RELEVANCE.includeThreshold); // gambling → out
    expect(finalR(3, 0.85, 1)).toBeGreaterThanOrEqual(RELEVANCE.includeThreshold); // quit gambling → in
  });
});
