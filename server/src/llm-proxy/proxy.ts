// @aso/server/llm-proxy — prompt assembly (from @aso/core) + Anthropic call + metering of EVERY
// attempt + step_seq + llm_steps + idempotency-key (BUILD-PLAN D4/D7).
//
// D4 v3: the user pays PER KEYPHRASE (reserve/settle at the run level, billing/service).
// Here — INTERNAL per-attempt COGS accounting: every billable attempt = an llm_steps row with
// usage + cost_usd (margin is monitored; the circuit breaker lives in the orchestrator). The
// wallet is NOT touched here.
//
// Invariants:
//  • The valid result is in llm_steps BEFORE returning (advance state) — replay reads it instead
//    of calling the provider again (idempotency-key = run_id+step_seq; getLastValidStep).
//  • COGS charges the SUM OF ALL attempts (each callOnce = its own row), not just the successful one.
//  • ANY spend requires a live client connection (D7) — via gate().
//  • Replay mode (req.replay): no valid prior attempt → ReplayFrontier (provider is not called).

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
  /** Unique id of the logical step within a run (for replay): "context#1","rate#3",… */
  logicalStep: string;
  system: string;
  contextBlock?: string;
  prompt: string;
  schema: object;
  model: string;
  /** Replay mode (D7): use only the persisted result; otherwise ReplayFrontier. */
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
    /** Live client-connection gate (D7): throws if there is no client session. */
    private gate: (runId: string) => void,
  ) {}

  async complete<T = unknown>(req: LlmProxyRequest): Promise<LlmProxyResult<T>> {
    // Replay (D7): if the logical step already finished with a valid attempt — return it, WITHOUT calling the provider.
    const prior = await this.store.getLastValidStep(req.runId, req.logicalStep);
    if (prior) {
      return { data: prior.result_json as T, usage: prior.usage, costUsd: prior.cost_usd ?? 0, replayed: true };
    }
    // In replay mode a missing persisted result = the frontier of durable history.
    if (req.replay) throw new ReplayFrontier(`llm ${req.logicalStep}`);

    // ANY spend requires a live client (D7).
    this.gate(req.runId);

    let note = "";
    let valid: { data: T; usage: LlmUsage; cost: number } | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !valid; attempt++) {
      const stepSeq = await this.store.nextStepSeq(req.runId);
      const idempotencyKey = `${req.runId}:${stepSeq}`;
      const prompt = note
        ? `${req.prompt}\n\nThe previous response failed schema validation:\n${note}\nReturn correct JSON strictly matching the schema.`
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
        // D4: failed NETWORK retries are not billable — no row written; network retry is in the orchestrator.
        throw e;
      }
      const durationMs = Date.now() - t0;

      // Internal COGS of every billable attempt (D4): usage + cost_usd in llm_steps.
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
        parseNote = `response is not valid JSON: ${text.slice(0, 200)}`;
      }

      await this.store.insertLlmStep({
        run_id: req.runId,
        logical_step: req.logicalStep,
        step_seq: stepSeq,
        request_hash: idempotencyKey,
        result_json: ok ? data : null,
        valid: ok, // the valid result is persisted BEFORE advance (D7)
        usage,
        cost_usd: cost,
        model: req.model,
        duration_ms: durationMs,
      });

      if (ok) valid = { data: data as T, usage, cost };
      else note = parseNote;
    }

    if (!valid) throw new Error(`LLM task ${req.task} did not return a valid response in ${MAX_ATTEMPTS} attempts`);
    return { data: valid.data, usage: valid.usage, costUsd: valid.cost, replayed: false };
  }
}
