// @aso/server — дефолтный RunConfig и валидация (порт aso-util store/runs.ts::defaultConfig).
// Веса/лимиты — доменные дефолты (spec 01/03). Публичные константы берём из @aso/shared.

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
    model: DEFAULT_MODEL, // D4 v4: дефолт — Haiku (самая дешёвая кейфраза); юзер меняет в форме
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
  if (!c.brand?.trim()) errors.brand = "бренд обязателен";
  else if (c.brand.length + 3 > c.limits.title) errors.brand = `бренд + " - " не влезает в лимит title (${c.limits.title})`;
  if (!(c.sampleSize >= 30 && c.sampleSize <= 500)) errors.sampleSize = "sampleSize в [30, 500]";
  if (!(c.batchSize >= 5 && c.batchSize <= 50)) errors.batchSize = "batchSize в [5, 50]";
  if (!(c.exploreRatio >= 0 && c.exploreRatio <= 1)) errors.exploreRatio = "exploreRatio в [0, 1]";
  const pw = c.weights.popularity;
  if (Math.abs(pw.depth + pw.rank - 1) > 0.001) errors.weights = "сумма весов popularity = 1.0";
  const dw = c.weights.difficulty;
  if (Math.abs(dw.volume + dw.quality + dw.freshness + dw.match - 1) > 0.001) errors.weights = "сумма весов difficulty = 1.0";
  if (!(c.country in STOREFRONTS)) errors.country = `неизвестная страна; поддерживаются: ${Object.keys(STOREFRONTS).join(", ")}`;
  if (!knownModel(c.model)) errors.model = `неизвестная модель: ${c.model}`;
  return errors;
}
