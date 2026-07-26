// @aso/server/tbc — credit top-ups via TBC E-Commerce (tpay). ALTERNATIVE to Paddle: TBC is a
// direct card acquirer (Georgian IP merchant contract), NOT a merchant of record — you handle
// your own VAT/tax. Selected with PAYMENT_PROVIDER=tbc; Paddle stays the default and untouched.
//
// API (https://developers.tbcbank.ge — TBC E-Commerce / tpay):
//   Base:   https://api.tbcbank.ge/v1  (single host; sandbox is gated by the apikey/app you use)
//   Auth:   TWO layers on every payment call —
//             1) header  apikey: <developer API key>          (identifies the registered app)
//             2) header  Authorization: Bearer <access_token> (obtained below; valid ~1 day)
//   Token:  POST /tpay/access-token  (form: client_id, client_secret) → { access_token, expires_in }
//   Create: POST /tpay/payments      → { payId, status, links[] }  (redirect the payer to links[].uri)
//   Verify: GET  /tpay/payments/{payId} → { status: Succeeded|Failed|... }  ← the source of truth
//   Callback: TBC POSTs to our callbackUrl when a payment settles. It is only a NUDGE — we never
//             trust its body; we re-fetch the payment and grant ONLY on status=Succeeded.
//
// MONEY SAFETY (identical discipline to the Paddle handler):
//   • grant is idempotent by payId (ledger UNIQUE) — a re-delivered callback never double-credits.
//   • the amount charged is re-derived from OUR signed ref, then checked against the verified
//     payment total — a tampered callback cannot grant more than was actually paid.

import type { TopupRequest, TopupCustomRange } from "@aso/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "../db/index.ts";
import { BillingService } from "../billing/service.ts";
import type { EmailService } from "../email/service.ts";
import { packages } from "../billing/packages.ts";
import { IS_DEV, ProdConfigError, optionalEnv, requireEnv } from "../env.ts";
import { log } from "../log.ts";

const API_BASE = "https://api.tbcbank.ge/v1";

/** TBC statuses that mean "settled, credit now". Everything else is pending/failed — no grant. */
const SUCCEEDED = new Set(["Succeeded", "PartialRefunded"]); // PartialRefunded = paid then partially refunded

export class TbcService {
  private apiKey: string;     // developer apikey header
  private clientId: string;
  private clientSecret: string;
  private signKey: string;    // HMAC over the routing ref carried through TBC
  private currency: string;   // MUST match the merchant contract (GEL for a GEL-only contract)
  readonly mock: boolean;
  onGrant: ((userId: string, balance: number) => void) | null = null;

  private token: { value: string; expiresAt: number } | null = null;

  constructor(private store: Store, private billing: BillingService, private email: EmailService) {
    const key = process.env.TBC_API_KEY;
    this.currency = optionalEnv("TBC_CURRENCY", "GEL").toUpperCase();
    if (key && key.trim()) {
      this.apiKey = key.trim();
      this.clientId = requireEnv("TBC_CLIENT_ID", "TBC E-Commerce client_id (Developer portal → your app)");
      this.clientSecret = requireEnv("TBC_CLIENT_SECRET", "TBC E-Commerce client_secret");
      // Sign the routing ref so a forged callback can't invent a (userId, credits) pair. Reuse the
      // app HMAC secret; in DEV fall back to a constant so the mock path stays deterministic.
      this.signKey = optionalEnv("HMAC_SECRET") || optionalEnv("TBC_SIGN_SECRET") || (IS_DEV ? "dev-tbc-sign" : "");
      if (!this.signKey) throw new ProdConfigError("HMAC_SECRET", "needed to sign TBC payment refs (or set TBC_SIGN_SECRET)");
      this.mock = false;
      if (!IS_DEV) {
        const missing = Object.entries(packages()).filter(([, p]) => !p.tbcAmount && !p.chargeUsd).map(([id]) => id);
        if (missing.length) throw new ProdConfigError("TOPUP_PACKAGES_JSON", `packages missing a chargeable amount: ${missing.join(", ")}`);
      }
      log.info("[tbc] live", { base: API_BASE, currency: this.currency });
    } else if (IS_DEV) {
      this.apiKey = this.clientId = this.clientSecret = this.signKey = "";
      this.mock = true;
      log.warn("[tbc] mock (DEV=1; real checkout unavailable without TBC_API_KEY/CLIENT_ID/CLIENT_SECRET)");
    } else {
      throw new ProdConfigError("TBC_API_KEY", "TBC E-Commerce developer apikey");
    }
  }

