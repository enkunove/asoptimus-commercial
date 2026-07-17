// Приёмка 08.4 п.2–4: фолдинг, жадный отбор на фикстуре 30 фраз, validate() по правилам.
// Порт 1:1 из aso-util/test/assembly.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldKey } from "./folding.ts";
import { selectWords } from "./select.ts";
import { placeWords } from "./place.ts";
import { validate } from "./validate.ts";

const STOPWORDS = ["app", "apps", "free", "best", "top", "new", "a", "an", "the", "and", "or", "for", "of", "with", "your", "my", "&"];

describe("Фолдинг (spec 05.3)", () => {
  test("позитивные склейки", () => {
    expect(foldKey("habits", "en")).toBe("habit");
    expect(foldKey("stories", "en")).toBe("story");
    expect(foldKey("boxes", "en")).toBe("box");
    expect(foldKey("games", "en")).toBe("game");
    expect(foldKey("notes", "en")).toBe("note");
    expect(foldKey("planes", "en")).toBe("plane");
    expect(foldKey("watches", "en")).toBe("watch");
  });
  test("негативные: ключ = слово как есть", () => {
    for (const w of ["focus", "status", "class", "press", "business", "analysis", "news", "lens", "ios"]) {
      expect(foldKey(w, "en")).toBe(w);
    }
  });
  test("критично: нет ложных склеек", () => {
    expect(foldKey("planes", "en")).not.toBe(foldKey("plan", "en"));
    expect(foldKey("news", "en")).not.toBe(foldKey("new", "en"));
  });
  test("не-en язык: фолдинг выключен полностью", () => {
    expect(foldKey("habits", "ru")).toBe("habits");
    expect(foldKey("stories", "de")).toBe("stories");
  });
});

const phrases: { keyword: string; score: number }[] = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "phrases-30.json"), "utf8"),
);

const BUDGETS = { titleSloganMax: 22, subtitleMax: 30, keywordsMax: 100 }; // brand "Somna": 30-5-3=22
const BUDGET_TOTAL = 22 + 30 + 100;

describe("Жадный отбор + размещение (spec 05.4–05.5)", () => {
  const input = {
    phrases,
    stopwords: STOPWORDS,
    brandWords: ["somna"],
    language: "en",
    budgetTotal: BUDGET_TOTAL,
  };

  test("стабильный повторяемый результат", () => {
    const a = selectWords(input);
    const b = selectWords(input);
    expect(a.words).toEqual(b.words);
  });

  test("нет повторов фолдинг-ключей между полями, бюджеты не превышены", () => {
    const { words } = selectWords(input);
    const placement = placeWords({ words, phrases, stopwords: STOPWORDS, brandWords: ["somna"], language: "en", budgets: BUDGETS });
    const all = [...placement.titleWords, ...placement.subtitleWords, ...placement.keywordWords];
    const keys = all.map((w) => foldKey(w, "en"));
    expect(new Set(keys).size).toBe(keys.length); // нет повторов
    const len = (ws: string[]) => ws.reduce((s, w) => s + w.length, 0) + Math.max(0, ws.length - 1);
    expect(len(placement.titleWords)).toBeLessThanOrEqual(BUDGETS.titleSloganMax);
    expect(len(placement.subtitleWords)).toBeLessThanOrEqual(BUDGETS.subtitleMax);
    expect(len(placement.keywordWords)).toBeLessThanOrEqual(BUDGETS.keywordsMax);
    expect(all.length).toBeGreaterThan(5); // бюджет реально используется
  });

  test("покрытие: сильнейшие фразы покрыты отобранными словами", () => {
    const res = selectWords(input);
    expect(res.covered.get("sleep tracker")).toBe(true);
    expect(res.covered.get("smart alarm")).toBe(true);
  });

  test("стоп-слова игнорируются при покрытии (rain sounds for sleeping)", () => {
    const res = selectWords({ ...input, budgetTotal: 400 });
    // фраза покрывается словами rain, sounds, sleeping — "for" не требуется
    expect(res.covered.get("rain sounds for sleeping")).toBe(true);
  });

  test("mustCover: дорогая топ-фраза покрывается вне конкурса", () => {
    // Без гарантии дорогое уникальное слово проигрывает дешёвым частотным.
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

describe("validate() — негативная фикстура на каждое правило (spec 05.7)", () => {
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

  test("эталонная корзина проходит без ошибок", () => {
    expect(codes(okBucket)).toEqual([]);
  });
  test("T1: превышение длины title", () => {
    expect(codes({ ...okBucket, title: "Somna - Sleep Tracker And More Stuff" })).toContain("T1");
  });
  test("T1: title не начинается с бренда", () => {
    expect(codes({ ...okBucket, title: "Sleep Tracker" })).toContain("T1");
  });
  test("T2: title не содержит titleWord", () => {
    expect(codes({ ...okBucket, title: "Somna - Sleep Monitor" })).toContain("T2");
  });
  test("S1: превышение длины subtitle", () => {
    expect(codes({ ...okBucket, subtitle: "Smart Alarm And Also White Noise Machine" })).toContain("S1");
  });
  test("S1: subtitle не содержит subtitleWord", () => {
    expect(codes({ ...okBucket, subtitle: "Smart Alarm Only Here Now" })).toContain("S1");
  });
  test("K1: пробелы в keyword field", () => {
    expect(codes({ ...okBucket, keywords: "insomnia, snore" })).toContain("K1");
  });
  test("K1: превышение 100 символов", () => {
    expect(codes({ ...okBucket, keywords: "a".repeat(101) })).toContain("K1");
  });
  test("X1: повтор фолдинг-ключа между полями", () => {
    expect(codes({ ...okBucket, keywords: okBucket.keywords + ",sleep" })).toContain("X1");
  });
  test("X1: слово дублирует бренд", () => {
    expect(codes({ ...okBucket, keywords: okBucket.keywords + ",somna" })).toContain("X1");
  });
  test("X2: стоп-слово в keyword field", () => {
    expect(codes({ ...okBucket, keywords: okBucket.keywords + ",free" })).toContain("X2");
  });
  test("X3: чужой бренд", () => {
    expect(codes({ ...okBucket, subtitle: "Like Sleep Cycle But Smart" })).toContain("X3");
  });
  test("X4: повтор ключа между корзинами", () => {
    const other = new Set(["insomnia"]);
    expect(codes(okBucket, { otherBucketKeys: other })).toContain("X4");
  });
  test("W1: предупреждение о недоборе бюджета", () => {
    const v = validate({ bucket: { ...okBucket, keywords: "insomnia,snore" }, ...base });
    expect(v.some((x) => x.code === "W1" && x.level === "warning")).toBe(true);
  });
});
