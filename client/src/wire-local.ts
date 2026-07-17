// Browser-facing projection shapes for the D1 relay.
//
// The WSS transport now uses the RECONCILED @aso/shared contract directly:
//   ClientToServer `query{query_id, kind, params}`  →  ServerToClient
//   `query.result{query_id, data}` | `query.error{query_id, reason}`.
// The ad-hoc `q.*` messages + `cid` correlation that lived here before are GONE.
//
// What remains here is the agreed SHAPE of `query.result.data` per QueryKind — i.e.
// exactly what the localhost relay hands to the browser for each REST endpoint (D1 /
// BUILD-PLAN §4: "программа не исполняет их локально, а транслирует в WSS и стримит
// ответ обратно"). `data` is typed `unknown` in the contract on purpose; this file is
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
  TopupPackage,
  QueryKind,
} from "@aso/shared";

/** Пагинированный список кейвордов (проекция для таблицы UI). */
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

/** Событие ленты прогресса (человекочитаемое, релеится в SSE). */
export interface FeedEvent {
  ts: string;
  kind: string;
  text: string;
}

/** Полное состояние прогона для экрана прогона (совпадает по духу с aso-util GET /api/runs/:id).
 *  Надмножество RunState: + config/events/счётчики, которых нет в push-only канале и которые
 *  экран прогона не может добрать из SSE при первой загрузке. См. NOTES.md gap #2. */
export interface RunSnapshot {
  state: Omit<RunState, "keywords">;
  keywordCount: number;
  sampleCount: number;
  config: unknown;
  context: RunState["context"];
  events: FeedEvent[];
  assembly: RunState["assembly"];
}

/** Ответ на kind="keyword" (одиночный кейворд). */
export interface KeywordHit {
  item: KeywordEntry | null;
}

/** Тип `query.result.data` по QueryKind — то, что сервер кладёт в data, а реле отдаёт браузеру.
 *  Соответствие «kind → форма» — это под-контракт (см. NOTES.md); @aso/shared оставляет data:unknown. */
export interface QueryData {
  runs: RunSummary[];
  run: RunSnapshot;
  keywords: KeywordPage;
  keyword: KeywordHit;
  "llm-log": LlmLogPage;
  balance: BalanceView;
  models: ModelInfo[];
  packages: TopupPackage[];
}

// Гарантия на уровне типов: ключи QueryData ровно совпадают с QueryKind контракта.
type _AssertKindsCovered = QueryData[QueryKind];