  // ── auth ───────────────────────────────────────────────────────────────────
  private async accessToken(): Promise<string> {
    // Refresh a minute before expiry so an in-flight request never races the deadline.
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${API_BASE}/tpay/access-token`, {
      method: "POST",
      headers: { apikey: this.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      throw new Error(`TBC access-token failed (HTTP ${res.status}): ${data?.message ?? res.statusText}`);
    }
    const ttlMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 86_400) * 1000;
    this.token = { value: data.access_token, expiresAt: Date.now() + ttlMs };
    return this.token.value;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.accessToken();
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        apikey: this.apiKey,
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.message ?? data?.developerMessage ?? data?.error ?? res.statusText;
      throw new Error(`TBC ${method} ${path} failed (HTTP ${res.status}): ${detail}`);
    }
    return data;
  }

  // ── routing ref (userId + credits carried through TBC, signed) ──────────────
  private makeRef(userId: string, credits: number, charge: number): string {
    const payload = Buffer.from(JSON.stringify({ u: userId, c: credits, a: charge })).toString("base64url");
    const mac = createHmac("sha256", this.signKey).update(payload).digest("base64url");
    return `${payload}.${mac}`;
  }
  private readRef(ref: string | null): { userId: string; credits: number; charge: number } | null {
    if (!ref || !ref.includes(".")) return null;
    const [payload, mac] = ref.split(".", 2);
    const expected = createHmac("sha256", this.signKey).update(payload).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    try {
      const o = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (typeof o.u === "string" && Number.isFinite(o.c) && Number.isFinite(o.a)) return { userId: o.u, credits: o.c, charge: o.a };
    } catch { /* fall through */ }
    return null;
  }

  // ── selection → (credits to grant, amount to charge) ────────────────────────
  customRange(): TopupCustomRange | null {
    if (!this.mock && !optionalEnv("TBC_CREDIT_ENABLED")) return null; // opt-in custom amounts
    const envInt = (name: string, def: number): number => {
      const raw = optionalEnv(name);
      const v = raw ? Number(raw) : NaN;
      return raw && Number.isFinite(v) ? Math.round(v) : def;
    };
    const min = Math.max(1, envInt("TOPUP_CUSTOM_MIN", 5));
    const max = Math.min(1_000_000, Math.max(min, envInt("TOPUP_CUSTOM_MAX", 500)));
    return { minCredits: min, maxCredits: max, usdPerCredit: 1 };
  }

  private resolve(sel: TopupRequest): { credits: number; charge: number; label: string } {
    const hasPkg = typeof sel.packageId === "string" && sel.packageId.length > 0;
    const hasCustom = sel.customCredits !== undefined && sel.customCredits !== null;
    if (hasPkg === hasCustom) throw new Error("pass exactly one of packageId / customCredits");
    if (hasPkg) {
      const pkg = packages()[sel.packageId!];
      if (!pkg) throw new Error(`unknown package: ${sel.packageId}`);
      // Charge amount in the merchant currency: tbcAmount if given, else chargeUsd (USD contract).
      return { credits: pkg.credits, charge: pkg.tbcAmount ?? pkg.chargeUsd, label: pkg.label };
    }
    const range = this.customRange();
    if (!range) throw new Error("custom top-ups are not configured on this server");
    const n = Number(sel.customCredits);
    if (!Number.isInteger(n) || n < range.minCredits || n > range.maxCredits) {
      throw new Error(`customCredits must be a whole number between ${range.minCredits} and ${range.maxCredits}`);
    }
    return { credits: n, charge: n, label: `${n} credits` }; // flat 1:1 in the merchant currency
  }

  /** Create a TBC payment → hosted redirect URL to open in the browser. */
  async createCheckout(userId: string, email: string, selection: TopupRequest, origin: string): Promise<{ checkoutUrl: string }> {
    const { credits, charge } = this.resolve(selection);
    if (this.mock) {
      const q = "packageId" in selection && selection.packageId ? `package=${selection.packageId}` : `credits=${credits}`;
      return { checkoutUrl: `${origin}/checkout/success?dev=1&${q}&user=${userId}` };
    }
    const ref = this.makeRef(userId, credits, charge);
    // The callback carries our signed ref as a query param: TBC calls back the EXACT url we set,
    // so the ref round-trips without any server-side pending-state. Public base must be reachable
    // by TBC (not localhost) — PUBLIC_API_URL, else fall back to the request origin.
    const publicBase = optionalEnv("PUBLIC_API_URL", origin).replace(/\/$/, "");
    const callbackUrl = `${publicBase}/webhooks/tbc?ref=${encodeURIComponent(ref)}`;
    const payment = await this.api("POST", "/tpay/payments", {
      amount: { currency: this.currency, total: charge },
      returnurl: `${origin}/checkout/success`,
      callbackUrl,
      expirationMinutes: 20,
      language: "EN",
      merchantPaymentId: `aso_${userId}_${Date.now()}`,
      // custom_data equivalent, also visible in payment details / statement (kept short):
      extra: `ASOptimus ${credits} credits`,
    });
    const links: any[] = Array.isArray(payment?.links) ? payment.links : [];
    const redirect = links.find((l) => /redirect/i.test(l?.method ?? "") || /approval|checkout|pay/i.test(l?.rel ?? ""))?.uri
      ?? links.find((l) => l?.uri && !/self/i.test(l?.rel ?? ""))?.uri;
    if (!redirect) throw new Error("TBC returned no redirect link — check the tpay/payments response shape");
    return { checkoutUrl: redirect };
  }

  /** Callback entry: read the signed ref → verify the payment with TBC → grant on Succeeded.
   *  `body` may echo the payId; if absent we fall back to the ref (which is enough to look up). */
  async handleCallback(ref: string | null, payIdFromBody: string | null): Promise<{ ok: boolean; note: string }> {
    if (this.mock) return { ok: true, note: "mock — callbacks are not processed" };
    const parsed = this.readRef(ref);
    if (!parsed) return { ok: false, note: "missing or invalid signed ref" };

    // Resolve the payId: prefer the callback body, else the ref cannot name it — require the body.
    const payId = (payIdFromBody ?? "").trim();
    if (!payId) return { ok: false, note: "callback without payId" };

    // Source of truth: re-fetch the payment from TBC (authenticated). Never trust the callback body.
    const details = await this.api("GET", `/tpay/payments/${encodeURIComponent(payId)}`);
    const status = String(details?.status ?? "");
    if (!SUCCEEDED.has(status)) {
      return { ok: true, note: `payment ${payId} status=${status || "unknown"} — no grant` };
    }
    // Anti-tamper: the amount TBC actually settled must cover what our ref claims was charged.
    const paid = Number(details?.amount ?? details?.confirmedAmount ?? NaN);
    if (Number.isFinite(paid) && paid + 1e-9 < parsed.charge) {
      log.error("[tbc] settled amount below charged ref — refusing grant", { payId, paid, expected: parsed.charge });
      return { ok: false, note: "settled amount below expected — not granting" };
    }

    // Idempotent by payId: a re-delivered callback (TBC retries) never double-credits.
    const granted = await this.billing.grant(parsed.userId, parsed.credits, `tbc_${payId}`);
    if (granted) {
      const balance = await this.billing.balance(parsed.userId);
      try { this.onGrant?.(parsed.userId, balance); } catch { /* push must not fail the callback */ }
      try {
        const user = await this.store.getUserById(parsed.userId);
        if (user?.email) await this.email.sendReceipt(user.email, parsed.credits, parsed.charge, balance);
      } catch (e: any) {
        log.warn("[tbc] receipt not sent (grant succeeded)", { userId: parsed.userId, err: String(e?.message ?? e) });
      }
    }
    return { ok: true, note: granted ? `granted ${parsed.credits} credits` : "grant already existed (idempotent)" };
  }

  /** DEV helper: simulate a settled payment (DEV=1 only), mirroring PaddleService.devComplete. */
  async devComplete(userId: string, selection: TopupRequest): Promise<{ ok: boolean; note: string }> {
    if (!IS_DEV) return { ok: false, note: "dev-complete is only available with DEV=1" };
    const { credits, charge } = this.resolve(selection);
    const stamp = Date.now();
    const granted = await this.billing.grant(userId, credits, `tbc_dev_${userId}_${stamp}`);
    if (granted) {
      const balance = await this.billing.balance(userId);
      try { this.onGrant?.(userId, balance); } catch { /* ignore */ }
    }
    return { ok: true, note: granted ? `granted ${credits} credits (dev)` : "already granted (idempotent)" };
  }
}
