// @aso/core — валидация финальных полей (spec 05.7): T/S/K/X/W + межкорзинное X4 (05.9).
// ПРОПРИЕТАРНО. Порт 1:1 из aso-util.

import { foldKey } from "./folding.ts";
import type { Violation } from "@aso/shared";

export interface BucketFields {
  title: string;
  subtitle: string;
  keywords: string;
  titleWords: string[];
  subtitleWords: string[];
}

export interface ValidateInput {
  bucket: BucketFields;
  brand: string;
  language: string;
  stopwords: string[];
  competitors: string[];
  limits: { title: number; subtitle: number; keywords: number };
  /** Фолдинг-ключи другой корзины — для X4; пустой набор для первой корзины. */
  otherBucketKeys?: Set<string>;
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

export function bucketFoldKeys(bucket: BucketFields, brand: string, language: string): Set<string> {
  const keys = new Set<string>();
  for (const w of [...wordsOf(bucket.title), ...wordsOf(bucket.subtitle), ...wordsOf(bucket.keywords)]) {
    keys.add(foldKey(w, language));
  }
  for (const w of wordsOf(brand)) keys.delete(foldKey(w, language));
  return keys;
}

export function validate(input: ValidateInput): Violation[] {
  const v: Violation[] = [];
  const { bucket, brand, language, limits } = input;
  const stopSet = new Set(input.stopwords.map((s) => s.toLowerCase()));
  const brandKeys = new Set(wordsOf(brand).map((w) => foldKey(w, language)));

  // T1
  if (bucket.title.length > limits.title) {
    v.push({ code: "T1", message: `title длиннее ${limits.title}: ${bucket.title.length} символов`, level: "error" });
  }
  if (!bucket.title.startsWith(`${brand} - `)) {
    v.push({ code: "T1", message: `title должен начинаться с "${brand} - "`, level: "error" });
  }

  // T2
  const titleKeys = new Set(wordsOf(bucket.title).map((w) => foldKey(w, language)));
  for (const w of bucket.titleWords) {
    if (!titleKeys.has(foldKey(w.toLowerCase(), language))) {
      v.push({ code: "T2", message: `title не содержит слово "${w}"`, level: "error" });
    }
  }

  // S1
  if (bucket.subtitle.length > limits.subtitle) {
    v.push({ code: "S1", message: `subtitle длиннее ${limits.subtitle}: ${bucket.subtitle.length} символов`, level: "error" });
  }
  const subKeys = new Set(wordsOf(bucket.subtitle).map((w) => foldKey(w, language)));
  for (const w of bucket.subtitleWords) {
    if (!subKeys.has(foldKey(w.toLowerCase(), language))) {
      v.push({ code: "S1", message: `subtitle не содержит слово "${w}"`, level: "error" });
    }
  }

  // K1
  if (bucket.keywords.length > limits.keywords) {
    v.push({ code: "K1", message: `keyword field длиннее ${limits.keywords}: ${bucket.keywords.length}`, level: "error" });
  }
  if (bucket.keywords.length > 0 && !/^[^,\s]+(,[^,\s]+)*$/.test(bucket.keywords)) {
    v.push({ code: "K1", message: "keyword field: слова через запятую, без пробелов и пустых элементов", level: "error" });
  }

  // X1
  const kwKeys = bucket.keywords ? bucket.keywords.split(",").map((w) => foldKey(w.toLowerCase(), language)) : [];
  const seen = new Map<string, string>();
  const addAll = (keys: Iterable<string>, field: string) => {
    for (const k of keys) {
      if (brandKeys.has(k)) {
        if (field !== "title-brand") {
          v.push({ code: "X1", message: `слово с ключом "${k}" дублирует бренд (${field})`, level: "error" });
        }
        continue;
      }
      const prev = seen.get(k);
      if (prev && prev !== field) {
        v.push({ code: "X1", message: `повтор ключа "${k}" между ${prev} и ${field}`, level: "error" });
      } else if (prev === field && field === "keywords") {
        v.push({ code: "X1", message: `повтор ключа "${k}" внутри keyword field`, level: "error" });
      }
      seen.set(k, field);
    }
  };
  const sloganKeys = wordsOf(bucket.title.slice((brand + " - ").length)).map((w) => foldKey(w, language))
    .filter((k) => !stopSet.has(k));
  addAll(sloganKeys, "title");
  addAll([...wordsOf(bucket.subtitle).map((w) => foldKey(w, language))].filter((k) => !stopSet.has(k)), "subtitle");
  addAll(kwKeys, "keywords");

  // X2
  for (const w of bucket.keywords ? bucket.keywords.split(",") : []) {
    if (stopSet.has(w.toLowerCase())) {
      v.push({ code: "X2", message: `стоп-слово "${w}" в keyword field`, level: "error" });
    }
  }

  // X3
  const allText = `${bucket.title} ${bucket.subtitle} ${bucket.keywords}`.toLowerCase();
  for (const comp of input.competitors) {
    const c = comp.toLowerCase().trim();
    if (c && allText.includes(c)) {
      v.push({ code: "X3", message: `чужой бренд "${comp}" в метаданных`, level: "error" });
    }
  }

  // X4
  if (input.otherBucketKeys && input.otherBucketKeys.size > 0) {
    const myKeys = bucketFoldKeys(bucket, brand, language);
    for (const k of myKeys) {
      if (input.otherBucketKeys.has(k)) {
        v.push({ code: "X4", message: `ключ "${k}" повторяется между корзинами`, level: "error" });
      }
    }
  }

  // W1
  if (bucket.keywords.length < 92) {
    v.push({ code: "W1", message: `keyword field короче 92 символов (${bucket.keywords.length}) — бюджет недобран`, level: "warning" });
  }

  return v;
}
