// @aso/shared — WIRE-ПРОТОКОЛ «локальная программа ↔ облако» и «браузер ↔ localhost».
// Это КОНТРАКТ (BUILD-PLAN §4). Zero-I/O, zero-secret. Импортируется и сервером, и клиентом.
// Здесь НЕТ ни формул, ни промптов, ни стратегий — только формы сообщений.

import type { RunState, RunConfig, KeywordEntry } from "./types.ts";

// ── Сырьё Apple (клиент возвращает ЭТО; метрики считает сервер) ──────────────

/** Упорядоченный список строк-подсказок одного запроса hints. Порядок = ранг. */
export type RawHints = string[];

/** Сырой ответ iTunes Search API (как есть, поля берёт сервер). */
export interface RawSerp {
  resultCount: number;
  results: RawSerpApp[];
}
export interface RawSerpApp {
  trackId: number;
  trackName: string;
  averageUserRating?: number;
  userRatingCount?: number;
  currentVersionReleaseDate?: string;
  primaryGenreName?: string;
  genres?: string[];
  artworkUrl100?: string;
  sellerName?: string;
  [k: string]: unknown;
}

// ── Джобы: сервер решает ЧТО фетчить, клиент — КАК (BUILD-PLAN D2) ────────────

export type JobKind = "probe" | "serp" | "hints";

/** Прогон популярности одного кейворда. Клиент: полный-префикс-shortcut → лестница
 *  early-stop → childTerms; возвращает СЫРЬЁ. Сервер считает P/L/rank/childCount/seenTerms
 *  над `prefill ∪ fetched` (BUILD-PLAN D2/D3). */
export interface ProbeJob {
  job_id: string;
  kind: "probe";
  run_id: string;
  keyword: string;
  storefront: number; // X-Apple-Store-Front id
  /** ['k','ke','key',…,keyword] — детерминирован из keyword сервером. */
  prefixLadder: string[];
  /** Префиксы, уже лежащие в общесетевом кэше (с контентом) — для локальной ранней остановки
   *  без сети. Ключ = префикс. Сервер их уже имеет; клиент по сети шлёт только реально фетченные. */
  prefill: Record<string, RawHints>;
  /** [reconcile v2] Кэшированные подсказки на "keyword " (childCount) — если сервер уже имеет их,
   *  клиент НЕ фетчит childTerms. Отсутствует → клиент фетчит сам. */
  childPrefill?: RawHints;
}

/** Один запрос выдачи (для Difficulty). */
export interface SerpJob {
  job_id: string;
  kind: "serp";
  run_id: string;
  query: string;
  storefront: number;
  /** [reconcile v2] 2-буквенный country-код для iTunes Search (`country=`) — сервер кладёт
   *  его сам из конфига; клиент берёт отсюда, а НЕ реверс-мапит storefront id обратно. */
  country: string;
  lang: string;
}

/** Одиночные подсказки для НЕЗАВИСИМЫХ нужд: дети лидеров (hypothesize), alphabet-soup expander.
 *  childCount сюда НЕ входит — он внутри ProbeJob. */
export interface HintsJob {
  job_id: string;
  kind: "hints";
  run_id: string;
  term: string;
  storefront: number;
}

export type Job = ProbeJob | SerpJob | HintsJob;

// ── Результаты джоб (клиент → сервер): всегда СЫРЬЁ, никаких метрик ───────────

export interface ProbeResult {
  job_id: string;
  kind: "probe";
  /** ТОЛЬКО реально фетченные префиксы (полные массивы подсказок), ключ = префикс.
   *  Полные массивы обязательны: сервер харвестит seenTerms в новых кандидатов (D2). */
  fetched: Record<string, RawHints>;
  /** Подсказки на "keyword " (childCount). null если кейворд unsuggested. */
  childTerms: RawHints | null;
  unsuggested: boolean;
}
export interface SerpResult {
  job_id: string;
  kind: "serp";
  raw: RawSerp;
}
export interface HintsResult {
  job_id: string;
  kind: "hints";
  raw: RawHints;
}
export type JobResult = ProbeResult | SerpResult | HintsResult;

