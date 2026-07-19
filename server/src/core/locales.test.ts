// serpLangFor: the SERP metadata locale is the STOREFRONT's primary locale — never the run's
// semantic language (Apple 400s unknown combos like ru_us; first non-EN run, 2026-07-19).

import { describe, test, expect } from "bun:test";
import { STOREFRONTS } from "@aso/shared";
import { serpLangFor } from "./locales.ts";

describe("serpLangFor", () => {
  test("derives lang from the storefront, not the semantic language", () => {
    expect(serpLangFor("us")).toBe("en_us");
    expect(serpLangFor("ru")).toBe("ru_ru");
    expect(serpLangFor("jp")).toBe("ja_jp");
    expect(serpLangFor("DE")).toBe("de_de"); // case-insensitive input
  });

  test("every supported storefront yields primaryLanguage_country (minus live-validated overrides)", () => {
    for (const [country, sf] of Object.entries(STOREFRONTS)) {
      if (country === "in") continue; // Apple 400s en_in; India storefront defaults to en_gb
      expect(serpLangFor(country)).toBe(`${sf.primaryLanguage}_${country}`);
    }
    expect(serpLangFor("in")).toBe("en_gb");
  });

  test("unknown country falls back to en_<country> (config validation rejects it upstream)", () => {
    expect(serpLangFor("zz")).toBe("en_zz");
  });
});
