// @aso/core — final field validation (spec 05.7): T/S/K/X/W + cross-bucket X4 (05.9).
// PROPRIETARY. 1:1 port from aso-util.

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
  /** Folding keys of the other bucket — for X4; empty set for the first bucket. */
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
    v.push({ code: "T1", message: `title longer than ${limits.title}: ${bucket.title.length} characters`, level: "error" });
  }
  if (!bucket.title.startsWith(`${brand} - `)) {
    v.push({ code: "T1", message: `title must start with "${brand} - "`, level: "error" });
  }

  // T2
  const titleKeys = new Set(wordsOf(bucket.title).map((w) => foldKey(w, language)));
  for (const w of bucket.titleWords) {
    if (!titleKeys.has(foldKey(w.toLowerCase(), language))) {
      v.push({ code: "T2", message: `title does not contain the word "${w}"`, level: "error" });
    }
  }

  // S1
  if (bucket.subtitle.length > limits.subtitle) {
    v.push({ code: "S1", message: `subtitle longer than ${limits.subtitle}: ${bucket.subtitle.length} characters`, level: "error" });
  }
  const subKeys = new Set(wordsOf(bucket.subtitle).map((w) => foldKey(w, language)));
  for (const w of bucket.subtitleWords) {
    if (!subKeys.has(foldKey(w.toLowerCase(), language))) {
      v.push({ code: "S1", message: `subtitle does not contain the word "${w}"`, level: "error" });
    }
  }

  // K1
  if (bucket.keywords.length > limits.keywords) {
    v.push({ code: "K1", message: `keyword field longer than ${limits.keywords}: ${bucket.keywords.length}`, level: "error" });
  }
  if (bucket.keywords.length > 0 && !/^[^,\s]+(,[^,\s]+)*$/.test(bucket.keywords)) {
    v.push({ code: "K1", message: "keyword field: comma-separated words, no spaces or empty items", level: "error" });
  }

  // X1
  const kwKeys = bucket.keywords ? bucket.keywords.split(",").map((w) => foldKey(w.toLowerCase(), language)) : [];
  const seen = new Map<string, string>();
  const addAll = (keys: Iterable<string>, field: string) => {
    for (const k of keys) {
      if (brandKeys.has(k)) {
        if (field !== "title-brand") {
          v.push({ code: "X1", message: `word with key "${k}" duplicates the brand (${field})`, level: "error" });
        }
        continue;
      }
      const prev = seen.get(k);
      if (prev && prev !== field) {
        v.push({ code: "X1", message: `key "${k}" repeated between ${prev} and ${field}`, level: "error" });
      } else if (prev === field && field === "keywords") {
        v.push({ code: "X1", message: `key "${k}" repeated inside the keyword field`, level: "error" });
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
      v.push({ code: "X2", message: `stopword "${w}" in the keyword field`, level: "error" });
    }
  }

  // X3
  const allText = `${bucket.title} ${bucket.subtitle} ${bucket.keywords}`.toLowerCase();
  for (const comp of input.competitors) {
    const c = comp.toLowerCase().trim();
    if (c && allText.includes(c)) {
      v.push({ code: "X3", message: `third-party brand "${comp}" in the metadata`, level: "error" });
    }
  }

  // X4
  if (input.otherBucketKeys && input.otherBucketKeys.size > 0) {
    const myKeys = bucketFoldKeys(bucket, brand, language);
    for (const k of myKeys) {
      if (input.otherBucketKeys.has(k)) {
        v.push({ code: "X4", message: `key "${k}" repeated between buckets`, level: "error" });
      }
    }
  }

  // W1
  if (bucket.keywords.length < 92) {
    v.push({ code: "W1", message: `keyword field shorter than 92 characters (${bucket.keywords.length}) — budget underused`, level: "warning" });
  }

  return v;
}
