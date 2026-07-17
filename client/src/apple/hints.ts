// Автоподсказки поиска App Store (spec 02.1). Формат ответа — XML plist ЛИБО JSON
// (Apple меняла формат). Парсер обязан поддерживать оба. Порт парсера из
// aso-util/src/apple/hints.ts ТОЧНО. Возвращает упорядоченный RawHints (ранг = индекс+1).
// Клиент НЕ считает метрик — только достаёт сырьё.

import { XMLParser } from "fast-xml-parser";
import type { AppleHttp } from "./http";
import type { RawHints } from "@aso/shared";
import { storefrontHeader } from "./storefront";

const UA = "AppStore/3.0 iOS/17.0 model/iPhone14,2";

/** Один запрос подсказок для `term` в storefront (по id). Возвращает упорядоченные строки. */
export async function fetchHints(http: AppleHttp, term: string, storefrontId: number): Promise<RawHints> {
  const url =
    "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints" +
    `?clientApplication=Software&term=${encodeURIComponent(term)}`;
  const header = storefrontHeader(storefrontId);
  const body = await http.get(url, { "X-Apple-Store-Front": header, "User-Agent": UA }, header);
  return parseHints(body);
}

/** Разбор ответа подсказок: JSON `{hints:[{term}]}` или XML plist. Возвращает термы по порядку. */
export function parseHints(body: string): RawHints {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    // JSON-вариант: { "hints": [ { "term": "..." }, ... ] }
    const data = JSON.parse(trimmed);
    const hints = Array.isArray(data.hints) ? data.hints : [];
    return hints.map((h: any) => String(h.term ?? "")).filter(Boolean);
  }
  // plist-вариант
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true });
  const doc = parser.parse(trimmed);
  const terms: string[] = [];
  collectPlistTerms(doc, terms);
  return terms;
}

// В plist каждая подсказка — <dict> с парой <key>term</key><string>...</string>.
// preserveOrder-дерево fast-xml-parser: массивы узлов вида { key: [...], string: [...] }.
function collectPlistTerms(node: any, out: string[]) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const n = node[i];
      if (n && typeof n === "object" && "key" in n) {
        const keyText = textOf(n.key);
        if (keyText === "term") {
          // Значение — следующий узел-сосед <string>
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
