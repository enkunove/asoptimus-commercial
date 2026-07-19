// @aso/core — word form folding (spec 05.3). PROPRIETARY. 1:1 port from aso-util.
// Only for semanticLanguage = en*; disabled for other languages (every form is its own word).

const EXCEPTIONS = new Set(["news", "lens", "ios", "css", "gps", "sms", "canvas", "atlas"]);

/**
 * Folding key. Rules strictly in order (first hit is final):
 * 1. len < 4 OR the word is in EXCEPTIONS → as-is.
 * 2. ends with `ss` → as-is. 3. `us`/`is` → as-is.
 * 4. `ies` and len ≥ 5 → ies→y. 5. ches/shes/xes/zes/ses/oes → drop es. 6. `s` → drop s.
 */
export function foldKey(word: string, language: string): string {
  const w = word.toLowerCase();
  if (!language.toLowerCase().startsWith("en")) return w;
  if (w.length < 4 || EXCEPTIONS.has(w)) return w;
  if (w.endsWith("ss")) return w;
  if (w.endsWith("us") || w.endsWith("is")) return w;
  if (w.endsWith("ies") && w.length >= 5) return w.slice(0, -3) + "y";
  if (/(ches|shes|xes|zes|ses|oes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}
