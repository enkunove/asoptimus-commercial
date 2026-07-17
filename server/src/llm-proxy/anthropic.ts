// @aso/server/llm-proxy — реальный клиент Anthropic по СЕРВЕРНОМУ api_key (D4: не
// subscription — иначе costUsd=null = бесплатные прогоны). Порт callOnce из aso-util
// claude.ts БЕЗ подписочной ветки и без хардкод-цен (цена считается в billing/prices).
// Промпты НИКОГДА не покидают сервер, кроме как в Anthropic (D9).

import Anthropic from "@anthropic-ai/sdk";
import type { CallOnceRequest, CallOnceResult, LlmClient } from "./client.ts";
import { LlmAuthError } from "./client.ts";

// Модели, принимающие `thinking:{type:"adaptive"}` (Opus 4.6+/Sonnet 4.6+/Sonnet 5/Fable 5).
// Haiku 4.5 и старше adaptive НЕ поддерживают — для них thinking опускаем (structured-output-only).
// Fable 5 отвергает thinking:{disabled}, но опускание/adaptive допустимы.
function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.startsWith("claude-opus-4-6") ||
    modelId.startsWith("claude-opus-4-7") ||
    modelId.startsWith("claude-opus-4-8") ||
    modelId.startsWith("claude-sonnet-4-6") ||
    modelId.startsWith("claude-sonnet-5") ||
    modelId.startsWith("claude-fable-5") ||
    modelId.startsWith("claude-mythos-5")
  );
}

export class AnthropicClient implements LlmClient {
  readonly kind = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async callOnce(req: CallOnceRequest): Promise<CallOnceResult> {
    const system: any[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    if (req.contextBlock) {
      system.push({ type: "text", text: req.contextBlock, cache_control: { type: "ephemeral" } });
    }
    const params: any = {
      model: req.model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { format: { type: "json_schema", schema: req.schema } },
    };
    if (supportsAdaptiveThinking(req.model)) params.thinking = { type: "adaptive" };

    try {
      // idempotencyKey (run_id+step_seq): рестарт посреди вызова не двоит COGS (D7).
      const res: any = await this.client.messages.create(params, {
        headers: { "Idempotency-Key": req.idempotencyKey },
      });
      const text = (res.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const usage = {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage?.cache_creation_input_tokens ?? 0,
      };
      return { text, usage };
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) {
        throw new LlmAuthError(`Anthropic auth (${e.status}): ключ неверный/без прав`);
      }
      throw e;
    }
  }
}
