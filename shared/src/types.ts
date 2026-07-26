// @aso/shared — domain types (shared vocabulary UI ↔ server). Zero-I/O, zero-secret.
// Ported from aso-util/src/types.ts. LlmLogEntry with system/prompt bodies is DELIBERATELY OMITTED —
// they never leave (D9); the client sees only protocol.ts::LlmLogPublic.

export interface RunConfig {
  brand: string;
  country: string;
  semanticLanguage: string;
  language: string;
  sampleSize: number;
  batchSize: number;
  exploreRatio: number;
  improvementRounds: number;
  serpTop: number;
  model: string;
  extraLocale: boolean;
  weights: {
    popularity: { depth: number; rank: number };
    difficulty: { volume: number; quality: number; freshness: number; match: number };
    opportunity: { popularityExp: number; easeExp: number };
  };
  limits: { title: number; subtitle: number; keywords: number };
  http: { requestsPerMinute: number; cacheTtlDays: number; timeoutMs: number; retries: number };
  stopwords: string[];
  freshData?: boolean;
}

export interface BusinessContext {
  productSummary: string;
  category: string;
  jobsToBeDone: string[];
  audience: string;
  featureVocabulary: string[];
  competitors: string[];
  antiSemantics: string;
  targetLanguage: string;
}

export type KeywordStatus =
  | "candidate" | "verified" | "rated" | "selected" | "bench" | "excluded" | "error";
export type KeywordSource = "seed" | "suggest" | "competitor" | "expansion";

export interface TopApp {
  trackId: number;
  trackName: string;
  ratingCount: number;
  rating: number;
  updatedDaysAgo: number;
  match: number;
  strength: number;
}

export interface KeywordMetrics {
  P: number | null;
  L: number | null;
  rank: number | null;
  unsuggested: boolean;
  childCount: number;
  D: number | null;
  serpSize: number | null;
  topApps: TopApp[];
  R: number | null;
  reason: string | null;
  score: number | null;
  brandQuery?: boolean;
  /** Semantic half of R: the prescreen LLM rating (0–3 integer), kept for the audit trail. */
  semR?: number | null;
  /** Measured half of R: positionally-weighted share of top-SERP apps in our niche (0–1). */
  serpFit?: number | null;
}

export interface KeywordEntry {
  keyword: string;
  status: KeywordStatus;
  source: KeywordSource;
  strategy?: "exploit" | "explore";
  type?: string;
  addedAt: string;
  probedAt?: string;
  metrics: KeywordMetrics;
  degraded: boolean;
  error?: string;
  speculative?: boolean;
}

export type RunPhase =
  | "created" | "context" | "context_review" | "seeding"
  | "loop" | "improving" | "assembling" | "done";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  costUsd: number | null;
  byTask: Record<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number | null }>;
}

export interface HttpStats {
  requestsMade: number;
  cacheHits: number;
  throttleWaitMs: number;
}

export interface Violation {
  code: string;
  message: string;
  level: "error" | "warning";
}

export interface AssemblyBucket {
  locale: string;
  titleWords: string[];
  subtitleWords: string[];
  keywordFieldDraft: string;
  title: string | null;
  subtitle: string | null;
  budgets: { titleSloganMax: number; subtitleMax: number; keywordsMax: number };
  speculativeWords: string[];
  violations: Violation[];
}

export interface CoverageRow {
  keyword: string;
  score: number;
  covered: boolean;
  bucket: number | null;
  fields: string[];
  placementWeight: number;
}

export interface AssemblyResult {
  buckets: AssemblyBucket[];
  coverage: {
    phrasesCovered: number;
    scoreCovered: number;
    scoreTotal: number;
    coveredShare: number;
    rows: CoverageRow[];
  };
  topUncovered: { keyword: string; score: number; missingWords: string[] }[];
}

/** Run state projection seen by the UI (in the cloud the source is Postgres). */
export interface RunState {
  runId: string;
  phase: RunPhase;
  paused: boolean;
  failed: string | null;
  notice: string | null;
  hintsEndpointDown: boolean;
  createdAt: string;
  updatedAt: string;
  context: BusinessContext | null;
  keywords: KeywordEntry[];
  usage: UsageTotals;
  http: HttpStats;
  assembly: AssemblyResult | null;
}

export interface RunSummary {
  runId: string;
  /** Owning project (spec 10) — lists scope by it. Travels at the message level, NOT in RunConfig. */
  projectId: string | null;
  brand: string;
  country: string;
  phase: RunPhase;
  paused: boolean;
  failed: string | null;
  sampleCount: number;
  sampleSize: number;
  updatedAt: string;
  usage: { calls: number; totalTokens: number; costUsd: number | null };
  topKeywords: { keyword: string; score: number }[];
}

// ── Projects (spec 10): the app-centric home system ─────────────────────────

export interface MetadataLocaleFields {
  title: string;
  subtitle: string;
  keywords: string;
}

/** One append-only entry of projects.versions. `locales` is a FULL snapshot of every covered
 *  assembly-bucket locale ("en-US", "es-MX", …), not a delta. */
export interface MetadataVersion {
  v: number; // 1-based, monotonic
  ts: string;
  note: string;
  source: { type: "run" | "manual" | "rollback"; runId?: string; fromV?: number };
  locales: Record<string, MetadataLocaleFields>;
}

/** Public shape of a curated market slot (the TABLE itself is server-side; only slots the
 *  server chooses to surface travel in coverage/suggestions). */
