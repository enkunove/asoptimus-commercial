// @aso/server/db — migrations: applies schema.sql to Postgres. Run with: `bun run migrate`.
// Requires DATABASE_URL. Without it — no-op with a hint (in-memory needs no schema migration).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[migrate] DATABASE_URL not set — skipping (dev mode on MemoryStore needs no schema).");
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  const postgres = (await import("postgres")).default;
  const sql = postgres(url);
  try {
    await sql.unsafe(schema);
    console.log("[migrate] schema applied (schema.sql).");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("[migrate] error:", e);
  process.exit(1);
});
