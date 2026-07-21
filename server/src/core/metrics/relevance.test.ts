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
    // A word-salad the LLM over-rated 3, store fit ~0.3 → fit-dominant blend demotes it hard.
    expect(finalR(3, 0.3, 1)).toBeLessThan(1.6);
    expect(finalR(3, 0.3, 1)).toBeGreaterThan(1.0);
  });

  test("store-confirmed core outranks an over-rated feature (the reported inversion)", () => {
    // gambling addiction: LLM under-rated it 2, but the store strongly backs it (fit 0.75).
    // panic button: LLM over-rated it 3, store half-backs it (fit 0.5). Core must now win.
    const gamblingAddiction = finalR(2, 0.75, 1);
    const panicButton = finalR(3, 0.5, 1);
    expect(gamblingAddiction).toBeGreaterThan(panicButton);
  });

  test("sem 0 is a hard zero regardless of fit (anti-semantics)", () => {
    expect(finalR(0, 1, 1)).toBe(0);
  });

  test("thin evidence blends back toward the semantic prior", () => {
    // conf 0 → fitAdj = sem/3, so R = 3*(s/3)^0.6*(s/3)^0.4 = s.
    expect(finalR(2, 0, 0)).toBeCloseTo(2, 5);
    expect(finalR(3, 0, 0)).toBeCloseTo(3, 5);
  });

  test("monotonic in fit and in semantics", () => {
    expect(finalR(2, 0.8, 1)).toBeGreaterThan(finalR(2, 0.3, 1));
    expect(finalR(3, 0.5, 1)).toBeGreaterThan(finalR(2, 0.5, 1));
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
