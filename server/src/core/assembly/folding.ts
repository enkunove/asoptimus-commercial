// @aso/core — фолдинг форм слов (spec 05.3). ПРОПРИЕТАРНО. Порт 1:1 из aso-util.
// Только для semanticLanguage = en*; для остальных языков выключен (каждая форма — слово).

const EXCEPTIONS = new Set(["news", "lens", "ios", "css", "gps", "sms", "canvas", "atlas"]);

/**
 * Ключ фолдинга. Правила строго по порядку (первое сработавшее — финал):
 * 1. len < 4 ИЛИ слово в EXCEPTIONS → как есть.
 * 2. кончается на `ss` → как есть. 3. `us`/`is` → как есть.
 * 4. `ies` и len ≥ 5 → ies→y. 5. ches/shes/xes/zes/ses/oes → убрать es. 6. `s` → убрать s.
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
