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

import { STOREFRONTS, type MarketSlot } from "@aso/shared";

// Curated market table (spec 10 §4) — order = priority for next-best-actions. Only entries
// whose country exists in STOREFRONTS survive the filter (the client can't fetch others anyway).
const MARKET_TABLE: MarketSlot[] = [
  { locale: "en-US", country: "us", language: "en", name: "United States", tier: 1, note: "the largest store" },
  { locale: "ja-JP", country: "jp", language: "ja", name: "Japan", tier: 1, note: "2nd by revenue; low English competition" },
  { locale: "de-DE", country: "de", language: "de", name: "Germany", tier: 1, note: "largest EU store" },
  { locale: "en-GB", country: "gb", language: "en", name: "United Kingdom", tier: 1, note: "distinct suggest index from the US" },
  { locale: "fr-FR", country: "fr", language: "fr", name: "France", tier: 2, note: "" },
  { locale: "ko-KR", country: "kr", language: "ko", name: "South Korea", tier: 2, note: "" },
  { locale: "es-MX", country: "mx", language: "es", name: "Mexico (Spanish)", tier: 2, note: "es-MX also indexes on the US storefront" },
  { locale: "pt-BR", country: "br", language: "pt", name: "Brazil", tier: 2, note: "" },
  { locale: "it-IT", country: "it", language: "it", name: "Italy", tier: 3, note: "" },
  { locale: "es-ES", country: "es", language: "es", name: "Spain", tier: 3, note: "" },
  { locale: "nl-NL", country: "nl", language: "nl", name: "Netherlands", tier: 3, note: "" },
  { locale: "ru-RU", country: "ru", language: "ru", name: "Russia", tier: 3, note: "" },
  { locale: "tr-TR", country: "tr", language: "tr", name: "Türkiye", tier: 3, note: "" },
  { locale: "pl-PL", country: "pl", language: "pl", name: "Poland", tier: 3, note: "" },
  { locale: "sv-SE", country: "se", language: "sv", name: "Sweden", tier: 3, note: "" },
  { locale: "uk-UA", country: "ua", language: "uk", name: "Ukraine", tier: 3, note: "" },
  { locale: "hi-IN", country: "in", language: "hi", name: "India (Hindi)", tier: 3, note: "storefront defaults to en-GB SERPs" },
];
export const MARKETS: MarketSlot[] = MARKET_TABLE.filter((m) => m.country in STOREFRONTS);

export function marketForLocale(locale: string): MarketSlot | undefined {
  return MARKETS.find((m) => m.locale === locale);
}

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
