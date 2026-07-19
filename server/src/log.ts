// @aso/server — structured logging (one JSON line per record). Secrets NEVER end up in the
// log: any field whose name looks like a secret (key/secret/token/password/hmac/…) is
// redacted. We log facts/names, not secret values.

import { IS_DEV } from "./env.ts";

type Level = "debug" | "info" | "warn" | "error";
const SECRET_KEY_RE = /(secret|token|password|passwd|^pass$|apikey|api_key|hmac|authorization|signature|webhook)/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
  if (fields) Object.assign(rec, redact(fields));
  const line = JSON.stringify(rec);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => { if (IS_DEV) emit("debug", msg, fields); },
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
