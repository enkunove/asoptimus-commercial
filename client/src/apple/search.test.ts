// searchApps 400-fallback: Apple rejects unknown lang combos (e.g. ru_us) with HTTP 400.
// The client must retry once WITHOUT lang (storefront default) instead of failing the keyword.

import { describe, test, expect } from "bun:test";
import { searchApps, serpUrl } from "./search.ts";
import { HttpError, type AppleHttp } from "./http.ts";

const SERP_BODY = JSON.stringify({ resultCount: 1, results: [{ trackId: 42, trackName: "Focus App" }] });

function fakeHttp(handler: (url: string) => string): AppleHttp & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url: string) { urls.push(url); return handler(url); },
  } as unknown as AppleHttp & { urls: string[] };
}

describe("searchApps", () => {
  test("serpUrl encodes the term and omits lang when null", () => {
    expect(serpUrl("экранное время", "us", "ru_us", 25)).toContain("term=%D1%8D%D0%BA%D1%80%D0%B0%D0%BD%D0%BD%D0%BE%D0%B5%20%D0%B2%D1%80%D0%B5%D0%BC%D1%8F");
    expect(serpUrl("x", "us", null, 25)).not.toContain("lang=");
  });

  test("HTTP 400 with lang → single retry without lang, result returned", async () => {
    const http = fakeHttp((url) => {
      if (url.includes("lang=")) throw new HttpError("HTTP 400 from itunes.apple.com", 400);
      return SERP_BODY;
    });
    const serp = await searchApps(http, "экранное время", "us", "ru_us", 25);
    expect(serp.results[0].trackName).toBe("Focus App");
    expect(http.urls.length).toBe(2);
    expect(http.urls[0]).toContain("lang=ru_us");
    expect(http.urls[1]).not.toContain("lang=");
  });

  test("non-400 errors are NOT retried without lang", async () => {
    const http = fakeHttp(() => { throw new HttpError("HTTP 500 from itunes.apple.com", 500); });
    await expect(searchApps(http, "focus", "us", "en_us", 25)).rejects.toThrow("HTTP 500");
    expect(http.urls.length).toBe(1);
  });

  test("400 on the lang-less retry propagates (no infinite loop)", async () => {
    const http = fakeHttp(() => { throw new HttpError("HTTP 400 from itunes.apple.com", 400); });
    await expect(searchApps(http, "focus", "us", "en_us", 25)).rejects.toThrow("HTTP 400");
    expect(http.urls.length).toBe(2);
  });
});
