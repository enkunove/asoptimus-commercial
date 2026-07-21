// @aso/core — assembly v2 (spec 05v2): joint word-slot optimization across BOTH localization
// buckets. PROPRIETARY.
//
// Why word-first: v1 picked whole phrases for title/subtitle, so it could never discover
// packings like "Bet & Gamble Blocker" (covers "bet blocker" + "gamble blocker" through the
// shared word) or overlapped subtitles like "Quit Gambling Addiction" (two top queries in
// 23 characters — v1's subtitle combo demanded DISJOINT phrases and forbade exactly this).
// The unit of indexing is the WORD: a word contributes to every phrase it completes, so the
// optimizer places fold-keys into six slots (T/S/K × two buckets) to maximize the R-weighted
// Score of completed phrases under positional field weights. The store indexes the union of
// localizations, so phrases completed ACROSS buckets count too, at a discount.

import { foldKey } from "./folding.ts";
import { FIELD_WEIGHTS } from "./place.ts";

export interface OptPhrase {
  keyword: string;
  score: number;
  R: number | null;
}

export interface OptimizeInput {
  phrases: OptPhrase[];
  stopwords: string[];
  brandWords: string[];
  language: string;
  budgets: { titleSloganMax: number; subtitleMax: number; keywordsMax: number };
  bucketCount: 1 | 2;
  /** Fold-keys of job verbs (quit/stop/block…): a title slot containing one reads as a
   *  product statement, not a word pile — small additive bonus steers composability. */
  anchorKeys?: Set<string>;
  /** Fold-keys that must never occupy budget (e.g. words that exist only inside brand
   *  queries for other products — indexing them buys competitor-brand traffic). */
  bannedKeys?: Set<string>;
}

export interface BucketWordPlan {
  /** Surface forms in value order; compose/order them before showing to humans. */
  title: string[];
  subtitle: string[];
  keywords: string[];
}

export interface OptimizeResult {
  buckets: BucketWordPlan[];
  /** Objective value — exposed for tests and for comparing design variants. */
  objective: number;
}

// A phrase completed across two buckets is still indexed (union), but loses same-field
// adjacency — discounted. Title anchor bonus is deliberately small: it breaks ties toward
// readable titles without overriding real Score.
const CROSS_BUCKET_FACTOR = 0.8;
const ANCHOR_BONUS = 8;
const PARTIAL_SHAPING = 0.2;
/** Composability caps: a title of 5+ significant words cannot be read as a slogan. */
const TITLE_WORD_CAP = 4;
const SUBTITLE_WORD_CAP = 5;
/** The primary bucket is the listing most users see — value placed there wins ties. */
const SECONDARY_BUCKET_FACTOR = 0.93;
/** A phrase whose every word sits in ONE title/subtitle slot will be composed contiguously —
 *  exact-substring presence beats scattered words; reward slots that ARE phrases. */
const COHESION_BONUS = 0.15;
/** Words whose best marginal gain is below this never earn their characters — prunes the
 *  long tail of value-1 R1 words (junk and stray brand names); speculative fill will top the
 *  keyword field back up to the 92-char floor with unsuggested R=3 words instead. */
const MIN_PLACEMENT_GAIN = 2;

interface Slot {
  bucket: number;
  field: "title" | "subtitle" | "keywords";
  capChars: number;
  capWords: number;
}

interface WordInfo {
  key: string;
  form: string; // best surface form (max summed value, then shorter, then alphabetical)
  formValue: number;
  phrases: number[];
}

const rWeight = (r: number | null) => ((r ?? 0) >= 3 ? 1 : (r ?? 0) === 2 ? 0.35 : 0.1);

