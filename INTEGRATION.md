# Интеграционный лог — Фаза 1

## Статус
Оба модуля собраны параллельными агентами против замороженного `@aso/shared` и закоммичены в
свои репо. Границы соблюдены: `client` не содержит формул/промптов (проверено grep’ом),
`server/src/core` держит весь moat (метрики, assembly, expander, locales, 5 промптов).

- **server** (`asoptimus-server`): core (metrics/assembly/expander/locales/prompts) + orchestrator
  (control-flow inverted) + llm-proxy (per-attempt debit, step_seq, llm_steps, idem-key) + billing
  (атомарный микро-резерв, UNIQUE(run_id,step_seq)) + auth + apple-dispatch (кэш D3, очередь) +
  stripe + db (Postgres + Memory-fallback) + api. Стартует офлайн на моках. Pure-логика: 28/28
  метрики, 27/27 assembly/expander/store (прогонял через shim; bun в окружении не было).
  `popularity.ts` переписан на `prefill ∪ fetched` (блокер D2/D3 закрыт, в комментарии кода).
- **client** (`asoptimus-client`): apple/{http,hints,search,probe} + apple-exec + cloud-link (WSS)
  + localserver (реле + guard D8) + activation + web-ui (логин/баланс/top-up). `probe.ts` живо
  проверен против Apple (early-stop + 1-request unsuggested). D8 (Host/Origin/token) и D9 (нет
  полей prompt в LlmLogPublic) подтверждены.

## Reconciliation v2 — что сведено в `@aso/shared/protocol.ts`
Оба агента независимо уткнулись в одни и те же дыры контракта (совпадение = дыры реальны). Внёс:

| Изменение | Закрывает | Кто адаптирует |
|---|---|---|
| `query` / `query.result` / `query.error` (WSS запрос-ответ для браузерных чтений) | client-a, server-4 | клиент: заменить `wire-local.ts::LocalQuery` на shared `query`; сервер: реализовать ответы (runs/run/keywords/llm-log/balance/models) |
| `run.created{client_ref,run_id}` ack + `client_ref` в `run.create` | client-b, server-3 | сервер: слать ack; клиент: коррелировать по client_ref |
| `SerpJob.country` (2-буквенный код для Search API) | client-c | сервер: класть country из конфига; клиент: брать отсюда, убрать реверс-мап |
| `run.delete` в `RunAction` | client-d | оба |
| `ProbeJob.childPrefill?` (кэш `"<kw> "`) | server-2 | сервер: класть при cache-hit; клиент: если есть — не фетчить childTerms |
| `SignedEnvelope{mac,ts,nonce,body}` (per-message HMAC) | server-1 | клиент: оборачивать; сервер: `auth.verifyMessage` |
| `ActivateRequest/Response` (HTTPS `/activate`, + hmac_secret) | client-f | сервер: эндпоинт; клиент: использовать форму |
| `ModelInfo` + query `kind="models"` | client-g | сервер: отдавать список; клиент: убрать хардкод |

Изменения аддитивные, кроме `SerpJob.country` и `run.create.client_ref` (обязательные) — их обе
стороны подхватывают в следующей итерации (компилировать всё равно нужно после `bun install`).

## Остаточные gap’ы Фазы 1 (следующая итерация)
1. **Сервер: полный event-replay** из `run_events` (сейчас — снапшот `runs.state`) — честное
   закрытие резюмируемости D7.
2. **Провод query-чтений end-to-end**: сервер отвечает на `query`, клиент переводит браузерные
   `/api/runs|:id|/keywords|/llm-log|/balance` на shared `query` вместо локального обхода.
3. **HMAC-envelope** включить с обеих сторон (SignedEnvelope) + `/activate` HTTPS-лег вживую.
4. **Порт тест-сьюта** aso-util в репо (`core` тесты сейчас гонялись временным shim’ом, не
   закоммичены как `.test.ts`).
5. **Живая проверка** против Postgres + Anthropic api_key + Stripe test (PostgresStore/Anthropic/
   Stripe написаны, но против живых сервисов не гонялись).
6. **Клиент**: secure-store для win/linux (сейчас chmod-600 fallback); partial-ProbeJob стриминг
   для кэша при реконнекте (оптимизация D7).

Ничего из остатка не блокирует демонстрацию happy-path офлайн — оба модуля стартуют и
проходят поток создание→context_review→loop→assemble→done на моках.
