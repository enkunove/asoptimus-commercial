// @aso/server — точка входа: Bun.serve (HTTP + WSS), env-валидация на старте (fail-fast в проде),
// структурное логирование, graceful shutdown. HTTP: REST + SSE (api/http). WSS на /ws: команды
// клиента + диспатч Apple-джоб (api/wss).

import { createApp } from "./app.ts";
import { handleHttp } from "./api/http.ts";
import { wssMessage, wssClose, type WsData } from "./api/wss.ts";
import { IS_DEV, ProdConfigError } from "./env.ts";
import { log } from "./log.ts";

// @ts-ignore — Bun global (типы из @types/bun; вне bun среда всё равно целевая).
if (typeof Bun === "undefined") {
  log.error("[main] требуется Bun-рантайм (bun run src/main.ts). Node не поддерживает Bun.serve/text-import промптов.");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8787);

// createApp() конструирует все сервисы; в проде их фабрики бросают ProdConfigError при
// отсутствии обязательного секрета (DATABASE_URL / ANTHROPIC_API_KEY / STRIPE_* / SMTP_*).
let app: ReturnType<typeof createApp>;
try {
  app = createApp();
} catch (e: any) {
  if (e instanceof ProdConfigError) {
    log.error(e.message);
    log.error("[main] запуск прерван: заполните обязательные секреты (.env.example) или запустите с DEV=1.");
  } else {
    log.error("[main] ошибка инициализации", { err: String(e?.message ?? e) });
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
    message(ws: any, message: string | Buffer) { wssMessage(app, ws, message); },
    close(ws: any) { wssClose(app, ws); },
  },
});

log.info("[main] ASOptimus server слушает", {
  http: `http://localhost:${server.port}`,
  wss: `ws://localhost:${server.port}/ws`,
  mode: IS_DEV ? "DEV (моки разрешены)" : "PROD",
  llm: process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock",
  db: process.env.DATABASE_URL ? "postgres" : "memory",
  stripe: process.env.STRIPE_SECRET_KEY ? "live" : "mock",
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
