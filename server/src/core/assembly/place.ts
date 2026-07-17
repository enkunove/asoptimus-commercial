// @aso/core — размещение слов по полям (spec 05.5) + PlacementWeight. ПРОПРИЕТАРНО.
// Порт 1:1 из aso-util. Константы позиционного веса (05.2) — moat, живут только тут.

import { foldKey } from "./folding.ts";
import { phraseKeys, type Phrase } from "./select.ts";

// Константы позиционного веса (spec 05.2) — server-only (moat).
export const FIELD_WEIGHTS = { title: 1.0, subtitle: 0.85, keywords: 0.7 } as const;

export interface PlaceInput {
  words: string[];
  phrases: Phrase[];
  stopwords: string[];
  brandWords: string[];
  language: string;
  budgets: { titleSloganMax: number; subtitleMax: number; keywordsMax: number };
}

export interface Placement {
  titleWords: string[];
  subtitleWords: string[];
  keywordWords: string[];
}

function fieldOf(placement: Placement, key: string, language: string): "title" | "subtitle" | "keywords" | null {
  if (placement.titleWords.some((w) => foldKey(w, language) === key)) return "title";
  if (placement.subtitleWords.some((w) => foldKey(w, language) === key)) return "subtitle";
  if (placement.keywordWords.some((w) => foldKey(w, language) === key)) return "keywords";
  return null;
}

/** Вес самого слабого поля среди слов фразы; слова бренда считаются как title. */
export function placementWeight(
  keyword: string,
  placement: Placement,
  stopwords: Set<string>,
  brandKeys: Set<string>,
  language: string,
): number {
  const keys = phraseKeys(keyword, stopwords, language);
  let weight = 1.0;
  for (const k of keys) {
    if (brandKeys.has(k)) continue;
    const f = fieldOf(placement, k, language);
    if (f === null) return 0;
    weight = Math.min(weight, FIELD_WEIGHTS[f]);
  }
  return weight;
}

function fits(words: string[], budget: number, sepLen: number): boolean {
  if (words.length === 0) return true;
  const chars = words.reduce((s, w) => s + w.length, 0) + sepLen * (words.length - 1);
  return chars <= budget;
}

function totalWeight(
  placement: Placement,
  phrases: Phrase[],
  stopwords: Set<string>,
  brandKeys: Set<string>,
  language: string,
): number {
  let sum = 0;
  for (const p of phrases) sum += p.score * placementWeight(p.keyword, placement, stopwords, brandKeys, language);
  return sum;
}

export function placeWords(input: PlaceInput): Placement {
  const stopSet = new Set(input.stopwords.map((s) => s.toLowerCase()));
  const brandKeys = new Set(input.brandWords.map((w) => foldKey(w.toLowerCase(), input.language)));

  const contribution = new Map<string, number>();
  const selectedKeys = new Set(input.words.map((w) => foldKey(w, input.language)));
  for (const p of input.phrases) {
    const keys = phraseKeys(p.keyword, stopSet, input.language);
    const coveredBySelection = keys.every((k) => selectedKeys.has(k) || brandKeys.has(k));
    if (!coveredBySelection) continue;
    for (const w of input.words) {
      if (keys.includes(foldKey(w, input.language))) {
        contribution.set(w, (contribution.get(w) ?? 0) + p.score);
      }
    }
  }
  const sorted = [...input.words].sort(
    (a, b) => (contribution.get(b) ?? 0) - (contribution.get(a) ?? 0) || a.localeCompare(b),
  );

  const greedy = fillFields(sorted, input.budgets);

  const topN = Math.min(6, sorted.length);
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  let best = greedy;
  let bestScore = totalWeight(greedy, input.phrases, stopSet, brandKeys, input.language);
  for (const perm of permutations(head)) {
    const candidate = fillFields([...perm, ...tail], input.budgets);
    if (sameWordSet(candidate, greedy)) {
      const score = totalWeight(candidate, input.phrases, stopSet, brandKeys, input.language);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return best;
}

function fillFields(words: string[], budgets: PlaceInput["budgets"]): Placement {
  const title: string[] = [];
  const subtitle: string[] = [];
  const keywords: string[] = [];
  for (const w of words) {
    if (fits([...title, w], budgets.titleSloganMax, 1)) title.push(w);
    else if (fits([...subtitle, w], budgets.subtitleMax, 1)) subtitle.push(w);
    else if (fits([...keywords, w], budgets.keywordsMax, 1)) keywords.push(w);
  }
  return { titleWords: title, subtitleWords: subtitle, keywordWords: keywords };
}

function sameWordSet(a: Placement, b: Placement): boolean {
  const setOf = (p: Placement) => new Set([...p.titleWords, ...p.subtitleWords, ...p.keywordWords]);
  const sa = setOf(a);
  const sb = setOf(b);
  if (sa.size !== sb.size) return false;
  for (const w of sa) if (!sb.has(w)) return false;
  return true;
}

function* permutations<T>(arr: T[]): Generator<T[]> {
  if (arr.length <= 1) {
    yield [...arr];
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}
