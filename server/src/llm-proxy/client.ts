// @aso/server/llm-proxy — интерфейс LLM-клиента: ОДНА billable-попытка = один callOnce.
// Schema-валидация и ретраи — в proxy.ts (чтобы метрить КАЖДУЮ попытку, D4). Клиент лишь
// делает один вызов провайдера и возвращает сырой текст + usage.

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CallOnceRequest {
  task: string;
  model: string;
  system: string;
  /** Стабильный блок бизнес-контекста — второй кэш-брейкпоинт (spec 06.2). */
  contextBlock?: string;
  prompt: string;
  schema: object;
  /** run_id+step_seq — idempotency key провайдера (D7): рестарт посреди вызова не двоит COGS. */
  idempotencyKey: string;
}

export interface CallOnceResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmClient {
  /** Один вызов провайдера (одна billable-попытка). Бросает при сетевой/авторизационной ошибке. */
  callOnce(req: CallOnceRequest): Promise<CallOnceResult>;
  readonly kind: "anthropic" | "mock";
}

export class LlmAuthError extends Error {}

import { IS_DEV, ProdConfigError } from "../env.ts";
import { log } from "../log.ts";

export function createLlmClient(): LlmClient {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && key.trim()) {
    const { AnthropicClient } = require("./anthropic.ts");
    log.info("[llm] AnthropicClient", { source: "ANTHROPIC_API_KEY" });
    return new AnthropicClient(key.trim());
  }
  if (IS_DEV) {
    const { MockLlmClient } = require("./mock.ts");
    log.warn("[llm] MockLlmClient (DEV=1; детерминированные ответы, без сети)");
    return new MockLlmClient();
  }
  // D4: нужен API-KEY (не subscription), иначе costUsd=null = бесплатные прогоны.
  throw new ProdConfigError("ANTHROPIC_API_KEY", "нужен API-KEY (не subscription) для costUsd (D4)");
}
