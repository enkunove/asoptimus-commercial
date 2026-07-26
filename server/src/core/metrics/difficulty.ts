// @aso/core — Difficulty (D), 0–100 (spec 03.2). PROPRIETARY, pure functions.
// 1:1 port from aso-util; input is now RawSerpApp[] from the wire protocol (raw Search JSON).

import { normalizeKeyword } from "@aso/shared";
import type { RawSerpApp, TopApp } from "@aso/shared";

export interface DifficultyWeights {
  volume: number;
  quality: number;
  freshness: number;
  match: number;
}

/** M: 1.0 — K appears in trackName in full; 0.5 — all words in any order; 0.0 — otherwise. */
export function matchScore(keyword: string, trackName: string): number {
  const k = normalizeKeyword(keyword);
  const name = normalizeKeyword(trackName);
  if (name.includes(k)) return 1.0;
  const words = k.split(" ").filter(Boolean);
  if (words.length > 0 && words.every((w) => name.includes(w))) return 0.5;
  return 0.0;
}

export function appStrength(
  keyword: string,
  app: { userRatingCount: number; averageUserRating: number; updatedDaysAgo: number; trackName: string },
  w: DifficultyWeights,
): number {
  const V = Math.min(1, Math.log10(app.userRatingCount + 1) / 6);
  const Q = app.averageUserRating / 5;
  const F = Math.max(0, 1 - app.updatedDaysAgo / 365);
  const M = matchScore(keyword, app.trackName);
  return Math.round(100 * (w.volume * V + w.quality * Q + w.freshness * F + w.match * M));
}

export interface DifficultyResult {
  D: number;
  serpSize: number;
  topApps: TopApp[];
}

/**
 * Brand-trap CANDIDATE generators, measured half (spec 03.3v3.1). Apple seeds app NAMES into
 * the suggest index, so a phrase that exists mainly as some app's name gets an inflated P with
 * little real demand ("cbt thought record" → P 78 off a 3-rating app; "gamblers recovery
 * companion" → P 63 off a 1-rating app). No SERP heuristic can tell a seeded phantom from a
 * weak app that happens to be NAMED in generic search language ("long distance relationship
 * ldr" is a real query AND the exact name of a tiny app; childCount separated nothing on
 * labeled data) — so these signatures only NOMINATE candidates; the verdict is a batched LLM
 * `brandcheck` call with the SERP as evidence (orchestrator.rateAll).
 *
 * isExactNameOfWeakApp — the query IS the full normalized name of a weak top-3 app and no
 * other top app carries the phrase in full. Fires at ANY intent rating: an exact 1:1 name
 * match is suspicious even for a core-sounding phrase.
 */
export function isExactNameOfWeakApp(keyword: string, topApps: TopApp[], ratingFloor = 200): boolean {
  const kw = normalizeKeyword(keyword);
  if (topApps.filter((a) => a.match === 1).length > 1) return false; // several owners = category language
  return topApps.slice(0, 3).some((a) => normalizeKeyword(a.trackName) === kw && a.ratingCount < ratingFloor);
}

/**
 * isBrandNameQuery — the broader segment signature: the query matches a NAME SEGMENT (split on
 * :|–-·) of a weak (< ratingFloor) top-3 app and no app with ≥ strongFloor ratings owns the
 * phrase in full ("TellMe: CBT Thought Record"). Too noisy to fire on core intent — young
 * niches consist entirely of weak apps and it would nominate real cores like "quit gambling"
 * — so the caller applies it only at sem<3.
 */
export function isBrandNameQuery(
  keyword: string,
  topApps: TopApp[],
  opts: { ratingFloor?: number; strongFloor?: number; topN?: number } = {},
): boolean {
  const { ratingFloor = 300, strongFloor = 1000, topN = 3 } = opts;
  const kw = normalizeKeyword(keyword);
  if (topApps.some((a) => a.match === 1 && a.ratingCount >= strongFloor)) return false;
  for (const a of topApps.slice(0, topN)) {
    if (a.ratingCount >= ratingFloor) continue;
    const name = normalizeKeyword(a.trackName);
    const segments = a.trackName
      .toLowerCase()
      .split(/[:|–—·•-]+/)
      .map((s) => normalizeKeyword(s))
      .filter(Boolean);
    for (const s of [name, ...segments]) {
      if (s === kw || s.startsWith(kw + " ") || (s.startsWith(kw) && s.length <= kw.length + 4)) return true;
    }
  }
  return false;
}

export function computeDifficulty(
  keyword: string,
  apps: RawSerpApp[],
  resultCount: number,
  serpTop: number,
  w: DifficultyWeights,
  now: Date = new Date(),
): DifficultyResult {
  const top = apps.slice(0, serpTop);
  const n = top.length;
  const weightSum = (serpTop * (serpTop + 1)) / 2;

  const topApps: TopApp[] = top.map((a) => {
    const updatedDaysAgo = a.currentVersionReleaseDate
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(a.currentVersionReleaseDate)) / 86_400_000))
      : 3650;
    const userRatingCount = Number(a.userRatingCount ?? 0);
    const averageUserRating = Number(a.averageUserRating ?? 0);
    const trackName = String(a.trackName ?? "");
    const strength = appStrength(keyword, { userRatingCount, averageUserRating, updatedDaysAgo, trackName }, w);
    return {
      trackId: a.trackId,
      trackName,
      ratingCount: userRatingCount,
      rating: averageUserRating,
      updatedDaysAgo,
      match: matchScore(keyword, trackName),
      strength,
    };
  });

  let dRaw = 0;
  topApps.forEach((a, i) => {
    const wi = (serpTop - i) / weightSum; // position i=1..serpTop → weight (serpTop+1−i)/Σ
    dRaw += wi * a.strength;
  });

  const D = Math.round((dRaw * n) / serpTop);
  return { D, serpSize: resultCount, topApps };
}
