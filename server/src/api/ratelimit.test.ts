// Per-IP rate limiting on public endpoints (RATE_LIMIT_TEST=1 enables it under DEV).

import { describe, test, expect } from "bun:test";

process.env.DEV = "1";
process.env.RATE_LIMIT_TEST = "1";

const { rateLimited } = await import("./ratelimit.ts");

function reqFrom(ip: string): Request {
  return new Request("http://t.test/signup", { method: "POST", headers: { "x-forwarded-for": ip } });
}

describe("rateLimited", () => {
  test("allows up to the limit, then 429 with retry-after; window is per IP + bucket", () => {
    for (let i = 0; i < 5; i++) expect(rateLimited(reqFrom("1.2.3.4"), "t-signup", 5, 60_000)).toBeNull();
    const blocked = rateLimited(reqFrom("1.2.3.4"), "t-signup", 5, 60_000);
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
    // another IP is unaffected
    expect(rateLimited(reqFrom("5.6.7.8"), "t-signup", 5, 60_000)).toBeNull();
    // another bucket for the same IP is unaffected
    expect(rateLimited(reqFrom("1.2.3.4"), "t-other", 5, 60_000)).toBeNull();
  });

  test("disabled in plain DEV (no RATE_LIMIT_TEST)", () => {
    delete process.env.RATE_LIMIT_TEST;
    try {
      for (let i = 0; i < 50; i++) expect(rateLimited(reqFrom("9.9.9.9"), "t-dev", 2, 60_000)).toBeNull();
    } finally {
      process.env.RATE_LIMIT_TEST = "1";
    }
  });
});
