// @aso/shared — доменные типы (общий словарь UI ↔ сервер). Zero-I/O, zero-secret.
// Портировано из aso-util/src/types.ts. НАРОЧНО ОПУЩЕН LlmLogEntry с телами system/prompt —
// наружу они не уходят (D9); клиент видит только protocol.ts::LlmLogPublic.

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

/** Проекция состояния прогона, которую видит UI (в облаке источник — Postgres). */
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

// Счётчик выборки: rated/selected/bench с R >= 1 (spec 04.1).
export function sampleCount(keywords: KeywordEntry[]): number {
  return keywords.filter(
    (k) =>
      (k.status === "rated" || k.status === "selected" || k.status === "bench") &&
      (k.metrics.R ?? 0) >= 1,
  ).length;
}

// Нормализация кейворда (spec 03): lowercase → trim → схлопнуть пробелы → NFC.
export function normalizeKeyword(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
}
