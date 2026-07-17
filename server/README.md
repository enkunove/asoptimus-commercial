# asoptimus-server (мозг + касса) — PRIVATE

Облачный сервер ASOptimus: вся проприетарная логика (`core/` — metrics/assembly/expander/locales/prompts)
+ orchestrator + llm-proxy + billing + auth + apple-dispatch + email + stripe + db + api. Контракт —
из `@aso/shared` (вложен в `./shared`; в суперпроекте — сабмодуль). Архитектура — `../BUILD-PLAN.md`
(D1–D9). Заметки/контракт-гэпы — `NOTES.md`.

## Прод-режим (по умолчанию)
Без `DEV=1` сервер работает в проде: отсутствие обязательного секрета (`DATABASE_URL`,
`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_HOST`) → **жёсткий отказ на
старте** (не тихий мок). Заполни `.env` (см. `.env.example`) — больше ничего дописывать не нужно.

```bash
bun install
cp .env.example .env    # заполни секреты
bun run migrate         # применить schema.sql к Postgres (нужен DATABASE_URL)
bun run dev             # Bun.serve на :8787 (HTTP + SSE + WSS /ws)
```

## Docker (self-hosting)
`Dockerfile` (Bun-база, `EXPOSE 8787`) собирается из `infra/docker-compose.yml`
(server + Postgres + one-shot migrate). `docker compose up --build -d`.

## DEV-режим (офлайн, без секретов)
```bash
DEV=1 bun run dev
```
Включает in-memory Store + Mock-LLM + mock-Stripe + loopback-Apple + DEV-log email. Happy-path
течёт целиком без сети. Только при DEV=1 доступен `POST /api/dev/complete-checkout` и bare-WSS
(без SignedEnvelope).

## Тесты
```bash
bun test    # core-метрики/сборка/expander (числовые примеры spec/03,05) + биллинг D4 v4
```

## Биллинг (D4 v4 — usage-based, в реальном времени)
1 кредит = $1, free-tier НЕТ, только пополнение (Stripe, $1/кредит). Как только кейворд становится
проверенной кейфразой (rated, R≥1) — **сразу** списывается `pricePerKeyphrase[model]` (атомарно,
идемпотентно по `(run_id, keyword)`), баланс тает живьём. Overshoot до +10% оплачивается; на нуле —
`paused` (резюмируемо). Цену за кейфразу правь через `PRICE_PER_KEYPHRASE_JSON` (дефолты — плейсхолдер).

## Env — см. `.env.example`
`DEV · PORT · DATABASE_URL · ANTHROPIC_API_KEY · MODEL_PRICES_JSON · PRICE_PER_KEYPHRASE_JSON ·`
`STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET · TOPUP_PACKAGES_JSON · SMTP_HOST/PORT/USER/PASS/FROM ·`
`REQUIRE_CLIENT · CLIENT_DOWNLOAD_MANIFEST_JSON`

## Демонстрация happy-path (DEV, HTTP)
```bash
curl -sX POST localhost:8787/signup -d '{"email":"me@example.com"}' -H 'content-type: application/json'   # → devKey
curl -sX POST localhost:8787/activate -d '{"key":"asop_live_…","device_fp":"dev1"}' -H 'content-type: application/json'  # → session_token
curl -sX POST localhost:8787/api/dev/complete-checkout -H "authorization: Bearer <tok>" -d '{"packageId":"p10"}' -H 'content-type: application/json'
curl -sX POST localhost:8787/api/runs -H "authorization: Bearer <tok>" -d '{"brief":"Habit tracker…","config":{"brand":"Acme","sampleSize":30}}' -H 'content-type: application/json'
curl -N localhost:8787/api/runs/<runId>/events   # SSE прогресса
curl -sX POST localhost:8787/api/runs/<runId>/control -H "authorization: Bearer <tok>" -d '{"action":{"type":"confirmContext"}}' -H 'content-type: application/json'
curl -s localhost:8787/api/runs/<runId> -H "authorization: Bearer <tok>"       # итог
curl -s localhost:8787/api/balance    -H "authorization: Bearer <tok>"         # баланс + ledger
curl -s localhost:8787/api/runs/<runId>/llm-log -H "authorization: Bearer <tok>"  # D9: только выходы+числа
```
В проде шаги 4–7 браузер шлёт на localhost, а программа-клиент релеит их в облако по WSS
(SignedEnvelope: HMAC+ts+nonce); Apple-джобы исполняет клиент с IP пользователя.
