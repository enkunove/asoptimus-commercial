// @aso/server — central environment handling: DEV flag and required secrets in prod.
// Rule (BUILD-PLAN §6/§9): mock Store/LLM/Paddle/Apple loopback and dev helpers work
// ONLY with DEV=1. In prod (DEV unset) a missing required secret is a hard failure,
// not a silent mock. Secret values are never logged here — only their presence.

export const IS_DEV = process.env.DEV === "1";

export class ProdConfigError extends Error {
  constructor(public varName: string, hint = "") {
    super(
      `[config] environment variable ${varName} is required in prod mode and is not set. ` +
        `Set it (see .env.example)${hint ? ` — ${hint}` : ""}, or run with DEV=1 for mock fallbacks.`,
    );
    this.name = "ProdConfigError";
  }
}

/** Secret required in prod. In DEV returns "" (enables the caller's mock branch). */
export function requireEnv(name: string, hint = ""): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  if (IS_DEV) return "";
  throw new ProdConfigError(name, hint);
}

/** Optional variable (no prod requirement). */
export function optionalEnv(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Presence of a variable (to pick the live/mock branch in DEV). */
export function hasEnv(name: string): boolean {
  const v = process.env[name];
  return !!(v && v.trim());
}
