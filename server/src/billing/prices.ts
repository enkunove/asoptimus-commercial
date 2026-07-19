// @aso/server/billing — models, per-keyphrase prices (D4 v3: what the user pays) and live
// token prices (INTERNAL COGS accounting: margin/fuse, NOT the user's bill).
//
// D4 v3: the debit unit is a verified keyphrase. 1 credit = $1. quote = ceil(sampleSize ×
// pricePerKeyphrase[model]). More powerful model → pricier keyphrase. Default model — Haiku.
// Internal per-attempt COGS (tokens × live price) is compared against the reserved quote:
// margin is baked into pricePerKeyphrase; if real COGS overruns the quote — the run is paused.

import type { ModelInfo } from "@aso/shared";
import { optionalEnv } from "../env.ts";
import { log } from "../log.ts";

/** Default run model (D4 v3): the cheapest keyphrase. User changes it in the form. */
export const DEFAULT_MODEL = "claude-haiku-4-5";

/** Up to +10% keyphrases included in the price (D4): the orchestrator opens no new branches past this threshold. */
export const OVERSHOOT_PCT = 0.1;

interface ModelDef { id: string; name: string; note?: string; }

// Run model registry (query kind="models"). IDs are current Anthropic strings.
const MODELS: ModelDef[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", note: "fast, cheapest keyphrase — default" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", note: "balance of quality and price" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", note: "highest quality" },
  { id: "claude-fable-5", name: "Claude Fable 5", note: "most powerful model" },
];

// ── INTERNAL COGS: live token prices (D4: "price from a live source, not hardcoded"). ──
// Overridden by env MODEL_PRICES_JSON (or DB config). costUsd is computed FROM THIS table.
export interface ModelPrice { inputPer1M: number; outputPer1M: number; }
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-fable-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
  "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
};

// ── PRICE PER KEYPHRASE (credits; 1 credit = $1). This is THE USER'S BILL (D4 v3). ──
// How the default was derived (PLACEHOLDER — exact numbers to be finalized by the user, BUILD-PLAN §9):
//   COGS/keyphrase ≈ (token price) × (typical token spend per keyphrase). From spec 04.6:
//   ~15–25 LLM calls per 150-keyphrase run, ~3k input / ~1.5k output per call.
//   Haiku: 20 × (3000×$1 + 1500×$5)/1e6 = $0.21 per 150 keyphrases ≈ $0.0014/keyphrase COGS.
//   With a healthy margin (infrastructure, support, chargebacks, price-drift risk) ×~10–15 and
//   rounding to a "nice" number → the table below. Pricier model → proportionally pricier keyphrase.
//   ⚠️ FINAL NUMBERS are up to the user. Adjust via env PRICE_PER_KEYPHRASE_JSON or DB,
//      WITHOUT editing code: {"claude-haiku-4-5":0.02,"claude-opus-4-8":0.08,...}
const DEFAULT_PRICE_PER_KEYPHRASE: Record<string, number> = {
  "claude-haiku-4-5": 0.02, // default model — the cheapest
  "claude-sonnet-5": 0.05,
  "claude-opus-4-8": 0.08,
  "claude-fable-5": 0.15,
};

let pricesCache: Record<string, ModelPrice> | null = null;
let keyphraseCache: Record<string, number> | null = null;

function loadJsonOverlay<T extends object>(envName: string, def: T): T {
  const raw = optionalEnv(envName);
  if (!raw) return def;
  try {
    return { ...def, ...(JSON.parse(raw) as object) } as T;
  } catch {
    log.warn(`${envName} failed to parse — using default`);
    return def;
  }
}

export function loadPrices(): Record<string, ModelPrice> {
  return (pricesCache ??= loadJsonOverlay("MODEL_PRICES_JSON", DEFAULT_PRICES));
}
function loadKeyphrasePrices(): Record<string, number> {
  return (keyphraseCache ??= loadJsonOverlay("PRICE_PER_KEYPHRASE_JSON", DEFAULT_PRICE_PER_KEYPHRASE));
}

export function priceFor(model: string): ModelPrice {
  const p = loadPrices();
  return p[model] ?? p[DEFAULT_MODEL];
}

/** Price of one verified keyphrase in credits (D4 v3). */
export function pricePerKeyphrase(model: string): number {
  const p = loadKeyphrasePrices();
  return p[model] ?? p[DEFAULT_MODEL];
}

/** Upfront run quote in credits = ceil(sampleSize × pricePerKeyphrase[model]) (D4). */
export function quoteFor(sampleSize: number, model: string): number {
  return Math.max(1, Math.ceil(sampleSize * pricePerKeyphrase(model) - 1e-9));
}

/** ModelInfo[] for the run form (query kind="models" / REST /api/models). */
export function modelInfos(): ModelInfo[] {
  return MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    pricePerKeyphrase: pricePerKeyphrase(m.id),
    note: m.note,
  }));
}

export function knownModel(model: string): boolean {
  return MODELS.some((m) => m.id === model);
}

/** Cost of a single LLM attempt in USD (cacheRead 0.1×input, cacheWrite 1.25×input; spec 06.2).
 *  Internal COGS accounting (D4) — NOT the user's bill. */
export function costUsdFor(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const m = priceFor(model);
  const usd =
    (usage.inputTokens * m.inputPer1M +
      usage.outputTokens * m.outputPer1M +
      usage.cacheReadTokens * m.inputPer1M * 0.1 +
      usage.cacheWriteTokens * m.inputPer1M * 1.25) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
