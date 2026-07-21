// Assembly v2 optimizer: word-first slot packing (spec 05v2).

import { describe, test, expect } from "bun:test";
import { optimizeAssembly, orderForField, glueField } from "./optimize.ts";

const STOP = ["app", "apps", "free", "best", "top", "new", "a", "an", "the", "and", "or", "for", "of", "with", "your", "my", "&"];
const BUDGETS = { titleSloganMax: 20, subtitleMax: 30, keywordsMax: 100 };

describe("optimizeAssembly", () => {
  test("exploits shared words: two phrases through one 'blocker' beat disjoint picks", () => {
    const r = optimizeAssembly({
      phrases: [
        { keyword: "bet blocker", score: 64, R: 3 },
        { keyword: "gamble blocker", score: 62, R: 3 },
        { keyword: "meditation planner", score: 50, R: 3 },
      ],
      stopwords: STOP, brandWords: ["NoBettr"], language: "en",
      budgets: BUDGETS, bucketCount: 1,
    });
    const title = r.buckets[0].title.map((w) => w.toLowerCase());
    // 'bet gamble blocker' (18 chars, covers 126 points) must win the title over any
    // phrase-at-a-time pick; 'meditation planner' (19 chars, 50 points) goes lower.
    expect(title).toContain("blocker");
    expect(title).toContain("bet");
    expect(title).toContain("gamble");
  });

  test("respects char and word budgets in every slot", () => {
    const phrases = Array.from({ length: 60 }, (_, i) => ({
      keyword: `verylongword${i} extra${i}`, score: 40 - (i % 20), R: 3 as const,
    }));
    const r = optimizeAssembly({
      phrases, stopwords: STOP, brandWords: [], language: "en", budgets: BUDGETS, bucketCount: 2,
    });
    for (const b of r.buckets) {
      const len = (ws: string[]) => ws.reduce((s, w) => s + w.length, 0) + Math.max(0, ws.length - 1);
      expect(len(b.title)).toBeLessThanOrEqual(BUDGETS.titleSloganMax);
      expect(len(b.subtitle)).toBeLessThanOrEqual(BUDGETS.subtitleMax);
      expect(len(b.keywords)).toBeLessThanOrEqual(BUDGETS.keywordsMax);
      expect(b.title.length).toBeLessThanOrEqual(4);
      expect(b.subtitle.length).toBeLessThanOrEqual(5);
    }
  });

  test("no fold-key is placed twice across buckets (X4 by construction)", () => {
    const phrases = [
      { keyword: "quit gambling", score: 60, R: 3 },
      { keyword: "gambling addiction", score: 59, R: 3 },
      { keyword: "stop betting", score: 40, R: 3 },
      { keyword: "relapse tracker", score: 37, R: 2 },
      { keyword: "urge journal", score: 30, R: 2 },
    ];
    const r = optimizeAssembly({
      phrases, stopwords: STOP, brandWords: [], language: "en", budgets: BUDGETS, bucketCount: 2,
    });
    const all = r.buckets.flatMap((b) => [...b.title, ...b.subtitle, ...b.keywords].map((w) => w.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
  });

  test("deterministic: same input → identical plan", () => {
    const phrases = [
      { keyword: "habit tracker", score: 50, R: 3 },
      { keyword: "streak counter", score: 40, R: 2 },
      { keyword: "day counter", score: 35, R: 2 },
    ];
    const input = { phrases, stopwords: STOP, brandWords: [], language: "en", budgets: BUDGETS, bucketCount: 1 as const };
    expect(optimizeAssembly(input)).toEqual(optimizeAssembly(input));
  });

  test("brand and stop words never occupy budget", () => {
    const r = optimizeAssembly({
      phrases: [{ keyword: "nobettr best tracker", score: 50, R: 3 }],
      stopwords: STOP, brandWords: ["NoBettr"], language: "en", budgets: BUDGETS, bucketCount: 1,
    });
    const all = r.buckets[0].title.concat(r.buckets[0].subtitle, r.buckets[0].keywords).map((w) => w.toLowerCase());
    expect(all).not.toContain("nobettr");
    expect(all).not.toContain("best");
  });
});

describe("orderForField / glueField (deterministic composer fallback)", () => {
  const phrases = [
    { keyword: "bet blocker", score: 64, R: 3 },
    { keyword: "gamble blocker", score: 62, R: 3 },
  ];

  test("orders words so the strongest phrases stay contiguous", () => {
    const ordered = orderForField(["gamble", "blocker", "bet"], phrases, STOP, "en");
    // 'blocker' must directly follow 'bet' or 'gamble' (a covered phrase realized verbatim).
    const bi = ordered.indexOf("blocker");
    expect(["bet", "gamble"]).toContain(ordered[bi - 1]);
  });

  test("glue inserts a single & at a non-adjacent boundary when it fits", () => {
    const ordered = orderForField(["bet", "gamble", "blocker"], phrases, STOP, "en");
    const glued = glueField(ordered, phrases, STOP, "en", 20);
    expect(glued.length).toBeLessThanOrEqual(20);
    expect(glued).toMatch(/^[A-Z]/);
    expect(glued.split("&").length).toBeLessThanOrEqual(2);
  });

  test("phrase overlap packs into a chain: quit gambling + gambling addiction", () => {
    const ph = [
      { keyword: "quit gambling", score: 60, R: 3 },
      { keyword: "gambling addiction", score: 59, R: 3 },
    ];
    const ordered = orderForField(["addiction", "quit", "gambling"], ph, STOP, "en");
    expect(ordered).toEqual(["quit", "gambling", "addiction"]);
    expect(glueField(ordered, ph, STOP, "en", 30)).toBe("Quit Gambling Addiction");
  });
});
