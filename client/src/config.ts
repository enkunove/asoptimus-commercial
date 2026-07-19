// Single point of environment resolution: cloud endpoints + DEV flag.
// Prod path — defaults on api.asoptimus.com; env overrides them; the dev cloud stub is
// ONLY behind DEV=1. No domain logic.

/** Prod defaults (overridable via env). 1 source of truth so files don't drift apart. */
export const DEFAULT_WSS = "wss://api.asoptimus.com/ws";
export const DEFAULT_HTTPS = "https://api.asoptimus.com";

/** DEV=1 — the only way to bring up the offline cloud stub and synthetic activation. */
export function isDev(): boolean {
  return process.env.DEV === "1";
}

/** Cloud WSS endpoint (jobs/progress/reads). Env ASO_CLOUD_WSS, otherwise prod default. */
export function wssUrl(): string {
  return process.env.ASO_CLOUD_WSS || DEFAULT_WSS;
}

/** HTTPS endpoint (activation, top-up-redirect). Env ASO_CLOUD_HTTPS, otherwise prod default. */
export function httpsBase(): string {
  return process.env.ASO_CLOUD_HTTPS || DEFAULT_HTTPS;
}
