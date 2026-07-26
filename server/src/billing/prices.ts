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

// ── PRICE PER KEYPHRASE (credits; 1 credit = $1) — LEGACY (billing v1). ──
// Runs created before D4 v5 keep this flat per-keyphrase debit forever (their state carries
// billing.version < 2). New runs use the workload fee schedule below.
const DEFAULT_PRICE_PER_KEYPHRASE: Record<string, number> = {
  "claude-haiku-4-5": 0.02, // default model — the cheapest
  "claude-sonnet-5": 0.05,
  "claude-opus-4-8": 0.08,
  "claude-fable-5": 0.15,
};

// ── D4 v5: WORKLOAD FEE SCHEDULE (credits; 1 credit = $1). This is THE USER'S BILL. ──
// The debit is no longer one flat step per keyphrase: every stage of real work carries a small
// fee, so spending is smooth and tracks the actual effort the run performs. The user-facing
// surface stays a single run ESTIMATE — the schedule itself is internal (no per-unit price list
// in the UI).
//
//   prescreenPerKeyword — every candidate rated by the prescreen (incl. the ones it rejects);
//                         hunting for survivors is where large runs burn effort
//   probePerKeyword     — every keyword actually measured against the store (P probe + SERP)
//   classifyPerApp      — every new store app niche-classified for the run
//   inclusionBase       — every keyphrase that makes the cut (R≥1, charged at inclusion)
//   inclusionSlope      — the progressive part: the k-th included keyphrase costs
//                         inclusionBase + k·inclusionSlope. Deeper in a run every additional
//                         surviving keyphrase is harder to find (the superlinearity is real:
//                         rejected/measured ratios grow with sample size), and the schedule
//                         prices that in — smoothly, with no fixed steps.
//
// CALIBRATION (haiku, from live-run telemetry: ≈4 prescreen candidates, ≈1.8 measured
// keywords and ≈7.5 classified apps per sample slot; ≈0.92 inclusions per slot):
//   expected(S) ≈ 0.0276·S + 0.0000113·S²  →  S=200 ≈ 6.0 cr, S=500 ≈ 16.6 → quote 17 cr.
// Other models scale by MODEL_FEE_MULT. Override via env RUN_FEES_JSON (base schedule) and
// MODEL_FEE_MULT_JSON without code changes.
export interface RunFees {
  prescreenPerKeyword: number;
  probePerKeyword: number;
  classifyPerApp: number;
  inclusionBase: number;
  inclusionSlope: number;
}
const DEFAULT_RUN_FEES: RunFees = {
  prescreenPerKeyword: 0.002,
  probePerKeyword: 0.005,
  classifyPerApp: 0.0008,
  inclusionBase: 0.005,
  inclusionSlope: 0.000027,
};
const DEFAULT_MODEL_FEE_MULT: Record<string, number> = {
  "claude-haiku-4-5": 1,
  "claude-sonnet-5": 2.5,
  "claude-opus-4-8": 4,
  "claude-fable-5": 7.5,
};
/** Expected work per sample slot (from live-run telemetry) — quote model only. */
const EXPECTED_PER_SLOT = { prescreen: 4, probe: 1.8, classify: 7.5, inclusion: 0.92 };

let pricesCache: Record<string, ModelPrice> | null = null;
let keyphraseCache: Record<string, number> | null = null;
let feesCache: RunFees | null = null;
let feeMultCache: Record<string, number> | null = null;

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

/** Price of one verified keyphrase in credits — LEGACY (billing v1 runs only). */
export function pricePerKeyphrase(model: string): number {
  const p = loadKeyphrasePrices();
  return p[model] ?? p[DEFAULT_MODEL];
}

function feeMult(model: string): number {
  feeMultCache ??= loadJsonOverlay("MODEL_FEE_MULT_JSON", DEFAULT_MODEL_FEE_MULT);
  return feeMultCache[model] ?? feeMultCache[DEFAULT_MODEL] ?? 1;
}

/** The run's workload fee schedule in credits, scaled to the model (D4 v5). */
export function runFees(model: string): RunFees {
  feesCache ??= loadJsonOverlay("RUN_FEES_JSON", DEFAULT_RUN_FEES);
  const m = feeMult(model);
  return {
    prescreenPerKeyword: feesCache.prescreenPerKeyword * m,
    probePerKeyword: feesCache.probePerKeyword * m,
    classifyPerApp: feesCache.classifyPerApp * m,
    inclusionBase: feesCache.inclusionBase * m,
    inclusionSlope: feesCache.inclusionSlope * m,
  };
}

/**
 * Run quote in credits (D4 v5): expected workload × the fee schedule. Superlinear in
 * sampleSize — the progressive inclusion fee prices in how much harder survivors are to find
 * deep into a large run. An ESTIMATE for the run form, not a reserve.
 */
export function quoteFor(sampleSize: number, model: string): number {
  const f = runFees(model);
  const e = EXPECTED_PER_SLOT;
  const inclusions = e.inclusion * sampleSize;
  const linear =
    f.prescreenPerKeyword * e.prescreen * sampleSize +
    f.probePerKeyword * e.probe * sampleSize +
    f.classifyPerApp * e.classify * sampleSize +
    f.inclusionBase * inclusions;
  const progressive = (f.inclusionSlope * inclusions * inclusions) / 2;
  return Math.max(1, Math.ceil(linear + progressive - 1e-9));
}

/** ModelInfo[] for the run form (query kind="models" / REST /api/models).
 *  D4 v5: pricePerKeyphrase carries the effective AVERAGE at a typical sampleSize so that
 *  clients still computing a linear estimate land near the real workload quote; new clients
 *  ask the server (kind="quote") instead. */
export function modelInfos(): ModelInfo[] {
  return MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    pricePerKeyphrase: Math.round((quoteFor(150, m.id) / 150) * 10_000) / 10_000,
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
