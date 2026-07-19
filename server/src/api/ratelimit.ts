// @aso/server/api — per-IP fixed-window rate limiting for PUBLIC endpoints (signup/activate/
// checkout/resend): without it anyone can spam activation emails or hammer checkout creation.
// In-memory (single instance, BUILD-PLAN §5); IP from X-Forwarded-For (set by Caddy).
// DEV=1 disables limiting (tests hammer these endpoints) unless RATE_LIMIT_TEST=1.

import { IS_DEV } from "../env.ts";

const windows = new Map<string, { count: number; resetAt: number }>();

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
}

/** null → allowed; Response(429) → over the limit. */
export function rateLimited(req: Request, bucket: string, limit: number, windowMs: number): Response | null {
  if (IS_DEV && process.env.RATE_LIMIT_TEST !== "1") return null;
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  let w = windows.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  w.count += 1;
  if (windows.size > 50_000) {
    for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
  }
  if (w.count > limit) {
    return new Response(JSON.stringify({ error: "too many requests — try again in a few minutes" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(Math.ceil((w.resetAt - now) / 1000)) },
    });
  }
  return null;
}
