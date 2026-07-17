// @aso/server/orchestrator — внутреннее (богатое) состояние прогона. Шире, чем проекция
// @aso/shared::RunState (та — то, что видит UI). Внутренние поля (rejected/expansion/
// improvementState) — как в aso-util RunState, но живут в приватном репо server.

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
  /** Монотонные счётчики логических шагов (для реплей-id llm_steps). */
  stepCounters: Record<string, number>;
  /** Оценочный потолок прогона в кредитах (D4 v4): ≈ sampleSize × pricePerKeyphrase. Потолок
   *  предохранителя COGS; НЕ резерв (usage-based списание — в реальном времени). */
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

/** Проекция для UI (@aso/shared::RunState). Внутренние moat-поля наружу не идут. */
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
    // HTTP-статы Apple живут на клиенте (он делает fetch); сервер их не ведёт. Прогресс
    // выборки/кэша идёт отдельным сообщением run.phase (RunCounters), не через эти поля.
    http: { requestsMade: 0, cacheHits: 0, throttleWaitMs: 0 },
    assembly: s.assembly,
  };
}

export { sampleCount };
