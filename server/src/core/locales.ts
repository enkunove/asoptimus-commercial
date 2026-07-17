// @aso/core — таблица кросс-локализации extraLocale (spec 05.9) + placement-веса (05.2).
// SERVER-ONLY (moat). BUILD-PLAN §3/§5: extraLocale и веса НЕ кладутся в @aso/shared —
// туда идёт только storefronts.public {id, primaryLanguage}. Источник — aso-util
// apple/storefronts.json (поле extraLocale).

/** country → доп. локаль для второго прохода сборки (spec 05.9). null = второй проход нет. */
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

/** Позиционный вес поля (spec 05.2). Реэкспорт из assembly/place — единая точка moat. */
export { FIELD_WEIGHTS } from "./assembly/place.ts";
