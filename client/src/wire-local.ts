// Browser-facing projection shapes for the D1 relay.
//
// The WSS transport now uses the RECONCILED @aso/shared contract directly:
//   ClientToServer `query{query_id, kind, params}`  →  ServerToClient
//   `query.result{query_id, data}` | `query.error{query_id, reason}`.
// The ad-hoc `q.*` messages + `cid` correlation that lived here before are GONE.
//
// What remains here is the agreed SHAPE of `query.result.data` per QueryKind — i.e.
// exactly what the localhost relay hands to the browser for each REST endpoint (D1 /
// BUILD-PLAN §4: "the program does not execute them locally — it translates them into WSS
// and streams the response back"). `data` is typed `unknown` in the contract on purpose; this file is
// the client-side view of what the server puts there. ZERO proprietary logic — these
// only carry already-computed projections (RunSummary/RunState/LlmLogPublic/BalanceView/
// ModelInfo from @aso/shared).
//
// Any shape here that @aso/shared does not yet name authoritatively is flagged in
// client/NOTES.md ("Contract gaps") — do NOT edit @aso/shared from this repo.

import type {
  RunSummary,
  RunState,
  KeywordEntry,
  LlmLogPublic,
  BalanceView,
  ModelInfo,
  TopupCatalog,
  QueryKind,
  KeywordsLiteView,
  CompetitorsView,
  ExportArtifact,
} from "@aso/shared";

/** Paginated keyword list (projection for the UI table). */
export interface KeywordPage {
  total: number;
  page: number;
  pageSize: number;
  items: KeywordEntry[];
}

export interface LlmLogPage {
  total: number;
  page: number;
  items: LlmLogPublic[];
}

/** Progress feed event (human-readable, relayed into SSE). */
export interface FeedEvent {
  ts: string;
  kind: string;
  text: string;
}

/** Full run state for the run screen (matches aso-util GET /api/runs/:id in spirit).
 *  Superset of RunState: + config/events/counters that are absent from the push-only channel and
 *  that the run screen cannot recover from SSE on first load. See NOTES.md gap #2. */
export interface RunSnapshot {
  state: Omit<RunState, "keywords">;
  keywordCount: number;
  sampleCount: number;
  /** [spec 09 §3] Credits actually debited for this run so far (user-facing money). */
  creditsSpent: number;
  config: unknown;
  context: RunState["context"];
  events: FeedEvent[];
  assembly: RunState["assembly"];
}

/** Response for kind="keyword" (single keyword). */
export interface KeywordHit {
  item: KeywordEntry | null;
}

/** Type of `query.result.data` per QueryKind — what the server puts into data and the relay hands to the browser.
 *  The "kind → shape" mapping is a sub-contract (see NOTES.md); @aso/shared leaves data:unknown. */
export interface QueryData {
  runs: RunSummary[];
  run: RunSnapshot;
  keywords: KeywordPage;
  keyword: KeywordHit;
  "llm-log": LlmLogPage;
  balance: BalanceView;
  models: ModelInfo[];
  packages: TopupCatalog;
  // spec 09: insights & exports
  "keywords-lite": KeywordsLiteView;
  competitors: CompetitorsView;
  export: ExportArtifact;
}

// Type-level guarantee: QueryData keys exactly match the contract's QueryKind.
type _AssertKindsCovered = QueryData[QueryKind];
