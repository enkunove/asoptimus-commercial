# asoptimus-client — build notes

Тонкий локальный клиент (BUILD-PLAN D1/D5/§3) + десктоп-обёртка (D6/Фаза 2). Поднимает
localhost-UI, делает Apple-fetch по джобам облака, релеит команды/прогресс/чтения. **Проприетарной
логики здесь нет** — ни формул P/D/Score, ни assembly/expander, ни промптов, ни placement-весов/
extraLocale/locales. Прод-путь идёт в реальное облако по WSS+HTTPS; оффлайн-стаб — только за `DEV=1`.

## Как запустить (CLI-бинарь)

```bash
bun install
bun run dev                       # = bun run src/main.ts → http://127.0.0.1:4317, откроет браузер
bun run src/main.ts --port 4319 --no-open --data-dir /tmp/aso
bun run build                     # dist/ — 4 таргета bun --compile
bun run src/build.ts --sidecar    # sidecar-бинари под Tauri (target-triple-suffixed)
```

Переменные окружения:

| env | назначение | дефолт |
|---|---|---|
| `ASO_CLOUD_WSS` | WSS-endpoint облака (джобы/прогресс/чтения) | `wss://api.asoptimus.com/ws` |
| `ASO_CLOUD_HTTPS` | HTTPS-endpoint (активация `/activate`, top-up `/topup`) | `https://api.asoptimus.com` |
| `ASO_DATA_DIR` | директория данных (кэш Apple, dev-fallback сессии) | `~/.asoptimus` |
| `ASO_LAUNCH_TOKEN` | per-launch guard-токен (D8); задаёт хост-обёртка | генерируется |
| `ASO_SIDECAR=1` | режим sidecar: печатать `ASOPTIMUS_STATUS`-строки в stdout (для трея) | выкл |
| `DEV=1` | **оффлайн-режим:** dev-стаб облака + синтетическая активация (НЕ прод) | выкл |
| `ASO_DEV_CREDITS` | DEV-only: стартовый баланс стаба (для проверки hard-stop) | 500 |

Активация: в UI ввести ключ `asop_live_…`. Прод — обмен на session-token по HTTPS
(`ActivateRequest`→`ActivateResponse`, приходит `hmac_secret` для подписи). `DEV=1` — синтетический
токен без облака.

## Что сделано в этой итерации (прод-готово)

- **Реконсиляция под @aso/shared (reconcile v2 / billing v4):**
  - Read-путь браузера — на официальном контракте `query{query_id,kind,params}` →
    `query.result{query_id,data}` / `query.error`. Ад-хок `q.*`/`cid` из прежнего `wire-local.ts` **удалён**.
  - `run.create{client_ref}` → ждём ack `run.created{client_ref, run_id}` (run_id узнаём в ответе).
  - `deleteRun` → `run.control` c `action{type:"delete"}`.
  - Каждое клиент→сервер сообщение обёрнуто в `SignedEnvelope` (HMAC-SHA256 по `hmac_secret`).
  - `SerpJob.country` берём напрямую (реверс-мап storefront→country **удалён** из `storefront.ts`/`apple-exec`).
  - `ProbeJob.childPrefill` — при кэш-хите НЕ фетчим `"<kw> "` (0 сети).
  - HTTPS-активация `POST /activate` (`ActivateRequest`/`ActivateResponse`); HTTPS top-up `POST /topup`.
- **Прод WSS-нога:** дефолт `wss://api.asoptimus.com/ws`; реконнект+resume_job_ids (D7); подпись, таймауты.
  Dev-стаб — **только за `DEV=1`** (`makeCloudLink`), из прод-пути недостижим.
- **Keychain:** session (вкл. `hmac_secret`) в macOS Keychain (`security`); chmod-600 файл — только fallback.
- **Quote-UI (D4 v4, usage-based):** форма прогона — слайдер sampleSize + селектор модели (**дефолт Haiku**);
  живая **оценка** `≈ ceil(sampleSize × pricePerKeyphrase)`; ремарка «до +10% кейфраз **тоже списываются**,
  итог до +10% выше оценки»; список моделей + цены — с сервера (`query kind="models"`, `/api/models`),
  **не хардкод**. Баланс тает **в реальном времени** (сервер шлёт `balance` после каждого списания → SSE →
  виджет с подсветкой тика). Кредиты кончились посреди прогона → баннер «пополни, продолжим с этого места»
  + top-up + resume. Форма старт **не гейтит** балансом (pay-as-you-go, без резерва). Экран `#/balance` с
  леджером. Free-tier нет. LLM-журнал — только `LlmLogPublic` (промптов нет, D9).
