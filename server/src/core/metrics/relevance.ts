// @aso/core — final Relevance (spec 03.3v2). PROPRIETARY, pure functions.
//
// R used to be a per-keyword LLM opinion taken at final-rating time — the least stable number
// in the pipeline (batch composition swung 2↔3, which is ±33% of Score). V2 decomposes R into
// the only two things it ever actually meant:
//   semantic   — does the QUERY's intent match our product? (prescreen LLM, 0–3)
//   store fit  — how does Apple actually interpret the query? (measured: the share of top-SERP
//                apps that are in our niche, classified once per app per run)
//
// v2.1 (weighting fix): the MEASURED store fit is the reliable signal; the 0–3 LLM rating is the
// noisy one (on a live run it rated the core term "gambling addiction" 2 and the feature "panic
// button" 3 — inverting them). So the geometric blend leans on fit (0.7) and keeps the LLM as a
// SECONDARY signal (0.3): it still vetoes anti-semantics (sem=0 ⇒ R=0) and suppresses queries the
// store only coincidentally associates with us (generic "habit tracker …" the LLM correctly marks
// tangential), but it can no longer drag a store-confirmed core term below a feature. Exponents
// sum to 1 so a thin SERP (no store evidence) returns exactly the semantic prior.

export const RELEVANCE = {
  /** Geometric-blend exponents. Fit-dominant: the measured store signal leads; the LLM rating is
   *  a secondary check + the anti-semantics veto. Must sum to 1 (thin-evidence blend → R=sem). */
  semExp: 0.3,
  fitExp: 0.7,
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
