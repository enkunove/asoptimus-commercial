// @aso/server/db — типы строк и интерфейс хранилища (Store). Реализации: Postgres и
// in-memory (dev-fallback). Всё I/O за этим интерфейсом — так main.ts стартует без живой БД.

import type { RunConfig, BusinessContext, AssemblyResult, UsageTotals } from "@aso/shared";
import type { JobKind, Job, JobResult, ProgressEvent } from "@aso/shared";

export interface UserRow {
  id: string;
  email: string;
  stripe_customer_id: string | null;
}

export interface LicenseRow {
  key_hash: string;
  user_id: string;
  device_fp: string | null;
  status: "active" | "revoked";
  revoked_at: string | null;
}

export type LedgerType = "grant" | "debit" | "settle" | "refund" | "chargeback";
export interface LedgerRowDb {
  id?: number;
  user_id: string;
  delta: number; // кредиты (фракционные; 1 кредит = $1)
  type: LedgerType;
  run_id: string | null;
  /** Кейворд (D4 v4): по строке debit на каждую проверенную кейфразу; UNIQUE(run_id, keyword). */
  keyword: string | null;
  step_seq: number | null;
  stripe_event_id: string | null;
  ts?: string;
}

export interface LlmStepRow {
  run_id: string;
  logical_step: string;
  step_seq: number;
  request_hash: string;
  result_json: unknown | null;
  valid: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  cost_usd: number | null;
  /** Модель попытки (для D9-журнала LlmLogPublic). */
  model?: string | null;
  /** Латентность вызова провайдера, мс (для D9-журнала). */
  duration_ms?: number | null;
  ts?: string;
}

export interface RunRow {
  id: string;
  user_id: string;
  phase: string;
  config: RunConfig;
  /** Бриф продукта — нужен для event-replay (phaseContext читает его). */
  brief: string;
  /** Оценочный потолок прогона в кредитах (D4 v4: ≈ sampleSize × pricePerKeyphrase). НЕ резерв —
   *  ничего не удерживает; служит потолком предохранителя COGS. */
  estimate_credits: number;
  context: BusinessContext | null;
  final: AssemblyResult | null;
  usage: UsageTotals | null;
  /** Read-проекция состояния (для getState/listRuns + fallback). Авторитет по resume —
   *  event-replay из llm_steps/apple_cache/run_events (см. orchestrator.replayFromLogs). */
  state: unknown | null;
  updated_at?: string;
}

export interface RunEventRow {
  run_id: string;
  seq: number;
  ts: string;
  event: ProgressEvent;
}

export interface JobRow {
  job_id: string;
  run_id: string;
  kind: JobKind;
  payload: Job;
  status: "pending" | "dispatched" | "done" | "error";
  result: JobResult | null;
  deadline: string | null;
}

export interface AppleCacheRow {
  cache_key: string;
  url: string;
  storefront: number;
  status: number;
  body: unknown;
  fetched_at: string;
}

/** Единый интерфейс хранилища. Атомарные примитивы кошелька — для корректного биллинга (D4). */
export interface Store {
  // users
  createUser(u: UserRow): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  getUserByStripeCustomer(customerId: string): Promise<UserRow | null>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;

  // licenses
  createLicense(l: LicenseRow): Promise<void>;
  getLicenseByKeyHash(keyHash: string): Promise<LicenseRow | null>;
  bindDevice(keyHash: string, deviceFp: string): Promise<void>;
  revokeLicense(keyHash: string): Promise<void>;

  // wallet (атомарные примитивы — D4 v4: usage-based, списание в реальном времени)
  getBalance(userId: string): Promise<number>;
  ensureWallet(userId: string, initialCredits: number): Promise<void>;
  /** Атомарно (транзакция/FOR UPDATE): списать `price` за одну кейфразу. Идемпотентно по
   *  (run_id, keyword). Возврат: charged — списали сейчас; alreadyCharged — уже была; иначе
   *  (баланс < price) — не списано → hard-stop у вызывающего. В минус не уходит. */
  debitForKeyphrase(userId: string, runId: string, keyword: string, price: number): Promise<{ charged: boolean; alreadyCharged: boolean; balance: number }>;
  /** Атомарно: начислить credits, идемпотентно по stripe_event_id (grant/top-up). */
  grantCredits(userId: string, credits: number, stripeEventId: string | null): Promise<{ granted: boolean; balance: number }>;

  // ledger (иммутабельный журнал; чтение для BalanceView/аккаунта)
  listLedger(userId: string, limit?: number): Promise<LedgerRowDb[]>;

  // llm_steps
  insertLlmStep(row: LlmStepRow): Promise<void>;
  nextStepSeq(runId: string): Promise<number>;
  getLastValidStep(runId: string, logicalStep: string): Promise<LlmStepRow | null>;
  /** Все попытки прогона (для D9-журнала LlmLogPublic — только выходы+числа, НЕ промпты). */
  listLlmSteps(runId: string): Promise<LlmStepRow[]>;

  // processed_events (Stripe idempotency)
  tryMarkProcessed(eventId: string): Promise<boolean>;

  // runs
  createRun(r: RunRow): Promise<void>;
  getRun(id: string): Promise<RunRow | null>;
  updateRun(r: Partial<RunRow> & { id: string }): Promise<void>;
  listRunsByUser(userId: string): Promise<RunRow[]>;

  // run_events (event-sourced)
  appendRunEvent(runId: string, event: ProgressEvent): Promise<number>;
  listRunEvents(runId: string, afterSeq?: number): Promise<RunEventRow[]>;

  // jobs
  insertJob(job: JobRow): Promise<void>;
  updateJob(jobId: string, patch: Partial<JobRow>): Promise<void>;
  getJob(jobId: string): Promise<JobRow | null>;

  // apple_cache (D3)
  getCache(cacheKey: string): Promise<AppleCacheRow | null>;
  putCache(row: AppleCacheRow): Promise<void>;

  close(): Promise<void>;
}
