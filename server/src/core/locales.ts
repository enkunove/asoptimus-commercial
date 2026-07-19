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
