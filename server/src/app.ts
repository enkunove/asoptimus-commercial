// @aso/server — корень композиции: собирает все сервисы (store, auth, billing, stripe, email,
// llm-client, hub, run-manager) за интерфейсами. Внешние зависимости (Postgres, Anthropic,
// Stripe, SMTP) обязательны в проде; их мок/loopback работают ТОЛЬКО при DEV=1 (иначе фабрики
// бросают ProdConfigError). Порядок конструирования = порядок валидации секретов на старте.

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

  // Loopback Apple (mock-apple) — ТОЛЬКО DEV=1 и без REQUIRE_CLIENT. В проде Apple-джобы
  // исполняет реальный клиент по WSS (jobs фейлятся, если клиента нет).
  const allowLoopback = IS_DEV && process.env.REQUIRE_CLIENT !== "1";
  const manager = new RunManager(store, billing, client, hub, { allowLoopback });

  return { store, billing, auth, stripe, email, hub, manager };
}