export function optimizeAssembly(input: OptimizeInput): OptimizeResult {
  const stopSet = new Set(input.stopwords.map((s) => s.toLowerCase()));
  const brandKeys = new Set(input.brandWords.map((w) => foldKey(w.toLowerCase(), input.language)));
  const anchors = input.anchorKeys ?? new Set<string>();

  // Phrase values and per-word aggregation.
  const values = input.phrases.map((p) => Math.max(1, Math.round(p.score * rWeight(p.R))));
  const phraseKeys: string[][] = input.phrases.map((p) =>
    p.keyword
      .split(" ")
      .filter((w) => w && !stopSet.has(w))
      .map((w) => foldKey(w, input.language))
      .filter((k) => !brandKeys.has(k)),
  );

  const words = new Map<string, WordInfo>();
  input.phrases.forEach((p, pi) => {
    for (const w of p.keyword.split(" ")) {
      if (!w || stopSet.has(w)) continue;
      const key = foldKey(w, input.language);
      if (brandKeys.has(key)) continue;
      if (input.bannedKeys?.has(key)) continue;
      let info = words.get(key);
      if (!info) {
        info = { key, form: w, formValue: values[pi], phrases: [pi] };
        words.set(key, info);
        continue;
      }
      if (!info.phrases.includes(pi)) info.phrases.push(pi);
      // Best surface form: max summed value; tie → shorter, then alphabetical.
      const fv = values[pi];
      if (
        fv > info.formValue ||
        (fv === info.formValue && (w.length < info.form.length || (w.length === info.form.length && w < info.form)))
      ) {
        if (w !== info.form) { info.form = w; info.formValue = fv; }
      }
    }
  });

  const slots: Slot[] = [];
  for (let b = 0; b < input.bucketCount; b++) {
    slots.push({ bucket: b, field: "title", capChars: input.budgets.titleSloganMax, capWords: TITLE_WORD_CAP });
    slots.push({ bucket: b, field: "subtitle", capChars: input.budgets.subtitleMax, capWords: SUBTITLE_WORD_CAP });
    slots.push({ bucket: b, field: "keywords", capChars: input.budgets.keywordsMax, capWords: Number.MAX_SAFE_INTEGER });
  }

  // assignment: fold-key → slot index
  const assign = new Map<string, number>();
  const slotWords: string[][] = slots.map(() => []);
  const slotChars: number[] = slots.map(() => 0);

  const costOf = (form: string, si: number) => form.length + (slotWords[si].length > 0 ? 1 : 0);
  const fits = (info: WordInfo, si: number) => {
    if (slotWords[si].length >= slots[si].capWords) return false;
    if (slotChars[si] + costOf(info.form, si) > slots[si].capChars) return false;
    // A title must not read as a stutter: forbid prefix pairs (block/blocker) in one slot.
    if (slots[si].field === "title") {
      const f = info.form.toLowerCase();
      for (const w of slotWords[si]) {
        const o = w.toLowerCase();
        if (f.startsWith(o) || o.startsWith(f)) return false;
      }
    }
    return true;
  };

  const objective = (): number => {
    let sum = 0;
    for (let pi = 0; pi < input.phrases.length; pi++) {
      const keys = phraseKeys[pi];
      if (keys.length === 0) { sum += values[pi]; continue; } // brand/stopword-only phrase
      let minW = 1;
      let bucketOf: number | null = null;
      let cross = false;
      let placed = 0;
      let oneSlot: number | null | -1 = null; // -1 → words span slots
      for (const k of keys) {
        const si = assign.get(k);
        if (si === undefined) continue;
        placed += 1;
        minW = Math.min(minW, FIELD_WEIGHTS[slots[si].field] * (slots[si].bucket > 0 ? SECONDARY_BUCKET_FACTOR : 1));
        if (bucketOf === null) bucketOf = slots[si].bucket;
        else if (bucketOf !== slots[si].bucket) cross = true;
        if (oneSlot === null) oneSlot = si;
        else if (oneSlot !== si) oneSlot = -1;
      }
      if (placed === keys.length) {
        sum += values[pi] * minW * (cross ? CROSS_BUCKET_FACTOR : 1);
        // Whole phrase inside a single title/subtitle slot → it will be composed as a
        // contiguous run; keyword-field slots gain nothing (order there is meaningless).
        if (keys.length > 1 && oneSlot !== null && oneSlot !== -1 && slots[oneSlot].field !== "keywords") {
          sum += COHESION_BONUS * values[pi];
        }
      } else if (placed > 0) sum += PARTIAL_SHAPING * values[pi] * (placed / keys.length);
    }
    for (const si of slots.keys()) {
      if (slots[si].field !== "title") continue;
      if (slotWords[si].some((f) => anchors.has(foldKey(f, input.language)))) sum += ANCHOR_BONUS;
    }
    return sum;
  };

  const place = (info: WordInfo, si: number) => {
    assign.set(info.key, si);
    slotChars[si] += costOf(info.form, si);
    slotWords[si].push(info.form);
  };
  const unplace = (info: WordInfo) => {
    const si = assign.get(info.key)!;
    const idx = slotWords[si].indexOf(info.form);
    slotWords[si].splice(idx, 1);
    slotChars[si] -= info.form.length + (slotWords[si].length > 0 ? 1 : 0);
    assign.delete(info.key);
  };

  // Phrase seeding: the word-at-a-time greedy is myopic — it never tries a phrase as a
  // unit, so top queries end up scattered across fields. Give the highest-value R≥3 phrases
  // first claim on the title/subtitle slots as WHOLE groups (this is exactly how a human
  // assembles: start from "bet blocker" / "quit gambling", pack around them). The greedy
  // and local search then refine around the seeds.
  let base = objective();
  {
    const seedSlots = [...slots.keys()]
      .filter((si) => slots[si].field !== "keywords")
      .sort((a, b) =>
        FIELD_WEIGHTS[slots[b].field] * (slots[b].bucket > 0 ? SECONDARY_BUCKET_FACTOR : 1) -
        FIELD_WEIGHTS[slots[a].field] * (slots[a].bucket > 0 ? SECONDARY_BUCKET_FACTOR : 1));
    const seedOrder = [...input.phrases.keys()]
      .filter((pi) => (input.phrases[pi].R ?? 0) >= 3 && phraseKeys[pi].length > 0)
      .sort((a, b) => values[b] - values[a] || input.phrases[a].keyword.length - input.phrases[b].keyword.length);
    for (const pi of seedOrder) {
      const keys = phraseKeys[pi];
      const infos = keys.map((k) => words.get(k));
      if (infos.some((x) => !x)) continue;
      for (const si of seedSlots) {
        // Every word must land in THIS slot: unassigned and fitting, or already here.
        const pending = (infos as WordInfo[]).filter((info) => assign.get(info.key) !== si);
        if (pending.some((info) => assign.has(info.key))) continue;
        const placedNow: WordInfo[] = [];
        let okAll = true;
        for (const info of pending) {
          if (!fits(info, si)) { okAll = false; break; }
          place(info, si);
          placedNow.push(info);
        }
        if (!okAll) { for (const info of placedNow.reverse()) unplace(info); continue; }
        const now = objective();
        if (now > base) { base = now; break; }
        for (const info of placedNow.reverse()) unplace(info);
      }
    }
  }

  // Greedy: repeatedly place the (word, slot) with the best marginal gain per character.
  // Deterministic: candidates iterated in insertion order, ties broken by ratio → gain →
  // shorter form → alphabetical.
  for (;;) {
    let best: { info: WordInfo; si: number; gain: number; ratio: number } | null = null;
    for (const info of words.values()) {
      if (assign.has(info.key)) continue;
      for (let si = 0; si < slots.length; si++) {
        if (!fits(info, si)) continue;
        place(info, si);
        const gain = objective() - base;
        unplace(info);
        if (gain < MIN_PLACEMENT_GAIN) continue;
        const ratio = gain / (info.form.length + 1);
        if (
          !best ||
          ratio > best.ratio ||
          (ratio === best.ratio &&
            (gain > best.gain ||
              (gain === best.gain &&
                (info.form.length < best.info.form.length ||
                  (info.form.length === best.info.form.length && info.form < best.info.form)))))
        ) {
          best = { info, si, gain, ratio };
        }
      }
    }
    if (!best) break;
    place(best.info, best.si);
    base = objective();
  }

  // Local search: single-word relocations while they strictly improve (bounded passes).
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (const info of [...words.values()]) {
      const from = assign.get(info.key);
      if (from === undefined) continue;
      for (let si = 0; si < slots.length; si++) {
        if (si === from) continue;
        unplace(info);
        if (!fits(info, si)) { place(info, from); continue; }
        place(info, si);
        const now = objective();
        if (now > base) { base = now; improved = true; break; }
        unplace(info);
        place(info, from);
      }
    }
    if (!improved) break;
  }

  const buckets: BucketWordPlan[] = [];
  for (let b = 0; b < input.bucketCount; b++) {
    buckets.push({
      title: slotWords[b * 3],
      subtitle: slotWords[b * 3 + 1],
      keywords: slotWords[b * 3 + 2],
    });
  }
  return { buckets, objective: base };
}

