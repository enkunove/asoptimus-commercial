// @aso/core — движок расширения suggest-графа. ПРОПРИЕТАРНО (стратегия = moat).
//
// planWave — чистая функция, порт 1:1 из aso-util (детерминированный генератор РЕАЛЬНЫХ
// запросов). runWave БОЛЬШЕ НЕ ХОДИТ В СЕТЬ (BUILD-PLAN §7): вместо inline-fetch она
// разбита на (1) planWave → задачи, (2) оркестратор ЭМИТИТ HintsJob на каждую задачу,
// (3) harvestWaveResults — чистый разбор вернувшегося сырья в discovered + done.
// «break on throttle» из старого runWave → серверный back-pressure в apple-dispatch.

import { normalizeKeyword } from "@aso/shared";
import type { RawHints } from "@aso/shared";

export interface ExpansionTask {
  /** Терм, который дёргаем: сам root, root+" ", root+" a"… → HintsJob.term. */
  term: string;
  /** Ключ операции для журнала done: "complete" | "children" | "soup:x" | "spice:for". */
  opKey: string;
  /** Корень, породивший задачу (для метки done). */
  root: string;
}

export interface ExpansionResult {
  requestsSpent: number;
  discovered: string[];
  done: { root: string; opKey: string }[];
}

// Связки-квалификаторы после головы (эмпирика: "vpn for ..." раскрывает пласт long-tail).
export const SPICE_TOKENS = ["for", "free", "with", "app", "kids", "pro"];

const CLEAN_RE = /^[\p{L}\p{N} ]+$/u;

/** Чистый поисковый запрос: буквы/цифры/пробелы, 1–4 слова, без названий-приложений. */
export function isCleanQuery(term: string): boolean {
  if (!CLEAN_RE.test(term) || term.length > 40) return false;
  const words = term.split(" ");
  if (words.length > 4) return false;
  if (words.some((w) => w.length < 2)) return false;
  return true;
}

/**
 * Составить очередь задач волны из приоритизированных корней (чистая, 1:1 из aso-util).
 * Приоритет операторов: children доказанных голов → complete слов →
 * complete/children LLM-корней → soup+spice для топ-голов.
 */
export function planWave(input: {
  provenHeads: string[];
  headWords: string[];
  llmRoots: string[];
  soupLetters: string[];
  done: Record<string, string[]>;
  budget: number;
}): ExpansionTask[] {
  const tasks: ExpansionTask[] = [];
  const has = (root: string, opKey: string) => (input.done[root] ?? []).includes(opKey);
  const push = (root: string, opKey: string, term: string) => {
    if (tasks.length >= input.budget) return;
    if (has(root, opKey)) return;
    if (tasks.some((t) => t.term === term)) return;
    tasks.push({ term, opKey, root });
  };

  for (const head of input.provenHeads) push(head, "children", head + " ");
  const llmSlotEnd = Math.min(input.budget, tasks.length + 8);
  for (const r of input.llmRoots) {
    if (tasks.length >= llmSlotEnd) break;
    push(r, "complete", r);
    if (tasks.length < llmSlotEnd) push(r, "children", r + " ");
  }
  for (const w of input.headWords) push(w, "complete", w);
  for (const head of input.provenHeads.slice(0, 2)) {
    for (const letter of input.soupLetters) push(head, `soup:${letter}`, `${head} ${letter}`);
    for (const spice of SPICE_TOKENS) push(head, `spice:${spice}`, `${head} ${spice}`);
  }
  return tasks;
}

/**
 * Чистый разбор результатов волны (сырьё HintsJob'ов → discovered + done).
 * @param results   массив { task, terms|null } — terms=null означает провал джобы.
 * `terms=null` для permanent-провала (4xx≠429/403, битый парсинг) помечает задачу done,
 * иначе задача НЕ помечается (перевыполнится на следующей волне). Троттлинг обрывает
 * волну ВЫШЕ (оркестратор перестаёт эмитить), сюда доходят только полученные ответы.
 */
export function harvestWaveResults(
  results: { task: ExpansionTask; terms: RawHints | null; permanentError?: boolean }[],
): ExpansionResult {
  const discovered = new Set<string>();
  const done: ExpansionResult["done"] = [];
  let requestsSpent = 0;
  for (const { task, terms, permanentError } of results) {
    if (terms === null) {
      if (permanentError) done.push({ root: task.root, opKey: task.opKey });
      continue;
    }
    requestsSpent++;
    for (const t of terms) {
      const n = normalizeKeyword(t);
      if (isCleanQuery(n)) discovered.add(n);
    }
    done.push({ root: task.root, opKey: task.opKey });
  }
  return { requestsSpent, discovered: [...discovered], done };
}
