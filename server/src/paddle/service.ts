// @aso/server/paddle — credit top-ups via Paddle Billing (merchant of record).
// Checkout: POST /transactions (items = the package's paddlePriceId) → hosted checkout URL.
// Webhook: transaction.completed → grant in the ledger, idempotent twice over:
//   processed_events (event_id) + ledger UNIQUE(paddle_event_id) keyed by the TRANSACTION id
//   (txn_…) — Paddle may re-deliver the same event under new notification ids, and a
//   transaction must never grant twice.
// PROD: PADDLE_API_KEY + PADDLE_WEBHOOK_SECRET required (hard failure otherwise). Mock — DEV=1.
// Signature spec: `Paddle-Signature: ts=<unix>;h1=<hex>` where h1 = HMAC-SHA256(secret, `${ts}:${rawBody}`).

import { createHmac, timingSafeEqual } from "node:crypto";
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

  /** Create a transaction → hosted checkout URL to open in the system browser. */
  async createCheckout(userId: string, email: string, packageId: string, origin: string): Promise<{ checkoutUrl: string }> {
    const pkg = packages()[packageId];
    if (!pkg) throw new Error(`unknown package: ${packageId}`);
    if (this.mock) {
      // DEV: no Paddle — placeholder; granting happens via /api/dev/complete-checkout.
      return { checkoutUrl: `${origin}/checkout/success?dev=1&package=${packageId}&user=${userId}` };
    }
    if (!pkg.paddlePriceId) {
      throw new Error(`package ${packageId} has no paddlePriceId — set it in TOPUP_PACKAGES_JSON (pri_… from the Paddle catalog)`);
    }
    const customerId = await this.customerFor(userId, email);
    const txn = await this.api("POST", "/transactions", {
      items: [{ price_id: pkg.paddlePriceId, quantity: 1 }],
      customer_id: customerId,
      // custom_data comes back verbatim in transaction.completed — the grant routing key.
      custom_data: { userId, packageId },
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
    const pkg = packageId ? packages()[packageId] : undefined;
    if (!userId || !pkg) {
      // Not ours (dashboard invoice, another product on the same Paddle account). ACK with
      // 200: a 4xx would count as a delivery failure and push the endpoint toward Paddle's
      // auto-deactivation threshold while retrying an event that can never be routed.
      log.warn("[paddle] transaction.completed without routable custom_data — acknowledged", { eventId, txnId: txn.id });
      return { ok: true, note: "no userId/package in custom_data — acknowledged, not ours" };
    }

    // Ledger idempotency key = TRANSACTION id: the same purchase must never grant twice even
    // if Paddle re-issues the event under a fresh event_id.
    const grantKey = String(txn.id ?? eventId);
    const granted = await this.billing.grant(userId, pkg.credits, grantKey);
    if (eventId) await this.store.tryMarkProcessed(eventId); // audit trail only, post-success

    if (granted) {
      // Payment receipt (best-effort: a failed email does not roll back the grant).
      try {
        const user = await this.store.getUserById(userId);
        const balance = await this.billing.balance(userId);
        if (user?.email) await this.email.sendReceipt(user.email, pkg.credits, pkg.chargeUsd, balance);
      } catch (e: any) {
        log.warn("[paddle] receipt not sent (grant succeeded)", { userId, err: String(e?.message ?? e) });
      }
    }
    return { ok: true, note: granted ? `granted ${pkg.credits} credits` : "grant already existed (idempotent)" };
  }

  /** DEV helper: simulate a completed transaction (DEV=1 only). Feeds processEvent directly —
   *  it must keep working when a sandbox PADDLE_API_KEY is set (mock=false) and the signed
   *  webhook path would rightly reject an unsigned body. */
  async devComplete(userId: string, packageId: string): Promise<{ ok: boolean; note: string }> {
    if (!IS_DEV) return { ok: false, note: "dev-complete is only available with DEV=1" };
    const stamp = Date.now();
    return this.processEvent({
      event_id: `evt_dev_${userId}_${packageId}_${stamp}`,
      event_type: "transaction.completed",
      data: { id: `txn_dev_${userId}_${packageId}_${stamp}`, custom_data: { userId, packageId } },
    });
  }
}
