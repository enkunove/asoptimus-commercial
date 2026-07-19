// @aso/core — greedy word selection (spec 05.4). PROPRIETARY. 1:1 port from aso-util.

import { foldKey } from "./folding.ts";

export interface Phrase {
  keyword: string;
  score: number;
}

export interface SelectInput {
  phrases: Phrase[];
  stopwords: string[];
  brandWords: string[];
  language: string;
  /** Total character budget: slogan + subtitle + keywords. */
  budgetTotal: number;
  /** Words already taken by the previous pass (for cross-localization, spec 05.9). */
  excludedFoldKeys?: Set<string>;
  /** Phrases with guaranteed coverage: their words are reserved BEFORE the greedy contest, as long as they fit. */
  mustCover?: string[];
}

export interface SelectResult {
  words: string[];
  covered: Map<string, boolean>;
}

interface WordInfo {
  key: string;
  forms: Map<string, number>;
  phrases: Set<number>;
}

/** Splits a phrase into meaningful folding keys (minus stopwords). */
export function phraseKeys(keyword: string, stopwords: Set<string>, language: string): string[] {
  return keyword
    .split(" ")
    .filter((w) => w && !stopwords.has(w))
    .map((w) => foldKey(w, language));
}

export function selectWords(input: SelectInput): SelectResult {
  const stopSet = new Set(input.stopwords.map((s) => s.toLowerCase()));
  const brandKeys = new Set(input.brandWords.map((w) => foldKey(w.toLowerCase(), input.language)));
  const excluded = input.excludedFoldKeys ?? new Set<string>();

  const wordMap = new Map<string, WordInfo>();
  const phraseKeyLists: string[][] = [];

  input.phrases.forEach((p, pi) => {
    const keys = phraseKeys(p.keyword, stopSet, input.language);
    phraseKeyLists.push(keys);
    for (const w of p.keyword.split(" ").filter(Boolean)) {
      if (stopSet.has(w)) continue;
      const key = foldKey(w, input.language);
      if (brandKeys.has(key) || excluded.has(key)) continue;
      let info = wordMap.get(key);
      if (!info) {
        info = { key, forms: new Map(), phrases: new Set() };
        wordMap.set(key, info);
      }
      info.forms.set(w, (info.forms.get(w) ?? 0) + p.score);
      info.phrases.add(pi);
    }
  });

  const selected = new Set<string>();
  const order: string[] = [];
  let budgetLeft = input.budgetTotal;
  const skipped = new Set<string>();

  const isCovered = (pi: number, extra?: string): boolean =>
    phraseKeyLists[pi].every((k) => selected.has(k) || brandKeys.has(k) || excluded.has(k) || k === extra);

  // Guaranteed coverage: mustCover phrase words are taken outside the contest (as long as they fit).
  for (const phrase of input.mustCover ?? []) {
    const pi = input.phrases.findIndex((p) => p.keyword === phrase);
    if (pi < 0 || isCovered(pi)) continue;
    const missing = phraseKeyLists[pi].filter(
      (k) => !selected.has(k) && !brandKeys.has(k) && !excluded.has(k),
    );
    const infos = missing.map((k) => wordMap.get(k)).filter((x): x is WordInfo => !!x);
    if (infos.length !== missing.length) continue;
    const forms = infos.map((info) => bestForm(info));
    const cost = forms.reduce((s, f) => s + f.length + 1, 0);
    if (cost > budgetLeft) continue;
    infos.forEach((info, i) => {
      selected.add(info.key);
      order.push(forms[i]);
    });
    budgetLeft -= cost;
  }

  for (;;) {
    let best: { key: string; gain: number; ratio: number; form: string; cost: number } | null = null;

    for (const info of wordMap.values()) {
      if (selected.has(info.key) || skipped.has(info.key)) continue;
      let gain = 0;
      for (const pi of info.phrases) {
        if (isCovered(pi)) continue;
        if (isCovered(pi, info.key)) {
          gain += input.phrases[pi].score;
        } else {
          const rem = phraseKeyLists[pi].filter(
            (k) => !selected.has(k) && !brandKeys.has(k) && !excluded.has(k),
          ).length;
          if (rem > 0) gain += 0.2 * (input.phrases[pi].score / rem);
        }
      }
      if (gain <= 0) continue;
      const form = bestForm(info);
      const cost = form.length + 1;
      const ratio = gain / cost;
      if (
        !best ||
        ratio > best.ratio ||
        (ratio === best.ratio &&
          (gain > best.gain ||
            (gain === best.gain &&
              (form.length < best.form.length ||
                (form.length === best.form.length && form < best.form)))))
      ) {
        best = { key: info.key, gain, ratio, form, cost };
      }
    }

    if (!best) break;
    if (best.cost > budgetLeft) {
      skipped.add(best.key);
      continue;
    }
    selected.add(best.key);
    order.push(best.form);
    budgetLeft -= best.cost;
  }

  const covered = new Map<string, boolean>();
  input.phrases.forEach((p, pi) => covered.set(p.keyword, isCovered(pi)));
  return { words: order, covered };
}

/** Form with the maximum Score sum; tie-break — shorter, then alphabetical. */
function bestForm(info: WordInfo): string {
  let best = "";
  let bestScore = -1;
  for (const [form, score] of info.forms) {
    if (
      score > bestScore ||
      (score === bestScore && (form.length < best.length || (form.length === best.length && form < best)))
    ) {
      best = form;
      bestScore = score;
    }
  }
  return best;
}
