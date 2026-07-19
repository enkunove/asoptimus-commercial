// @aso/server/orchestrator — internal (rich) run state. Wider than the @aso/shared::RunState
// projection (which is what the UI sees). Internal fields (rejected/expansion/
// improvementState) match aso-util RunState but live in the private server repo.

import type {
  RunConfig, BusinessContext, KeywordEntry, RunPhase, UsageTotals, AssemblyResult, RunState,
} from "@aso/shared";
import { sampleCount } from "@aso/shared";

export interface ServerRunState {
  runId: string;
  userId: string;
  phase: RunPhase;
  paused: boolean;
  failed: string | null;
  notice: string | null;
  hintsEndpointDown: boolean;
  createdAt: string;
  updatedAt: string;
  brief: string;
  config: RunConfig;
  context: BusinessContext | null;
  keywords: KeywordEntry[];
  rejected: string[];
  expansion: { done: Record<string, string[]>; roots: string[]; pending: string[]; improvingWaves?: number };
  usage: UsageTotals;
  assembly: AssemblyResult | null;
  improvementState: { roundsSpent: number; topSnapshot: string[] };
  /** Monotonic logical-step counters (for llm_steps replay ids). */
  stepCounters: Record<string, number>;
  /** Estimated run ceiling in credits (D4 v4): ≈ sampleSize × pricePerKeyphrase. Ceiling for
   *  the COGS fuse; NOT a reserve (usage-based debit happens in real time). */
  estimateCredits: number;
}

export function newUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, costUsd: null, byTask: {} };
}

export function initialState(runId: string, userId: string, brief: string, config: RunConfig, estimateCredits = 0): ServerRunState {
  const now = new Date().toISOString();
  return {
    runId, userId, phase: "created", paused: false, failed: null, notice: null,
    hintsEndpointDown: false, createdAt: now, updatedAt: now, brief, config,
    context: null, keywords: [], rejected: [],
    expansion: { done: {}, roots: [], pending: [] },
    usage: newUsage(), assembly: null,
    improvementState: { roundsSpent: 0, topSnapshot: [] },
    stepCounters: {},
    estimateCredits,
  };
}

/** Projection for the UI (@aso/shared::RunState). Internal moat fields do not go out. */
export function projectRunState(s: ServerRunState): RunState {
  return {
    runId: s.runId,
    phase: s.phase,
    paused: s.paused,
    failed: s.failed,
    notice: s.notice,
    hintsEndpointDown: s.hintsEndpointDown,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    context: s.context,
    keywords: s.keywords,
    usage: s.usage,
    // Apple HTTP stats live on the client (it does the fetching); the server does not track them.
    // Sample/cache progress goes via a separate run.phase message (RunCounters), not these fields.
    http: { requestsMade: 0, cacheHits: 0, throttleWaitMs: 0 },
    assembly: s.assembly,
  };
}

export { sampleCount };
