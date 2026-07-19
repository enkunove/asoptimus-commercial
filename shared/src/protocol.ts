// @aso/shared — WIRE PROTOCOL "local program ↔ cloud" and "browser ↔ localhost".
// This is the CONTRACT (BUILD-PLAN §4). Zero-I/O, zero-secret. Imported by both server and client.
// There are NO formulas, NO prompts, NO strategies here — only message shapes.

import type { RunState, RunConfig, KeywordEntry } from "./types.ts";

// ── Raw Apple data (the client returns THIS; the server computes the metrics) ──────────────

/** Ordered list of hint strings from one hints request. Order = rank. */
export type RawHints = string[];

/** Raw iTunes Search API response (as-is; the server picks the fields). */
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

// ── Jobs: the server decides WHAT to fetch, the client decides HOW (BUILD-PLAN D2) ────────────

export type JobKind = "probe" | "serp" | "hints";

/** Popularity run of one keyword. Client: full-prefix shortcut → early-stop
 *  ladder → childTerms; returns RAW material. The server computes P/L/rank/childCount/seenTerms
 *  over `prefill ∪ fetched` (BUILD-PLAN D2/D3). */
export interface ProbeJob {
  job_id: string;
  kind: "probe";
  run_id: string;
  keyword: string;
  storefront: number; // X-Apple-Store-Front id
  /** ['k','ke','key',…,keyword] — deterministically derived from keyword by the server. */
  prefixLadder: string[];
  /** Prefixes already present in the network-wide cache (with content) — for local early stop
   *  without network. Key = prefix. The server already has these; over the wire the client sends only what it actually fetched. */
  prefill: Record<string, RawHints>;
  /** [reconcile v2] Cached hints for "keyword " (childCount) — if the server already has them,
   *  the client does NOT fetch childTerms. Absent → the client fetches on its own. */
  childPrefill?: RawHints;
}

/** One SERP request (for Difficulty). */
export interface SerpJob {
  job_id: string;
  kind: "serp";
  run_id: string;
  query: string;
  storefront: number;
  /** [reconcile v2] 2-letter country code for iTunes Search (`country=`) — the server sets it
   *  from the config; the client takes it from here and does NOT reverse-map the storefront id. */
  country: string;
  lang: string;
}

/** Standalone hints for INDEPENDENT needs: leaders' children (hypothesize), alphabet-soup expander.
 *  childCount is NOT included here — it lives inside ProbeJob. */
export interface HintsJob {
  job_id: string;
  kind: "hints";
  run_id: string;
  term: string;
  storefront: number;
}

export type Job = ProbeJob | SerpJob | HintsJob;

// ── Job results (client → server): always RAW material, no metrics ───────────

