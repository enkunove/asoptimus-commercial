// localserver — serves the web-ui and the RELAY API/SSE between browser and cloud (D1).
// The browser talks ONLY to 127.0.0.1; cloud-link goes outside. Guard D8:
//   (1) strict Host allowlist (protection against DNS rebinding);
//   (2) Origin check on state-changing routes (blind CSRF);
//   (3) per-launch token in the HTML, required on all /api (naive CSRF).
// No domain logic — only transport and statics.

import type { CloudLink, RelayEvent } from "./cloud-link";
import { STOREFRONTS, HTTP_DEFAULTS, FIELD_LIMITS, DEFAULT_STOPWORDS } from "@aso/shared";

// UI statics embedded into the binary (Bun `with { type: "text" }`).
import indexHtmlRaw from "./web-ui/index.html" with { type: "text" };
const indexHtmlTemplate = indexHtmlRaw as unknown as string;
// @ts-expect-error — Bun text import
import appJs from "./web-ui/app.js" with { type: "text" };
// @ts-expect-error — Bun text import
import stylesCss from "./web-ui/styles.css" with { type: "text" };

export interface LocalServerDeps {
  port: number;
  token: string;
  /** Current cloud-link (null before activation). */
  getCloud(): CloudLink | null;
  isActivated(): boolean;
  /** Key activation: exchange for a session-token + start cloud-link. */
  activate(key: string): Promise<void>;
  logout(): Promise<void>;
}

const encoder = new TextEncoder();

export function startLocalServer(deps: LocalServerDeps) {
  const hostsFor = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const originsFor = (port: number) => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // ── SSE clients (relay of cloud-link events) ─────────────────────────────
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const pushSse = (obj: unknown) => {
    const payload = encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
    for (const c of [...sseClients]) {
      try { c.enqueue(payload); } catch { sseClients.delete(c); }
    }
  };
  // Subscription to cloud-link events (re-subscribe when cloud changes after activation).
  let unsub: (() => void) | null = null;
  const wireCloud = () => {
    unsub?.();
    const cloud = deps.getCloud();
    unsub = cloud?.subscribe((ev: RelayEvent) => pushSse(ev)) ?? null;
  };
  wireCloud();

  const server = Bun.serve({
    hostname: "127.0.0.1", // local only (D1)
    port: deps.port,
    idleTimeout: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const boundPort = srv.port ?? deps.port; // actual port (matters when port=0)

      // ── Guard D8.1: Host allowlist on ALL requests ──────────────────────────
      const host = req.headers.get("host") ?? "";
      if (!hostsFor(boundPort).has(host)) {
        return new Response("forbidden host", { status: 403 });
      }

      try {
        // ── UI statics (no token: the page is what bootstraps it) ─────────────
        if (req.method === "GET" && (path === "/" || path === "/index.html")) {
          const html = indexHtmlTemplate.replace(/__ASO_TOKEN__/g, deps.token);
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (req.method === "GET" && path === "/app.js") {
          return new Response(appJs, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
        }
        if (req.method === "GET" && path === "/styles.css") {
          return new Response(stylesCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });
        }

        // Everything under /api — only with a valid per-launch token (D8.3).
        if (path.startsWith("/api/")) {
          const token = req.headers.get("x-aso-token") ?? url.searchParams.get("token");
          if (token !== deps.token) return json({ error: "bad token" }, 401);

          // Guard D8.2: Origin on state-changing routes.
          if (req.method !== "GET") {
            const origin = req.headers.get("origin");
            if (origin && !originsFor(boundPort).has(origin)) return json({ error: "bad origin" }, 403);
          }
          return await handleApi(req, url, path, deps, sseClients, wireCloud);
        }

        return new Response("not found", { status: 404 });
      } catch (e: any) {
        return json({ error: e?.message ?? String(e) }, 500);
      }
    },
  });

  // Keep-alive SSE so proxies/browsers don't drop the connection.
  const ping = setInterval(() => {
    const p = encoder.encode(`: ping\n\n`);
    for (const c of [...sseClients]) {
      try { c.enqueue(p); } catch { sseClients.delete(c); }
    }
  }, 25_000);

  return {
    port: server.port,
    stop() { clearInterval(ping); unsub?.(); server.stop(true); },
  };
}

