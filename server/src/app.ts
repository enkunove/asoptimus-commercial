// @aso/server — composition root: wires all services (store, auth, billing, stripe, email,
// llm-client, hub, run-manager) behind interfaces. External dependencies (Postgres, Anthropic,
// Stripe, SMTP) are required in prod; their mock/loopback work ONLY with DEV=1 (otherwise the
// factories throw ProdConfigError). Construction order = secret-validation order at startup.

import { createStore, type Store } from "./db/index.ts";
import { BillingService } from "./billing/service.ts";
import { AuthService } from "./auth/service.ts";
import { StripeService } from "./stripe/service.ts";
import { createLlmClient } from "./llm-proxy/client.ts";
import { ClientHub } from "./apple-dispatch/hub.ts";
import { RunManager } from "./orchestrator/manager.ts";
import { createEmailService, type EmailService } from "./email/service.ts";
import { IS_DEV } from "./env.ts";

export interface App {
  store: Store;
  billing: BillingService;
  auth: AuthService;
  stripe: StripeService;
  email: EmailService;
  hub: ClientHub;
  manager: RunManager;
}

export function createApp(): App {
  const store = createStore();
  const billing = new BillingService(store);
  const auth = new AuthService(store);
  const email = createEmailService();
  const stripe = new StripeService(store, billing, email);
  const hub = new ClientHub();
  const client = createLlmClient();

  // Apple loopback (mock-apple) — ONLY with DEV=1 and without REQUIRE_CLIENT. In prod, Apple
  // jobs are executed by a real client over WSS (jobs fail if no client is present).
  const allowLoopback = IS_DEV && process.env.REQUIRE_CLIENT !== "1";
  const manager = new RunManager(store, billing, client, hub, { allowLoopback });

  return { store, billing, auth, stripe, email, hub, manager };
}