export interface MarketSlot {
  locale: string;
  country: string;
  language: string;
  name: string;
  tier: 1 | 2 | 3;
  note: string;
}

export interface ProjectCard {
  id: string;
  name: string;
  brand: string;
  appStoreId: number | null;
  archived: boolean;
  localesCovered: string[];
  bankCount: number;
  lastActivityTs: string;
  runCount: number;
  liveVersion: number | null;
  latestVersion: number | null;
}

export interface ProjectVersionSummary {
  v: number;
  ts: string;
  note: string;
  source: MetadataVersion["source"];
  localeCount: number;
  isLive: boolean;
}

/** One slot of the Overview locale grid: covered → the metadata card; empty MARKET slot →
 *  dimmed with a credits estimate. */
export interface ProjectCoverageSlot {
  locale: string;
  covered: boolean;
  market?: MarketSlot;
  fields?: MetadataLocaleFields;
  sourceRunId?: string;
  staleDays?: number;
  /** quoteFor(150, lastModel) — "≈N cr" on the empty slot. */
  estimateCredits?: number;
}

export interface ProjectSuggestion {
  kind: "link-app" | "apply-run" | "new-locale" | "refresh" | "check-positions";
  title: string;
  detail: string;
  credits?: number;
  /** Routing payload for the UI (go: "settings"|"apply"|"new-run"|"positions" + params). */
  action: Record<string, unknown>;
}

/** Pending apply proposal: a done run produced `final` whose locales were never saved. */
export interface ProjectProposal {
  runId: string;
  ts: string;
  locales: Record<string, MetadataLocaleFields>;
}

export interface ProjectPositionsSummary {
  storefront: string;
  checkedAt: string;
  tracked: number;
  ranked: number;
  top10: number;
}

export interface ProjectView extends ProjectCard {
  createdAt: string;
  context: BusinessContext | null;
  versionsSummary: ProjectVersionSummary[];
  current: MetadataVersion | null;
  coverage: ProjectCoverageSlot[];
  suggestions: ProjectSuggestion[];
  proposals: ProjectProposal[];
  positionsSummary?: ProjectPositionsSummary[];
}

/** Latest metrics snapshot of a bank keyword (spec 10 §1: project_keywords.metrics). */
export interface ProjectBankMetrics {
  P: number | null;
  D: number | null;
  R: number | null;
  score: number | null;
  status: KeywordStatus;
  reason: string | null;
  runId: string;
  ts: string;
}

export interface ProjectBankRow {
  storefront: string;
  language: string;
  keyword: string;
  metrics: ProjectBankMetrics;
  pinned: boolean;
  hidden: boolean;
  firstSeen: string;
  updatedAt: string;
}

export interface ProjectBankPage {
  total: number;
  page: number;
  pageSize: number;
  /** Distinct (storefront, language) pairs present in the bank — filter chips. */
  buckets: Array<{ storefront: string; language: string; count: number }>;
  hiddenCount: number;
  items: ProjectBankRow[];
}

export interface ProjectPositionEntry {
  keyword: string;
  position: number | null;
  serpSize: number | null;
  checkedAt: string;
  /** vs the previous check: positive = moved up; null = new/no previous rank. */
  delta: number | null;
  /** Last 10 checks, newest first (sparkline). */
  history: Array<{ position: number | null; checkedAt: string }>;
}

export interface ProjectPositionsView {
  storefront: string;
  storefronts: string[];
  /** Current tracked set (what "Check now" would measure). */
  tracked: string[];
  checkedAt: string | null;
  items: ProjectPositionEntry[];
  /** Flat per-keyword fee in credits + the estimate for the current tracked set. */
  feePerKeyword: number;
  estimateCredits: number;
}

/** The single write message payload (spec 10 §5) — validated server-side, owner-gated. */
export type ProjectOp =
  | { kind: "create"; name: string; brand: string; appStoreUrl?: string }
  | { kind: "update"; projectId: string; name?: string; brand?: string; appStoreUrl?: string | null }
  | { kind: "updateContext"; projectId: string; context: BusinessContext }
  | {
      kind: "applyMetadata"; projectId: string; runId: string;
      selection: Record<string, { title?: boolean; subtitle?: boolean; keywords?: boolean }>;
      edits?: Record<string, Partial<MetadataLocaleFields>>;
      note?: string;
    }
  | { kind: "editMetadata"; projectId: string; locales: Record<string, MetadataLocaleFields>; note?: string }
  | { kind: "rollback"; projectId: string; toV: number }
  | { kind: "markLive"; projectId: string; v: number }
  | { kind: "bankFlag"; projectId: string; storefront: string; language: string; keyword: string; pinned?: boolean; hidden?: boolean }
  | { kind: "checkPositions"; projectId: string; storefront: string }
  | { kind: "archive"; projectId: string; archived: boolean }
  | { kind: "delete"; projectId: string; confirmName: string };

// Sample counter: rated/selected/bench with R >= 1 (spec 04.1).
export function sampleCount(keywords: KeywordEntry[]): number {
  return keywords.filter(
    (k) =>
      (k.status === "rated" || k.status === "selected" || k.status === "bench") &&
      (k.metrics.R ?? 0) >= 1,
  ).length;
}

// Keyword normalization (spec 03): lowercase → trim → collapse whitespace → NFC.
export function normalizeKeyword(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
}
