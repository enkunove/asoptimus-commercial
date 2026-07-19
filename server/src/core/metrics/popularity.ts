// @aso/core — Popularity (P), 0–100 (spec 03.1). PROPRIETARY, zero-I/O.
//
// BUILD-PLAN D2/D3: this module NO LONGER TOUCHES THE NETWORK. The client executes a
// ProbeJob (full-prefix shortcut → early-stop ladder → childTerms) and returns RAW DATA
// (ProbeResult). The server computes P/L/rank/childCount/seenTerms OVER `prefill ∪ fetched`
// (key = prefix). The popularityScore formula is 1:1 from aso-util (the numeric examples
// in spec/03 must match to the digit).

import { normalizeKeyword } from "@aso/shared";
import type { RawHints } from "@aso/shared";

export interface PopularityWeights {
  depth: number;
  rank: number;
}

/** Popularity computation result over raw data (domain-level, not wire). */
export interface PopularityMetrics {
  P: number;
  L: number | null;
  rank: number | null;
  unsuggested: boolean;
  childCount: number;
  /** All suggestions seen during probing (normalized, deduplicated) —
   *  raw material for source="suggest" candidates (spec 03.5). */
  seenTerms: string[];
}

/** Pure P formula from the found L and rank (spec 03.1). 1:1 with aso-util. */
export function popularityScore(N: number, L: number, rank: number, w: PopularityWeights): number {
  if (N < 2) return 0;
  const depthScore = (N - L) / (N - 1);
  const rankScore = (11 - rank) / 10;
  return Math.round(100 * (w.depth * depthScore + w.rank * rankScore));
}

/** Deterministic prefix ladder K[0:1..N] — the server puts it into the ProbeJob. */
export function prefixLadder(keyword: string): string[] {
  const K = normalizeKeyword(keyword);
  const out: string[] = [];
  for (let i = 1; i <= K.length; i++) out.push(K.slice(0, i));
  return out;
}

/**
 * Popularity computation over the RAW DATA of a ProbeJob run (BUILD-PLAN D2/D3).
 * @param keyword       source keyword
 * @param prefixHints   `prefill ∪ fetched` — key = prefix, value = ordered suggestions
 * @param childTerms    suggestions for "keyword " (for childCount); null if unsuggested
 * @param unsuggested   client flag (K did not appear even on the full prefix)
 * @param weights       popularity weights from the run config
 *
 * CRITICAL (closed blocker D2/D3): L/rank are computed over the UNION prefill∪fetched,
 * not over fetched alone — otherwise a matching prefix from the cache would be lost and P would wrongly be 0.
 */
export function computePopularity(
  keyword: string,
  prefixHints: Record<string, RawHints>,
  childTerms: RawHints | null,
  unsuggested: boolean,
  weights: PopularityWeights,
): PopularityMetrics {
  const K = normalizeKeyword(keyword);
  const N = K.length;

  // seenTerms = union of ALL suggestions (across all prefixes + childTerms), normalized.
  const seen = new Set<string>();
  for (const terms of Object.values(prefixHints)) {
    for (const t of terms) seen.add(normalizeKeyword(t));
  }
  if (childTerms) for (const t of childTerms) seen.add(normalizeKeyword(t));

  if (unsuggested) {
    return { P: 0, L: null, rank: null, unsuggested: true, childCount: 0, seenTerms: [...seen] };
  }

  // Minimal L: the smallest prefix length whose suggestions contain K.
  // Strictly in ascending length order (order is mandatory — L is a minimum).
  let L: number | null = null;
  let rank: number | null = null;
  for (let i = 1; i <= N; i++) {
    const prefix = K.slice(0, i);
    const terms = prefixHints[prefix];
    if (!terms) continue; // prefix untouched (neither cached nor fetched) — skip
    const idx = terms.findIndex((t) => normalizeKeyword(t) === K);
    if (idx >= 0) {
      L = i;
      rank = idx + 1;
      break; // early stop
    }
  }

  if (L === null || rank === null) {
    // K not found anywhere in the union — treat as unsuggested (safety net).
    return { P: 0, L: null, rank: null, unsuggested: true, childCount: 0, seenTerms: [...seen] };
  }

  // childCount: how many suggestions for "K " start with "K " (spec 03.1).
  let childCount = 0;
  if (childTerms) {
    childCount = childTerms.filter((t) => normalizeKeyword(t).startsWith(K + " ")).length;
  }

  return {
    P: popularityScore(N, L, rank, weights),
    L,
    rank,
    unsuggested: false,
    childCount,
    seenTerms: [...seen],
  };
}
