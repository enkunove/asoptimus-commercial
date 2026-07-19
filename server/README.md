# asoptimus-server (brain + till) — PRIVATE

The ASOptimus cloud server: all proprietary logic (`core/` — metrics/assembly/expander/locales/prompts)
+ orchestrator + llm-proxy + billing + auth + apple-dispatch + email + stripe + db + api. The contract —
from `@aso/shared` (nested in `./shared`; a submodule in the superproject). Architecture — `../BUILD-PLAN.md`
(D1–D9). Notes/contract gaps — `NOTES.md`.

## Prod mode (default)
Without `DEV=1` the server runs in prod: a missing required secret (`DATABASE_URL`,
`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_HOST`) → **hard refusal at
startup** (no silent mock). Fill in `.env` (see `.env.example`) — nothing else needs writing.

```bash
bun install
cp .env.example .env    # fill in the secrets
bun run migrate         # apply schema.sql to Postgres (needs DATABASE_URL)
bun run dev             # Bun.serve on :8787 (HTTP + SSE + WSS /ws)
```

## Docker (self-hosting)
The `Dockerfile` (Bun base, `EXPOSE 8787`) is built from `infra/docker-compose.yml`
(server + Postgres + one-shot migrate). `docker compose up --build -d`.

## DEV mode (offline, no secrets)
```bash
DEV=1 bun run dev
```
Enables the in-memory Store + Mock LLM + mock Stripe + loopback Apple + DEV-log email. The happy path
flows entirely without network. Only under DEV=1 are `POST /api/dev/complete-checkout` and bare WSS
(without SignedEnvelope) available.

## Tests
```bash
bun test    # core metrics/assembly/expander (numeric examples from spec/03,05) + billing D4 v4
```

## Billing (D4 v4 — usage-based, real-time)
1 credit = $1, NO free tier, top-up only (Stripe, $1/credit). As soon as a keyword becomes a
verified keyphrase (rated, R≥1) — `pricePerKeyphrase[model]` is debited **immediately** (atomic,
idempotent by `(run_id, keyword)`); the balance drains live. Overshoot up to +10% is charged; at zero —
`paused` (resumable). Adjust the per-keyphrase price via `PRICE_PER_KEYPHRASE_JSON` (defaults are a placeholder).

## Env — see `.env.example`
`DEV · PORT · DATABASE_URL · ANTHROPIC_API_KEY · MODEL_PRICES_JSON · PRICE_PER_KEYPHRASE_JSON ·`
`STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET · TOPUP_PACKAGES_JSON · SMTP_HOST/PORT/USER/PASS/FROM ·`
`REQUIRE_CLIENT · CLIENT_DOWNLOAD_MANIFEST_JSON`

## Happy-path demo (DEV, HTTP)
```bash
curl -sX POST localhost:8787/signup -d '{"email":"me@example.com"}' -H 'content-type: application/json'   # → devKey
curl -sX POST localhost:8787/activate -d '{"key":"asop_live_…","device_fp":"dev1"}' -H 'content-type: application/json'  # → session_token
curl -sX POST localhost:8787/api/dev/complete-checkout -H "authorization: Bearer <tok>" -d '{"packageId":"p10"}' -H 'content-type: application/json'
curl -sX POST localhost:8787/api/runs -H "authorization: Bearer <tok>" -d '{"brief":"Habit tracker…","config":{"brand":"Acme","sampleSize":30}}' -H 'content-type: application/json'
curl -N localhost:8787/api/runs/<runId>/events   # progress SSE
curl -sX POST localhost:8787/api/runs/<runId>/control -H "authorization: Bearer <tok>" -d '{"action":{"type":"confirmContext"}}' -H 'content-type: application/json'
curl -s localhost:8787/api/runs/<runId> -H "authorization: Bearer <tok>"       # result
curl -s localhost:8787/api/balance    -H "authorization: Bearer <tok>"         # balance + ledger
curl -s localhost:8787/api/runs/<runId>/llm-log -H "authorization: Bearer <tok>"  # D9: outputs+numbers only
```
In prod, the browser sends steps 4–7 to localhost and the client program relays them to the cloud over WSS
(SignedEnvelope: HMAC+ts+nonce); Apple jobs are executed by the client from the user's IP.
