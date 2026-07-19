// @aso/core — suggest-graph expansion engine. PROPRIETARY (the strategy = moat).
//
// planWave — pure function, 1:1 port from aso-util (deterministic generator of REAL
// queries). runWave NO LONGER TOUCHES THE NETWORK (BUILD-PLAN §7): instead of inline
// fetch it is split into (1) planWave → tasks, (2) the orchestrator EMITS a HintsJob
// per task, (3) harvestWaveResults — pure parsing of the returned raw data into
// discovered + done. "break on throttle" from the old runWave → server-side
// back-pressure in apple-dispatch.

import { normalizeKeyword } from "@aso/shared";
import type { RawHints } from "@aso/shared";

export interface ExpansionTask {
  /** Term to hit: the root itself, root+" ", root+" a"… → HintsJob.term. */
  term: string;
  /** Operation key for the done journal: "complete" | "children" | "soup:x" | "spice:for". */
  opKey: string;
  /** Root that spawned the task (for the done marker). */
  root: string;
}

export interface ExpansionResult {
  requestsSpent: number;
  discovered: string[];
  done: { root: string; opKey: string }[];
}

// Qualifier connectors after the head (empirical: "vpn for ..." uncovers a long-tail layer).
export const SPICE_TOKENS = ["for", "free", "with", "app", "kids", "pro"];

const CLEAN_RE = /^[\p{L}\p{N} ]+$/u;

/** Clean search query: letters/digits/spaces, 1–4 words, no app names. */
export function isCleanQuery(term: string): boolean {
  if (!CLEAN_RE.test(term) || term.length > 40) return false;
  const words = term.split(" ");
  if (words.length > 4) return false;
  if (words.some((w) => w.length < 2)) return false;
  return true;
}

/**
 * Build the wave task queue from prioritized roots (pure, 1:1 from aso-util).
 * Operator priority: children of proven heads → complete of words →
 * complete/children of LLM roots → soup+spice for top heads.
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
 * Pure parsing of wave results (raw HintsJob data → discovered + done).
 * @param results   array of { task, terms|null } — terms=null means the job failed.
 * `terms=null` with a permanent failure (4xx≠429/403, broken parsing) marks the task
 * done; otherwise the task is NOT marked (it reruns on the next wave). Throttling cuts
 * the wave off ABOVE (the orchestrator stops emitting); only received responses get here.
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
