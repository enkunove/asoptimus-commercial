// Official iTunes Search API (spec 02.2). Returns RAW JSON of the needed fields (RawSerp).
// Difficulty (D) is computed by the server over this raw material — the client touches no metrics.

import { HttpError, type AppleHttp } from "./http";
import type { RawSerp, RawSerpApp } from "@aso/shared";

/** SERP URL builder (exported for tests). lang=null → omit the param (storefront default). */
export function serpUrl(query: string, country: string, lang: string | null, limit: number): string {
  return (
    "https://itunes.apple.com/search" +
    `?media=software&entity=software&term=${encodeURIComponent(query)}` +
    `&country=${encodeURIComponent(country)}` +
    (lang ? `&lang=${encodeURIComponent(lang)}` : "") +
    `&limit=${limit}`
  );
}

/** One SERP request. `country` — two-letter code (see storefront.ts), `lang` — language. */
export async function searchApps(
  http: AppleHttp,
  query: string,
  country: string,
  lang: string,
  limit = 25,
): Promise<RawSerp> {
  let body: string;
  try {
    body = await http.get(serpUrl(query, country, lang, limit));
  } catch (e) {
    // Apple rejects locale combos it doesn't know (e.g. lang=ru_us) with HTTP 400 — the
    // search itself is valid, only the metadata-language hint is bad. Retry once without
    // lang: the storefront's default localization is exactly what real users see anyway.
    if (e instanceof HttpError && e.status === 400 && lang) {
      body = await http.get(serpUrl(query, country, null, limit));
    } else {
      throw e;
    }
  }
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
