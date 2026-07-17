// @aso/core — Popularity (P), 0–100 (spec 03.1). ПРОПРИЕТАРНО, zero-I/O.
//
// BUILD-PLAN D2/D3: этот модуль БОЛЬШЕ НЕ ХОДИТ В СЕТЬ. Клиент исполняет ProbeJob
// (полный-префикс-shortcut → лестница early-stop → childTerms) и возвращает СЫРЬЁ
// (ProbeResult). Сервер считает P/L/rank/childCount/seenTerms НАД `prefill ∪ fetched`
// (ключ = префикс). Формула popularityScore — 1:1 из aso-util (числовые примеры spec/03
// обязаны сходиться до цифры).

import { normalizeKeyword } from "@aso/shared";
import type { RawHints } from "@aso/shared";

export interface PopularityWeights {
  depth: number;
  rank: number;
}

/** Результат расчёта популярности над сырьём (доменный, не wire). */
export interface PopularityMetrics {
  P: number;
  L: number | null;
  rank: number | null;
  unsuggested: boolean;
  childCount: number;
  /** Все подсказки, встреченные при probing (нормализованные, без дублей) —
   *  сырьё для кандидатов source="suggest" (spec 03.5). */
  seenTerms: string[];
}

/** Чистая формула P по найденным L и rank (spec 03.1). 1:1 с aso-util. */
export function popularityScore(N: number, L: number, rank: number, w: PopularityWeights): number {
  if (N < 2) return 0;
  const depthScore = (N - L) / (N - 1);
  const rankScore = (11 - rank) / 10;
  return Math.round(100 * (w.depth * depthScore + w.rank * rankScore));
}

/** Детерминированная лестница префиксов K[0:1..N] — сервер кладёт её в ProbeJob. */
export function prefixLadder(keyword: string): string[] {
  const K = normalizeKeyword(keyword);
  const out: string[] = [];
  for (let i = 1; i <= K.length; i++) out.push(K.slice(0, i));
  return out;
}

/**
 * Расчёт популярности над СЫРЬЁМ прогона ProbeJob (BUILD-PLAN D2/D3).
 * @param keyword       исходный кейворд
 * @param prefixHints   `prefill ∪ fetched` — ключ = префикс, значение = упорядоченные подсказки
 * @param childTerms    подсказки на "keyword " (для childCount); null если unsuggested
 * @param unsuggested   флаг клиента (K не встретился даже на полном префиксе)
 * @param weights       веса popularity из конфига прогона
 *
 * КРИТИЧНО (закрытый блокер D2/D3): L/rank считаются над ОБЪЕДИНЕНИЕМ prefill∪fetched,
 * а не над одними fetched — иначе matching-префикс из кэша был бы потерян и P ошибочно = 0.
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

  // seenTerms = объединение ВСЕХ подсказок (по всем префиксам + childTerms), нормализованные.
  const seen = new Set<string>();
  for (const terms of Object.values(prefixHints)) {
    for (const t of terms) seen.add(normalizeKeyword(t));
  }
  if (childTerms) for (const t of childTerms) seen.add(normalizeKeyword(t));

  if (unsuggested) {
    return { P: 0, L: null, rank: null, unsuggested: true, childCount: 0, seenTerms: [...seen] };
  }

  // Минимальный L: наименьшая длина префикса, где K встречается в его подсказках.
  // Строго по возрастанию длины (порядок обязателен — L есть минимум).
  let L: number | null = null;
  let rank: number | null = null;
  for (let i = 1; i <= N; i++) {
    const prefix = K.slice(0, i);
    const terms = prefixHints[prefix];
    if (!terms) continue; // префикс не трогали (ни в кэше, ни фетчен) — пропускаем
    const idx = terms.findIndex((t) => normalizeKeyword(t) === K);
    if (idx >= 0) {
      L = i;
      rank = idx + 1;
      break; // ранняя остановка
    }
  }

  if (L === null || rank === null) {
    // K нигде не найден в объединении — трактуем как unsuggested (страховка).
    return { P: 0, L: null, rank: null, unsuggested: true, childCount: 0, seenTerms: [...seen] };
  }

  // childCount: сколько подсказок на "K " начинаются с "K " (spec 03.1).
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
