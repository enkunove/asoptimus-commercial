// @aso/server/billing — модели, цены за кейфразу (D4 v3: то, что платит юзер) и живые
// цены токенов (ВНУТРЕННИЙ COGS-учёт: маржа/предохранитель, НЕ чек юзеру).
//
// D4 v3: единица списания — проверенная кейфраза. 1 кредит = $1. quote = ceil(sampleSize ×
// pricePerKeyphrase[model]). Мощнее модель → дороже кейфраза. Дефолт модели — Haiku.
// Внутренний per-attempt COGS (токены × живая цена) сравнивается с зарезервированным квотом:
// маржа зашита в pricePerKeyphrase; если реальный COGS вылез за квот — прогон ставится на паузу.

import type { ModelInfo } from "@aso/shared";
import { optionalEnv } from "../env.ts";
import { log } from "../log.ts";

/** Дефолтная модель прогона (D4 v3): самая дешёвая кейфраза. Пользователь меняет в форме. */
export const DEFAULT_MODEL = "claude-haiku-4-5";

/** До +10% кейфраз включено в цену (D4): оркестратор не заводит новые ветки после этого порога. */
export const OVERSHOOT_PCT = 0.1;

interface ModelDef { id: string; name: string; note?: string; }

// Реестр моделей прогона (query kind="models"). ID — актуальные Anthropic-строки.
const MODELS: ModelDef[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", note: "быстрая, самая дешёвая кейфраза — по умолчанию" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", note: "баланс качества и цены" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", note: "высшее качество" },
  { id: "claude-fable-5", name: "Claude Fable 5", note: "самая мощная модель" },
];

// ── ВНУТРЕННИЙ COGS: живые цены токенов (D4: «цена из живого источника, не хардкод»). ──
// Перекрывается env MODEL_PRICES_JSON (или БД-конфигом). costUsd считается ПО ЭТОЙ таблице.
export interface ModelPrice { inputPer1M: number; outputPer1M: number; }
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-fable-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
  "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
};

// ── ЦЕНА ЗА КЕЙФРАЗУ (кредитов; 1 кредит = $1). Это ЧЕК ПОЛЬЗОВАТЕЛЮ (D4 v3). ──
// Как выведен дефолт (ПЛЕЙСХОЛДЕР — точные числа финализирует пользователь, BUILD-PLAN §9):
//   COGS/кейфразу ≈ (цена токенов) × (типичный расход токенов на кейфразу). Из spec 04.6:
//   ~15–25 LLM-вызовов на прогон в 150 кейфраз, ~3k input / ~1.5k output на вызов.
//   Haiku: 20 × (3000×$1 + 1500×$5)/1e6 = $0.21 за 150 кейфраз ≈ $0.0014/кейфраза COGS.
//   Со здоровой маржой (инфраструктура, поддержка, чарджбэки, риск дрейфа цен) ×~10–15 и
//   округление до «красивого» → таблица ниже. Дороже модель → пропорционально дороже кейфраза.
//   ⚠️ ФИНАЛЬНЫЕ ЦИФРЫ — за пользователем. Правь через env PRICE_PER_KEYPHRASE_JSON или БД,
//      НЕ редактируя код: {"claude-haiku-4-5":0.02,"claude-opus-4-8":0.08,...}
const DEFAULT_PRICE_PER_KEYPHRASE: Record<string, number> = {
  "claude-haiku-4-5": 0.02, // дефолтная модель — самая дешёвая
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
    log.warn(`${envName} не распарсился — использую дефолт`);
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

/** Цена одной проверенной кейфразы в кредитах (D4 v3). */
export function pricePerKeyphrase(model: string): number {
  const p = loadKeyphrasePrices();
  return p[model] ?? p[DEFAULT_MODEL];
}

/** Апфронт-квот прогона в кредитах = ceil(sampleSize × pricePerKeyphrase[model]) (D4). */
export function quoteFor(sampleSize: number, model: string): number {
  return Math.max(1, Math.ceil(sampleSize * pricePerKeyphrase(model) - 1e-9));
}

/** ModelInfo[] для формы прогона (query kind="models" / REST /api/models). */
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

/** Себестоимость одной LLM-попытки в USD (cacheRead 0.1×input, cacheWrite 1.25×input; spec 06.2).
 *  Внутренний COGS-учёт (D4) — НЕ чек юзеру. */
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
