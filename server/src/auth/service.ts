// @aso/server/auth — key→short-lived session token (device-bound), per-message HMAC,
// revocation, per-user rate limit (BUILD-PLAN §auth, ARCHITECTURE §5). No passwords (§5).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../db/index.ts";

const SESSION_TTL_MS = 12 * 3600 * 1000; // 12h; client refreshes/re-activates on expiry
const NONCE_WINDOW_MS = 5 * 60 * 1000;    // ±5m anti-replay (ARCHITECTURE §5)
// D4 v4: NO free tier. Wallet is created at zero; you can only work after topping up credits.

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
export function generateKey(): string {
  return `asop_live_${randomBytes(24).toString("base64url")}`;
}
/** Session tokens are persisted HASHED (a DB leak must not yield usable bearer tokens). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface Session {
  userId: string;
  deviceFp: string;
  hmacSecret: string;
  exp: number;
}

interface Bucket { tokens: number; last: number; }

export class AuthService {
  /** In-memory READ CACHE over the persisted sessions table — never the source of truth.
   *  (It was the source of truth once: every deploy logged all clients out.) */
  private sessions = new Map<string, Session>();
  private nonces = new Map<string, number>(); // nonce → ts (±5m window; in-memory is fine: the window is shorter than any deploy)
  private buckets = new Map<string, Bucket>();

  constructor(private store: Store, private rpm = 120) {}

  /** Hydrate the cache from the store on miss (cold token after a restart). Cheap no-op on hit. */
  async ensureLoaded(token: string | undefined | null): Promise<void> {
    if (!token || this.sessions.has(token)) return;
    const row = await this.store.getSession(hashToken(token));
    if (!row) return;
    const exp = new Date(row.expires_at).getTime();
    if (!Number.isFinite(exp) || exp < Date.now()) {
      void this.store.deleteSession(row.token_hash);
      return;
    }
    this.sessions.set(token, { userId: row.user_id, deviceFp: row.device_fp, hmacSecret: row.hmac_secret, exp });
  }

  /** Async session check for HTTP paths (hydrates cold tokens, then the sync check). */
  async verifySessionAsync(token: string, deviceFp?: string): Promise<{ userId: string; hmacSecret: string } | null> {
    await this.ensureLoaded(token);
    return this.verifySession(token, deviceFp);
  }

  /** signup: create User+wallet+license, return the key. Idempotent by email (no duplicates). */
  async signup(email: string): Promise<{ key: string; userId: string; existed: boolean }> {
    const existing = await this.store.getUserByEmail(email);
    if (existing) {
      // Repeat signup: don't spawn a Customer/user; the key was already sent earlier (resend is separate).
      return { key: "", userId: existing.id, existed: true };
    }
    const userId = `usr_${randomBytes(9).toString("base64url")}`;
    await this.store.createUser({ id: userId, email, paddle_customer_id: null });
    await this.store.ensureWallet(userId, 0); // D4 v4: NO free tier — starting balance 0
    const key = generateKey();
    await this.store.createLicense({
      key_hash: hashKey(key), user_id: userId, device_fp: null, status: "active", revoked_at: null,
    });
    return { key, userId, existed: false };
  }

  /** Key reissue (resend/reissue): issue a new active key to an existing user. */
  async reissueKey(userId: string): Promise<string> {
    const key = generateKey();
    await this.store.createLicense({
      key_hash: hashKey(key), user_id: userId, device_fp: null, status: "active", revoked_at: null,
    });
    return key;
  }

  /** activation: key → session token (+ HMAC secret + expiry), device-binding on first success. */
  async activate(key: string, deviceFp: string): Promise<{ token: string; hmacSecret: string; userId: string; expiresAt: string } | { error: string }> {
    const lic = await this.store.getLicenseByKeyHash(hashKey(key));
    if (!lic) return { error: "key not found" };
    if (lic.status === "revoked") return { error: "key has been revoked" };
    if (lic.device_fp && lic.device_fp !== deviceFp) return { error: "key is bound to another device" };
    if (!lic.device_fp) await this.store.bindDevice(lic.key_hash, deviceFp);
    return this.issue(lic.user_id, deviceFp);
  }

  /** Issue a session token: persist FIRST (source of truth), then cache. */
  private async issue(userId: string, deviceFp: string): Promise<{ token: string; hmacSecret: string; userId: string; expiresAt: string }> {
    const token = randomBytes(24).toString("base64url");
    const hmacSecret = randomBytes(32).toString("base64url");
    const exp = Date.now() + SESSION_TTL_MS;
    await this.store.putSession({
      token_hash: hashToken(token), user_id: userId, device_fp: deviceFp,
      hmac_secret: hmacSecret, expires_at: new Date(exp).toISOString(),
    });
    this.sessions.set(token, { userId, deviceFp, hmacSecret, exp });
    return { token, hmacSecret, userId, expiresAt: new Date(exp).toISOString() };
  }

  /**
   * refresh: a valid (not yet expired) session token from the same device → a new token with a
   * fresh expiry (client doesn't store the key in prod — refresh without re-activation).
   * Checks license revocation at the level of... there's no direct key_hash lookup by userId, so
   * refresh relies on a non-expired session; revocation blocks NEW activation + invalidates via TTL.
   */
  async refresh(token: string, deviceFp: string): Promise<{ token: string; hmacSecret: string; userId: string; expiresAt: string } | { error: string }> {
    await this.ensureLoaded(token);
    const s = this.sessions.get(token);
    if (!s) return { error: "session not found or expired" };
    if (s.exp < Date.now()) { await this.drop(token); return { error: "session expired — activate your key again" }; }
    if (s.deviceFp !== deviceFp) return { error: "device_fp mismatch" };
    await this.drop(token); // one-time rotation
    return this.issue(s.userId, deviceFp);
  }

  private async drop(token: string): Promise<void> {
    this.sessions.delete(token);
    await this.store.deleteSession(hashToken(token));
  }

  /** Session-token check (+ device-binding). null → invalid/expired. */
  verifySession(token: string, deviceFp?: string): { userId: string; hmacSecret: string } | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(token); return null; }
    if (deviceFp && s.deviceFp !== deviceFp) return null;
    return { userId: s.userId, hmacSecret: s.hmacSecret };
  }

  /** Key revocation + invalidation of this user's active sessions (cache AND store). */
  async revoke(key: string): Promise<void> {
    const lic = await this.store.getLicenseByKeyHash(hashKey(key));
    await this.store.revokeLicense(hashKey(key));
    if (lic) {
      for (const [tok, s] of this.sessions) if (s.userId === lic.user_id) this.sessions.delete(tok);
      await this.store.deleteSessionsForUser(lic.user_id);
    }
  }

  /** HMAC + timestamp(±5m) + nonce anti-replay per WSS message (ARCHITECTURE §5). */
  verifyMessage(token: string, body: string, ts: number, nonce: string, mac: string): boolean {
    const s = this.sessions.get(token);
    if (!s) return false;
    if (Math.abs(Date.now() - ts) > NONCE_WINDOW_MS) return false;
    if (this.nonces.has(nonce)) return false;
    const expected = createHmac("sha256", s.hmacSecret).update(`${ts}.${nonce}.${body}`).digest("hex");
    const a = Buffer.from(expected), b = Buffer.from(mac);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    this.nonces.set(nonce, ts);
    this.gcNonces();
    return true;
  }

  private gcNonces() {
    const cutoff = Date.now() - NONCE_WINDOW_MS;
    for (const [n, t] of this.nonces) if (t < cutoff) this.nonces.delete(n);
  }

  /** Per-user token-bucket rate limit. true = allowed. */
  allow(userId: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(userId);
    if (!b) { b = { tokens: this.rpm, last: now }; this.buckets.set(userId, b); }
    const refill = ((now - b.last) / 60_000) * this.rpm;
    b.tokens = Math.min(this.rpm, b.tokens + refill);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
