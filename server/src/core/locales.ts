// @aso/core — extraLocale cross-localization table (spec 05.9) + placement weights (05.2).
// SERVER-ONLY (moat). BUILD-PLAN §3/§5: extraLocale and weights do NOT go into @aso/shared —
// only storefronts.public {id, primaryLanguage} goes there. Source — aso-util
// apple/storefronts.json (extraLocale field).

/** country → extra locale for the second assembly pass (spec 05.9). null = no second pass. */
export const EXTRA_LOCALE: Record<string, string | null> = {
  us: "es-MX",
  gb: "en-AU",
  de: "en-GB",
  fr: "en-GB",
  it: "en-GB",
  es: "en-GB",
  ca: "fr-CA",
  ru: "en-GB",
  nl: "en-GB",
  se: "en-GB",
  jp: "en-US",
  kr: "en-US",
  cn: "en-GB",
  br: "en-GB",
  mx: "en-US",
  au: null,
  in: "hi",
  tr: "en-GB",
  ua: "en-GB",
  pl: "en-GB",
};

export function extraLocaleFor(country: string): string | null {
  return EXTRA_LOCALE[country] ?? null;
}

/** Positional field weight (spec 05.2). Re-export from assembly/place — single moat entry point. */
export { FIELD_WEIGHTS } from "./assembly/place.ts";

import { STOREFRONTS } from "@aso/shared";

/** Combos Apple's search API rejects even though they look canonical (validated against the
 *  live API across every STOREFRONTS entry on 2026-07-19: only en_in 400s; Apple's India
 *  storefront defaults to en_gb). */
const SERP_LANG_OVERRIDES: Record<string, string> = {
  in: "en_gb",
};

/** iTunes Search `lang` for a storefront: the store's PRIMARY locale — what its real users
 *  see in the SERP. The run's semantic language must NOT leak here: Apple rejects unknown
 *  locale combos (lang=ru_us → HTTP 400 on every SERP; found on the first non-EN run,
 *  2026-07-19). ru→ru_ru, us→en_us, jp→ja_jp. The client additionally retries a 400 once
 *  without lang — defense in depth for combos this table doesn't know. */
export function serpLangFor(country: string): string {
  const c = country.toLowerCase();
  const override = SERP_LANG_OVERRIDES[c];
  if (override) return override;
  const primary = STOREFRONTS[c]?.primaryLanguage ?? "en";
  return `${primary}_${c}`;
}
