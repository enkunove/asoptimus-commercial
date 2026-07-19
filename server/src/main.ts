// @aso/server — entry point: Bun.serve (HTTP + WSS), env validation at startup (fail-fast in prod),
// structured logging, graceful shutdown. HTTP: REST + SSE (api/http). WSS at /ws: client
// commands + Apple job dispatch (api/wss).

import { createApp } from "./app.ts";
import { handleHttp } from "./api/http.ts";
import { wssMessage, wssClose, type WsData } from "./api/wss.ts";
import { IS_DEV, ProdConfigError } from "./env.ts";
import { log } from "./log.ts";

// @ts-ignore — Bun global (types from @types/bun; bun is the target environment regardless).
if (typeof Bun === "undefined") {
  log.error("[main] Bun runtime required (bun run src/main.ts). Node does not support Bun.serve/text-import of prompts.");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8787);

// createApp() constructs all services; in prod their factories throw ProdConfigError when
// a required secret is missing (DATABASE_URL / ANTHROPIC_API_KEY / PADDLE_* / SMTP_*).
let app: ReturnType<typeof createApp>;
try {
  app = createApp();
} catch (e: any) {
  if (e instanceof ProdConfigError) {
    log.error(e.message);
    log.error("[main] startup aborted: fill in the required secrets (.env.example) or run with DEV=1.");
  } else {
    log.error("[main] initialization error", { err: String(e?.message ?? e) });
  }
  process.exit(1);
}

// @ts-ignore
const server = Bun.serve<WsData>({
  port: PORT,
  idleTimeout: 240,
  async fetch(req: Request, srv: any) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const ok = srv.upgrade(req, { data: {} as WsData });
      return ok ? undefined : new Response("ws upgrade failed", { status: 400 });
    }
    try {
      return await handleHttp(app, req);
    } catch (e: any) {
      log.error("[http] error", { err: String(e?.message ?? e) });
      return new Response(JSON.stringify({ error: e?.message ?? String(e) }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
  websocket: {
    message(ws: any, message: string | Buffer) {
      // Serialize per connection: wssMessage is async (session hydration from the store) and
      // hello MUST be fully processed before the next message is examined.
      const d = ws.data as WsData & { _q?: Promise<void> };
      d._q = (d._q ?? Promise.resolve())
        .then(() => wssMessage(app, ws, message))
        .catch((e) => log.error("[wss] message handler error", { err: String(e?.message ?? e) }));
    },
    close(ws: any) { wssClose(app, ws); },
  },
});

log.info("[main] ASOptimus server listening", {
  http: `http://localhost:${server.port}`,
  wss: `ws://localhost:${server.port}/ws`,
  mode: IS_DEV ? "DEV (mocks allowed)" : "PROD",
  llm: process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock",
  db: process.env.DATABASE_URL ? "postgres" : "memory",
  paddle: process.env.PADDLE_API_KEY ? "live" : "mock",
  smtp: process.env.SMTP_HOST ? "smtp" : "dev-log",
  apple: process.env.REQUIRE_CLIENT === "1" ? "client-only" : (IS_DEV ? "loopback-fallback" : "client-only"),
});

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[main] ${sig} — graceful shutdown`);
    try { server.stop(); await app.store.close(); } finally { process.exit(0); }
  });
}
