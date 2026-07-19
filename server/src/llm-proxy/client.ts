// @aso/server/llm-proxy — LLM client interface: ONE billable attempt = one callOnce.
// Schema validation and retries live in proxy.ts (to meter EVERY attempt, D4). The client
// just makes a single provider call and returns raw text + usage.

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
  /** Stable business-context block — second cache breakpoint (spec 06.2). */
  contextBlock?: string;
  prompt: string;
  schema: object;
  /** run_id+step_seq — provider idempotency key (D7): a restart mid-call does not double COGS. */
  idempotencyKey: string;
}

export interface CallOnceResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmClient {
  /** One provider call (one billable attempt). Throws on network/auth errors. */
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
    log.warn("[llm] MockLlmClient (DEV=1; deterministic responses, no network)");
    return new MockLlmClient();
  }
  // D4: an API-KEY is required (not subscription), otherwise costUsd=null = free runs.
  throw new ProdConfigError("ANTHROPIC_API_KEY", "an API-KEY (not subscription) is required for costUsd (D4)");
}
