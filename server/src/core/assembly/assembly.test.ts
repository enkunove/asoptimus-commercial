// Acceptance 08.4 items 2–4: folding, greedy selection on the 30-phrase fixture, validate() per rules.
// 1:1 port from aso-util/test/assembly.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldKey } from "./folding.ts";
import { selectWords } from "./select.ts";
import { placeWords } from "./place.ts";
import { validate } from "./validate.ts";

const STOPWORDS = ["app", "apps", "free", "best", "top", "new", "a", "an", "the", "and", "or", "for", "of", "with", "your", "my", "&"];

describe("Folding (spec 05.3)", () => {
  test("positive folds", () => {
    expect(foldKey("habits", "en")).toBe("habit");
    expect(foldKey("stories", "en")).toBe("story");
    expect(foldKey("boxes", "en")).toBe("box");
    expect(foldKey("games", "en")).toBe("game");
    expect(foldKey("notes", "en")).toBe("note");
    expect(foldKey("planes", "en")).toBe("plane");
    expect(foldKey("watches", "en")).toBe("watch");
  });
  test("negative: key = word as-is", () => {
    for (const w of ["focus", "status", "class", "press", "business", "analysis", "news", "lens", "ios"]) {
      expect(foldKey(w, "en")).toBe(w);
    }
  });
  test("critical: no false folds", () => {
    expect(foldKey("planes", "en")).not.toBe(foldKey("plan", "en"));
    expect(foldKey("news", "en")).not.toBe(foldKey("new", "en"));
  });
  test("non-en language: folding fully disabled", () => {
    expect(foldKey("habits", "ru")).toBe("habits");
    expect(foldKey("stories", "de")).toBe("stories");
  });
});

const phrases: { keyword: string; score: number }[] = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "phrases-30.json"), "utf8"),
);

const BUDGETS = { titleSloganMax: 22, subtitleMax: 30, keywordsMax: 100 }; // brand "Somna": 30-5-3=22
const BUDGET_TOTAL = 22 + 30 + 100;

describe("Greedy selection + placement (spec 05.4–05.5)", () => {
  const input = {
    phrases,
    stopwords: STOPWORDS,
    brandWords: ["somna"],
    language: "en",
    budgetTotal: BUDGET_TOTAL,
  };

  test("stable repeatable result", () => {
    const a = selectWords(input);
    const b = selectWords(input);
    expect(a.words).toEqual(b.words);
  });

  test("no folding-key repeats between fields, budgets not exceeded", () => {
    const { words } = selectWords(input);
    const placement = placeWords({ words, phrases, stopwords: STOPWORDS, brandWords: ["somna"], language: "en", budgets: BUDGETS });
    const all = [...placement.titleWords, ...placement.subtitleWords, ...placement.keywordWords];
    const keys = all.map((w) => foldKey(w, "en"));
    expect(new Set(keys).size).toBe(keys.length); // no repeats
    const len = (ws: string[]) => ws.reduce((s, w) => s + w.length, 0) + Math.max(0, ws.length - 1);
    expect(len(placement.titleWords)).toBeLessThanOrEqual(BUDGETS.titleSloganMax);
    expect(len(placement.subtitleWords)).toBeLessThanOrEqual(BUDGETS.subtitleMax);
    expect(len(placement.keywordWords)).toBeLessThanOrEqual(BUDGETS.keywordsMax);
    expect(all.length).toBeGreaterThan(5); // the budget is actually used
  });

  test("coverage: the strongest phrases are covered by the selected words", () => {
    const res = selectWords(input);
    expect(res.covered.get("sleep tracker")).toBe(true);
    expect(res.covered.get("smart alarm")).toBe(true);
  });

  test("stopwords are ignored for coverage (rain sounds for sleeping)", () => {
    const res = selectWords({ ...input, budgetTotal: 400 });
    // the phrase is covered by the words rain, sounds, sleeping — "for" is not required
    expect(res.covered.get("rain sounds for sleeping")).toBe(true);
  });

  test("mustCover: an expensive top phrase is covered outside the contest", () => {
    // Without the guarantee, an expensive unique word loses to cheap frequent ones.
    const phrases = [
      { keyword: "stop doomscrolling", score: 66 },
      { keyword: "habit tracker", score: 40 },
      { keyword: "habit streak", score: 38 },
      { keyword: "streak tracker", score: 36 },
      { keyword: "habit builder", score: 30 },
    ];
    const base = { phrases, stopwords: STOPWORDS, brandWords: [], language: "en", budgetTotal: 34 };
    const without = selectWords(base);
    expect(without.covered.get("stop doomscrolling")).toBe(false);
    const withGuarantee = selectWords({ ...base, mustCover: ["stop doomscrolling"] });
    expect(withGuarantee.covered.get("stop doomscrolling")).toBe(true);
  });
});

