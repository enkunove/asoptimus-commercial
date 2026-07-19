// @aso/server/db — Store factory. Prod: Postgres via DATABASE_URL (hard failure otherwise).
// DEV=1: if DATABASE_URL is unset — in-memory (no persistence across restarts).

import type { Store } from "./types.ts";
import { IS_DEV, hasEnv, ProdConfigError } from "../env.ts";
import { log } from "../log.ts";

export * from "./types.ts";

let singleton: Store | null = null;

export function createStore(): Store {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL;
  if (url && url.trim()) {
    // Lazy import: the `postgres` package is not needed in dev mock mode.
    const { PostgresStore } = require("./postgres-store.ts");
    singleton = new PostgresStore(url.trim()) as Store;
    log.info("[db] PostgresStore", { source: "DATABASE_URL" });
  } else if (IS_DEV) {
    const { MemoryStore } = require("./memory-store.ts");
    singleton = new MemoryStore() as Store;
    log.warn("[db] MemoryStore (DEV=1; no persistence across restarts)");
  } else {
    throw new ProdConfigError("DATABASE_URL", "Postgres address (postgres://user:pass@host:5432/db)");
  }
  return singleton;
}

export function getStore(): Store {
  return singleton ?? createStore();
}

export function hasPostgres(): boolean {
  return hasEnv("DATABASE_URL");
}
