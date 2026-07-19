// @aso/server/paddle — credit top-ups via Paddle Billing (merchant of record).
// Checkout: POST /transactions (items = the package's paddlePriceId) → hosted checkout URL.
// Webhook: transaction.completed → grant in the ledger, idempotent twice over:
//   processed_events (event_id) + ledger UNIQUE(paddle_event_id) keyed by the TRANSACTION id
//   (txn_…) — Paddle may re-deliver the same event under new notification ids, and a
//   transaction must never grant twice.
// PROD: PADDLE_API_KEY + PADDLE_WEBHOOK_SECRET required (hard failure otherwise). Mock — DEV=1.
// Signature spec: `Paddle-Signature: ts=<unix>;h1=<hex>` where h1 = HMAC-SHA256(secret, `${ts}:${rawBody}`).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TopupRequest, TopupCustomRange } from "@aso/shared";
import type { Store } from "../db/index.ts";
import { BillingService } from "../billing/service.ts";
import type { EmailService } from "../email/service.ts";
import { packages } from "../billing/packages.ts";
import { IS_DEV, ProdConfigError, optionalEnv } from "../env.ts";
import { log } from "../log.ts";

const SIGNATURE_TOLERANCE_S = 300; // reject webhooks older than 5 minutes (replay guard)

function apiBase(): string {
  return optionalEnv("PADDLE_ENV") === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
}

/** Parse `ts=…;h1=…[;h1=…]` (multiple h1 during secret rotation). */
export function parsePaddleSignature(header: string | null): { ts: number; h1: string[] } | null {
  if (!header) return null;
  let ts = NaN;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim());
    if (k === "ts" && v) ts = Number(v);
    else if (k === "h1" && v) h1.push(v);
  }
  return Number.isFinite(ts) && h1.length ? { ts, h1 } : null;
}

