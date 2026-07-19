// Local program paths (data dir, Apple cache, session file).
// The CLIENT has no runs/store — only an optional local cache of raw Apple data (D3)
// and a dev-fallback for the session-token (activation.ts). No domain logic.

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

/** Machine-wide cache of raw Apple data (spec 01.4 / D3 — local leg). */
export function cacheDir(): string {
  return join(dataDir(), "cache");
}

/** Dev-fallback storage for the session-token (chmod 600) when the OS keychain is unavailable. */
export function sessionPath(): string {
  return join(dataDir(), "session.json");
}

export function ensureDirs() {
  mkdirSync(cacheDir(), { recursive: true });
}