describe("validate() — negative fixture for every rule (spec 05.7)", () => {
  const base = {
    brand: "Somna",
    language: "en",
    stopwords: STOPWORDS,
    competitors: ["Sleep Cycle", "Pillow"],
    limits: { title: 30, subtitle: 30, keywords: 100 },
  };
  const okBucket = {
    title: "Somna - Sleep Tracker",
    subtitle: "Smart Alarm & White Noise",
    keywords: "insomnia,snore,dream,nap,relax,bedtime,rain,calm,night,rest,wake,cycles,deep,fast,aid,babys",
    titleWords: ["sleep", "tracker"],
    subtitleWords: ["smart", "alarm", "white", "noise"],
  };
  const codes = (bucket: any, extra?: Partial<typeof base> & { otherBucketKeys?: Set<string> }) =>
    validate({ bucket, ...base, ...extra }).filter((v) => v.level === "error").map((v) => v.code);

  test("reference bucket passes without errors", () => {
    expect(codes(okBucket)).toEqual([]);
  });
  test("T1: title length exceeded", () => {
    expect(codes({ ...okBucket, title: "Somna - Sleep Tracker And More Stuff" })).toContain("T1");
  });
  test("T1: title does not start with the brand", () => {
    expect(codes({ ...okBucket, title: "Sleep Tracker" })).toContain("T1");
  });
  test("T2: title missing a titleWord", () => {
    expect(codes({ ...okBucket, title: "Somna - Sleep Monitor" })).toContain("T2");
  });
  test("S1: subtitle length exceeded", () => {
    expect(codes({ ...okBucket, subtitle: "Smart Alarm And Also White Noise Machine" })).toContain("S1");
  });
  test("S1: subtitle missing a subtitleWord", () => {
    expect(codes({ ...okBucket, subtitle: "Smart Alarm Only Here Now" })).toContain("S1");
  });
  test("K1: spaces in the keyword field", () => {
    expect(codes({ ...okBucket, keywords: "insomnia, snore" })).toContain("K1");
  });
  test("K1: 100 characters exceeded", () => {
    expect(codes({ ...okBucket, keywords: "a".repeat(101) })).toContain("K1");
  });
  test("X1: folding-key repeat between fields", () => {
    expect(codes({ ...okBucket, keywords: okBucket.keywords + ",sleep" })).toContain("X1");
  });
  test("X1: word duplicates the brand", () => {
    expect(codes({ ...okBucket, keywords: okBucket.keywords + ",somna" })).toContain("X1");
  });
  test("X2: stopword in the keyword field", () => {
    expect(codes({ ...okBucket, keywords: okBucket.keywords + ",free" })).toContain("X2");
  });
  test("X3: third-party brand", () => {
    expect(codes({ ...okBucket, subtitle: "Like Sleep Cycle But Smart" })).toContain("X3");
  });
  test("X4: key repeated between buckets", () => {
    const other = new Set(["insomnia"]);
    expect(codes(okBucket, { otherBucketKeys: other })).toContain("X4");
  });
  test("W1: budget-underuse warning", () => {
    const v = validate({ bucket: { ...okBucket, keywords: "insomnia,snore" }, ...base });
    expect(v.some((x) => x.code === "W1" && x.level === "warning")).toBe(true);
  });
});
