# asoptimus-server — notes (production-ready)

The server is brought to prod-readiness: all TODOs/stubs on the prod path are closed; the only thing left
to the user is filling in the secrets in `.env` (and, optionally, finalizing prices/packages with numbers). Mocks
(Store/LLM/Stripe/Apple-loopback/DEV-log-email, dev helpers) work **only under DEV=1** — in prod
their factories throw `ProdConfigError` at startup.

## Verified live (bun 1.3.14, DEV mode, this env)
- `bun test` — **48/48** (core metrics/assembly/expander spec numbers + billing D4 v4). `tsc --noEmit` — clean.
- Happy-path E2E: signup→activation→top-up→run (sampleSize 30)→confirmContext→**done**; final
  assembly `Acme - habit tracker`, coveredShare 1.0.
- **Billing D4 v4 (usage-based, real-time):** 33 keyphrases × 0.02 = 0.66 cr. debited LIVE (33 ledger
  `debit` rows, each with `(run_id, keyword)`), balance 10→9.34. Overshoot capped at exactly 30×1.1=33.
- **Hard stop:** zero balance → start `paused` ("top up"); mid-run, `WHERE balance>=price` never
  goes negative.
- **WSS SignedEnvelope:** valid HMAC envelope → hello+query.result(models); forged mac → connection
  closed (nonce/ts/HMAC enforced on EVERY message).
- **Event replay (D7):** a run driven to done → purged from memory → `getOrchestrator` reconstructed
  the state by RE-RUNNING from durable logs (llm_steps + apple_cache): phase/keywords/sample/assembly
  matched, balance unchanged (debits are idempotent — no double COGS/charge).

## What was closed (was TODO/stub → prod)
- **D4 v4 billing** rewritten to usage-based real-time debiting (`billing/service.ts`,
  `debitForKeyphrase`/`grantCredits` atomically in a transaction with FOR UPDATE; idempotency via
  `UNIQUE(run_id, keyword)` and `stripe_event_id`). NO upfront reserve/settle. The internal per-attempt
  token COGS remains (llm_steps) — a safety fuse/calibration only, never touches the wallet.
- **Event-sourced replay** (`orchestrator.replayFromLogs`, `apple-dispatch/gateway.setReplay`,
  `proxy.replay`, `replay.ts::ReplayFrontier`): cold-resume reconstructs state from logs, not from
  the snapshot (the `runs.state` snapshot is a read projection + fallback only).
- **WSS** end-to-end: SignedEnvelope verification on every message, the `query`/`query.result` read path
  (runs/run/keywords/llm-log/balance/models), the `run.created{client_ref,run_id}` ack, `SerpJob.country` +
  `ProbeJob.childPrefill` on cache hit.
- **/activate** → `ActivateResponse{session_token, expires_at, hmac_secret}`; `/session/refresh`
  (rotation), device binding, revocation (+session invalidation), per-user rate limit.
- **Stripe** live-ready: Checkout ($1/credit, packages in config) + idempotent webhook → grant + receipt email.
- **SMTP email service** (`email/service.ts`, nodemailer): activation key on /signup, receipts on webhook;
  in prod without SMTP — hard refusal.
- **DEV gating** (`env.ts`): Postgres/Anthropic/Stripe/SMTP required in prod; mocks only under DEV=1.
- **Dockerfile** (`server/Dockerfile`, Bun, EXPOSE 8787) — for `infra/docker-compose.yml`.
- **Tests** from aso-util core ported (`src/core/**/*.test.ts`) + `billing.test.ts`.
- **Prod hygiene:** `env.ts`/`log.ts` (structured JSON log with secret redaction), fail-fast startup,
  graceful shutdown, `/health`, overshoot cap, the COGS fuse.
- **D9** LLM journal: REST `/api/runs/:id/llm-log` + WSS query kind="llm-log" return `LlmLogPublic`
  (task/model/stage/output/tokens/costUsd/durationMs) — **prompts are physically absent** (llm_steps does not contain them).

## Left to the user (secrets/numbers only — the code is ready)
- `.env` secrets: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `SMTP_HOST/PORT/USER/PASS/FROM`.
- Opt. final numbers: `PRICE_PER_KEYPHRASE_JSON` (defaults are a placeholder, `prices.ts` stresses this),
  `TOPUP_PACKAGES_JSON`, `CLIENT_DOWNLOAD_MANIFEST_JSON` (URL+sha of the signed .dmg when the client ships).

## Known boundaries (Phase 3 / outside server — NOT prod-path stubs)
- Sessions/nonce cache — in instance memory (single-instance OK; a shared store — Phase 3, BUILD-PLAN §8).
  License revocation is durable (Postgres); a restart forces the client to re-activate/refresh.
- Partial streaming of an unfinished ProbeJob's raw data on reconnect — the job is re-dispatched whole
  (the client's local D3 cache absorbs the repeat hit on Apple; behavior per D7).
- The real client (apple-exec), .dmg signing/notarization, the desktop wrapper — the `client` repo / Phase 2.

## Contract gaps (@aso/shared — did NOT edit; status)
The contract reconcile v2 + v3/v4 already covered everything needed — **no new local wire types were required**:
1. `SignedEnvelope` (v2) — enforced. **Wire detail for the client:** `mac = HMAC_sha256(hmac_secret,
   `${ts}.${nonce}.${JSON.stringify(body)}`)`, `body` serialized compactly (no whitespace), key order
   = declaration order (a round-trip JSON.parse→stringify preserves it). ts in ms, ±5 min window, single-use nonce.
2. `ProbeJob.childPrefill` (v2) — in use (cache-hit childTerms).
3. `run.created{client_ref}` (v2) — the ack for run.create is sent.
4. `LlmLogPublic` (D9) — served via REST + WSS query.
5. `ModelInfo.pricePerKeyphrase` / `RunQuote` (v3/v4) — `/api/models`, `/api/quote`, query kind="models".
   The v3 comment in `ModelInfo`/`RunQuote` about "reserve" is outdated (v4 has no reserve — it is an ESTIMATE); the fields
   and their semantics are correct, no contract change needed (comment cosmetics — at the owner's discretion).
