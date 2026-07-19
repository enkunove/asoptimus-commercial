// Activation: exchange of an `asop_live_…` key for a session-token via the cloud over HTTPS
// (ActivateRequest → ActivateResponse from @aso/shared), stored in the OS secure-store
// (macOS Keychain via `security`); a chmod-600 file is a dev-fallback ONLY.
// The response also carries `hmac_secret` — a per-session key for SignedEnvelope (see cloud-link.ts).
// The token lives ONLY in the program (nothing for a browser to leak, D1).
//
// This file contains NO formulas and NO prompts — only key exchange and secure storage.

import { createHash } from "node:crypto";
import { hostname, userInfo, platform, arch } from "node:os";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { ActivateRequest, ActivateResponse } from "@aso/shared";
import { sessionPath, ensureDirs } from "./paths";
import { httpsBase, isDev } from "./config";

const SERVICE = "com.asoptimus.client";
const ACCOUNT = "session-token";

export interface Session {
  sessionToken: string;
  deviceFp: string;
  /** per-session HMAC secret for SignedEnvelope (issued by the cloud on activation). */
  hmacSecret: string;
  /** ISO expiry of the session-token (from ActivateResponse). null in dev mode. */
  expiresAt: string | null;
  activatedAt: string;
}

/** Stable machine fingerprint (device-binding, ARCHITECTURE §5 / D8). No PII leaves the machine — it's a hash. */
export function deviceFingerprint(): string {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    /* some environments don't provide userInfo */
  }
  return createHash("sha256")
    .update(`${hostname()}|${platform()}|${arch()}|${user}`)
    .digest("hex")
    .slice(0, 32);
}

/** Activation key format: asop_live_… (or asop_test_… for testing). */
export function isActivationKey(key: string): boolean {
  return /^asop_(live|test)_[A-Za-z0-9]{8,}$/.test(key.trim());
}

/**
 * Exchange an activation key for a session-token via the cloud (HTTPS `POST /activate`).
 * Endpoint — config.httpsBase (env ASO_CLOUD_HTTPS, default https://api.asoptimus.com).
 * DEV=1 without the cloud → synthetic token/secret so the UI comes up offline.
 */
export async function activate(key: string): Promise<Session> {
  const trimmed = key.trim();
  if (!isActivationKey(trimmed)) {
    throw new Error("Key must look like asop_live_… — check that you copied it in full.");
  }
  const deviceFp = deviceFingerprint();

  let session: Session;
  if (isDev()) {
    // DEV-ONLY (behind the DEV=1 flag): synthetic session for the offline UI. Unreachable in the prod path.
    const seed = createHash("sha256").update(trimmed + deviceFp).digest("hex");
    session = {
      sessionToken: `dev-session-${seed.slice(0, 24)}`,
      deviceFp,
      hmacSecret: `dev-hmac-${seed.slice(24, 56)}`,
      expiresAt: null,
      activatedAt: new Date().toISOString(),
    };
  } else {
    const body: ActivateRequest = { key: trimmed, device_fp: deviceFp };
    let res: Response;
    try {
      res = await fetch(new URL("/activate", httpsBase()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new Error(`Could not reach the activation server (${httpsBase()}): ${e?.message ?? e}`);
    }
    const data = (await res.json().catch(() => ({}))) as Partial<ActivateResponse> & { error?: string };
    if (!res.ok) throw new Error(data?.error || `Activation failed (HTTP ${res.status}).`);
    if (!data?.session_token) throw new Error("Cloud did not return a session_token.");
    if (!data?.hmac_secret) throw new Error("Cloud did not return an hmac_secret (required for message signing).");
    session = {
      sessionToken: String(data.session_token),
      deviceFp,
      hmacSecret: String(data.hmac_secret),
      expiresAt: data.expires_at ? String(data.expires_at) : null,
      activatedAt: new Date().toISOString(),
    };
  }

  await storeSession(session);
  return session;
}

/** Read the stored session (keychain → dev file). null if not activated. */
export async function loadSession(): Promise<Session | null> {
  const fromStore = await keychainGet();
  if (fromStore) {
    const s = parseSession(fromStore);
    if (s) return s;
  }
  if (existsSync(sessionPath())) {
    try {
      return parseSession(readFileSync(sessionPath(), "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function parseSession(json: string): Session | null {
  try {
    const s = JSON.parse(json) as Partial<Session>;
    if (!s || !s.sessionToken || !s.hmacSecret) return null; // treat old/corrupt records as "not activated"
    return {
      sessionToken: s.sessionToken,
      deviceFp: s.deviceFp ?? deviceFingerprint(),
      hmacSecret: s.hmacSecret,
      expiresAt: s.expiresAt ?? null,
      activatedAt: s.activatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Forget the session (logout). */
export async function clearSession(): Promise<void> {
  await keychainDelete();
  try {
    if (existsSync(sessionPath())) writeFileSync(sessionPath(), "{}");
  } catch {
    /* ignore */
  }
}

async function storeSession(s: Session): Promise<void> {
  const json = JSON.stringify(s);
  const ok = await keychainSet(json);
  if (!ok) {
    // Dev-fallback: chmod-600 file (the only explicit fallback outside macOS Keychain).
    ensureDirs();
    writeFileSync(sessionPath(), json);
    try {
      chmodSync(sessionPath(), 0o600);
    } catch {
      // Windows: chmod is not supported.
    }
  }
}

// ── OS secure-store via native CLIs (no external dependencies) ─────────────
// macOS: `security`. Other OSes: fall back to a chmod-600 file (the app is macOS-only, D section 9).

async function keychainSet(value: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    // -U updates an existing entry. Value passed as an argument: local trusted
    // machine (D8); `security` does not read -w from stdin for add-generic-password.
    const proc = Bun.spawnSync([
      "security", "add-generic-password",
      "-s", SERVICE, "-a", ACCOUNT, "-w", value, "-U",
    ], { stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function keychainGet(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const proc = Bun.spawnSync([
      "security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w",
    ], { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    const out = new TextDecoder().decode(proc.stdout).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function keychainDelete(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    Bun.spawnSync([
      "security", "delete-generic-password", "-s", SERVICE, "-a", ACCOUNT,
    ], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* ignore */
  }
}
