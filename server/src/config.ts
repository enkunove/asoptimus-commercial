// @aso/server — default RunConfig and validation (port of aso-util store/runs.ts::defaultConfig).
// Weights/limits are domain defaults (spec 01/03). Public constants come from @aso/shared.

import { DEFAULT_STOPWORDS, HTTP_DEFAULTS, FIELD_LIMITS, STOREFRONTS, type RunConfig } from "@aso/shared";
import { DEFAULT_MODEL, knownModel } from "./billing/prices.ts";

export function defaultRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const base: RunConfig = {
    brand: "",
    country: "us",
    semanticLanguage: "en",
    language: "en_us",
    sampleSize: 150,
    batchSize: 20,
    exploreRatio: 0.3,
    improvementRounds: 2,
    serpTop: 10,
    model: DEFAULT_MODEL, // D4 v4: default is Haiku (cheapest keyphrase); user changes it in the form
    extraLocale: true,
    weights: {
      popularity: { depth: 0.7, rank: 0.3 },
      difficulty: { volume: 0.45, quality: 0.15, freshness: 0.15, match: 0.25 },
      opportunity: { popularityExp: 0.6, easeExp: 0.4 },
    },
    limits: { ...FIELD_LIMITS },
    http: { ...HTTP_DEFAULTS },
    stopwords: [...DEFAULT_STOPWORDS],
  };
  return { ...base, ...overrides, weights: { ...base.weights, ...(overrides.weights ?? {}) }, limits: { ...base.limits, ...(overrides.limits ?? {}) } };
}

export function validateRunConfig(c: RunConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!c.brand?.trim()) errors.brand = "brand is required";
  else if (c.brand.length + 3 > c.limits.title) errors.brand = `brand + " - " does not fit the title limit (${c.limits.title})`;
  if (!(c.sampleSize >= 30 && c.sampleSize <= 500)) errors.sampleSize = "sampleSize must be in [30, 500]";
  if (!(c.batchSize >= 5 && c.batchSize <= 50)) errors.batchSize = "batchSize must be in [5, 50]";
  if (!(c.exploreRatio >= 0 && c.exploreRatio <= 1)) errors.exploreRatio = "exploreRatio must be in [0, 1]";
  const pw = c.weights.popularity;
  if (Math.abs(pw.depth + pw.rank - 1) > 0.001) errors.weights = "popularity weights must sum to 1.0";
  const dw = c.weights.difficulty;
  if (Math.abs(dw.volume + dw.quality + dw.freshness + dw.match - 1) > 0.001) errors.weights = "difficulty weights must sum to 1.0";
  if (!(c.country in STOREFRONTS)) errors.country = `unknown country; supported: ${Object.keys(STOREFRONTS).join(", ")}`;
  if (!knownModel(c.model)) errors.model = `unknown model: ${c.model}`;
  return errors;
}