export interface ProbeResult {
  job_id: string;
  kind: "probe";
  /** ONLY the actually fetched prefixes (full hint arrays), key = prefix.
   *  Full arrays are mandatory: the server harvests seenTerms into new candidates (D2). */
  fetched: Record<string, RawHints>;
  /** Hints for "keyword " (childCount). null if the keyword is unsuggested. */
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

// ── WSS: client → server ─────────────────────────────────────────────────────

export type RunAction =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stopAndAssemble" }
  | { type: "reassemble" }
  | { type: "exclude"; keyword: string }
  | { type: "confirmContext" }
  | { type: "editContext"; patch: Record<string, unknown> }
  | { type: "delete" }; // [reconcile v2]

/** [reconcile v2] Kinds of on-demand reads the browser requests from localhost, and the program
 *  relays into the cloud as request-response (push events are not enough for large tables/logs). */
export type QueryKind = "runs" | "run" | "keywords" | "keyword" | "llm-log" | "balance" | "models" | "packages";

export type ClientToServer =
  | { t: "hello"; session_token: string; device_fp: string; resume_job_ids: string[] }
  // [reconcile v2] client_ref — correlates the request with the run.created reply (run_id learned from the reply)
  | { t: "run.create"; client_ref: string; brief: string; config: unknown /* RunConfig from types.ts */ }
  | { t: "run.control"; run_id: string; action: RunAction }
  | { t: "job.result"; result: JobResult }
  | { t: "job.error"; job_id: string; reason: string; throttle?: boolean }
  // [reconcile v2] request-response for browser reads (relayed through localhost, D1)
  | { t: "query"; query_id: string; kind: QueryKind; params?: Record<string, unknown> };

// ── WSS: server → client ─────────────────────────────────────────────────────

export type ServerToClient =
  | { t: "job.dispatch"; job: Job }
  | { t: "run.progress"; run_id: string; seq: number; event: ProgressEvent }
  | { t: "run.phase"; run_id: string; phase: string; counters: RunCounters }
  | { t: "run.paused"; run_id: string; reason: string; code?: "credits_out" | "provider_error" | "client_offline" | "user" }
  | { t: "balance"; credits: number }
  // [reconcile v2] ack for run.create: links client_ref ↔ the server-issued run_id
  | { t: "run.created"; client_ref: string; run_id: string }
  // [reconcile v2] reply to query (data — by kind: RunSummary[] | RunState | KeywordEntry[] | LlmLogPublic[] | BalanceView | model[])
  | { t: "query.result"; query_id: string; data: unknown }
  | { t: "query.error"; query_id: string; reason: string };

export interface RunCounters {
  sampleCount: number;
  sampleSize: number;
  requestsMade: number;
  cacheHits: number;
  calls: number;
}

/** Human-readable event for the UI feed (relayed into browser SSE). */
export interface ProgressEvent {
  ts: string;
  kind: string;
  text: string;
}

// ── Browser ↔ localhost (D1 relay). Relay-API response shapes. ────────────────────
// REST per BUILD-PLAN §4 / spec 07.2: /api/runs, /api/runs/:id[/keywords|/control],
// /api/events(SSE), /api/balance, /api/topup. The program does not execute them — it translates them into WSS.

/** LLM log projection FOR THE CLIENT (D9): NO system, NO prompt — only the output + numbers. */
export interface LlmLogPublic {
  ts: string;
  task: string; // context | seeds | rate | hypothesize | phrase
  model: string;
  /** Human-readable stage description (NOT a prompt). */
  stage: string;
  /** Model output (R+reason / hypotheses / field texts) — this is useful to the user. */
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
  checkoutUrl: string; // Stripe Checkout, the browser redirects to the Stripe domain
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

// ── Reconciliation v2 (merging both agents' gap lists) ─────────────────────

/** [reconcile v2] Transport wrapper for client→server WSS messages: per-message HMAC + replay
 *  protection (ARCHITECTURE §5). The server (auth.verifyMessage) verifies mac against the per-session secret,
 *  ts within ±5 min, nonce not reused. body — the actual ClientToServer. */
export interface SignedEnvelope {
  mac: string;
  ts: number;
  nonce: string;
  body: ClientToServer;
}

/** [reconcile v2] HTTPS activation leg (NOT WSS): key → short-lived session-token
 *  bound to the device. Endpoint `POST /activate`. */
export interface ActivateRequest {
  key: string; // asop_live_…
  device_fp: string;
}
export interface ActivateResponse {
  session_token: string;
  expires_at: string;
  /** per-session HMAC secret for SignedEnvelope (issued once at activation). */
  hmac_secret: string;
}

/** [reconcile v2] Model in the run-form list (served by the server via query kind="models"
 *  — the client does NOT hardcode the list). Price need not be shown in the UI; the server needs it. */
export interface ModelInfo {
  id: string;
  name: string;
  /** [v3] Price per one probed keyphrase in credits (1 credit = $1). More powerful model → more expensive.
   *  Public (the user sees it in the run form); the server authoritatively recomputes quotas at reserve. */
  pricePerKeyphrase: number;
  note?: string;
}

/** [v4] Run cost ESTIMATE (usage-based, D4). NOT a hold/reserve: credits are debited in
 *  real time as keyphrases are produced; the total = actually produced keyphrases × price.
 *  The client computes the estimate live on the sampleSize slider / model change. */
export interface RunQuote {
  sampleSize: number;
  model: string;
  pricePerKeyphrase: number; // credits per keyphrase
  quote: number;             // ≈ ceil(sampleSize × pricePerKeyphrase) — an ESTIMATE, not a reserve
  overshootPct: number;      // 0.1 — the total may be up to +10% higher (overshoot IS BILLED)
}

// ── Data projections for query.result by kind (reconcile v5) ───────────────────
// Close the `query.result.data` sub-contract — exactly what arrives for each QueryKind.

/** kind="run": everything the run screen needs on first load (push-only SSE does not
 *  deliver config/events/counters on first open). `state` carries RunState minus the keyword
 *  list (kind="keywords" pages it server-side); context/assembly are surfaced top-level
 *  for the UI, which reads them directly. */
export interface RunSnapshot {
  state: Omit<RunState, "keywords">;
  config: RunConfig;
  context: RunState["context"];
  events: ProgressEvent[];
  assembly: RunState["assembly"];
  keywordCount: number;
  sampleCount: number;
}

/** kind="keywords": SERVER-SIDE pagination/sort/filter (spec 07 — don't load 500+ rows wholesale).
 *  params: {runId, page, pageSize, sort, dir, status, q}. */
export interface KeywordPage {
  total: number;
  page: number;
  pageSize: number;
  items: KeywordEntry[];
}

/** kind="llm-log": log pagination (D9 — LlmLogPublic only, no prompts). */
export interface LlmLogPage {
  total: number;
  page: number;
  items: LlmLogPublic[];
}

/** kind="packages": top-up catalog (source of truth — the server config TOPUP_PACKAGES_JSON).
 *  The client does NOT hardcode packages. */
export interface TopupPackage {
  id: string;
  credits: number;  // 1 credit = $1
  priceUsd: number;
  label?: string;
  bonusPct?: number;
}

// Mapping of query kind → data type in query.result:
//   runs→RunSummary[] · run→RunSnapshot · keywords→KeywordPage · keyword→{item:KeywordEntry|null}
//   llm-log→LlmLogPage · balance→BalanceView · models→ModelInfo[] · packages→TopupPackage[]
