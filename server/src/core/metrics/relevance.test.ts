// Final Relevance v3: intent-led computed R (spec 03.3v3).
// Bands: sem3→3.0 flat; sem2→1.4+1.0E; sem1→0.4+0.8E; sem0→0. E = conf·fit + (1−conf)·sem/3.

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

describe("finalR (v3: intent leads, store evidence modulates the middle)", () => {
  test("core intent is R=3 regardless of SERP composition (the 'block betting apps' case)", () => {
    // The SERP of a blocker's most core query is dominated by the industry the user is escaping
    // (fit 0.09). That is COMPETITION information (D's channel), not relevance — v2 scored this
    // 0.3 and excluded it; v3 keeps the core at 3.
    expect(finalR(3, 0.09, 1)).toBe(3);
    expect(finalR(3, 0.92, 1)).toBe(3);
  });

  test("sem 0 is a hard veto regardless of fit (anti-semantics / opposite need)", () => {
    expect(finalR(0, 1, 1)).toBe(0);
  });

  test("sem=1 crosses the include threshold only with real store confirmation", () => {
    // "days until" (generic countdown intent, counters classified out of niche) → excluded.
    expect(finalR(1, 0.1, 1)).toBeLessThan(RELEVANCE.includeThreshold);
    // Store strongly confirms the niche reading → marginally included.
    expect(finalR(1, 0.8, 1)).toBeGreaterThanOrEqual(RELEVANCE.includeThreshold);
  });

  test("sem=2 is always included; store evidence grades it within 1.4–2.4", () => {
    expect(finalR(2, 0, 1)).toBeCloseTo(1.4, 5);
    expect(finalR(2, 1, 1)).toBeCloseTo(2.4, 5);
    expect(finalR(2, 0, 1)).toBeGreaterThanOrEqual(RELEVANCE.includeThreshold);
  });

  test("a core always outranks a store-confirmed adjacent (no more fit inversions)", () => {
    // v2 ranked "cbt thought record" (sem-over-rated, fit 0.85 → 2.6) above "quit gambling"
    // (core, fit 0.73 → 2.2). v3: any sem=3 sits above every sem≤2 ceiling.
    expect(finalR(3, 0.02, 1)).toBeGreaterThan(finalR(2, 1, 1));
  });

  test("thin evidence falls back to the semantic prior", () => {
    // conf 0 → E = sem/3.
    expect(finalR(2, 0, 0)).toBeCloseTo(1.4 + (2 / 3), 1);
    expect(finalR(1, 0, 0)).toBeCloseTo(0.4 + 0.8 / 3, 1);
    expect(finalR(3, 0, 0)).toBe(3);
  });

  test("monotonic in fit within the graded bands", () => {
    expect(finalR(2, 0.8, 1)).toBeGreaterThan(finalR(2, 0.3, 1));
    expect(finalR(1, 0.9, 1)).toBeGreaterThan(finalR(1, 0.2, 1));
  });

  test("legacy float semR from pre-v3 snapshots rounds into a band", () => {
    expect(finalR(2.6, 0.5, 1)).toBe(3); // rounds to sem 3
    expect(finalR(1.4, 0.5, 1)).toBe(finalR(1, 0.5, 1));
  });

  test("rounded to one decimal, within [0,3]", () => {
    const r = finalR(2, 0.37, 1);
    expect(r).toBe(Math.round(r * 10) / 10);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(3);
  });
});
