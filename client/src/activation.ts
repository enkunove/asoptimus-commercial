// Активация: обмен ключа `asop_live_…` на session-token через облако по HTTPS
// (ActivateRequest → ActivateResponse из @aso/shared), хранение в OS secure-store
// (macOS Keychain через `security`); chmod-600 файл — ТОЛЬКО dev-fallback.
// Ответ несёт ещё и `hmac_secret` — per-session ключ для SignedEnvelope (см. cloud-link.ts).
// Токен живёт ТОЛЬКО в программе (браузеру нечего утекать, D1).
//
// В этом файле НЕТ ни формул, ни промптов — лишь обмен ключа и безопасное хранение.

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
  /** per-session HMAC-секрет для SignedEnvelope (выдаётся облаком при активации). */
  hmacSecret: string;
  /** ISO-срок жизни session-token (из ActivateResponse). null для dev-режима. */
  expiresAt: string | null;
  activatedAt: string;
}

/** Стабильный отпечаток машины (device-binding, ARCHITECTURE §5 / D8). Не PII наружу — хэш. */
export function deviceFingerprint(): string {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    /* некоторые окружения не дают userInfo */
  }
  return createHash("sha256")
    .update(`${hostname()}|${platform()}|${arch()}|${user}`)
    .digest("hex")
    .slice(0, 32);
}

/** Формат ключа активации: asop_live_… (или asop_test_… для теста). */
export function isActivationKey(key: string): boolean {
  return /^asop_(live|test)_[A-Za-z0-9]{8,}$/.test(key.trim());
}

/**
 * Обменять ключ активации на session-token через облако (HTTPS `POST /activate`).
 * Endpoint — config.httpsBase (env ASO_CLOUD_HTTPS, дефолт https://api.asoptimus.com).
 * DEV=1 без облака → синтетический токен/секрет, чтобы UI поднялся оффлайн.
 */
export async function activate(key: string): Promise<Session> {
  const trimmed = key.trim();
  if (!isActivationKey(trimmed)) {
    throw new Error("Ключ должен иметь вид asop_live_… — проверьте, что скопировали целиком.");
  }
  const deviceFp = deviceFingerprint();

  let session: Session;
  if (isDev()) {
    // DEV-ONLY (за флагом DEV=1): синтетическая сессия для оффлайн-UI. В прод-пути недостижимо.
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
      throw new Error(`Не удалось связаться с сервером активации (${httpsBase()}): ${e?.message ?? e}`);
    }
    const data = (await res.json().catch(() => ({}))) as Partial<ActivateResponse> & { error?: string };
    if (!res.ok) throw new Error(data?.error || `Активация не удалась (HTTP ${res.status}).`);
    if (!data?.session_token) throw new Error("Облако не вернуло session_token.");
    if (!data?.hmac_secret) throw new Error("Облако не вернуло hmac_secret (нужен для подписи сообщений).");
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

/** Прочитать сохранённую сессию (keychain → dev-файл). null если не активирован. */
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
    if (!s || !s.sessionToken || !s.hmacSecret) return null; // старые/битые записи считаем «не активирован»
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

/** Забыть сессию (logout). */
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
    // Dev-fallback: chmod-600 файл (единственный явный fallback вне macOS Keychain).
    ensureDirs();
    writeFileSync(sessionPath(), json);
    try {
      chmodSync(sessionPath(), 0o600);
    } catch {
      // Windows: chmod не поддерживается.
    }
  }
}

// ── OS secure-store через нативные CLI (без внешних зависимостей) ─────────────
// macOS: `security`. Прочие ОС: падаем на chmod-600 файл (приложение — только macOS, D-раздел 9).

async function keychainSet(value: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    // -U обновляет существующую запись. Значение — через аргумент: локальная доверенная
    // машина (D8); `security` не читает -w из stdin у add-generic-password.
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