/** Best human ordering for a title/subtitle word set: the permutation realizing the highest
 *  summed value of phrases that appear CONTIGUOUSLY in order (exact-substring beats scattered
 *  presence). ≤5 words → brute force is exact and cheap. Deterministic. */
export function orderForField(
  forms: string[],
  phrases: OptPhrase[],
  stopwords: string[],
  language: string,
): string[] {
  if (forms.length <= 1) return [...forms];
  const stopSet = new Set(stopwords.map((s) => s.toLowerCase()));
  const values = phrases.map((p) => Math.max(1, Math.round(p.score * rWeight(p.R))));
  const seqs = phrases.map((p) =>
    p.keyword.split(" ").filter((w) => w && !stopSet.has(w)).map((w) => foldKey(w, language)),
  );
  const keyOf = (f: string) => foldKey(f, language);
  let best: string[] = [...forms];
  let bestScore = -1;
  let bestCount = -1;
  for (const perm of permutations(forms)) {
    const keys = perm.map(keyOf);
    let score = 0;
    let count = 0;
    for (let pi = 0; pi < seqs.length; pi++) {
      const seq = seqs[pi];
      if (seq.length === 0 || seq.length > keys.length) continue;
      for (let i = 0; i + seq.length <= keys.length; i++) {
        if (seq.every((k, j) => keys[i + j] === k)) { score += values[pi]; count += 1; break; }
      }
    }
    if (score > bestScore || (score === bestScore && count > bestCount)) {
      best = perm; bestScore = score; bestCount = count;
    }
  }
  return best;
}

