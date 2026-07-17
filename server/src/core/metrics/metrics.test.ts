// Приёмка 08.4 п.1: числовые примеры из spec 03 сходятся до цифры.
// Порт из aso-util/test/metrics.test.ts. parseHints опущен (client-only concern).

import { describe, expect, test } from "bun:test";
import { popularityScore, computePopularity } from "./popularity.ts";
import { appStrength, computeDifficulty, matchScore, isDeadBrandQuery } from "./difficulty.ts";
import { opportunityScore, compareKeywords } from "./score.ts";

const PW = { depth: 0.7, rank: 0.3 };
const DW = { volume: 0.45, quality: 0.15, freshness: 0.15, match: 0.25 };
const OW = { popularityExp: 0.6, easeExp: 0.4 };

describe("Popularity (spec 03.1)", () => {
  test("пример спеки: habit tracker, N=13, L=4, rank=2 → P=80", () => {
    expect(popularityScore(13, 4, 2, PW)).toBe(80);
  });
  test("L=1, rank=1 → P=100; L=N → только RankScore", () => {
    expect(popularityScore(10, 1, 1, PW)).toBe(100);
    expect(popularityScore(10, 10, 1, PW)).toBe(30);
    expect(popularityScore(10, 10, 10, PW)).toBe(3);
  });
});

describe("computePopularity над сырьём prefill∪fetched (D2/D3)", () => {
  test("habit tracker найден на префиксе 'habi' (L=4) на ранге 2 → P=80", () => {
    // K = "habit tracker" (N=13). Подсказки под ключами-префиксами; точное вхождение
    // K впервые встречается на префиксе длины 4 ("habi") на позиции idx=1 → rank=2.
    const prefixHints = {
      h: ["health", "hbo max"],
      ha: ["habit", "hair"],
      hab: ["habit", "haberdashery"],
      habi: ["habitica", "habit tracker", "habit"],
    };
    const res = computePopularity("habit tracker", prefixHints, null, false, PW);
    expect(res.P).toBe(80);
    expect(res.L).toBe(4);
    expect(res.rank).toBe(2);
    expect(res.unsuggested).toBe(false);
  });

  test("флаг unsuggested → P=0, unsuggested:true", () => {
    const res = computePopularity("nonexistent phrase", {}, null, true, PW);
    expect(res.P).toBe(0);
    expect(res.unsuggested).toBe(true);
  });
});

describe("Difficulty (spec 03.2)", () => {
  test("пример спеки: 250k рейтингов, 4.7, 30 дней, точное вхождение → AppStrength=93", () => {
    const s = appStrength(
      "habit tracker",
      { userRatingCount: 250_000, averageUserRating: 4.7, updatedDaysAgo: 30, trackName: "Habit Tracker Pro" },
      DW,
    );
    expect(s).toBe(93);
  });
  test("matchScore: целиком / все слова / ничего", () => {
    expect(matchScore("habit tracker", "Best Habit Tracker App")).toBe(1.0);
    expect(matchScore("habit tracker", "Tracker of Habit")).toBe(0.5);
    expect(matchScore("habit tracker", "Sleep Sounds")).toBe(0.0);
  });
  test("мало результатов → D падает пропорционально n/serpTop", () => {
    const app = {
      trackId: 1, trackName: "Habit Tracker", averageUserRating: 4.7, userRatingCount: 250_000,
      currentVersionReleaseDate: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      primaryGenreName: "", genres: [], artworkUrl100: "", sellerName: "",
    };
    const full = computeDifficulty("habit tracker", Array(10).fill(app), 25, 10, DW);
    const half = computeDifficulty("habit tracker", Array(5).fill(app), 5, 10, DW);
    expect(full.D).toBeGreaterThan(half.D);
    expect(full.serpSize).toBe(25);
    // вся десятка одинаково сильна → D ≈ AppStrength
    expect(full.D).toBe(93);
  });
});

describe("Детектор мёртвого брендового запроса", () => {
  const app = (trackName: string, ratingCount: number, match: number) =>
    ({ trackId: 1, trackName, ratingCount, rating: 4, updatedDaysAgo: 30, match, strength: 50 });

  test("реальные сигнатуры: имя мёртвой апки в её же выдаче → true", () => {
    // 007 Breathalyzer, 0 рейтингов (реальный кейс из прогона sober-time)
    expect(isDeadBrandQuery("007 breathalyzer", [
      app("007 Breathalyzer", 0, 1), app("BACtrack", 1048, 0), app("Smart Sense BAC Breathalyzer", 2, 0),
    ])).toBe(true);
    expect(isDeadBrandQuery("sobersense breathalyzer", [
      app("SoberSense Breathalyzer", 37, 1), app("BACtrack", 1048, 0), app("DRIVESAFE", 0, 0),
    ])).toBe(true);
  });

  test("легитимные запросы не зануляются", () => {
    // имя содержит фразу + хвост — не точное совпадение (bac calculator - alcocurve)
    expect(isDeadBrandQuery("bac calculator", [
      app("BAC calculator - Alcocurve", 8, 1), app("Drink Tracker - BAC Buddy", 23, 0), app("Ok To Drive", 41, 0),
    ])).toBe(false);
    // категорийный термин: фразу целиком содержат НЕСКОЛЬКО апок
    expect(isDeadBrandQuery("alcohol tracker", [
      app("DrinkControl: Alcohol Tracker", 4199, 1), app("I Am Sober", 182336, 0), app("Alcohol Tracker°", 37, 1),
    ])).toBe(false);
    // сильный бренд: рейтингов выше пола — реальный трафик, не зануляем
    expect(isDeadBrandQuery("i am sober", [
      app("I Am Sober", 182336, 1), app("Sober Time", 39730, 0), app("Nomo", 5000, 0),
    ])).toBe(false);
  });
});

describe("Opportunity Score (spec 03.4)", () => {
  test("примеры спеки", () => {
    expect(opportunityScore(80, 70, 3, OW)).toBe(54);
    expect(opportunityScore(35, 25, 3, OW)).toBe(47);
    expect(opportunityScore(80, 70, 1, OW)).toBe(18);
  });
  test("Score(80,63,3) по формуле", () => {
    const expected = Math.round(100 * Math.pow(0.8, 0.6) * Math.pow(0.37, 0.4));
    expect(opportunityScore(80, 63, 3, OW)).toBe(expected);
  });
  test("P=0 → Score=0; R=0 → Score=0", () => {
    expect(opportunityScore(0, 20, 3, OW)).toBe(0);
    expect(opportunityScore(80, 20, 0, OW)).toBe(0);
  });
  test("тай-брейки: больший P → меньший D → короче кейворд", () => {
    const a = { score: 50, P: 80, D: 40, keyword: "aaa" };
    const b = { score: 50, P: 70, D: 30, keyword: "bb" };
    expect(compareKeywords(a, b)).toBeLessThan(0);
    const c = { score: 50, P: 80, D: 30, keyword: "cc" };
    expect(compareKeywords(c, a)).toBeLessThan(0);
  });
});
