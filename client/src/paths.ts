// Локальные пути программы (data dir, кэш Apple, файл сессии).
// В КЛИЕНТЕ нет прогонов/стора — только опциональный локальный кэш сырья Apple (D3)
// и dev-fallback для session-token (activation.ts). Никакой доменной логики.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

let overrideDataDir: string | null = null;

export function setDataDir(dir: string) {
  overrideDataDir = dir;
}

export function dataDir(): string {
  if (overrideDataDir) return overrideDataDir;
  if (process.env.ASO_DATA_DIR) return process.env.ASO_DATA_DIR;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "asoptimus");
  }
  return join(homedir(), ".asoptimus");
}

/** Общий для машины кэш сырья Apple (spec 01.4 / D3 — локальная нога). */
export function cacheDir(): string {
  return join(dataDir(), "cache");
}

/** Dev-fallback хранилище session-token (chmod 600), когда OS keychain недоступен. */
export function sessionPath(): string {
  return join(dataDir(), "session.json");
}

export function ensureDirs() {
  mkdirSync(cacheDir(), { recursive: true });
}