/** Verify a Paddle webhook signature (timing-safe; ts within tolerance). */
export function verifyPaddleSignature(rawBody: string, header: string | null, secret: string, nowMs = Date.now()): boolean {
  const sig = parsePaddleSignature(header);
  if (!sig) return false;
  if (Math.abs(nowMs / 1000 - sig.ts) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${sig.ts}:${rawBody}`).digest();
  return sig.h1.some((h) => {
    const got = Buffer.from(h, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export class PaddleService {
  private apiKey: string;
  private webhookSecret: string;
  readonly mock: boolean;
  /** Wired by the composition root to hub.broadcast: pushes the fresh balance to the user's
   *  connected clients right after a grant — the header must tick live, not on tab switch. */
  onGrant: ((userId: string, balance: number) => void) | null = null;

  constructor(private store: Store, private billing: BillingService, private email: EmailService) {
    const key = process.env.PADDLE_API_KEY;
    if (key && key.trim()) {
      this.apiKey = key.trim();
      this.mock = false;
      const secret = optionalEnv("PADDLE_WEBHOOK_SECRET");
      if (!secret && !IS_DEV) throw new ProdConfigError("PADDLE_WEBHOOK_SECRET", "Paddle notification endpoint secret (pdl_ntfset_…)");
      if (!secret) log.warn("[paddle] PADDLE_API_KEY without PADDLE_WEBHOOK_SECRET — incoming webhooks will be REJECTED (dev grants: /api/dev/complete-checkout)");
      this.webhookSecret = secret;
      // Prod boot check: every advertised package must be purchasable, or the store boots
      // "live" and then 500s per checkout (silent revenue loss found only via complaints).
      if (!IS_DEV) {
        const missing = Object.entries(packages()).filter(([, p]) => !p.paddlePriceId).map(([id]) => id);
        if (missing.length) throw new ProdConfigError("TOPUP_PACKAGES_JSON", `packages missing paddlePriceId (pri_…): ${missing.join(", ")}`);
      }
      log.info("[paddle] live", { source: "PADDLE_API_KEY", env: optionalEnv("PADDLE_ENV") || "live" });
    } else if (IS_DEV) {
      this.apiKey = "";
      this.webhookSecret = "";
      this.mock = true;
      log.warn("[paddle] mock (DEV=1; real checkout unavailable without a key)");
    } else {
      throw new ProdConfigError("PADDLE_API_KEY", "Paddle API key (transactions + customers)");
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(apiBase() + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.detail ?? data?.error?.code ?? res.statusText;
      throw new Error(`Paddle API ${method} ${path} failed (HTTP ${res.status}): ${detail}`);
    }
    return data;
  }

  /** Checked once per process: the ONE-credit catalog price must be exactly $1.00 USD —
   *  the UI advertises "$1 per credit" and the receipt states chargeUsd = credits, so a
   *  mispriced (or dashboard-edited) price would silently diverge charged vs advertised
   *  vs receipted amounts. */
  private creditPriceVerified = false;
  private async verifyCreditPrice(priceId: string): Promise<void> {
    if (this.creditPriceVerified) return;
    const res = await this.api("GET", `/prices/${priceId}`);
    const amount = res?.data?.unit_price?.amount;
    const currency = res?.data?.unit_price?.currency_code;
    if (amount !== "100" || currency !== "USD") {
      throw new Error(`PADDLE_CREDIT_PRICE_ID must be exactly $1.00 USD per credit (Paddle has ${amount ?? "?"} ${currency ?? "?"}) — fix the catalog price or the env`);
    }
    this.creditPriceVerified = true;
  }

  /** Find-or-create the Paddle customer for a user (id cached in users.paddle_customer_id). */
  private async customerFor(userId: string, email: string): Promise<string> {
    const user = await this.store.getUserById(userId);
    if (user?.paddle_customer_id) return user.paddle_customer_id;
    let customerId: string | undefined;
    try {
      const created = await this.api("POST", "/customers", { email });
      customerId = created?.data?.id;
    } catch (e: any) {
      // ONLY the documented duplicate-email conflict falls through to lookup; transient
      // failures (429/5xx/network) must propagate as themselves, not masquerade as 409.
      const msg = String(e?.message ?? e);
      if (!/HTTP 409|customer_already_exists|conflict/i.test(msg)) throw e;
      const found = await this.api("GET", `/customers?email=${encodeURIComponent(email)}`);
      customerId = found?.data?.[0]?.id;
    }
    if (!customerId) throw new Error("Paddle did not return a customer id");
    await this.store.setPaddleCustomer(userId, customerId);
    return customerId;
  }

  /** Custom-amount config (flat $1/credit, no bonus). Enabled in mock always; live — only
   *  when PADDLE_CREDIT_PRICE_ID (the catalog price of ONE credit, charged via quantity) is
   *  set. null → the UI hides the custom input. */
  customRange(): TopupCustomRange | null {
    if (!this.mock && !optionalEnv("PADDLE_CREDIT_PRICE_ID")) return null;
    // NaN-proof env parsing: a typo ("abc", "1,000") must fall back to the default, NOT
    // become NaN bounds — every NaN comparison is false, which silently turns the money
    // guard into a no-op (any integer passes, including 0 and negatives).
    const envInt = (name: string, def: number): number => {
      const raw = optionalEnv(name);
      if (!raw) return def;
      const v = Number(raw);
      if (!Number.isFinite(v)) {
        log.warn(`[paddle] ${name}="${raw}" is not a number — using default ${def}`);
        return def;
      }
      return Math.round(v);
    };
    const min = Math.max(1, envInt("TOPUP_CUSTOM_MIN", 5));
    // Absolute ceiling 1M keeps the webhook sanity clamp (10M) strictly above any amount a
    // checkout can accept — the two bounds must never cross (charged-but-never-credited).
    const max = Math.min(1_000_000, Math.max(min, envInt("TOPUP_CUSTOM_MAX", 500)));
    return { minCredits: min, maxCredits: max, usdPerCredit: 1 };
  }

  /** Validate a top-up selection → normalized shape. Throws a user-facing error message. */
  private resolveSelection(sel: TopupRequest): { packageId: string } | { customCredits: number } {
    const hasPkg = typeof sel.packageId === "string" && sel.packageId.length > 0;
    const hasCustom = sel.customCredits !== undefined && sel.customCredits !== null;
    if (hasPkg === hasCustom) throw new Error("pass exactly one of packageId / customCredits");
    if (hasPkg) {
      if (!packages()[sel.packageId!]) throw new Error(`unknown package: ${sel.packageId}`);
      return { packageId: sel.packageId! };
    }
    const range = this.customRange();
    if (!range) throw new Error("custom top-ups are not configured on this server");
    const n = Number(sel.customCredits);
    if (!Number.isInteger(n) || n < range.minCredits || n > range.maxCredits) {
      throw new Error(`customCredits must be a whole number between ${range.minCredits} and ${range.maxCredits}`);
    }
    return { customCredits: n };
  }

  /** Create a transaction → hosted checkout URL to open in the system browser. */
  async createCheckout(userId: string, email: string, selection: TopupRequest, origin: string): Promise<{ checkoutUrl: string }> {
    const sel = this.resolveSelection(selection);
    if (this.mock) {
      // DEV: no Paddle — placeholder; granting happens via /api/dev/complete-checkout.
      const q = "packageId" in sel ? `package=${sel.packageId}` : `credits=${sel.customCredits}`;
      return { checkoutUrl: `${origin}/checkout/success?dev=1&${q}&user=${userId}` };
    }
    let item: { price_id: string; quantity: number };
    let customData: Record<string, unknown>;
    if ("packageId" in sel) {
      const pkg = packages()[sel.packageId];
      if (!pkg.paddlePriceId) {
        throw new Error(`package ${sel.packageId} has no paddlePriceId — set it in TOPUP_PACKAGES_JSON (pri_… from the Paddle catalog)`);
      }
      item = { price_id: pkg.paddlePriceId, quantity: 1 };
      customData = { userId, packageId: sel.packageId };
    } else {
      // Flat $1/credit: the ONE-credit catalog price × quantity. The price's quantity maximum
      // in the Paddle catalog must be ≥ TOPUP_CUSTOM_MAX or Paddle rejects the transaction.
      const priceId = optionalEnv("PADDLE_CREDIT_PRICE_ID");
      await this.verifyCreditPrice(priceId);
      item = { price_id: priceId, quantity: sel.customCredits };
      customData = { userId, customCredits: sel.customCredits };
    }
    const customerId = await this.customerFor(userId, email);
    const txn = await this.api("POST", "/transactions", {
      items: [item],
      customer_id: customerId,
      // custom_data comes back verbatim in transaction.completed — the grant routing key.
      custom_data: customData,
    });
    // Hosted checkout link (requires a default payment link configured in Paddle → Checkout
    // settings). PADDLE_CHECKOUT_URL overrides the base for custom checkout pages.
    const url: string | undefined = txn?.data?.checkout?.url;
    const base = optionalEnv("PADDLE_CHECKOUT_URL");
    const txnId: string | undefined = txn?.data?.id;
    if (url) return { checkoutUrl: url };
    if (base && txnId) return { checkoutUrl: `${base}${base.includes("?") ? "&" : "?"}_ptxn=${txnId}` };
    throw new Error("Paddle returned no checkout url — configure a default payment link in Paddle Checkout settings or set PADDLE_CHECKOUT_URL");
  }

  /** Webhook entry: verify → parse → process. Signature is REQUIRED in every non-mock
   *  configuration — an unset secret must reject, never verify against the empty string
   *  (HMAC with "" is forgeable by anyone). */
  async handleWebhook(rawBody: string, signature: string | null): Promise<{ ok: boolean; note: string }> {
    let event: any;
    if (this.mock) {
      event = JSON.parse(rawBody); // DEV mock: body without a signature
    } else {
      if (!this.webhookSecret) return { ok: false, note: "PADDLE_WEBHOOK_SECRET not configured — webhook rejected" };
      if (!verifyPaddleSignature(rawBody, signature, this.webhookSecret)) {
        return { ok: false, note: "invalid Paddle-Signature" };
      }
      try { event = JSON.parse(rawBody); } catch { return { ok: false, note: "malformed webhook body" }; }
    }
    return this.processEvent(event);
  }

  /** Grant flow. ORDER MATTERS: the grant runs FIRST (idempotent by transaction id), and
   *  processed_events is marked only after it is durable. Mark-then-grant would silently
   *  LOSE a paid purchase: a transient DB error after the mark makes Paddle's retry (same
   *  event_id) short-circuit as a duplicate, and the customer is charged but never credited.
   *  With grant-first, a failure → 500 → Paddle retries → the idempotent grant re-runs. */
  private async processEvent(event: any): Promise<{ ok: boolean; note: string }> {
    if (event.event_type !== "transaction.completed") return { ok: true, note: `ignoring ${event.event_type}` };

    const eventId = String(event.event_id ?? "");
    const txn = event.data ?? {};
    const userId = txn.custom_data?.userId as string | undefined;
    const packageId = txn.custom_data?.packageId as string | undefined;
    const rawCustom = txn.custom_data?.customCredits;
    const pkg = packageId ? packages()[packageId] : undefined;
    // Grant amount: a known package OR a custom amount (set by OUR transaction create; the
    // signature already proves origin). Sanity ceiling 10M sits strictly ABOVE the 1M cap
    // customRange() enforces at checkout — the clamps must never cross, or an amount a
    // checkout accepted (and Paddle charged) would be refused at grant time.
    const customCredits = Number.isInteger(Number(rawCustom)) && Number(rawCustom) > 0 && Number(rawCustom) <= 10_000_000
      ? Number(rawCustom) : undefined;
    const credits = pkg?.credits ?? customCredits;
    const chargeUsd = pkg?.chargeUsd ?? customCredits; // custom = flat $1/credit
    if (!userId || credits === undefined) {
      if (userId && (rawCustom !== undefined || packageId !== undefined)) {
        // OUR transaction (userId present) with an unresolvable amount — a PAID charge must
        // never be silently ACKed away. Fail so Paddle retries and the endpoint's failure
        // stats alert the operator.
        log.error("[paddle] paid transaction with unresolvable custom_data — refusing to ACK", { eventId, txnId: txn.id, packageId, rawCustom });
        return { ok: false, note: "paid transaction with unresolvable custom_data (unknown package or invalid customCredits)" };
      }
      // Not ours (dashboard invoice, another product on the same Paddle account). ACK with
      // 200: a 4xx would count as a delivery failure and push the endpoint toward Paddle's
      // auto-deactivation threshold while retrying an event that can never be routed.
      log.warn("[paddle] transaction.completed without routable custom_data — acknowledged", { eventId, txnId: txn.id });
      return { ok: true, note: "no userId/package in custom_data — acknowledged, not ours" };
    }

    // Ledger idempotency key = TRANSACTION id: the same purchase must never grant twice even
    // if Paddle re-issues the event under a fresh event_id.
    const grantKey = String(txn.id ?? eventId);
    const granted = await this.billing.grant(userId, credits, grantKey);
    if (eventId) await this.store.tryMarkProcessed(eventId); // audit trail only, post-success

    if (granted) {
      const balance = await this.billing.balance(userId);
      // Live balance push to connected clients (same channel run debits use).
      try { this.onGrant?.(userId, balance); } catch { /* push must not fail the webhook */ }
      // Payment receipt (best-effort: a failed email does not roll back the grant).
      try {
        const user = await this.store.getUserById(userId);
        if (user?.email) await this.email.sendReceipt(user.email, credits, chargeUsd!, balance);
      } catch (e: any) {
        log.warn("[paddle] receipt not sent (grant succeeded)", { userId, err: String(e?.message ?? e) });
      }
    }
    return { ok: true, note: granted ? `granted ${credits} credits` : "grant already existed (idempotent)" };
  }

  /** DEV helper: simulate a completed transaction (DEV=1 only). Feeds processEvent directly —
   *  it must keep working when a sandbox PADDLE_API_KEY is set (mock=false) and the signed
   *  webhook path would rightly reject an unsigned body. */
  async devComplete(userId: string, selection: TopupRequest): Promise<{ ok: boolean; note: string }> {
    if (!IS_DEV) return { ok: false, note: "dev-complete is only available with DEV=1" };
    const sel = this.resolveSelection(selection); // same bounds as a real checkout
    const tag = "packageId" in sel ? sel.packageId : `c${sel.customCredits}`;
    const stamp = Date.now();
    return this.processEvent({
      event_id: `evt_dev_${userId}_${tag}_${stamp}`,
      event_type: "transaction.completed",
      data: {
        id: `txn_dev_${userId}_${tag}_${stamp}`,
        custom_data: { userId, ...("packageId" in sel ? { packageId: sel.packageId } : { customCredits: sel.customCredits }) },
      },
    });
  }
}
