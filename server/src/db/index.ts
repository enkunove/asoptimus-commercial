// @aso/server/db — фабрика Store. Прод: Postgres по DATABASE_URL (иначе жёсткий отказ).
// DEV=1: если DATABASE_URL не задан — in-memory (без персистентности между рестартами).

import type { Store } from "./types.ts";
import { IS_DEV, hasEnv, ProdConfigError } from "../env.ts";
import { log } from "../log.ts";

export * from "./types.ts";

let singleton: Store | null = null;

export function createStore(): Store {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL;
  if (url && url.trim()) {
    // Ленивый импорт: пакет `postgres` не нужен для dev-мок-режима.
    const { PostgresStore } = require("./postgres-store.ts");
    singleton = new PostgresStore(url.trim()) as Store;
    log.info("[db] PostgresStore", { source: "DATABASE_URL" });
  } else if (IS_DEV) {
    const { MemoryStore } = require("./memory-store.ts");
    singleton = new MemoryStore() as Store;
    log.warn("[db] MemoryStore (DEV=1; нет персистентности между рестартами)");
  } else {
    throw new ProdConfigError("DATABASE_URL", "адрес Postgres (postgres://user:pass@host:5432/db)");
  }
  return singleton;
}

export function getStore(): Store {
  return singleton ?? createStore();
}

export function hasPostgres(): boolean {
  return hasEnv("DATABASE_URL");
}