- **Десктоп (Tauri 2.x, macOS):** `client/desktop/` — см. ниже.
- **DoD:** проверено оффлайн (`DEV=1`): активация → модели/баланс → прогон → живой дренаж → hard-stop →
  top-up → resume; guard D8 (bad Host 403 / no-token 401); D9 (в `/llm-log` нет `prompt`/`system`).

## Десктоп-приложение (client/desktop/, Tauri 2.x — только macOS)

Нативное окно поверх localhost-UI (не вкладка браузера): при старте выбирается свободный порт,
запускается **скомпилированный Bun-бинарь как sidecar** (`bundle.externalBin`, имя с target-triple из
`build.ts --sidecar`), Rust ждёт stdout-маркер `ASOPTIMUS_LISTENING <port>` и грузит `http://127.0.0.1:<port>`
в webview; трей (Connected/Disconnected + баланс из `ASOPTIMUS_STATUS`, пункты «Открыть»/«Пополнить»/«Выход»);
на выходе sidecar убивается. Иконки — `scripts/make-icons.sh` (source `gen-icon.mjs`).

```bash
cd client/desktop
bun install
bash scripts/build-dmg.sh both     # arm64 + x64 .dmg (drag-to-Applications)
```

**Единственное, что вставляет пользователь в конце (как ключи) — Apple Developer ID + секреты подписи:**
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (маппится в
`APPLE_PASSWORD`). Без них `.dmg` соберётся **неподписанным** (dev). Плюс требуется установленный **Rust
(cargo/rustup)** — в этой сборочной среде его нет, поэтому сам `cargo`-билд не выполнялся (сидекар,
конфиг, скрипты, иконки — готовы и проверены). Подпись/нотаризация выполняются внутри `tauri build`
автоматически при наличии env-секретов.

## Contract gaps, ещё НЕ покрытые @aso/shared (на тех-лида; shared НЕ редактируем отсюда)

Всё из прежнего списка reconcile-v2 **закрыто** (query/query.result, run.created, delete-action,
SignedEnvelope, ActivateRequest/Response+hmac_secret, SerpJob.country, ProbeJob.childPrefill,
ModelInfo.pricePerKeyphrase, RunQuote). Осталось зафиксировать:

1. **Каноника HMAC.** `SignedEnvelope.mac` считаем как `HMAC_SHA256(hmac_secret, "${ts}.${nonce}.${JSON.stringify(body)}")`
   (hex). Сервер (`auth.verifyMessage`) должен верифицировать **идентичной** строкой (тот же JSON-сериализатор
   порядка полей) + окно ts ±5м + защита nonce от replay. Зафиксировать формат в контракте/доке.
2. **Форма `query.result.data` по kind** (в контракте `data:unknown`). Клиент ждёт (под-контракт, `wire-local.ts`):
   `runs`→`RunSummary[]` · `run`→**`RunSnapshot`** (надмножество `RunState`: + `config`, `events`,
   `keywordCount`, `sampleCount` — экран прогона не добирает их из push-only SSE при первой загрузке) ·
   `keywords`→`KeywordPage{total,page,pageSize,items}` (пагинация/сорт/фильтр — на сервере; `total` нужен UI) ·
   `keyword`→`{item:KeywordEntry|null}` · `llm-log`→`LlmLogPage{total,page,items}` · `balance`→`BalanceView` ·
   `models`→`ModelInfo[]`. Желательно поднять эти проекции в контракт как типы `data` per kind.
3. **HTTPS top-up.** Клиент: `POST {ASO_CLOUD_HTTPS}/topup`, `Authorization: Bearer <session_token>`,
   body `{packageId}` → `TopupResponse{checkoutUrl}`. Зафиксировать метод авторизации HTTPS-лега и
   **каталог пакетов** (id/цена/кредиты) — сейчас в UI 3 условных пакета (small/medium/large), истина —
   серверный конфиг; желателен способ отдать каталог клиенту (напр. отдельный query kind или поле в balance).
4. **Live-balance push.** UI полагается, что сервер шлёт `balance{credits}` **после каждого списания
   кейфразы** (D4 v4 real-time drain) — виджет тает тик-в-тик. Убедиться, что оркестратор это эмитит.
5. **Причина паузы «кредиты кончились».** UI распознаёт credits-hard-stop по тексту `run.paused.reason`
   (regex `кредит|credit|баланс|пополн|top.?up`). Надёжнее — структурный флаг/код причины в `run.paused`.
