// @aso/core — final Relevance (spec 03.3v3). PROPRIETARY, pure functions.
//
// R history. v1: a per-keyword LLM opinion at final-rating time — the least stable number in the
// pipeline. v2: R = measured store-fit (share of the top SERP classified into our niche), the LLM
// demoted to a veto. Live runs falsified v2's core assumption: SERP composition is COMPETITION
// information, not relevance. For counter-positioned products (blockers, recovery companions) the
// SERP of the most core queries is dominated by the very industry the user is escaping — "block
// betting apps" scored R=0.3 and was excluded while generic-tool queries ("days until", "counter")
// scored ~2 off coincidental niche labels. Against a 3-lens judge panel over a full prod run the
// v2 ranking correlated at ρ=0.04 (noise) with 55% pairwise inversions.
//
// v3 inverts the roles back, with the fix where the signal actually was: the prescreen now rates
// SEARCHER INTENT ("who types this and what do they hope to install"), not topical overlap — and
// on the same panel intent=3 predicted truth≥2 in 100% of cases (39/43 exactly 3). So the intent
// rating LEADS and the measured store evidence E modulates only the uncertain middle bands:
//
//   sem 3 → R = 3.0                    core intent is not negotiable by SERP composition —
//                                      incumbents crowding the results is D's business, not R's
//   sem 2 → R = 1.4 + 1.0·E  (1.4–2.4) store evidence disambiguates partial/mixed intent
//   sem 1 → R = 0.4 + 0.8·E  (0.4–1.2) marginal intent crosses include (R≥1) only when the
//                                      store confirms the query belongs to our niche
//   sem 0 → R = 0                      anti-semantics / opposite-need veto, non-negotiable
//
//   E = conf·fit + (1−conf)·(sem/3)    thin SERP evidence falls back to the semantic prior
//
// Validated offline against judge-panel ground truth (scratchpad harness, 2026-07-26):
// v3 objective 0.29 vs 2.0 for the best exponent blend vs 7.07 for prod v2.2; core recall
// (truth-3 → R≥2.8) 100%, junk suppression 99%, false exclusions 0, rank inversions 0.

export const RELEVANCE = {
  /** Piecewise bands keyed by the integer intent rating: R = base + span·E, capped at 3. */
  bands: {
    1: { base: 0.4, span: 0.8 },
    2: { base: 1.4, span: 1.0 },
    3: { base: 3.0, span: 0.0 },
  } as Record<number, { base: number; span: number }>,
  /** Phrases below this R are excluded from metadata (unchanged boundary: R≥1 is included/charged). */
  includeThreshold: 1.0,
} as const;

export interface AppNiche {
  /** 1 — same niche (purpose-built for our core job); 0.5 — adjacent/generic tool covering the
   *  job among others; 0 — different niche. */
  match: number;
  reason: string;
}

export interface SerpFitResult {
  /** Positionally-weighted in-niche share of the top SERP, 0–1. */
  fit: number;
  /** Evidence confidence: how much of the expected top-N we actually observed, 0–1. */
  conf: number;
}

/** Positional weights mirror computeDifficulty: position i (0-based) → (serpTop−i)/Σ. */
export function serpFitOf(
  topApps: { trackId: number }[],
  niche: Record<string, AppNiche | undefined>,
  serpTop: number,
): SerpFitResult {
  const weightSum = (serpTop * (serpTop + 1)) / 2;
  let fit = 0;
  const n = Math.min(topApps.length, serpTop);
  for (let i = 0; i < n; i++) {
    const a = niche[String(topApps[i].trackId)];
    if (!a) continue;
    fit += ((serpTop - i) / weightSum) * Math.max(0, Math.min(1, a.match));
  }
  return { fit: Math.min(1, fit), conf: serpTop > 0 ? n / serpTop : 0 };
}

/**
 * Final R (0–3, one decimal), spec 03.3v3. sem is the INTENT rating from the prescreen (integers;
 * legacy float semR from pre-v3 snapshots is rounded into a band). sem≤0 is a hard zero.
 */
export function finalR(sem: number, fit: number, conf: number): number {
  const s = Math.round(Math.max(0, Math.min(3, sem)));
  if (s <= 0) return 0;
  const c = Math.max(0, Math.min(1, conf));
  const E = c * Math.max(0, Math.min(1, fit)) + (1 - c) * (s / 3);
  const band = RELEVANCE.bands[s];
  const r = Math.min(3, band.base + band.span * E);
  return Math.round(r * 10) / 10;
}
