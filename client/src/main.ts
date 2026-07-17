// Entrypoint локальной программы (D1/D6): свободный порт, health-check, открыть браузер.
// Управляет жизненным циклом сессии и cloud-link (создаётся после активации ключом).
// Флаги: --port / --no-open / --data-dir. Только 127.0.0.1.
//
// Под Tauri-обёрткой (desktop/) программа запускается как sidecar: хост передаёт
// --port <свободный> --no-open (+ env ASO_LAUNCH_TOKEN), читает из stdout маркер
// готовности `ASOPTIMUS_LISTENING <port>` и грузит этот URL в нативное окно. При выходе
// хост шлёт SIGTERM — ловим и гасим cloud-link/сервер.

import { randomBytes } from "node:crypto";
import { HTTP_DEFAULTS } from "@aso/shared";
import { setDataDir, ensureDirs } from "./paths";
import { AppleHttp } from "./apple/http";
import { activate as activateKey, loadSession, clearSession, type Session } from "./activation";
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
  console.log(`asoptimus — локальная программа (localhost-UI + Apple-fetch по джобам облака)

Поднимает веб-дашборд на http://127.0.0.1:<порт> и открывает браузер.
Активация: введите ключ asop_live_… в UI (или через POST /api/activate).

Флаги:
  --port <n>      порт (дефолт 4317; 0 = случайный свободный)
  --no-open       не открывать браузер (используется десктоп-обёрткой)
  --data-dir <p>  директория данных (дефолт ~/.asoptimus)
  --help          эта справка

Переменные окружения:
  ASO_CLOUD_WSS      WSS-endpoint облака (дефолт wss://api.asoptimus.com/ws)
  ASO_CLOUD_HTTPS    HTTPS-endpoint активации/top-up (дефолт https://api.asoptimus.com)
  ASO_DATA_DIR       альтернатива --data-dir
  ASO_LAUNCH_TOKEN   per-launch guard-токен (D8); если не задан — генерируется
  DEV=1              оффлайн-режим: dev-стаб облака + синтетическая активация (НЕ прод)`);
  process.exit(0);
}

if (args.dataDir) setDataDir(args.dataDir);
ensureDirs();

// Per-launch токен (D8.3) — инъектится в HTML, требуется на всех /api.
// Хост-обёртка может задать его через env (чтобы трей мог опрашивать /api/session).
const launchToken = process.env.ASO_LAUNCH_TOKEN || randomBytes(24).toString("hex");

// Единый HTTP-слой к Apple (троттл per-IP этой машины).
const http = new AppleHttp({
  requestsPerMinute: HTTP_DEFAULTS.requestsPerMinute,
  cacheTtlDays: HTTP_DEFAULTS.cacheTtlDays,
  timeoutMs: HTTP_DEFAULTS.timeoutMs,
  retries: HTTP_DEFAULTS.retries,
});

// Состояние сессии/облака.
let session: Session | null = await loadSession();
let cloud: CloudLink | null = null;

async function bringUpCloud() {
  if (!session) return;
  cloud = makeCloudLink({ session, http });
  await cloud.start();
}
if (session) await bringUpCloud();

// Поднять localhost-сервер (свободный порт).
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
      console.warn(`Порт ${port} занят — беру случайный свободный.`);
      return startLocalServerSafe(0);
    }
    throw e;
  }
}

const address = `http://127.0.0.1:${local.port}`;

// Health-check перед открытием браузера.
let healthy = false;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(address + "/");
    if (res.ok) { healthy = true; break; }
  } catch {
    /* ещё поднимается */
  }
  await new Promise((r) => setTimeout(r, 100));
}

const cloudMode = isDev() && !process.env.ASO_CLOUD_WSS ? "dev-stub (DEV=1)" : `wss → ${wssUrl()}`;
console.log(`asoptimus: дашборд на ${address}${healthy ? "" : " (health-check не прошёл — откройте вручную)"}`);
console.log(`  режим облака: ${cloudMode}${session ? "" : " (поднимется после активации)"}`);
if (!session) console.log(`  не активировано — введите ключ asop_live_… в UI`);

// Стабильный маркер готовности для десктоп-обёртки (парсит порт из stdout sidecar'а).
if (healthy) console.log(`ASOPTIMUS_LISTENING ${local.port}`);

// Под десктоп-обёрткой (ASO_SIDECAR=1) периодически печатаем статус в stdout — трей его
// парсит и рисует «на связи/нет связи» + баланс. Без обёртки (обычный CLI) — молчим.
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
  // Интервал читает текущий cloud каждый тик — покрывает и активацию после старта, и дренаж баланса.
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
    console.log("Не удалось открыть браузер автоматически — откройте адрес вручную.");
  }
}

// Аккуратное завершение: хост-обёртка шлёт SIGTERM при выходе — гасим cloud-link и сервер.
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
