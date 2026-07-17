# asoptimus-server — заметки (production-ready)

Сервер доведён до прод-готовности: все TODO/стабы на прод-пути закрыты; единственное, что остаётся
пользователю — заполнить секреты в `.env` (и, опц., финализировать цены/пакеты цифрами). Моки
(Store/LLM/Stripe/Apple-loopback/DEV-log-email, dev-хелперы) работают **только при DEV=1** — в проде
их фабрики бросают `ProdConfigError` на старте.

## Проверено вживую (bun 1.3.14, DEV-режим, this env)
- `bun test` — **48/48** (core-метрики/сборка/expander spec-числа + биллинг D4 v4). `tsc --noEmit` — чисто.
- Happy-path E2E: signup→активация→top-up→прогон (sampleSize 30)→confirmContext→**done**; финальная
  сборка `Acme - habit tracker`, coveredShare 1.0.
- **Биллинг D4 v4 (usage-based, real-time):** 33 кейфразы × 0.02 = 0.66 кр. списано ЖИВЬЁМ (33 строки
  ledger `debit`, каждая с `(run_id, keyword)`), баланс 10→9.34. Overshoot закэплен ровно на 30×1.1=33.
- **Hard-stop:** 0-баланс → старт `paused` («пополните»); внутри прогона `WHERE balance>=price` не
  уводит в минус.
- **WSS SignedEnvelope:** валидный HMAC-конверт → hello+query.result(models); подделанный mac → коннект
  закрыт (nonce/ts/HMAC enforced на КАЖДОМ сообщении).
- **Event-replay (D7):** прогон доведён до done → вычищен из памяти → `getOrchestrator` реконструировал
  состояние РЕ-ПРОГОНОМ из durable-логов (llm_steps + apple_cache): phase/keywords/sample/assembly
  совпали, баланс не изменился (списания идемпотентны — двойного COGS/charge нет).

## Что закрыто (было TODO/стаб → прод)
- **D4 v4 биллинг** переписан на usage-based real-time списание (`billing/service.ts`,
  `debitForKeyphrase`/`grantCredits` атомарно в транзакции с FOR UPDATE; идемпотентность
  `UNIQUE(run_id, keyword)` и `stripe_event_id`). Апфронт-резерва/settle НЕТ. Внутренний per-attempt
  token-COGS остался (llm_steps) — только предохранитель/калибровка, кошелёк не трогает.
- **Event-sourced replay** (`orchestrator.replayFromLogs`, `apple-dispatch/gateway.setReplay`,
  `proxy.replay`, `replay.ts::ReplayFrontier`): cold-resume реконструирует состояние из логов, не из
  снапшота (снапшот `runs.state` — только read-проекция + fallback).
- **WSS** end-to-end: SignedEnvelope-верификация на каждом сообщении, read-path `query`/`query.result`
  (runs/run/keywords/llm-log/balance/models), ack `run.created{client_ref,run_id}`, `SerpJob.country` +
  `ProbeJob.childPrefill` на cache-hit.
- **/activate** → `ActivateResponse{session_token, expires_at, hmac_secret}`; `/session/refresh`
  (ротация), device-binding, отзыв (+инвалидация сессий), per-user rate-limit.
- **Stripe** live-ready: Checkout ($1/кредит, пакеты в конфиге) + идемпотентный вебхук → grant + чек-email.
- **SMTP email-сервис** (`email/service.ts`, nodemailer): ключ активации на /signup, чеки на webhook;
  в проде без SMTP — жёсткий отказ.
- **DEV-гейтинг** (`env.ts`): Postgres/Anthropic/Stripe/SMTP обязательны в проде; моки только DEV=1.
- **Dockerfile** (`server/Dockerfile`, Bun, EXPOSE 8787) — под `infra/docker-compose.yml`.
- **Тесты** aso-util core портированы (`src/core/**/*.test.ts`) + `billing.test.ts`.
- **Прод-гигиена:** `env.ts`/`log.ts` (структурный JSON-лог с редакцией секретов), fail-fast старт,
  graceful shutdown, `/health`, overshoot-кэп, предохранитель COGS.
- **D9** LLM-журнал: REST `/api/runs/:id/llm-log` + WSS query kind="llm-log" отдают `LlmLogPublic`
  (task/model/stage/output/tokens/costUsd/durationMs) — **промптов нет физически** (в llm_steps их нет).

## Осталось пользователю (только секреты/цифры — код готов)
- Секреты `.env`: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `SMTP_HOST/PORT/USER/PASS/FROM`.
- Опц. финал-цифры: `PRICE_PER_KEYPHRASE_JSON` (дефолты — плейсхолдер, `prices.ts` это подчёркивает),
  `TOPUP_PACKAGES_JSON`, `CLIENT_DOWNLOAD_MANIFEST_JSON` (URL+sha подписанного .dmg при публикации клиента).

## Известные границы (Фаза 3 / вне server — НЕ стабы прод-пути)
- Сессии/nonce-кэш — в памяти инстанса (single-instance ок; общий store — Фаза 3, BUILD-PLAN §8).
  Отзыв лицензии durable (Postgres); рестарт заставляет клиента переактивироваться/рефрешнуться.
- Частичный стрим сырья недоделанной ProbeJob при реконнекте — джоба пере-диспатчится целиком
  (клиентский локальный кэш D3 гасит повторный удар по Apple; поведение из D7).
- Реальный клиент (apple-exec), подпись/нотаризация .dmg, десктоп-обёртка — репо `client` / Фаза 2.

## Contract gaps (@aso/shared — НЕ редактировал; статус)
Контракт reconcile v2 + v3/v4 уже покрыл всё нужное — **новых локальных wire-типов заводить не пришлось**:
1. `SignedEnvelope` (v2) — enforced. **Wire-деталь для клиента:** `mac = HMAC_sha256(hmac_secret,
   `${ts}.${nonce}.${JSON.stringify(body)}`)`, `body` сериализуется компактно (без пробелов), порядок
   ключей = порядок объявления (round-trip JSON.parse→stringify сохраняет). ts в мс, окно ±5м, nonce одноразовый.
2. `ProbeJob.childPrefill` (v2) — используется (cache-hit childTerms).
3. `run.created{client_ref}` (v2) — ack на run.create отправляется.
4. `LlmLogPublic` (D9) — отдаётся через REST + WSS query.
5. `ModelInfo.pricePerKeyphrase` / `RunQuote` (v3/v4) — `/api/models`, `/api/quote`, query kind="models".
   Комментарий v3 в `ModelInfo`/`RunQuote` про «reserve» устарел (в v4 резерва нет — это ОЦЕНКА); поля
   и семантика полей корректны, менять контракт не требуется (косметика комментария — при желании владельца).