/** Deterministic glue for the fallback composer: Title Case + a single "&" at the first
 *  boundary where the neighbors never co-occur adjacently in a covered phrase (reads as a
 *  list of two things instead of a run-on), only if it fits the budget. */
export function glueField(
  ordered: string[],
  phrases: OptPhrase[],
  stopwords: string[],
  language: string,
  capChars: number,
): string {
  const tc = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const plain = ordered.map(tc).join(" ");
  if (ordered.length < 2) return plain;
  const stopSet = new Set(stopwords.map((s) => s.toLowerCase()));
  const seqs = phrases.map((p) =>
    p.keyword.split(" ").filter((w) => w && !stopSet.has(w)).map((w) => foldKey(w, language)),
  );
  const adjacent = (a: string, b: string) => {
    const ka = foldKey(a, language);
    const kb = foldKey(b, language);
    return seqs.some((seq) => seq.some((k, i) => k === ka && seq[i + 1] === kb));
  };
  for (let i = 0; i + 1 < ordered.length; i++) {
    if (!adjacent(ordered[i], ordered[i + 1])) {
      const withAmp = [...ordered.slice(0, i + 1).map(tc), "&", ...ordered.slice(i + 1).map(tc)].join(" ");
      return withAmp.length <= capChars ? withAmp : plain;
    }
  }
  return plain;
}

function* permutations<T>(arr: T[]): Generator<T[]> {
  if (arr.length <= 1) { yield [...arr]; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}