// ── WSS: клиент → сервер ─────────────────────────────────────────────────────

export type RunAction =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stopAndAssemble" }
  | { type: "reassemble" }
  | { type: "exclude"; keyword: string }
  | { type: "confirmContext" }
  | { type: "editContext"; patch: Record<string, unknown> }
  | { type: "delete" }; // [reconcile v2]

/** [reconcile v2] Виды on-demand чтений, которые браузер запрашивает у localhost, а программа
 *  релеит в облако запрос-ответом (push-событий недостаточно для больших таблиц/журнала). */
export type QueryKind = "runs" | "run" | "keywords" | "keyword" | "llm-log" | "balance" | "models" | "packages";

export type ClientToServer =
  | { t: "hello"; session_token: string; device_fp: string; resume_job_ids: string[] }
  // [reconcile v2] client_ref — корреляция запроса с ответом run.created (run_id узнаётся в ответе)
  | { t: "run.create"; client_ref: string; brief: string; config: unknown /* RunConfig из types.ts */ }
  | { t: "run.control"; run_id: string; action: RunAction }
  | { t: "job.result"; result: JobResult }
  | { t: "job.error"; job_id: string; reason: string; throttle?: boolean }
  // [reconcile v2] запрос-ответ для браузерных чтений (релеится через localhost, D1)
  | { t: "query"; query_id: string; kind: QueryKind; params?: Record<string, unknown> };

// ── WSS: сервер → клиент ─────────────────────────────────────────────────────

export type ServerToClient =
  | { t: "job.dispatch"; job: Job }
  | { t: "run.progress"; run_id: string; seq: number; event: ProgressEvent }
  | { t: "run.phase"; run_id: string; phase: string; counters: RunCounters }
  | { t: "run.paused"; run_id: string; reason: string; code?: "credits_out" | "provider_error" | "client_offline" | "user" }
  | { t: "balance"; credits: number }
  // [reconcile v2] ack на run.create: связывает client_ref ↔ выданный сервером run_id
  | { t: "run.created"; client_ref: string; run_id: string }
  // [reconcile v2] ответ на query (data — по kind: RunSummary[] | RunState | KeywordEntry[] | LlmLogPublic[] | BalanceView | model[])
  | { t: "query.result"; query_id: string; data: unknown }
  | { t: "query.error"; query_id: string; reason: string };

export interface RunCounters {
  sampleCount: number;
  sampleSize: number;
  requestsMade: number;
  cacheHits: number;
  calls: number;
}

/** Человекочитаемое событие для ленты UI (релеится в браузерный SSE). */
export interface ProgressEvent {
  ts: string;
  kind: string;
  text: string;
}

// ── Браузер ↔ localhost (реле D1). Формы ответов реле-API. ────────────────────
// REST по BUILD-PLAN §4 / spec 07.2: /api/runs, /api/runs/:id[/keywords|/control],
// /api/events(SSE), /api/balance, /api/topup. Программа не исполняет их, а транслирует в WSS.

/** Проекция LLM-журнала ДЛЯ КЛИЕНТА (D9): НЕТ ни system, ни prompt — только выход + числа. */
export interface LlmLogPublic {
  ts: string;
  task: string; // context | seeds | rate | hypothesize | phrase
  model: string;
  /** Человекочитаемое описание стадии (НЕ промпт). */
  stage: string;
  /** Выход модели (R+reason / гипотезы / тексты полей) — это пользователю полезно. */
  output: unknown;
  tokens: { input: number; output: number; cacheRead: number };
  costUsd: number | null;
  durationMs: number;
  error?: string;
}

export interface TopupRequest {
  packageId: string;
}
export interface TopupResponse {
  checkoutUrl: string; // Stripe Checkout, браузер редиректит на домен Stripe
}

export interface BalanceView {
  credits: number;
  ledger: LedgerRow[];
}
export interface LedgerRow {
  ts: string;
  type: "grant" | "debit" | "settle" | "refund" | "chargeback";
  delta: number;
  runId?: string;
}

