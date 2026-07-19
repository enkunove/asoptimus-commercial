// @aso/server/db — row types and the storage interface (Store). Implementations: Postgres and
// in-memory (dev fallback). All I/O sits behind this interface — so main.ts starts without a live DB.

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
  delta: number; // credits (fractional; 1 credit = $1)
  type: LedgerType;
  run_id: string | null;
  /** Keyword (D4 v4): one debit row per checked keyphrase; UNIQUE(run_id, keyword). */
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
  /** Model of the attempt (for the D9 LlmLogPublic log). */
  model?: string | null;
  /** Provider call latency, ms (for the D9 log). */
  duration_ms?: number | null;
  ts?: string;
}

export interface RunRow {
  id: string;
  user_id: string;
  phase: string;
  config: RunConfig;
  /** Product brief — needed for event-replay (phaseContext reads it). */
  brief: string;
  /** Estimated run ceiling in credits (D4 v4: ≈ sampleSize × pricePerKeyphrase). NOT a reserve —
   *  holds nothing; serves as the COGS circuit-breaker ceiling. */
  estimate_credits: number;
  context: BusinessContext | null;
  final: AssemblyResult | null;
  usage: UsageTotals | null;
  /** Read projection of state (for getState/listRuns + fallback). The authority for resume is
   *  event-replay from llm_steps/apple_cache/run_events (see orchestrator.replayFromLogs). */
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

/** Unified storage interface. Atomic wallet primitives — for correct billing (D4). */
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

  // wallet (atomic primitives — D4 v4: usage-based, real-time debit)
  getBalance(userId: string): Promise<number>;
  ensureWallet(userId: string, initialCredits: number): Promise<void>;
  /** Atomic (transaction/FOR UPDATE): debit `price` for one keyphrase. Idempotent by
   *  (run_id, keyword). Returns: charged — debited now; alreadyCharged — row already existed;
   *  otherwise (balance < price) — not debited → hard-stop at the caller. Never goes negative. */
  debitForKeyphrase(userId: string, runId: string, keyword: string, price: number): Promise<{ charged: boolean; alreadyCharged: boolean; balance: number }>;
  /** Atomic: grant credits, idempotent by stripe_event_id (grant/top-up). */
  grantCredits(userId: string, credits: number, stripeEventId: string | null): Promise<{ granted: boolean; balance: number }>;

  // ledger (immutable log; read for BalanceView/account)
  listLedger(userId: string, limit?: number): Promise<LedgerRowDb[]>;

  // llm_steps
  insertLlmStep(row: LlmStepRow): Promise<void>;
  nextStepSeq(runId: string): Promise<number>;
  getLastValidStep(runId: string, logicalStep: string): Promise<LlmStepRow | null>;
  /** All attempts of a run (for the D9 LlmLogPublic log — outputs+numbers only, NOT prompts). */
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
