# Integration log — Phase 1

## Status
Both modules were built by parallel agents against a frozen `@aso/shared` and committed to
their repos. Boundaries hold: `client` contains no formulas/prompts (verified by grep),
`server/src/core` holds the whole moat (metrics, assembly, expander, locales, 5 prompts).

- **server** (`asoptimus-server`): core (metrics/assembly/expander/locales/prompts) + orchestrator
  (control-flow inverted) + llm-proxy (per-attempt debit, step_seq, llm_steps, idem-key) + billing
  (atomic micro-reserve, UNIQUE(run_id,step_seq)) + auth + apple-dispatch (D3 cache, queue) +
  stripe + db (Postgres + Memory fallback) + api. Starts offline on mocks. Pure logic: 28/28
  metrics, 27/27 assembly/expander/store (ran through a shim; no bun in the environment).
  `popularity.ts` rewritten as `prefill ∪ fetched` (D2/D3 blocker closed, noted in a code comment).
- **client** (`asoptimus-client`): apple/{http,hints,search,probe} + apple-exec + cloud-link (WSS)
  + localserver (relay + D8 guard) + activation + web-ui (login/balance/top-up). `probe.ts` was live-
  tested against Apple (early-stop + 1-request unsuggested). D8 (Host/Origin/token) and D9 (no
  prompt fields in LlmLogPublic) confirmed.

## Reconciliation v2 — what was merged into `@aso/shared/protocol.ts`
Both agents independently hit the same contract holes (agreement = the holes are real). Landed:

| Change | Closes | Who adapts |
|---|---|---|
| `query` / `query.result` / `query.error` (WSS request-response for browser reads) | client-a, server-4 | client: replace `wire-local.ts::LocalQuery` with shared `query`; server: implement the responses (runs/run/keywords/llm-log/balance/models) |
| `run.created{client_ref,run_id}` ack + `client_ref` in `run.create` | client-b, server-3 | server: send the ack; client: correlate by client_ref |
| `SerpJob.country` (2-letter code for the Search API) | client-c | server: put country from config; client: take it from here, drop the reverse map |
| `run.delete` in `RunAction` | client-d | both |
| `ProbeJob.childPrefill?` (cache of `"<kw> "`) | server-2 | server: include on cache hit; client: if present — do not fetch childTerms |
| `SignedEnvelope{mac,ts,nonce,body}` (per-message HMAC) | server-1 | client: wrap; server: `auth.verifyMessage` |
| `ActivateRequest/Response` (HTTPS `/activate`, + hmac_secret) | client-f | server: endpoint; client: use the form |
| `ModelInfo` + query `kind="models"` | client-g | server: return the list; client: drop the hardcode |

The changes are additive, except `SerpJob.country` and `run.create.client_ref` (required) — both
sides pick those up in the next iteration (everything needs compiling after `bun install` anyway).

## Remaining Phase 1 gaps (next iteration)
1. **Server: full event replay** from `run_events` (currently — the `runs.state` snapshot) — the honest
   closure of D7 resumability.
2. **Wire query reads end-to-end**: the server answers `query`, the client routes browser
   `/api/runs|:id|/keywords|/llm-log|/balance` through shared `query` instead of the local workaround.
3. **HMAC envelope** enabled on both sides (SignedEnvelope) + the `/activate` HTTPS leg live.
4. **Port the aso-util test suite** into the repo (the `core` tests were run via a temporary shim, not
   committed as `.test.ts`).
5. **Live verification** against Postgres + Anthropic api_key + Stripe test (PostgresStore/Anthropic/
   Stripe are written but never ran against live services).
6. **Client**: secure store for win/linux (currently a chmod-600 fallback); partial-ProbeJob streaming
   for the cache on reconnect (D7 optimization).

Nothing in the remainder blocks the offline happy-path demo — both modules start and
walk the create→context_review→loop→assemble→done flow on mocks.
