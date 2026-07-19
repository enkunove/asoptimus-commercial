# 06 — LLM adapters and prompt contracts

## 6.1 Adapter interface

The orchestrator and the UI know only this interface. The adapter registry is a static list in code; v1 has a single entry (`claude`), but the provider selection page renders from the registry.

```js
/** @typedef {Object} LlmAdapter */
{
  id: "claude",
  displayName: "Claude (Anthropic)",
  authMethods: ["subscription", "api_key"],

  // verify/set authorization (details per-adapter)
  async verifyAuth() {},            // → { ok: boolean, detail: string }  (detail: "API key •••Kf3, org ...", or an error message)
  async setAuth(method, payload) {},// saves credentials to auth.json, makes a probe call

  listModels() {},                  // → [{ id, name, inputPer1M, outputPer1M, note? }]

  // the single workhorse method: a typed JSON call
  async completeJSON({ task, system, prompt, schema, model }) {},
  // → { data: <object valid per schema>, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, costUsd: number|null, durationMs }
}
```

Rules for ANY adapter:
- every call is written in full to the run's `llm-log.jsonl`: `{ ts, task, model, system, prompt, response, usage, costUsd, durationMs, error? }` — this is the source for the transparency log in the UI;
- retries for network errors/429/5xx happen inside the adapter (for Claude — via the SDK); 401/403 propagate to the orchestrator as `AuthError`;
- the response is validated against `schema` by code even if the provider guarantees the schema; on an invalid response — one retry with the validation error text, then the error bubbles up;
- `costUsd` is computed from the price list in `listModels()`; `null` when authorized via subscription (cost is not applicable — we show tokens only).

## 6.2 Claude adapter

Implemented on the official `@anthropic-ai/sdk` (works in Bun and compiles into the binary).

### Models (`listModels`)

| id | Name in UI | $/1M input | $/1M output | Note |
|---|---|---|---|---|
| `claude-opus-4-8` | Claude Opus 4.8 | 5.00 | 25.00 | **default** |
| `claude-fable-5` | Claude Fable 5 | 10.00 | 50.00 | maximum quality |
| `claude-sonnet-5` | Claude Sonnet 5 | 3.00 | 15.00 | intro price 2.00/10.00 until 2026-08-31 |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 1.00 | 5.00 | cheap, for draft runs |

The price list is hardcoded next to the model registry (a constant with an as-of date; the UI shows this date in the cost tooltip).

### Auth method 1: API key

- An input field on the authorization page; stored in `auth.json` (`chmod 600`): `{ "claude": { "method": "api_key", "apiKey": "sk-ant-..." } }`.
- Client: `new Anthropic({ apiKey })`.
- `verifyAuth`: a minimal `messages.create` request (haiku, `max_tokens: 1`, "ping") → ok/error with a human-readable message (401 → "the key is invalid or revoked").

### Auth method 2: subscription (Anthropic OAuth token)

Works via OAuth credentials the user obtains with Anthropic's standard tooling — **we do not implement our own OAuth client** (less code, no dependence on undocumented details):

1. **Automatically via the `ant` CLI (preferred).** If `ant` is on PATH and `ant auth status` shows an active profile — the adapter obtains a short-lived token with `ant auth print-credentials --access-token` and re-creates it on 401 or every N minutes. `auth.json` stores only `{ "method": "subscription", "source": "ant" }` — the tokens themselves are not persisted.
2. **Manual OAuth token paste.** The user pastes a token obtained via `claude setup-token` (Claude Code) — stored as `{ "method": "subscription", "source": "manual", "token": "..." }`.

The client in both cases: `new Anthropic({ authToken, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })` — the OAuth token goes as a Bearer token, and the beta header is mandatory for `/v1/messages`.

The authorization page for this method shows step-by-step instructions with copyable commands: "install ant → `ant auth login` → press Verify" plus the alternative "or paste a token from `claude setup-token`". If `ant` is not found — a link to the installation. **An honest banner in the UI:** "Subscription mode uses your personal Anthropic OAuth credentials; for production workloads Anthropic recommends an API key".

### Request parameters

