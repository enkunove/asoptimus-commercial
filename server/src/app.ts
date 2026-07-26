// @aso/server — composition root: wires all services (store, auth, billing, paddle, email,
// llm-client, hub, run-manager) behind interfaces. External dependencies (Postgres, Anthropic,
// Paddle, SMTP) are required in prod; their mock/loopback work ONLY with DEV=1 (otherwise the
// factories throw ProdConfigError). Construction order = secret-validation order at startup.

import { createStore, type Store } from "./db/index.ts";
import { BillingService } from "./billing/service.ts";
import { AuthService } from "./auth/service.ts";
import { PaddleService } from "./paddle/service.ts";
import { TbcService } from "./tbc/service.ts";
import { createLlmClient } from "./llm-proxy/client.ts";
import { ClientHub } from "./apple-dispatch/hub.ts";
import { RunManager } from "./orchestrator/manager.ts";
import { createEmailService, type EmailService } from "./email/service.ts";
import { IS_DEV, optionalEnv } from "./env.ts";
import type { TopupRequest, TopupCustomRange } from "@aso/shared";

/** The provider-agnostic slice the checkout/grant routes use. Paddle- and TBC-specific
 *  routes (webhooks, the /buy page) reach for `app.paddle` / `app.tbc` directly, guarded. */
export interface PaymentProvider {
  readonly mock: boolean;
  onGrant: ((userId: string, balance: number) => void) | null;
  createCheckout(userId: string, email: string, selection: TopupRequest, origin: string): Promise<{ checkoutUrl: string }>;
  customRange(): TopupCustomRange | null;
  devComplete(userId: string, selection: TopupRequest): Promise<{ ok: boolean; note: string }>;
}

export interface App {
  store: Store;
  billing: BillingService;
  auth: AuthService;
  /** Active provider used by /checkout (chosen by PAYMENT_PROVIDER; default paddle). */
  payments: PaymentProvider;
  paddle: PaddleService | null;
  tbc: TbcService | null;
  email: EmailService;
  hub: ClientHub;
  manager: RunManager;
}

export function createApp(): App {
  const store = createStore();
  const billing = new BillingService(store);
  const auth = new AuthService(store);
  const email = createEmailService();

  // One acquirer is constructed — the one named by PAYMENT_PROVIDER (default paddle). Building
  // only the active provider means a TBC-only prod deploy doesn't need Paddle secrets and vice
  // versa (each constructor hard-fails on its own missing secrets in prod).
  const provider = optionalEnv("PAYMENT_PROVIDER", "paddle").toLowerCase();
  let paddle: PaddleService | null = null;
  let tbc: TbcService | null = null;
  let payments: PaymentProvider;
  if (provider === "tbc") {
    tbc = new TbcService(store, billing, email);
    payments = tbc;
  } else {
    paddle = new PaddleService(store, billing, email);
    payments = paddle;
  }

  const hub = new ClientHub();
  const client = createLlmClient();

  // Apple loopback (mock-apple) — ONLY with DEV=1 and without REQUIRE_CLIENT. In prod, Apple
  // jobs are executed by a real client over WSS (jobs fail if no client is present).
  const allowLoopback = IS_DEV && process.env.REQUIRE_CLIENT !== "1";
  const manager = new RunManager(store, billing, client, hub, { allowLoopback });

  // Top-up grants push the fresh balance to the user's connected clients immediately —
  // the header ticks live instead of waiting for a tab switch.
  payments.onGrant = (userId, credits) => hub.broadcast(userId, { t: "balance", credits });

  return { store, billing, auth, payments, paddle, tbc, email, hub, manager };
}
