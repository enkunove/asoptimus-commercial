// @aso/core — Opportunity Score (spec 03.4). PROPRIETARY, pure function + tie-breakers.
// 1:1 port from aso-util.

export interface OpportunityWeights {
  popularityExp: number;
  easeExp: number;
}

export function opportunityScore(P: number, D: number, R: number, w: OpportunityWeights): number {
  if (P <= 0 || R <= 0) return 0;
  const value = 100 * Math.pow(P / 100, w.popularityExp) * Math.pow((100 - D) / 100, w.easeExp) * (R / 3);
  return Math.round(value);
}

/** Tie-breakers on equal Score: higher P → lower D → shorter K (spec 03.4). */
export function compareKeywords(
  a: { score: number; P: number; D: number; keyword: string },
  b: { score: number; P: number; D: number; keyword: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.P !== a.P) return b.P - a.P;
  if (a.D !== b.D) return a.D - b.D;
  return a.keyword.length - b.keyword.length;
}
