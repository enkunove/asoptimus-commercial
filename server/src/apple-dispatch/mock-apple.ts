// @aso/server/apple-dispatch — СИНТЕТИЧЕСКИЙ Apple (только DEV=1 loopback, без сети).
// В ПРОДЕ сырьё фетчит реальный клиент с IP юзера — эта заглушка на прод-пути не используется.
// Детерминированная вселенная демо-кейвордов, чтобы probe давал P>0 и expander что-то находил.

import type { RawHints, RawSerp } from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";

const NOUNS = ["sleep", "habit", "focus", "water", "budget", "mood", "workout", "recipe",
  "language", "meditation", "reading", "study", "expense", "period", "fasting"];
const SUFFIX = ["tracker", "planner", "timer", "journal", "coach", "log", "reminder", "monitor"];

function universe(): string[] {
  const out: string[] = [];
  for (const n of NOUNS) for (const s of SUFFIX) out.push(`${n} ${s}`);
  // немного «детей» для вскрытия хвоста экспандером:
  for (const n of NOUNS.slice(0, 5)) out.push(`${n} tracker pro`, `${n} tracker free`);
  return out;
}
const UNIVERSE = universe();

/** Подсказки для произвольного терма/префикса (упорядоченный список). */
export function mockHints(term: string): RawHints {
  const p = normalizeKeyword(term);
  if (!p) return [];
  return UNIVERSE.filter((k) => k.startsWith(p)).slice(0, 10);
}

/** Синтетическая выдача iTunes Search (для Difficulty). */
export function mockSerp(query: string): RawSerp {
  const q = normalizeKeyword(query);
  const results = [];
  const base = Array.from(q).reduce((a, c) => a + c.charCodeAt(0), 0);
  const n = 8 + (base % 3);
  for (let i = 0; i < n; i++) {
    const ratings = 500 + ((base * (i + 3)) % 40000);
    results.push({
      trackId: 100000 + base + i,
      trackName: i === 0 ? `${query} - Pro` : `App ${i} for ${q.split(" ")[0]}`,
      averageUserRating: 4 + ((base + i) % 10) / 10,
      userRatingCount: ratings,
      currentVersionReleaseDate: new Date(Date.now() - ((base + i * 17) % 300) * 86_400_000).toISOString(),
      primaryGenreName: "Health & Fitness",
      genres: ["Health & Fitness"],
    });
  }
  return { resultCount: n, results };
}