// ── Reconciliation v2 (сведение gap-листов обоих агентов) ─────────────────────

/** [reconcile v2] Транспортная обёртка WSS-сообщений клиент→сервер: per-message HMAC + защита
 *  от replay (ARCHITECTURE §5). Сервер (auth.verifyMessage) проверяет mac по per-session секрету,
 *  ts в пределах ±5 мин, nonce не переиспользован. body — собственно ClientToServer. */
export interface SignedEnvelope {
  mac: string;
  ts: number;
  nonce: string;
  body: ClientToServer;
}

/** [reconcile v2] HTTPS-лег активации (НЕ WSS): ключ → короткоживущий session-token,
 *  привязанный к устройству. Эндпоинт `POST /activate`. */
export interface ActivateRequest {
  key: string; // asop_live_…
  device_fp: string;
}
export interface ActivateResponse {
  session_token: string;
  expires_at: string;
  /** per-session HMAC-секрет для SignedEnvelope (выдаётся один раз при активации). */
  hmac_secret: string;
}

/** [reconcile v2] Модель в списке для формы прогона (отдаётся сервером через query kind="models"
 *  — клиент НЕ хардкодит список). Цена не показывается в UI обязательно; нужна серверу. */
export interface ModelInfo {
  id: string;
  name: string;
  /** [v3] Цена за одну проверенную кейфразу в кредитах (1 кредит = $1). Мощнее модель → дороже.
   *  Публично (юзер видит в форме прогона); сервер авторитетно пересчитывает квот при reserve. */
  pricePerKeyphrase: number;
  note?: string;
}

/** [v4] ОЦЕНКА стоимости прогона (usage-based, D4). НЕ удержание/резерв: кредиты списываются в
 *  реальном времени по мере появления кейфраз; итог = фактически произведённые кейфразы × цена.
 *  Клиент считает оценку живьём при слайдере sampleSize / смене модели. */
export interface RunQuote {
  sampleSize: number;
  model: string;
  pricePerKeyphrase: number; // кредитов за кейфразу
  quote: number;             // ≈ ceil(sampleSize × pricePerKeyphrase) — ОЦЕНКА, не резерв
  overshootPct: number;      // 0.1 — итог может быть до +10% выше (overshoot ОПЛАЧИВАЕТСЯ)
}

// ── Проекции данных для query.result по kind (reconcile v5) ───────────────────
// Закрывают под-контракт `query.result.data` — что именно приходит на каждый QueryKind.

/** kind="run": надмножество RunState для первой загрузки экрана прогона (push-only SSE не
 *  доставляет config/events/счётчики при первом открытии). */
export interface RunSnapshot extends RunState {
  config: RunConfig;
  events: ProgressEvent[];
  keywordCount: number;
  sampleCount: number;
}

/** kind="keywords": СЕРВЕРНАЯ пагинация/сорт/фильтр (spec 07 — 500+ строк не грузить целиком).
 *  params: {runId, page, pageSize, sort, dir, status, q}. */
export interface KeywordPage {
  total: number;
  page: number;
  pageSize: number;
  items: KeywordEntry[];
}

/** kind="llm-log": пагинация журнала (D9 — только LlmLogPublic, без промптов). */
export interface LlmLogPage {
  total: number;
  page: number;
  items: LlmLogPublic[];
}

/** kind="packages": каталог пополнения (истина — серверный конфиг TOPUP_PACKAGES_JSON).
 *  Клиент НЕ хардкодит пакеты. */
export interface TopupPackage {
  id: string;
  credits: number;  // 1 кредит = $1
  priceUsd: number;
  label?: string;
  bonusPct?: number;
}

// Соответствие query kind → тип data в query.result:
//   runs→RunSummary[] · run→RunSnapshot · keywords→KeywordPage · keyword→{item:KeywordEntry|null}
//   llm-log→LlmLogPage · balance→BalanceView · models→ModelInfo[] · packages→TopupPackage[]
