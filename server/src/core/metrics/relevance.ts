// @aso/core — final Relevance (spec 03.3v2). PROPRIETARY, pure functions.
//
// R used to be a per-keyword LLM opinion taken at final-rating time — the least stable number
// in the pipeline (batch composition swung 2↔3, which is ±33% of Score). V2 decomposes R into
// the only two things it ever actually meant:
//   semantic   — does the QUERY's intent match our product? (prescreen LLM, 0–3, unchanged)
//   store fit  — how does Apple actually interpret the query? (measured: the share of top-SERP
//                apps that are in our niche, classified once per app per run)
// The final number is computed, continuous, and every factor is traceable to raw data.

export const RELEVANCE = {
  /** Exponents of the geometric blend: both factors are necessary, semantics slightly heavier. */
  semExp: 0.6,
  fitExp: 0.4,
  /** Phrases below this R are excluded from metadata (same boundary as the old integer R≥1). */
  includeThreshold: 1.0,
} as const;

export interface AppNiche {
  /** 1 — same niche (a user searching for our kind of app is satisfied by this result);
   *  0.5 — adjacent; 0 — different niche. */
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
 * Final R (0–3, one decimal). Thin SERP evidence is blended back toward the semantic prior
 * (conf<1 → the store told us little; trust the meaning). sem≤0 is a hard zero — the
 * anti-semantics verdict from the prescreen is not negotiable.
 */
export function finalR(sem: number, fit: number, conf: number): number {
  const s = Math.max(0, Math.min(3, sem));
  if (s <= 0) return 0;
  const c = Math.max(0, Math.min(1, conf));
  const fitAdj = c * Math.max(0, Math.min(1, fit)) + (1 - c) * (s / 3);
  const r = 3 * Math.pow(s / 3, RELEVANCE.semExp) * Math.pow(fitAdj, RELEVANCE.fitExp);
  return Math.round(r * 10) / 10;
}
