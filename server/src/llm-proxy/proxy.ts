// @aso/server/llm-proxy — сборка промптов (из @aso/core) + вызов Anthropic + метрик КАЖДОЙ
// попытки + step_seq + llm_steps + idempotency-key (BUILD-PLAN D4/D7).
//
// D4 v3: пользователь платит ПО КЕЙФРАЗАМ (reserve/settle на уровне прогона, billing/service).
// Здесь — ВНУТРЕННИЙ per-attempt COGS-учёт: каждая billable-попытка = строка llm_steps с
// usage + cost_usd (маржа мониторится, предохранитель — в оркестраторе). Кошелёк тут НЕ трогаем.
//
// Инварианты:
//  • Валидный результат в llm_steps ДО возврата (advance state) — реплей читает его, а не
//    зовёт провайдера заново (idempotency-key = run_id+step_seq; getLastValidStep).
//  • Списываем СУММУ ВСЕХ попыток в COGS (каждый callOnce = своя строка), не только успешной.
//  • ЛЮБАЯ трата требует живого клиент-коннекта (D7) — через gate().
//  • Реплей-режим (req.replay): нет валидной прошлой попытки → ReplayFrontier (провайдер не зовётся).

import { validateAgainstSchema } from "../core/llm-schemas.ts";
import { costUsdFor } from "../billing/prices.ts";
import type { Store } from "../db/index.ts";
import type { LlmClient, LlmUsage } from "./client.ts";
import { LlmAuthError } from "./client.ts";
import { ReplayFrontier } from "../replay.ts";

export interface LlmProxyRequest {
  runId: string;
  userId: string;
  task: string;
  /** Уникальный id логического шага в рамках прогона (для реплея): "context#1","rate#3",… */
  logicalStep: string;
  system: string;
  contextBlock?: string;
  prompt: string;
  schema: object;
  model: string;
  /** Реплей-режим (D7): использовать только персиснутый результат; иначе ReplayFrontier. */
  replay?: boolean;
}

export interface LlmProxyResult<T = unknown> {
  data: T;
  usage: LlmUsage;
  costUsd: number;
  replayed: boolean;
}

const MAX_ATTEMPTS = 3;

export class LlmProxy {
  constructor(
    private store: Store,
    private client: LlmClient,
    /** Гейт живого клиент-коннекта (D7): бросает, если сессии клиента нет. */
    private gate: (runId: string) => void,
  ) {}

  async complete<T = unknown>(req: LlmProxyRequest): Promise<LlmProxyResult<T>> {
    // Реплей (D7): если логический шаг уже завершён валидной попыткой — вернуть её, НЕ зовя провайдера.
    const prior = await this.store.getLastValidStep(req.runId, req.logicalStep);
    if (prior) {
      return { data: prior.result_json as T, usage: prior.usage, costUsd: prior.cost_usd ?? 0, replayed: true };
    }
    // В реплей-режиме отсутствие персиснутого результата = фронтир durable-истории.
    if (req.replay) throw new ReplayFrontier(`llm ${req.logicalStep}`);

    // ЛЮБАЯ трата требует живого клиента (D7).
    this.gate(req.runId);

    let note = "";
    let valid: { data: T; usage: LlmUsage; cost: number } | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !valid; attempt++) {
      const stepSeq = await this.store.nextStepSeq(req.runId);
      const idempotencyKey = `${req.runId}:${stepSeq}`;
      const prompt = note
        ? `${req.prompt}\n\nПредыдущий ответ не прошёл валидацию схемы:\n${note}\nВерни корректный JSON строго по схеме.`
        : req.prompt;

      const t0 = Date.now();
      let text: string;
      let usage: LlmUsage;
      try {
        const r = await this.client.callOnce({
          task: req.task, model: req.model, system: req.system,
          contextBlock: req.contextBlock, prompt, schema: req.schema, idempotencyKey,
        });
        text = r.text;
        usage = r.usage;
      } catch (e) {
        if (e instanceof LlmAuthError) throw e;
        // D4: неуспешные СЕТЕВЫЕ ретраи не billable — не пишем строку; сетевой ретрай в оркестраторе.
        throw e;
      }
      const durationMs = Date.now() - t0;

      // Внутренний COGS каждой billable-попытки (D4): usage + cost_usd в llm_steps.
      const cost = costUsdFor(req.model, usage);

      let data: unknown = null;
      let ok = false;
      let parseNote = "";
      try {
        data = JSON.parse(text);
        const errors = validateAgainstSchema(data, req.schema);
        if (errors.length > 0) parseNote = errors.slice(0, 10).join("\n");
        else ok = true;
      } catch {
        parseNote = `ответ не является валидным JSON: ${text.slice(0, 200)}`;
      }

      await this.store.insertLlmStep({
        run_id: req.runId,
        logical_step: req.logicalStep,
        step_seq: stepSeq,
        request_hash: idempotencyKey,
        result_json: ok ? data : null,
        valid: ok, // валидный результат персистится ДО advance (D7)
        usage,
        cost_usd: cost,
        model: req.model,
        duration_ms: durationMs,
      });

      if (ok) valid = { data: data as T, usage, cost };
      else note = parseNote;
    }

    if (!valid) throw new Error(`LLM-задача ${req.task} не вернула валидный ответ за ${MAX_ATTEMPTS} попыток`);
    return { data: valid.data, usage: valid.usage, costUsd: valid.cost, replayed: false };
  }
}
