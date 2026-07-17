// @aso/server/db — миграции: применяет schema.sql к Postgres. Запуск: `bun run migrate`.
// Требует DATABASE_URL. Без него — no-op с подсказкой (in-memory схему не мигрируют).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[migrate] DATABASE_URL не задан — пропуск (dev-режим на MemoryStore схему не требует).");
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  const postgres = (await import("postgres")).default;
  const sql = postgres(url);
  try {
    await sql.unsafe(schema);
    console.log("[migrate] схема применена (schema.sql).");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("[migrate] ошибка:", e);
  process.exit(1);
});
