// @aso/server/stripe — Checkout top-up (credit purchase, $1/credit) + webhook
// checkout.session.completed → grant in the ledger (idempotent via ledger.stripe_event_id UNIQUE
// + processed_events). D4 v4: 1 credit = $1; packages in config (env TOPUP_PACKAGES_JSON).
// PROD: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are required (hard failure otherwise). Mock — DEV=1.

import type Stripe from "stripe";
import type { TopupPackage } from "@aso/shared";
import type { Store } from "../db/index.ts";
import { BillingService } from "../billing/service.ts";
import type { EmailService } from "../email/service.ts";
import { IS_DEV, ProdConfigError, optionalEnv, hasEnv } from "../env.ts";
import { log } from "../log.ts";

/** Internal package config shape (what the user pays + how many credits to grant). */
export interface PackageConfig { chargeUsd: number; credits: number; label: string; }

// Top-up packages (1 credit = $1; larger ones carry a bonus). Overridden by env TOPUP_PACKAGES_JSON.
const DEFAULT_PACKAGES: Record<string, PackageConfig> = {
  p10: { chargeUsd: 10, credits: 10, label: "10 credits" },
  p25: { chargeUsd: 25, credits: 26, label: "25 credits (+1 bonus)" },
  p50: { chargeUsd: 50, credits: 53, label: "50 credits (+3 bonus)" },
  p100: { chargeUsd: 100, credits: 110, label: "100 credits (+10 bonus)" },
};

let packagesCache: Record<string, PackageConfig> | null = null;
export function packages(): Record<string, PackageConfig> {
  if (packagesCache) return packagesCache;
  const raw = optionalEnv("TOPUP_PACKAGES_JSON");
  let result: Record<string, PackageConfig> = DEFAULT_PACKAGES;
  if (raw) {
    try { result = { ...DEFAULT_PACKAGES, ...JSON.parse(raw) }; }
    catch { log.warn("TOPUP_PACKAGES_JSON failed to parse — using default"); }
  }
  packagesCache = result;
  return result;
}

/** Top-up catalog in the @aso/shared::TopupPackage contract shape (query kind="packages"). */
export function topupCatalog(): TopupPackage[] {
  return Object.entries(packages()).map(([id, p]) => ({
    id,
    credits: p.credits,
    priceUsd: p.chargeUsd,
    label: p.label,
    bonusPct: p.chargeUsd > 0 ? Math.round(((p.credits - p.chargeUsd) / p.chargeUsd) * 100) : 0,
  }));
}

export class StripeService {
  private stripe: Stripe | null = null;
  private webhookSecret: string;
  readonly mock: boolean;

  constructor(private store: Store, private billing: BillingService, private email: EmailService) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (key && key.trim()) {
      const StripeCtor = require("stripe").default ?? require("stripe");
      this.stripe = new StripeCtor(key.trim());
      this.mock = false;
      this.webhookSecret = hasEnv("STRIPE_WEBHOOK_SECRET")
        ? optionalEnv("STRIPE_WEBHOOK_SECRET")
        : (IS_DEV ? "" : (() => { throw new ProdConfigError("STRIPE_WEBHOOK_SECRET", "Stripe webhook signing secret"); })());
      log.info("[stripe] live", { source: "STRIPE_SECRET_KEY" });
    } else if (IS_DEV) {
      this.mock = true;
      this.webhookSecret = "";
      log.warn("[stripe] mock (DEV=1; real Checkout unavailable without a key)");
    } else {
      throw new ProdConfigError("STRIPE_SECRET_KEY", "Stripe secret key (Checkout + webhooks)");
    }
  }

  /** Create a Checkout Session → URL to redirect the browser to the Stripe domain. */
  async createCheckout(userId: string, email: string, packageId: string, origin: string): Promise<{ checkoutUrl: string }> {
    const pkg = packages()[packageId];
    if (!pkg) throw new Error(`unknown package: ${packageId}`);
    if (this.mock || !this.stripe) {
      // DEV: no Stripe — placeholder; granting happens via /api/dev/complete-checkout.
      return { checkoutUrl: `${origin}/checkout/success?dev=1&package=${packageId}&user=${userId}` };
    }
    let user = await this.store.getUserById(userId);
    let customerId = user?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await this.stripe.customers.create({ email });
      customerId = customer.id;
      await this.store.setStripeCustomer(userId, customerId);
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: pkg.label },
          unit_amount: Math.round(pkg.chargeUsd * 100),
        },
        quantity: 1,
      }],
      metadata: { userId, packageId },
      success_url: `${origin}/checkout/success`,
      cancel_url: `${origin}/checkout/cancel`,
    });
    return { checkoutUrl: session.url ?? "" };
  }

  /** Webhook handling. Idempotency: processed_events + ledger UNIQUE(stripe_event_id). */
  async handleWebhook(rawBody: string, signature: string | null): Promise<{ ok: boolean; note: string }> {
    let event: any;
    if (this.mock || !this.stripe) {
      event = JSON.parse(rawBody); // DEV: body without a signature
    } else {
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature ?? "", this.webhookSecret);
      } catch (e: any) {
        return { ok: false, note: `invalid signature: ${e?.message ?? e}` };
      }
    }
    if (event.type !== "checkout.session.completed") return { ok: true, note: `ignoring ${event.type}` };

    const first = await this.store.tryMarkProcessed(event.id);
    if (!first) return { ok: true, note: "duplicate event — skipped" };

    const session = event.data.object;
    const userId = session.metadata?.userId as string | undefined;
    const packageId = session.metadata?.packageId as string | undefined;
    const pkg = packageId ? packages()[packageId] : undefined;
    if (!userId || !pkg) return { ok: false, note: "no userId/package in metadata" };

    const granted = await this.billing.grant(userId, pkg.credits, event.id);
    if (granted) {
      // Payment receipt (best-effort: a failed email does not roll back the grant).
      try {
        const user = await this.store.getUserById(userId);
        const balance = await this.billing.balance(userId);
        if (user?.email) await this.email.sendReceipt(user.email, pkg.credits, pkg.chargeUsd, balance);
      } catch (e: any) {
        log.warn("[stripe] receipt not sent (grant succeeded)", { userId, err: String(e?.message ?? e) });
      }
    }
    return { ok: true, note: granted ? `granted ${pkg.credits} credits` : "grant already existed (idempotent)" };
  }

  /** DEV helper: simulate a successful webhook (DEV=1 only). */
  async devComplete(userId: string, packageId: string): Promise<{ ok: boolean; note: string }> {
    if (!IS_DEV) return { ok: false, note: "dev-complete is only available with DEV=1" };
    const eventId = `evt_dev_${userId}_${packageId}_${Date.now()}`;
    return this.handleWebhook(JSON.stringify({
      id: eventId, type: "checkout.session.completed",
      data: { object: { metadata: { userId, packageId } } },
    }), null);
  }
}
