// Official iTunes Search API (spec 02.2). Returns RAW JSON of the needed fields (RawSerp).
// Difficulty (D) is computed by the server over this raw material — the client touches no metrics.

import type { AppleHttp } from "./http";
import type { RawSerp, RawSerpApp } from "@aso/shared";

/** One SERP request. `country` — two-letter code (see storefront.ts), `lang` — language. */
export async function searchApps(
  http: AppleHttp,
  query: string,
  country: string,
  lang: string,
  limit = 25,
): Promise<RawSerp> {
  const url =
    "https://itunes.apple.com/search" +
    `?media=software&entity=software&term=${encodeURIComponent(query)}` +
    `&country=${encodeURIComponent(country)}&lang=${encodeURIComponent(lang)}&limit=${limit}`;
  const body = await http.get(url);
  const data = JSON.parse(body);
  // Raw passthrough of the needed fields: the RawSerpApp type allows [k]: unknown, so we
  // pass objects through as-is, only guaranteeing the mandatory trackId/trackName.
  const results: RawSerpApp[] = (Array.isArray(data.results) ? data.results : []).map((r: any) => ({
    ...r,
    trackId: Number(r.trackId ?? 0),
    trackName: String(r.trackName ?? ""),
  }));
  return { resultCount: Number(data.resultCount ?? results.length), results };
}
