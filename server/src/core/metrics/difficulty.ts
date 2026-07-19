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
 * "Dead brand query" detector (empirical): Apple seeds app NAMES into the suggest
 * index, so a phrase that is a dead app's name gets an inflated P with zero real
 * demand. Signature: the phrase is the exact normalized name of an app in the top-3
 * results, that app has fewer than ratingFloor ratings, and no OTHER top app contains
 * the phrase in full.
 */
export function isDeadBrandQuery(keyword: string, topApps: TopApp[], ratingFloor = 200): boolean {
  const kw = normalizeKeyword(keyword);
  const fullMatches = topApps.filter((a) => a.match === 1);
  if (fullMatches.length > 1) return false; // category term
  for (const a of topApps.slice(0, 3)) {
    if (normalizeKeyword(a.trackName) === kw && a.ratingCount < ratingFloor) return true;
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
