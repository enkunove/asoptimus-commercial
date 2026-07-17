// @aso/server/auth — ключ→короткоживущий session-token (device-bound), HMAC на сообщение,
// отзыв, per-user rate limit (BUILD-PLAN §auth, ARCHITECTURE §5). Пароли отсутствуют (§5).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../db/index.ts";

const SESSION_TTL_MS = 12 * 3600 * 1000; // 12ч; клиент рефрешит/переактивируется по истечении
const NONCE_WINDOW_MS = 5 * 60 * 1000;    // ±5м анти-replay (ARCHITECTURE §5)
// D4 v4: free-tier НЕТ. Кошелёк создаётся с нулём; работать можно только пополнив кредиты.

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
export function generateKey(): string {
  return `asop_live_${randomBytes(24).toString("base64url")}`;
}

interface Session {
  userId: string;
  deviceFp: string;
  hmacSecret: string;
  exp: number;
}

interface Bucket { tokens: number; last: number; }

export class AuthService {
  private sessions = new Map<string, Session>();
  private nonces = new Map<string, number>(); // nonce → ts (окно ±5м; общий store — Фаза 3, BUILD-PLAN §8)
  private buckets = new Map<string, Bucket>();

  constructor(private store: Store, private rpm = 120) {}

  /** signup: создать User+wallet+license, вернуть ключ. Идемпотентно по email (не плодим). */
  async signup(email: string): Promise<{ key: string; userId: string; existed: boolean }> {
    const existing = await this.store.getUserByEmail(email);
    if (existing) {
      // Повторный signup: не плодим Customer/юзера; ключ уже выслан ранее (resend отдельно).
      return { key: "", userId: existing.id, existed: true };
    }
    const userId = `usr_${randomBytes(9).toString("base64url")}`;
    await this.store.createUser({ id: userId, email, stripe_customer_id: null });
    await this.store.ensureWallet(userId, 0); // D4 v4: free-tier НЕТ — стартовый баланс 0
    const key = generateKey();
    await this.store.createLicense({
      key_hash: hashKey(key), user_id: userId, device_fp: null, status: "active", revoked_at: null,
    });
    return { key, userId, existed: false };
  }

  /** Перевыпуск ключа (resend/reissue): выдать новый активный ключ существующему юзеру. */
  async reissueKey(userId: string): Promise<string> {
    const key = generateKey();
    await this.store.createLicense({
      key_hash: hashKey(key), user_id: userId, device_fp: null, status: "active", revoked_at: null,
    });
    return key;
  }

  /** activation: ключ → session-token (+ HMAC-секрет + срок), device-binding при первом успехе. */
  async activate(key: string, deviceFp: string): Promise<{ token: string; hmacSecret: string; userId: string; expiresAt: string } | { error: string }> {
    const lic = await this.store.getLicenseByKeyHash(hashKey(key));
    if (!lic) return { error: "ключ не найден" };
    if (lic.status === "revoked") return { error: "ключ отозван" };
    if (lic.device_fp && lic.device_fp !== deviceFp) return { error: "ключ привязан к другому устройству" };
    if (!lic.device_fp) await this.store.bindDevice(lic.key_hash, deviceFp);
    return this.issue(lic.user_id, deviceFp);
  }

  /** Выпуск session-token с новым HMAC-секретом и сроком. */
  private issue(userId: string, deviceFp: string): { token: string; hmacSecret: string; userId: string; expiresAt: string } {
    const token = randomBytes(24).toString("base64url");
    const hmacSecret = randomBytes(32).toString("base64url");
    const exp = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { userId, deviceFp, hmacSecret, exp });
    return { token, hmacSecret, userId, expiresAt: new Date(exp).toISOString() };
  }

  /**
   * refresh: валидный (ещё не протухший) session-token того же устройства → новый токен со
   * свежим сроком (клиент не хранит ключ в проде — рефреш без повторной активации).
   * Проверяет отзыв лицензии на уровне... нет прямого доступа к key_hash по userId, поэтому
   * рефреш опирается на неистёкшую сессию; отзыв блокирует НОВУЮ активацию + инвалидируется по TTL.
   */
  async refresh(token: string, deviceFp: string): Promise<{ token: string; hmacSecret: string; userId: string; expiresAt: string } | { error: string }> {
    const s = this.sessions.get(token);
    if (!s) return { error: "сессия не найдена или истекла" };
    if (s.exp < Date.now()) { this.sessions.delete(token); return { error: "сессия истекла — активируйте ключ заново" }; }
    if (s.deviceFp !== deviceFp) return { error: "device_fp не совпадает" };
    this.sessions.delete(token); // одноразовая ротация
    return this.issue(s.userId, deviceFp);
  }

  /** Проверка session-token (+ device-binding). null → невалиден/протух. */
  verifySession(token: string, deviceFp?: string): { userId: string; hmacSecret: string } | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(token); return null; }
    if (deviceFp && s.deviceFp !== deviceFp) return null;
    return { userId: s.userId, hmacSecret: s.hmacSecret };
  }

  /** Отзыв ключа (revocation) + инвалидация активных сессий этого пользователя. */
  async revoke(key: string): Promise<void> {
    const lic = await this.store.getLicenseByKeyHash(hashKey(key));
    await this.store.revokeLicense(hashKey(key));
    if (lic) for (const [tok, s] of this.sessions) if (s.userId === lic.user_id) this.sessions.delete(tok);
  }

  /** HMAC + timestamp(±5м) + nonce анти-replay на сообщение WSS (ARCHITECTURE §5). */
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

  /** Per-user token-bucket rate limit. true = разрешено. */
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