- All calls: `client.messages.create` with `thinking: { type: "adaptive" }` (omitted on Fable 5), `max_tokens: 8192`.
- **Structured outputs:** every call passes `output_config: { format: { type: "json_schema", schema } }` — the response is guaranteed valid JSON per the schema. Schema restrictions: `additionalProperties: false` everywhere, all fields in `required`, no recursion and no numeric/string constraints (we validate such things in code after parsing).
- **Prompt caching:** each task's system prompt is stable (no dates/IDs) and marked `cache_control: {type: "ephemeral"}`; the business-context block is the second stable block with its own breakpoint. In a loop of ~16 calls this cuts cost noticeably; `usage.cache_read_input_tokens` is counted toward the cost at the discounted rate (0.1× input) and shown in the log.
- Retries: built into the SDK (default 2) for 429/5xx/network; timeout 120 s.

## 6.3 Prompt contracts (5 tasks)

For each task, a full system prompt is written during the build (files `src/llm/prompts/*.md`, embedded into the binary). Below is the mandatory content and output schemas. Common requirements for every system prompt: generation language = `semanticLanguage` from the run config (never guessed by the model); the full rubric/rule text from the spec verbatim; no explanations outside the JSON.

### `context` — brief → business context
Input: the brief text + `country`/`semanticLanguage` from the config. Output — the schema from `01.2` (all fields required; `jobsToBeDone` 5–10 items, `featureVocabulary` 10–20, `competitors` 0–10; `targetLanguage` = the config's `semanticLanguage`, the field stays in the schema for display). The system prompt requires: the feature vocabulary in the words users search with, not marketing jargon; the anti-semantics must be substantive.

### `seeds` — context → the first batch of hypotheses
Input: context.json + `batchSize` + the stopword list. Output:
```json
{ "keywords": [ { "keyword": "sleep tracker", "type": "functional|problem|audience|adjacent|category" } ] }
```
The prompt contains the hypothesis rules from `04.2` verbatim and requires covering all five types.

### `rate` — a batch of verified keywords → R scores
Input: context + an array of up to 25 keywords (each with its P, D, and the top-3 competitor names from the search results — this helps the model understand how Apple interprets the query). Output:
```json
{ "ratings": [ { "keyword": "...", "r": 0, "reason": "..." } ] }
```
The prompt = the 0–3 rubric from `03.3` verbatim + the anti-semantics + the requirement of a non-empty reason (< 200 characters). The code verifies that every input keyword received exactly one score; missing ones go into a retry.

### `hypothesize` — loop state → a new batch of hypotheses
Input: context; top 20 by Score (with metrics); the 10 worst (counter-examples); the leaders' "children" from autocomplete suggestions; titles of weak competitors (strength < 40) from the leaders' search results; the list of ALL already-known keywords (for model-side dedup); `batchSize`, `exploreRatio`. Output — the same schema as `seeds`, plus a `"strategy": "exploit|explore"` field on each item. The prompt requires an explore share ≈ `exploreRatio` and forbids repeating known keywords.

### `phrase` — selected words → field texts
Called once per bucket (primary localization and cross-localization, `05.9`). Input: brand; the bucket's `locale`; `titleWords`, `subtitleWords` (exactly in the given forms); character budgets; context (for tone); on retry — the list of validation violations from the previous attempt. Output:
```json
{ "titleSlogan": "Habit Tracker", "subtitle": "Daily Routine & Streaks" }
```
The prompt: the slogan and subtitle must contain all of their respective words in exact forms, fit the budgets, and be human-readable and selling; adding stopwords is allowed, changing word forms is not.

## 6.4 Adapter errors → UI behavior

| Error | Behavior |
|---|---|
| `AuthError` (401/403) | Run → paused; banner "Authorization lost" + a button to the provider page |
| 429 after retries | Run → paused; banner "Provider rate limit, wait and resume" |
| Invalid JSON ×2 | Event in the log with the full response; the step repeats; ×3 → paused |
| Network unavailable | paused + a banner with a "Retry" button |

## 6.5 Usage accounting

The orchestrator sums the usage of all the run's calls in state: `{ inputTokens, outputTokens, cacheReadTokens, calls, costUsd|null }`. The UI shows it in the run header: "LLM: 14 calls · 182k tokens · ~$1.9" (in subscription mode — without dollars). Clicking expands a breakdown by task (context/seeds/rate/hypothesize/phrase).
