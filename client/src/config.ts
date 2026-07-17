// Единая точка разрешения окружения: облачные endpoint'ы + DEV-флаг.
// Прод-путь — дефолты на api.asoptimus.com; env их переопределяет; dev-стаб облака —
// ТОЛЬКО за DEV=1. Никакой доменной логики.

/** Прод-дефолты (перекрываются env). 1 источник истины, чтобы не разъезжались по файлам. */
export const DEFAULT_WSS = "wss://api.asoptimus.com/ws";
export const DEFAULT_HTTPS = "https://api.asoptimus.com";

/** DEV=1 — единственный способ поднять оффлайн-стаб облака и синтетическую активацию. */
export function isDev(): boolean {
  return process.env.DEV === "1";
}

/** WSS-endpoint облака (джобы/прогресс/чтения). Env ASO_CLOUD_WSS, иначе прод-дефолт. */
export function wssUrl(): string {
  return process.env.ASO_CLOUD_WSS || DEFAULT_WSS;
}

/** HTTPS-endpoint (активация, top-up-redirect). Env ASO_CLOUD_HTTPS, иначе прод-дефолт. */
export function httpsBase(): string {
  return process.env.ASO_CLOUD_HTTPS || DEFAULT_HTTPS;
}
