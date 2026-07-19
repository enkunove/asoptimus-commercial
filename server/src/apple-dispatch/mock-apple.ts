// @aso/server/apple-dispatch — SYNTHETIC Apple (DEV=1 loopback only, no network).
// In PROD raw data is fetched by the real client from the user's IP — this stub is never used on
// the prod path. Deterministic universe of demo keywords so probe yields P>0 and the expander
// finds something.

import type { RawHints, RawSerp } from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";

const NOUNS = ["sleep", "habit", "focus", "water", "budget", "mood", "workout", "recipe",
  "language", "meditation", "reading", "study", "expense", "period", "fasting"];
const SUFFIX = ["tracker", "planner", "timer", "journal", "coach", "log", "reminder", "monitor"];

function universe(): string[] {
  const out: string[] = [];
  for (const n of NOUNS) for (const s of SUFFIX) out.push(`${n} ${s}`);
  // a few "children" so the expander can crack open the tail:
  for (const n of NOUNS.slice(0, 5)) out.push(`${n} tracker pro`, `${n} tracker free`);
  return out;
}
const UNIVERSE = universe();

/** Hints for an arbitrary term/prefix (ordered list). */
export function mockHints(term: string): RawHints {
  const p = normalizeKeyword(term);
  if (!p) return [];
  return UNIVERSE.filter((k) => k.startsWith(p)).slice(0, 10);
}

/** Synthetic iTunes Search results (for Difficulty). */
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