async function handleApi(
  req: Request,
  url: URL,
  path: string,
  deps: LocalServerDeps,
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>,
  wireCloud: () => void,
): Promise<Response> {
  // ── SSE relay ────────────────────────────────────────────────────────────
  if (path === "/api/events" && req.method === "GET") {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; sseClients.add(c); c.enqueue(encoder.encode(`: connected\n\n`)); },
      cancel() { sseClients.delete(ctrl); },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // ── Session / activation (login-by-key) ──────────────────────────────────
  if (path === "/api/session" && req.method === "GET") {
    const cloud = deps.getCloud();
    return json({
      activated: deps.isActivated(),
      cloud: cloud ? cloud.status() : { mode: "none", connected: false, balance: null },
    });
  }
  if (path === "/api/activate" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    await deps.activate(String((body as any).key ?? ""));
    wireCloud(); // after activation a cloud-link appeared — re-subscribe SSE
    return json({ ok: true });
  }
  if (path === "/api/logout" && req.method === "POST") {
    await deps.logout();
    wireCloud();
    return json({ ok: true });
  }

  // ── Public constants for the run form (storefronts + safe defaults) ─
  if (path === "/api/storefronts" && req.method === "GET") {
    return json({ storefronts: STOREFRONTS, defaults: publicDefaults() });
  }

  // Everything below requires an active cloud-link.
  const cloud = deps.getCloud();
  if (!cloud) return json({ error: "not activated" }, 401);

  if (path === "/api/balance" && req.method === "GET") {
    return json(await cloud.getBalance());
  }
  if (path === "/api/models" && req.method === "GET") {
    // Model registry + pricePerKeyphrase (D4 v3) — from the cloud (query kind="models"), NOT hardcoded.
    return json({ models: await cloud.getModels() });
  }
  if (path === "/api/packages" && req.method === "GET") {
    // Top-up catalog — from the cloud (query kind="packages"), NOT hardcoded.
    return json({ packages: await cloud.getPackages() });
  }
  if (path === "/api/topup" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    return json(await cloud.topup(String((body as any).packageId ?? "small")));
  }

  if (path === "/api/runs" && req.method === "GET") {
    return json({ runs: await cloud.listRuns() });
  }
  if (path === "/api/runs" && req.method === "POST") {
    // The UI sends JSON { brief, config } (the file is read in the browser) — no multipart.
    const body = await req.json().catch(() => ({}));
    const brief = String((body as any).brief ?? "");
    const config = (body as any).config ?? {};
    return json(await cloud.createRun(brief, config));
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const sub = runMatch[2] ?? "";

    if (sub === "" && req.method === "GET") return json(await cloud.getRun(runId));
    if (sub === "" && req.method === "DELETE") { await cloud.deleteRun(runId); return json({ ok: true }); }

    if (sub === "/keywords" && req.method === "GET") {
      const q: Record<string, string> = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      delete q.token;
      return json(await cloud.listKeywords(runId, q));
    }
    const kwMatch = sub.match(/^\/keywords\/(.+)$/);
    if (kwMatch && req.method === "GET") {
      return json(await cloud.getKeyword(runId, decodeURIComponent(kwMatch[1])));
    }
    if (sub === "/control" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      await cloud.controlRun(runId, toAction(body));
      return json({ ok: true });
    }
    if (sub === "/llm-log" && req.method === "GET") {
      return json(await cloud.getLlmLog(runId, Number(url.searchParams.get("page") ?? "0")));
    }
  }

  return json({ error: "not found" }, 404);
}

// Build a RunAction from the /control body (UI-compatible: { action, ...payload }).
function toAction(body: any): any {
  const type = body?.action;
  switch (type) {
    case "exclude": return { type: "exclude", keyword: body.keyword };
    case "editContext": {
      const { action, ...patch } = body;
      return { type: "editContext", patch };
    }
    default: return { type };
  }
}

// Safe config defaults: ONLY public @aso/shared constants.
// Formula weights (P/D/Score) and placement weights are the moat — they are NOT here; the server applies its own.
function publicDefaults() {
  return {
    country: "us",
    semanticLanguage: "en",
    sampleSize: 150,
    batchSize: 15,
    exploreRatio: 0.3,
    improvementRounds: 2,
    serpTop: 10,
    model: "claude-haiku-4-5",
    extraLocale: true,
    freshData: false,
    limits: FIELD_LIMITS,
    http: HTTP_DEFAULTS,
    stopwords: DEFAULT_STOPWORDS,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
