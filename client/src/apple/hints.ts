// App Store search autosuggest (spec 02.1). Response format — XML plist OR JSON
// (Apple has changed the format). The parser must support both. Parser ported from
// aso-util/src/apple/hints.ts EXACTLY. Returns an ordered RawHints (rank = index+1).
// The client does NOT compute metrics — it only pulls raw material.

import { XMLParser } from "fast-xml-parser";
import type { AppleHttp } from "./http";
import type { RawHints } from "@aso/shared";
import { storefrontHeader } from "./storefront";

const UA = "AppStore/3.0 iOS/17.0 model/iPhone14,2";

/** One hints request for `term` in a storefront (by id). Returns ordered strings. */
export async function fetchHints(http: AppleHttp, term: string, storefrontId: number): Promise<RawHints> {
  const url =
    "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints" +
    `?clientApplication=Software&term=${encodeURIComponent(term)}`;
  const header = storefrontHeader(storefrontId);
  const body = await http.get(url, { "X-Apple-Store-Front": header, "User-Agent": UA }, header);
  return parseHints(body);
}

/** Parse a hints response: JSON `{hints:[{term}]}` or XML plist. Returns terms in order. */
export function parseHints(body: string): RawHints {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    // JSON variant: { "hints": [ { "term": "..." }, ... ] }
    const data = JSON.parse(trimmed);
    const hints = Array.isArray(data.hints) ? data.hints : [];
    return hints.map((h: any) => String(h.term ?? "")).filter(Boolean);
  }
  // plist variant
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true });
  const doc = parser.parse(trimmed);
  const terms: string[] = [];
  collectPlistTerms(doc, terms);
  return terms;
}

// In the plist each hint is a <dict> with a <key>term</key><string>...</string> pair.
// fast-xml-parser preserveOrder tree: arrays of nodes shaped { key: [...], string: [...] }.
function collectPlistTerms(node: any, out: string[]) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const n = node[i];
      if (n && typeof n === "object" && "key" in n) {
        const keyText = textOf(n.key);
        if (keyText === "term") {
          // The value is the next sibling node <string>
          const next = node[i + 1];
          if (next && typeof next === "object" && "string" in next) {
            const v = textOf(next.string);
            if (v) out.push(v);
          }
        }
      }
      collectPlistTerms(n, out);
    }
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectPlistTerms(v, out);
  }
}

function textOf(node: any): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") {
    if ("#text" in node) return String(node["#text"]);
    return Object.values(node).map(textOf).join("");
  }
  if (node === null || node === undefined) return "";
  return String(node);
}
