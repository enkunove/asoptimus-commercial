// Entrypoint of the local program (D1/D6): free port, health-check, open the browser.
// Manages the lifecycle of the session and cloud-link (created after key activation).
// Flags: --port / --no-open / --data-dir. 127.0.0.1 only.
//
// Under the Tauri wrapper (desktop/) the program runs as a sidecar: the host passes
// --port <free> --no-open (+ env ASO_LAUNCH_TOKEN), reads the readiness marker
// `ASOPTIMUS_LISTENING <port>` from stdout and loads that URL into a native window. On exit
// the host sends SIGTERM — we catch it and shut down cloud-link/server.

import { randomBytes } from "node:crypto";
import { HTTP_DEFAULTS } from "@aso/shared";
import { setDataDir, ensureDirs } from "./paths";
import { AppleHttp } from "./apple/http";
import { activate as activateKey, loadSession, clearSession, refreshSession, type Session } from "./activation";
import { makeCloudLink, type CloudLink } from "./cloud-link";
import { startLocalServer } from "./localserver";
import { isDev, wssUrl } from "./config";

function parseArgs(argv: string[]) {
  const args = { port: null as number | null, noOpen: false, dataDir: null as string | null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--no-open") args.noOpen = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) args.port = Number(a.slice(7));
    else if (a === "--data-dir") args.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) args.dataDir = a.slice(11);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`asoptimus — local program (localhost UI + Apple fetch driven by cloud jobs)

Brings up a web dashboard on http://127.0.0.1:<port> and opens the browser.
Activation: enter an asop_live_… key in the UI (or via POST /api/activate).

Flags:
  --port <n>      port (default 4317; 0 = random free port)
  --no-open       don't open the browser (used by the desktop wrapper)
  --data-dir <p>  data directory (default ~/.asoptimus)
  --help          this help

Environment variables:
  ASO_CLOUD_WSS      cloud WSS endpoint (default wss://api.asoptimus.com/ws)
  ASO_CLOUD_HTTPS    activation/top-up HTTPS endpoint (default https://api.asoptimus.com)
  ASO_DATA_DIR       alternative to --data-dir
  ASO_LAUNCH_TOKEN   per-launch guard token (D8); generated if not set
  DEV=1              offline mode: dev cloud stub + synthetic activation (NOT prod)`);
  process.exit(0);
}

if (args.dataDir) setDataDir(args.dataDir);
ensureDirs();

// Per-launch token (D8.3) — injected into the HTML, required on all /api.
// The host wrapper may set it via env (so the tray can poll /api/session).
const launchToken = process.env.ASO_LAUNCH_TOKEN || randomBytes(24).toString("hex");

// Single HTTP layer to Apple (per-IP throttle for this machine).
const http = new AppleHttp({
  requestsPerMinute: HTTP_DEFAULTS.requestsPerMinute,
  cacheTtlDays: HTTP_DEFAULTS.cacheTtlDays,
  timeoutMs: HTTP_DEFAULTS.timeoutMs,
  retries: HTTP_DEFAULTS.retries,
});

// Session/cloud state.
let session: Session | null = await loadSession();
let cloud: CloudLink | null = null;

async function bringUpCloud() {
  if (!session) return;
  cloud = makeCloudLink({ session, http });
  await cloud.start();
}
if (session) await bringUpCloud();

// Session auto-refresh: cloud tokens live 12h — without rotation every user was logged out
// twice a day. Rotate when under 4h remain, then reconnect the WSS with the fresh token
// (rotation kills the old one). A failed rotation (expired/revoked) just lets the session
// die — the UI falls back to key activation.
const REFRESH_CHECK_MS = 15 * 60 * 1000;
async function maybeRefreshSession() {
  if (!session || !session.expiresAt) return;
  const left = Date.parse(session.expiresAt) - Date.now();
  if (Number.isFinite(left) && left > 4 * 3600 * 1000) return;
  const next = await refreshSession(session);
  if (next && next !== session) {
    session = next;
    try { cloud?.stop(); } catch { /* ignore */ }
    await bringUpCloud();
  }
}
setInterval(() => { void maybeRefreshSession(); }, REFRESH_CHECK_MS);
void maybeRefreshSession(); // an almost-expired stored session gets rotated right at startup

// Bring up the localhost server (free port).
const requested = args.port ?? 4317;
const local = startLocalServerSafe(requested);

function startLocalServerSafe(port: number) {
  try {
    return startLocalServer({
      port,
      token: launchToken,
      getCloud: () => cloud,
      isActivated: () => session !== null,
      activate: async (key: string) => {
        session = await activateKey(key);
        await bringUpCloud();
      },
      logout: async () => {
        cloud?.stop();
        await clearSession();
        session = null;
        cloud = null;
      },
    });
  } catch (e) {
    if (port !== 0) {
      console.warn(`Port ${port} is taken — picking a random free one.`);
      return startLocalServerSafe(0);
    }
    throw e;
  }
}

const address = `http://127.0.0.1:${local.port}`;

// Health-check before opening the browser.
let healthy = false;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(address + "/");
    if (res.ok) { healthy = true; break; }
  } catch {
    /* still coming up */
  }
  await new Promise((r) => setTimeout(r, 100));
}

const cloudMode = isDev() && !process.env.ASO_CLOUD_WSS ? "dev-stub (DEV=1)" : `wss → ${wssUrl()}`;
console.log(`asoptimus: dashboard at ${address}${healthy ? "" : " (health-check failed — open it manually)"}`);
console.log(`  cloud mode: ${cloudMode}${session ? "" : " (will come up after activation)"}`);
if (!session) console.log(`  not activated — enter an asop_live_… key in the UI`);

// Stable readiness marker for the desktop wrapper (it parses the port from the sidecar's stdout).
if (healthy) console.log(`ASOPTIMUS_LISTENING ${local.port}`);

// Under the desktop wrapper (ASO_SIDECAR=1) we periodically print status to stdout — the tray
// parses it and renders "connected/disconnected" + balance. Without the wrapper (plain CLI) — stay silent.
if (process.env.ASO_SIDECAR === "1") {
  const emitStatus = () => {
    const st = cloud?.status();
    const line = JSON.stringify({
      activated: session !== null,
      connected: st?.connected ?? false,
      balance: st?.balance ?? null,
    });
    console.log(`ASOPTIMUS_STATUS ${line}`);
  };
  emitStatus();
  // The interval reads the current cloud each tick — covers both post-start activation and balance drain.
  const statusTimer = setInterval(emitStatus, 3000);
  process.on("exit", () => clearInterval(statusTimer));
}

if (!args.noOpen && healthy) {
  const cmd =
    process.platform === "darwin" ? ["open", address]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", address]
    : ["xdg-open", address];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log("Could not open the browser automatically — open the address manually.");
  }
}

// Graceful shutdown: the host wrapper sends SIGTERM on exit — shut down cloud-link and the server.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { cloud?.stop(); } catch { /* ignore */ }
  try { local.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
