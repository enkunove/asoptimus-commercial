# ASOptimus — buildable blueprint (единый источник истины для стройки)

Этот документ — то, по чему **начинают писать код**. Он глубже, чем `ARCHITECTURE.md`
(решения/обоснования) и `PRODUCT.md` (картина продукта): здесь зафиксированы
ключевые архитектурные решения после глубокого пере-осмысления, полная карта репозитория и
всех сабмодулей, wire-протокол «локальная программа ↔ сервер», модель данных и порядок
стройки. При противоречии — этот документ главнее ARCHITECTURE/PRODUCT (их шапки указывают
сюда). Спека `aso-util/spec/*` остаётся истиной по **доменной логике** (формулы P/D/Score,
сборка, промпты) — коммерческая версия её не меняет, только перераспределяет по машинам —
**с одним явным исключением: принцип прозрачности principle 2 / 07.5 ослабляется (см. D9).**

Выбранная модель (подтверждена пользователем): **скачанная программа поднимает localhost-UI
и делает Apple-запросы; ВСЯ остальная логика — на облачном сервере.** Ниже — как именно это
собрать, чтобы оно работало правильно.

> Ревизия 2: план прошёл adversarial-валидацию двух субагентов против реального кода
> aso-util. Все подтверждённые находки внесены (помечены `[fix]` рядом с решением/секцией).

---

## 0. Что заставило пере-думать архитектуру (неочевидности из спеки + кода)

1. **Popularity считается адаптивным prefix-probing’ом (`spec/03.1`, `src/metrics/popularity.ts`).**
   И это не «сходи на один URL», а целая процедура: сперва фетчится **полный** префикс `K`
   (если `K` нет в подсказках → `unsuggested` за **один** запрос, ранний выход); иначе —
   восходящая лестница `K[0:1..N]` с ранней остановкой на минимальном `L`; затем ещё фетч
   `K + " "` для `childCount`; попутно все увиденные подсказки (`seenTerms`) становятся новыми
   кандидатами `source="suggest"`. Наивное делегирование по одному URL = тысячи облачных
   round-trip’ов **и** потеря one-request-shortcut’а для unsuggested. → D2.
2. **Кэш Apple в спеке — общий для машины (`spec/01.4`).** В облаке — общесетевой, но с
   аккуратной семантикой вычисления `L` (иначе кэш ломает саму метрику). → D3.
3. **Резюмируемость держалась на атомарном state-файле (`spec/04.4`).** В облаке источник
   истины — Postgres event-log; «клиент отвалился посреди прогона» — новый класс отказа; а
   **LLM-вызов — это внешний платный side-effect**, который при наивном реплее выполнится
   дважды. → D4, D7.
4. **Прозрачность (`spec` principle 2, `07.5`) требует показывать ПОЛНЫЕ промпты в UI** — а
   промпты объявлены moat’ом, клиент недоверен. Это прямое противоречие. → D9.

---

## 1. Девять решений (ядро пере-осмысления)

### D1 — Топология «вариант β»: браузер говорит ТОЛЬКО с localhost

Браузер (localhost-UI) общается **исключительно** с локальной программой на `127.0.0.1`.
Наружу, в облако, ходит **только сама программа** (нативный процесс). Браузер к облаку не
обращается вообще.

```
Браузер ──HTTP/SSE──► localhost:PORT (локальная программа) ──WSS/HTTPS──► облако
                                        └──fetch──► Apple (IP пользователя)
```

Почему так:
- **CORS исчезает как проблема целиком.** Браузер, как и в нынешнем aso-util, дёргает только
  `127.0.0.1` (same-origin со страницей). Cross-origin делает нативный Bun-процесс, а на
  нативный fetch CORS не распространяется.
- **Session-token живёт в одном месте** — в программе (OS secure-store); браузеру нечего
  утекать.
- **Минимальная дельта от текущего кода** — сегодня браузер уже говорит только с localhost;
  меняется лишь то, что программа вместо локального оркестратора **релеит** команды в облако.

### D2 — Грубые Apple-джобы, воспроизводящие ТОЧНУЮ процедуру probing’а `[fix]`

Единица работы — целостная джоба, а не «один URL». `ProbeJob` **инкапсулирует всю процедуру
`getPopularity` из `popularity.ts`**, чтобы один кейворд = один облачный round-trip и чтобы
не потерять one-request-shortcut для unsuggested:

Алгоритм исполнения `ProbeJob` на клиенте (строго):
1. Взять/фетчить **полный** префикс `K`. Если `K` не встречается в его подсказках →
   вернуть результат `unsuggested` (дальше ничего не фетчить). *(Это тот самый shortcut из
   `popularity.ts` — без него unsuggested-кейворд стоит N запросов вместо одного.)*
2. Иначе — идти по лестнице `K[0:1], K[0:2] … ` **строго по возрастанию длины**; для каждого
   префикса: если он есть в `prefill` (кэш D3) — взять контент оттуда без сети; иначе фетчить
   у Apple (свой троттлинг). Остановиться на **минимальном** `L`, где `K` встретился. **Нельзя
   пропускать более короткий cache-miss-префикс ради более длинного cache-hit’а** — `L` есть
   минимум, порядок обязателен.
3. Раз `K` найден — фетчить/взять `K + " "` (для `childCount`).
4. Вернуть `JobResult.raw` = **полные массивы подсказок по КАЖДОМУ префиксу, что реально
   потрогали** (fetched или взятому из prefill — не важно; но prefill сервер и так имеет, так
   что по сети клиент шлёт только реально фетченные) + массив по `K + " "`.

Клиент **не считает ни одной метрики**. `P/L/rank/childCount` + харвест `seenTerms` в новые
кандидаты считает сервер (`@aso/core/metrics/popularity.ts`) — **над объединением
`prefill ∪ вернувшиеся raw`, ключ = префикс** (иначе, если matching-префикс был в кэше, а по
сети пришли только более короткие промахи, сервер не найдёт `K` нигде и ошибочно выставит
`P=0` — это подтверждённый блокер, закрыт этим правилом).

Ранняя остановка — механический строковый матч (`K ∈ подсказки?`), лестница детерминирована
из `K`. Проприетарного (формулы, стратегия экспандера, промпты) в джобе нет — **сама
методика «популярность = f(глубина префикса, ранг)» частично видна из формы джобы; принимаем
это как не-секрет: секрет — константы (0.7/0.3) и стратегия, а не идея (`spec/03.1` её и так
описывает).**

Остальные джобы:
- `SerpJob{ query, storefront, lang }` — один iTunes Search запрос, сырой JSON (для D).
- `HintsJob{ term, storefront }` — одиночные подсказки для **независимых** нужд: «дети»
  лидеров для `hypothesize` и alphabet-soup экспандера. (childCount НЕ идёт сюда — он внутри
  ProbeJob, иначе лишний round-trip на каждый кейворд.)

### D3 — Общесетевой серверный кэш сырых ответов Apple `[fix]`

Сервер держит кэш **сырых** ответов Apple (`sha1(method+url+storefront)`, TTL). На каждую
джобу: сперва проверить кэш → найденное положить в `prefill` (probe) или не слать джобу вовсе
(всё в кэше) → клиент фетчит только промахи → вернувшееся **write-through** в кэш.

**Критично для корректности (закрытый блокер):** `L/rank/childCount/seenTerms` сервер считает
над `prefill ∪ raw` (D2), а не над одними вернувшимися raw. Клиент вычисляет раннюю остановку
локально по `prefill ∪ fetched`, строго по возрастанию длины.

Выигрыш и его честные границы:
- Cache-hit = Apple-запрос **не происходит вообще**; cache-miss всё равно идёт через **IP
  пользователя** (сервер к Apple не ходит никогда). Anti-ban-история цела.
- Ускорение — **агрегатное / на повторных прогонах**, НЕ снижение пикового burst’а: первый
  пользователь в свежей нише всё равно фетчит холодную лестницу со своего IP (как и локальный
  aso-util). Это не регресс, но и не «магически меньше банов на первом прогоне».
- Данные публичны и одинаковы для storefront’а — межпользовательской утечки приватного нет.
- **Клиентский локальный кэш — рекомендован (не «опционален»): он спасает re-fetch при
  реконнекте недоделанной джобы (D7).** Мягкая мера против дрейфа `L`: более короткий TTL для
  коротких высокореюзных префиксов (иначе near-TTL короткий префикс + свежий matching-префикс
  дают temporally-inconsistent лестницу).

### D4 — Инкрементальное списание + микро-резерв на стадию (без гонок и недоборов) `[fix]`

Источник истины по балансу — Postgres `wallet` (не Stripe). Модель:
- **Start-floor** на старте: атомарно удержать минимум (`context+seeds`), чтобы не стартовать
  пустой баланс. `UPDATE wallet SET balance=balance-:floor WHERE user_id=:u AND balance>=:floor`.
- **Микро-резерв перед КАЖДЫМ LLM-вызовом** (закрывает потерю negative-balance-гарантии):
  атомарно удержать `оценка_стадии × safety` (`WHERE balance>=hold`); мало → `paused`. После
  вызова — **settle к фактической стоимости** и вернуть разницу. Конкурентные LLM-вызовы
  одного кошелька **сериализуются** (row-lock/`FOR UPDATE` на wallet) — иначе оба проходят
  `balance>0` и уводят в минус.
- **Списывать фактическую стоимость = СУММА ВСЕХ провайдер-попыток**, не только успешной.
  Один логический шаг = до 6 реальных billable-вызовов (`orchestrator.llm()` до 3× вокруг
  `completeJSON()`, который сам ретраит до 2× на невалидной схеме — `src/llm/claude.ts`).
  `trackUsage` в aso-util пишет токены **только последней успешной** попытки → на сервере это
  структурный недобор. llm-proxy обязан метрить **каждый** `callOnce` и списывать за каждую
  попытку.
- **`step_seq` — детерминированный, назначаемый СЕРВЕРОМ монотонный счётчик на каждую
  billable-попытку** (не на «логический шаг»): каждая реальная попытка → свой `step_seq` →
  своя строка ledger. Идемпотентность списания — `UNIQUE(run_id, step_seq)` (см. §5).
  **Логический шаг** (context/rate/…) группирует свои попытки; state advance’ится по последней
  schema-валидной попытке (`llm_steps.valid`), она же — авторитетный результат при реплее.
  (Внутренние ретраи Anthropic-SDK `maxRetries` невидимы для per-callOnce-метрик, но неуспешные
  сетевые ретраи не billable — на списание не влияют.)
- **Цена модели — из живого источника (config/DB), не из хардкод-таблицы адаптера**
  (`PRICES_AS_OF` в `claude.ts` — это ровно «дрейф цен молча делает прогоны убыточными»).
  Сервер обязан ходить в Anthropic по **api_key** (не subscription), иначе `costUsd=null` =
  бесплатные прогоны.
- Маржа — **на покупке кредитов** (продаёшь $10 силы за $12–15), списание = сырой COGS. Плюс
  **per-run floor** покрывает фиксированный оверхед на дешёвых прогонах.
- **Idle-run TTL:** прогон, застрявший на `context_review` и не подтверждённый, держит floor
  вечно → авто-release floor по TTL простоя.

(Остальные митигации `ARCHITECTURE §4` — идемпотентность вебхуков, Radar, кап top-up
новичкам — в силе.)

### D5 — Полирепо на git-сабмодулях: каждый логический модуль — отдельный git-репозиторий `[fix]`

**Решение пользователя (перекрывает прежний монорепо-вариант):** структура — суперпроект
`asoptimus` + git-**сабмодули**, по одному на логический модуль. Четыре сабмодуля:

| Сабмодуль (git-репо) | Что внутри | Приватность |
|---|---|---|
| `asoptimus-shared` | контракт: wire-протокол, домен-типы, публичные константы (`@aso/shared`) | публичный-safe |
| `asoptimus-server` | **мозг:** `@aso/core` (metrics/assembly/expander/**prompts**) + `@aso/server` (orchestrator/llm-proxy/billing/auth/apple-dispatch/db/api) | **ПРИВАТНЫЙ** (moat) |
| `asoptimus-client` | **локальная программа:** `@aso/apple` (fetch-примитивы) + `@aso/client` (реле/cloud-link/activation) + `@aso/web-ui` | можно сделать аудируемым/public |
| `asoptimus-landing` | лендинг (уже есть) | публичный |

Почему это сильнее прежнего CI-графа: **разделение moat’а теперь физическое, а не проверкой.**
Формулы, стратегия expander’а и промпты лежат **только** в приватном репо `server` и не могут
попасть в `client` в принципе — их там нет как файлов. `shared` — тонкий контракт (типы +
протокол), поэтому известная боль сабмодулей (версионирование общего кода) минимальна: оба
зависят от `shared`, бампишь его редко. `shared` включается в `server` и `client` как **вложенный
сабмодуль**, импорт через tsconfig-alias `@aso/shared` (детали — `SETUP-SUBMODULES.md`).

### D6 — Tauri опционален; MVP-«программа» = скомпилированный Bun-бинарь

«Программа» на MVP — тот же `bun build --compile` бинарь: поднимает localhost-UI, открывает
браузер. Никакого Tauri для запуска не нужно (localhost-serving уже есть в aso-util;
`bun build --compile` уже эмбедит web-ui через `import … with { type: "text" }` и собирает 4
таргета). Tauri 2.x — **Фаза 2**, UX-обёртка (нативное окно, трей, auto-updater, единая точка
code-signing). Полировка, не фундамент.

### D7 — Жизненный цикл прогона поверх обрывов; клиент-коннект гейтит ЛЮБУЮ трату `[fix]`

Прогон живёт на сервере (event-sourced лог в Postgres). Инварианты:
- **Живой клиент-коннект + достаточный баланс — жёсткое условие для ЛЮБОЙ траты, не только
  Apple-fetch.** `rate/hypothesize/phrase` работают над уже добытыми данными и могли бы
  «убежать» и потратить токены после дисконнекта — запрещаем: нет живой сессии клиента → нет
  ни одного LLM-вызова. (Иначе нарушается `spec 04.4` «никаких сюрпризов с фоновой тратой».)
- **LLM-вызов — внешний side-effect; реплей его НЕ повторяет.** Перед вызовом Anthropic
  сервер пишет `dispatched`-событие с идемпотентным ключом (`run_id+step_seq`) и **передаёт
  этот ключ как idempotency key в запрос Anthropic**; результат персистится ДО advance
  состояния. Реплей после рестарта читает персиснутый результат, не зовёт провайдера заново.
  (Иначе рестарт посреди LLM-вызова = двойной COGS при однократном user-debit.)
- **Клиент отвалился** → Apple-fetch невозможен → авто-`paused`; реконнект: клиент шлёт
  выполненные `job_id`, сервер дедуплицирует. **Недоделанная ProbeJob** (часть префиксов
  фетчена, но `job.result` не отправлен) не в списке выполненных → джоба пере-диспатчится
  целиком; сервер те префиксы во write-through не писал → клиентский локальный кэш (D3)
  спасает от повторного удара по Apple. (Опц.: клиент стримит частичные raw, чтобы кэшировать
  готовые префиксы.)
- **Браузер закрыли** → прогон продолжается (клиент-программа на связи); открыли снова → SSE
  реаттач `Last-Event-ID` → replay-then-tail. **SSE релеится через программу (D1): если
  программа рестартнула — браузерный стрим переустанавливается; авторитетен `run_events.seq`
  сервера, не локальный.**
- **Программа закрыта целиком** → как «клиент отвалился»: `paused`, ноль фоновой траты.
- **nonce-кэш анти-replay** (`ARCHITECTURE §5`) в памяти теряется при рестарте → окно ±5м;
  на Фазе 4 — общий store, либо привязать окно к per-connection epoch.

### D8 — localhost-guard: Host-allowlist + Origin, не только токен `[fix]`

Localhost «доверен» лишь условно. Токен в HTML **не закрывает** названную им же угрозу:
любой co-resident процесс просто `GET /` и выскребает токен из тела. И не защищает от
**DNS-rebinding** (после ребиндинга атакующий домен = same-origin, читает HTML, берёт токен).
Поэтому guard = три слоя:
1. **Строгий Host-allowlist** — отвергать любой `Host` ≠ `127.0.0.1:PORT`/`localhost:PORT`.
   Это и есть настоящая защита от DNS-rebinding.
2. **Origin-проверка** на всех state-changing маршрутах (бьёт blind-CSRF).
3. **Per-launch токен** в HTML — против наивного CSRF.
**Остаточный риск, заявленный явно:** co-resident локальный процесс может выскрести токен —
токеном это не закрыть в принципе; это вне модели угроз localhost-инструмента.

### D9 — Промпты в UI не показываем ВООБЩЕ (решение принято) `[fix]`

`spec` principle 2 / `07.5` требовали раскрывать каждый LLM-вызов до полного системного и
пользовательского промпта. В коммерческой версии это **отменяется полностью**: промпты —
moat, клиент недоверен, лишней инфы пользователю не даём.

**Решение (окончательное):** облачный LLM-журнал **не содержит ни системного, ни
пользовательского промпта, ни в каком виде** — ни тела, ни «редактированной» версии, ни
намёка. Пользователю показываем только **результат работы** (то, что ему полезно и на что он
платит): оценки `R + reason` по кейвордам, сгенерированные гипотезы, финальные title/subtitle,
плюс суммарные токены/стоимость прогона. Всё это — выходы модели и метрики, не промпты.
**Прозрачность ЧИСЕЛ при этом полная:** raw SERP/подсказки и объяснение «P=80, потому что
префикс "habi"…» релеятся свободно (сырые данные Apple — не moat). Промпты физически живут
только в приватном репозитории `server` (D5) и наружу не пересекают границу сервера никогда.

---

## 2. Целевая топология (вариант β)

```
┌───────────────────── МАШИНА пользователя (недоверенная) ──────────────────────┐
│  Браузер: localhost-UI (@aso/web-ui) — прогоны, кейворды, сборка, баланс       │
│     │  HTTP + SSE, only 127.0.0.1, Host-allowlist + Origin + per-launch token (D8)
│     ▼                                                                          │
│  ЛОКАЛЬНАЯ ПРОГРАММА (@aso/client, Bun-бинарь; опц. Tauri в Фазе 2):            │
│    ├─ localserver: отдаёт @aso/web-ui + реле-API/SSE к облаку (D1)             │
│    ├─ cloud-link: WSS в облако, session-token из secure-store                  │
│    ├─ apple-exec: исполняет Probe/Serp/Hints-джобы через @aso/apple (D2)       │
│    │     (троттл per-IP, полный-префикс-shortcut, ранняя остановка, СЫРЬЁ)     │
│    └─ activation: ключ → session-token, OS keychain                            │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ WSS (команды/джобы/прогресс) + HTTPS (актив., top-up)
┌──────────────────────────── ОБЛАКО: @aso/server (доверенный) ─┴─────────────────┐
│  orchestrator  — машина состояний + expander (@aso/core), event-sourced;        │
│                  Apple-I/O через apple-dispatch, pause-at-job-boundary (D7)      │
│  apple-dispatch— общесетевой кэш сырья (D3) + очередь джоб + WSS-канал клиентам  │
│  llm-proxy     — промпты из @aso/core, вызов Anthropic api_key, метрик КАЖДОЙ    │
│                  попытки, prompt-caching, микро-резерв+hard-stop (D4), idem-key  │
│  billing       — wallet+ledger (истина), микро-резерв/settle (D4), per-run floor │
│  auth          — ключ→session-token, device-binding, HMAC, отзыв, rate/user      │
│  db            — Postgres: users, licenses, wallet, ledger, llm_steps, runs,     │
│                  run_events(event-log), jobs, apple_cache, processed_events      │
└──────────────────────────────────────────────────────────────────────────────────┘
        Apple (autocomplete + search) ◄── fetch с IP ПОЛЬЗОВАТЕЛЯ (cache-hit = нет fetch)
```

---

## 3. Репозиторий и все сабмодули (полирепо, git submodules) `[fix]`

Суперпроект `asoptimus/` + 4 git-сабмодуля (D5). `S` = серверный репо, `C` = клиентский репо,
`∘` = shared. **Границы moat’а физические: файлы `core/` и `prompts/` существуют ТОЛЬКО в
приватном репо `server`.**

```
asoptimus/                        ← СУПЕРПРОЕКТ (git): планы, infra, .gitmodules
├── BUILD-PLAN.md / ARCHITECTURE.md / PRODUCT.md / LANDING-ADDITIONS.md
├── .gitmodules                   # регистрация 4 сабмодулей (URL под github.com/enkunove/asoptimus-*)
├── SETUP-SUBMODULES.md           # одноразовые команды: создать remotes + submodule add + nested shared
├── infra/                        # docker-compose (server+postgres), deploy (Railway/Fly), CI-matrix
│
├── shared/   → сабмодуль asoptimus-shared      ∘  @aso/shared — контракт, zero-I/O, zero-secret
│   └── src/{types.ts, protocol.ts, constants.public.ts, storefronts.public.json, index.ts}
│        # types (из aso-util/src/types.ts); protocol (Probe/Serp/HintsJob, JobResult, SSE — §4);
│        # storefronts.public = ТОЛЬКО {country→id, primaryLanguage}; НЕ класть extraLocale/веса/формулы
│
├── server/   → сабмодуль asoptimus-server (ПРИВАТНЫЙ)   S  мозг + касса, долгоживущий процесс
│   ├── shared/  (вложенный сабмодуль asoptimus-shared; импорт как @aso/shared)
│   └── src/
│      ├── core/                  # @aso/core — ПРОПРИЕТАРНО, zero-I/O:
│      │   ├── metrics/{popularity,difficulty,score}.ts  # P/L/rank/childCount/seenTerms из сырья; D; Score
│      │   ├── assembly/{folding,select,place,validate}.ts # 05.3–05.7 (+X4)
│      │   ├── expander.ts        # planWave/runWave → ЭМИТИТ Hints-джобы (из src/pipeline/expander.ts)
│      │   ├── locales.ts         # extraLocale-таблица (05.9) + placement-веса (05.2) — server-only
│      │   ├── prompts/*.md       # context/seeds/rate/hypothesize/phrase — moat (из src/llm/prompts/*)
│      │   └── llm-schemas.ts     # JSON-схемы выходов (06.3)
│      ├── orchestrator/          # машина состояний (рефактор src/pipeline/orchestrator.ts):
│      │      # pure-функции 1:1; loop + getPopularity/runWave → async job emit/await,
│      │      # pause-at-job-boundary, disconnect-resume (control-flow inversion, §7)
│      ├── apple-dispatch/        # кэш D3 + очередь джоб + WSS-канал + идемпотентность (D7)
│      ├── llm-proxy/             # сборка промптов + Anthropic api_key + метрик КАЖДОЙ попытки (D4)
│      ├── billing/               # wallet+ledger, микро-резерв/settle (D4), live-price, per-run floor
│      ├── auth/                  # ключ→session-token, device-bind, HMAC, отзыв, rate/user
│      ├── stripe/               # Checkout top-up, вебхуки (идемпотентные), Meter
│      ├── db/                    # схема, миграции, репозитории, pg-boss/graphile-worker
│      ├── api/                   # REST (актив./баланс/top-up) + SSE прогресса + WSS роутер
│      └── main.ts                # Bun.serve (HTTP+WSS), graceful shutdown
│
├── client/   → сабмодуль asoptimus-client   C  скачиваемая программа (bun build --compile)
│   ├── shared/  (вложенный сабмодуль asoptimus-shared; импорт как @aso/shared)
│   └── src/
│      ├── apple/                 # @aso/apple — примитивы fetch, БЕЗ метрик:
│      │   ├── http.ts            #   token-bucket, ретраи/backoff, локальный кэш (из src/http.ts)
│      │   ├── hints.ts / search.ts #  fetch+parse сырья (из src/apple/*)
│      │   └── probe.ts           #   НОВОЕ: исполнитель ProbeJob (полный-префикс-shortcut →
│      │        #                       лестница early-stop → childTerms; возврат сырья) (D2)
│      ├── cloud-link.ts          # WSS-клиент: session-token, приём джоб, отдача сырья, реле прогресса
│      ├── apple-exec.ts          # маршрутизация Probe/Serp/Hints → apple/ (D2)
│      ├── localserver.ts         # отдаёт web-ui + реле-API/SSE ↔ облако (D1) + guard (D8)
│      ├── activation.ts          # ключ → session-token; secure-store
│      ├── web-ui/                # @aso/web-ui — localhost-UI (vanilla, без сборки; 07/08):
│      │   └── index.html/app.js/styles.css  # + логин-по-ключу, баланс, top-up; говорит ТОЛЬКО с localhost
│      ├── main.ts / build.ts     # свободный порт, health-check, открыть браузер, 4 таргета
│      └── (Фаза 2) desktop/      # ОПЦ.: Tauri 2.x шелл, этот бинарь как sidecar
│
└── landing/  → сабмодуль asoptimus-landing   asoptimus.com (есть): оффер, кнопки скачивания,
        # email-capture → Customer+wallet, письмо с ключом. Что добавить — LANDING-ADDITIONS.md
```

**Границы (moat/корректность) — теперь на уровне репозиториев:**
- `core/` (формулы, expander-стратегия, `locales.ts`, `prompts/`) **физически только в приватном
  репо `server`**. Клиентский репо их не содержит — CI-граф не нужен, это структурная гарантия.
- Репо `client` содержит только fetch-примитивы + реле + UI. Полностью вскрытый — не выдаёт
  ничего проприетарного (D2/§1).
- `shared` — только wire-типы и ПУБЛИЧНЫЕ константы (ревью-инвариант: ни формул, ни весов, ни
  `extraLocale`). `storefronts.public` несёт лишь `{id, primaryLanguage}`; `extraLocale` (05.9)
  и placement-веса (05.2) — в `server/src/core/locales.ts`.

---

## 4. Wire-протокол «программа ↔ облако» (`@aso/shared/protocol.ts`) `[fix]`

Два канала: **WSS** (команды/джобы/прогресс) и **HTTPS** (активация, top-up-redirect).
Аутентификация: `session-token` при коннекте; каждое сообщение — HMAC + timestamp(±5м) +
nonce (`ARCHITECTURE §5`).

**Клиент → сервер:** `hello{session_token, device_fp, resume_job_ids[]}` ·
`run.create{brief, config}` · `run.control{run_id, action}` · `job.result{job_id, kind, raw}`
· `job.error{job_id, reason, throttle?}`.

**Сервер → клиент:** `job.dispatch(Probe|Serp|Hints)` · `run.progress{run_id, seq, event}` ·
`run.phase{run_id, phase, counters}` · `run.paused{run_id, reason}` · `balance{credits}`.

**Джоб-типы (сервер решает ЧТО, клиент — КАК; сырьё, не метрики):**
```ts
type RawHints = string[]                        // упорядоченные подсказки одного запроса
type ProbeJob = { job_id, kind:'probe', run_id, keyword, storefront,
                  prefixLadder: string[],       // ['k','ke','key',… ,keyword] — детерминирован из keyword
                  prefill: Record<string,RawHints> }   // кэш D3 (с контентом, для локальной ранней остановки)
type ProbeResult = { job_id, kind:'probe',
                  fetched: Record<string,RawHints>,    // ТОЛЬКО реально фетченные префиксы (полные массивы)
                  childTerms: RawHints | null,         // подсказки на "keyword " (null если unsuggested)
                  unsuggested: boolean }
type SerpJob  = { job_id, kind:'serp',  run_id, query, storefront, lang }   // → сырой Search JSON
type HintsJob = { job_id, kind:'hints', run_id, term, storefront }          // дети лидеров / alphabet-soup
```
Сервер над `prefill ∪ fetched` считает `L/rank` (а `childCount` — из `childTerms`), и
**харвестит `seenTerms` (объединение всех подсказок) в новые кандидаты `source="suggest"`** (это питает цикл гипотез —
без полных массивов в `fetched` харвест невозможен). `job.error{throttle}` → серверный
back-pressure (аналог `runWave` «break on throttle» из `expander.ts`).

**Браузер ↔ localhost** (реле D1, как `spec/07.2`): те же `/api/runs`, `/api/runs/:id[/keywords|/control]`,
`/api/events`(SSE), `/api/balance`, `/api/topup`(→ Stripe Checkout URL) — но программа не
исполняет их локально, а транслирует в WSS и стримит ответ обратно.

---

## 5. Модель данных (Postgres, `@aso/server/db`) `[fix]`

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| `users` | `id, email, stripe_customer_id` | идентичность |
| `licenses` | `key_hash, user_id, device_fp, status, revoked_at` | ключ→юзер, device-bind, отзыв |
| `wallet` | `user_id PK, balance_credits` | баланс — **источник истины** (D4); списание под `FOR UPDATE` |
| `ledger` | `id, user_id, delta, type, run_id, step_seq, stripe_event_id, ts`, **`UNIQUE(run_id, step_seq)` (для debit/settle)**, `stripe_event_id UNIQUE` | иммутабельный журнал; идемпотентность списания и грантов |
| `llm_steps` | `run_id, logical_step, step_seq, request_hash, result_json\|null, valid bool, usage, ts`, `PK(run_id, step_seq)` | каждая billable-попытка = строка (в т.ч. невалидные); **advance/реплей по последней `valid` строке логического шага** — Anthropic не зовётся заново (D7) |
| `processed_events` | `stripe_event_id UNIQUE` | идемпотентность вебхуков |
| `runs` | `id, user_id, phase, config, context, final, usage` | шапка прогона |
| `run_events` | `run_id, seq, ts, event` | **event-sourced** лог (реплей, SSE, `Last-Event-ID`) |
| `jobs` | `job_id, run_id, kind, payload, status, result, deadline` | очередь Apple-джоб, идемпотентность (D7) |
| `apple_cache` | `cache_key PK, url, storefront, status, body, fetched_at` | общесетевой кэш сырья (D3), TTL |

`step_seq` — серверный монотонный счётчик **на billable-попытку** (не на логический шаг), см.
D4. Очередь джоб — `FOR UPDATE SKIP LOCKED`. Один инстанс на старте → sticky-WS не нужен.

---

## 6. Поток одного прогона (сшитый с D1–D9)

```
1. Браузер → localhost (Host-allowlist+Origin+token, D8): POST /api/runs {brief, config}
2. Программа (cloud-link) → облако (WSS, session-token+HMAC): run.create
3. Сервер(auth): токен ок? → START-FLOOR атомарно (D4); мало → run.paused("пополните")
4. context: llm-proxy (микро-резерв → dispatched-событие+idem-key → Anthropic api_key →
   метрик КАЖДОЙ попытки → settle к факту, D4; результат в llm_steps ДО advance, D7) → context_review
5. Браузер подтверждает контекст → seeding → loop:
     P/D: orchestrator+expander эмитят Probe/Serp/Hints-джобы. apple-dispatch: кэш D3 → промахи
       в job.dispatch (probe с prefill). apple-exec: полный-префикс-shortcut → early-stop →
       childTerms → ProbeResult(сырьё). Сервер: L/rank/childCount над prefill∪fetched, харвест
       seenTerms, write-through кэш.
     rate/hypothesize: llm-proxy (микро-резерв → hard-stop → idem-вызов → per-attempt debit).
     ЛЮБАЯ трата requires живой клиент-коннект (D7).
   Прогресс: run.progress/phase → релей в браузерный SSE (authoritative run_events.seq).
6. improving (04.2) → assembling: @aso/core greedy+place, 2 корзины; phrase-вызовы; validate
   (T/S/K/X/W/X4). → done.
7. SETTLE: вернуть остаток floor, финальная строка ledger, отчёт в Stripe Meter.
```

Ни один шаг невозможен без сервера: Apple-джобы шлёт он, LLM-ключ только у него, кредиты
одобряет он, а трата ещё и требует живого клиента. Клиент простаивает без коннекта/баланса.

---

## 7. Что переезжает из aso-util (пофайлово, честно про сложность) `[fix]`

| aso-util | Куда | Сложность переноса |
|---|---|---|
| `src/types.ts` | `@aso/shared/types.ts` | тривиально; + wire-типы в `protocol.ts` |
| `src/http.ts`, `apple/hints.ts`, `apple/search.ts` | `@aso/apple/*` | почти 1:1; + новый `probe.ts` (D2) |
| `apple/storefronts.json` | split: `@aso/shared/storefronts.public.json` (id+lang) + `@aso/core/locales.ts` (extraLocale) | лёгкий split |
| `metrics/*.ts` (чистые: `popularityScore`, `computeDifficulty`, `opportunityScore`) | `@aso/core/metrics/*` | **1:1** (чистые функции) — но вход теперь сырьё из джоб |
| `assembly/*.ts` (`selectWords`, `placeWords`, `validate`, `foldKey`) | `@aso/core/assembly/*` | **1:1** (уже чистые) |
| `pipeline/expander.ts` `planWave` (чистая) | `@aso/core/expander.ts` | 1:1 |
| `pipeline/expander.ts` `runWave` (сетевой, inline-blocking) | `@aso/server` | **переписать** в async job-emit; «break on throttle» → server back-pressure |
| `metrics/popularity.ts` `SuggestPopularityProvider.getPopularity` (сетевой) | расщепляется: клиентский probe-исполнитель (`@aso/apple`) + серверный расчёт (`@aso/core`) | **переписать** (сеть ↔ расчёт разъезжаются по машинам) |
| `pipeline/orchestrator.ts` (1339 стр) | `@aso/server/orchestrator/*` | **самый тяжёлый кусок:** loop сейчас `await fetch → raw+метрики inline` + конкурентный `rateInFlight` промис во время probing + `checkPause()`→`PauseInterrupt`. Всё это → event-driven scatter/gather с pause-at-job-boundary и disconnect-resume. **Это control-flow inversion, не «режем на модули».** Бюджетировать Фазу 3 соответственно. |
| `pipeline/controls.ts` | `@aso/server/orchestrator/controls.ts` | 1:1, но guard’ы (`≥30 sample` и пр.) — серверные |
| `llm/prompts/*`, `schemas.ts` | `@aso/core/prompts/*`, `llm-schemas.ts` | ПРОПРИЕТАРНО, только сервер |
| `llm/claude.ts` | `@aso/server/llm-proxy/*` | сервер, api_key; клиентский subscription/BYO — **удаляется**; цена — live, не хардкод; метрик КАЖДОЙ попытки (D4) |
| `llm/adapter.ts` | `@aso/server/llm-proxy/adapter.ts` | реестр остаётся; auth серверная |
| `server/routes.ts`, `sse.ts` | split: `@aso/server/api` (облако) + `@aso/client/localserver` (реле+guard D8) | средне |
| `server/public/*` | `@aso/web-ui/*` | + логин-по-ключу, баланс, top-up; LLM-журнал по D9 (только ответы+числа, промптов НЕТ) |
| `store/*` | `@aso/server/db` | прогоны → Postgres; локально — лишь опц. Apple-кэш |
| `main.ts`, `build.ts` | `@aso/client/*` | 1:1 |

Юнит-тесты `aso-util/test/*` едут с модулями: метрики/сборка → `@aso/core` (сходятся 1:1),
адаптер → `@aso/server`.

---

## 8. Порядок стройки (фазы) `[fix]`

Полирепо-сабмодули (D5) делают «тонкий клиент / толстый сервер» естественной формой с первого
дня — поэтому **прежний компромисс «метрики/expander временно в клиенте» отменён**: вся логика
серверная сразу (иначе она бы физически оказалась в клиентском репо — противоречие D5). Это
поднимает объём Фазы 1, но убирает грязную миграцию и закрывает дыру форжинга счёта клиентом.

- **Фаза 0 — валидация спроса (сейчас).** aso-util живёт как free локальная бета для
  лендинга/waitlist. Коммерцию не строим без сигнала спроса.
- **Фаза 1 — вертикальный срез «тонкий клиент, деньги гейтятся».** Три репо (`shared/server/
  client`) стоят. Сервер держит **ВСЮ** логику: `core` (metrics/assembly/expander/prompts) +
  orchestrator (job-dispatch, §7 inversion) + llm-proxy (Anthropic api_key, метрик каждой
  попытки, D4) + billing (wallet+ledger с `UNIQUE(run_id,step_seq)`, микро-резерв/settle,
  llm_steps) + auth (ключ→session-token) + apple-dispatch (кэш D3, очередь джоб) + один Stripe
  Checkout+вебхук. Клиент: apple-exec (D2) + cloud-link + localserver (guard D8) + web-ui
  (логин/баланс/top-up) + activation. **Без Tauri** — просто localhost-бинарь.
  **Инвариант биллинга:** авторитет по счёту только серверный — сервер выдаёт `run_id`/
  `step_seq`, **сериализует** LLM-вызовы кошелька (`FOR UPDATE`), списывает по СВОЕМУ usage,
  никогда по числам клиента.
- **Фаза 2 — десктоп-обёртка (D6).** Tauri-шелл + sidecar (этот же бинарь), подпись/
  нотаризация 3 ОС, auto-updater, кнопки скачивания + письмо с ключом, экран баланса/top-up.
- **Фаза 3 — масштаб/страховка.** Второй инстанс + шина WS (Redis pub/sub), durable-стрим,
  персист nonce-кэша, ASA-провайдер (вторая нога против смерти Apple-эндпоинта), мониторинг
  позиций как апселл.

**DoD Фазы 1:** новый ключ → активация → бриф → прогон, который **физически невозможен без
сервера** (Apple-джобы шлёт сервер, LLM-ключ только у сервера, кредиты одобряет сервер);
**сервер списывает инкрементально по СВОЕМУ usage, сериализованно, без гонок и недоборов**; на
нуле — честный `paused`; top-up через Stripe пополняет; рестарт сервера посреди LLM-вызова не
двоит COGS (llm_steps); вскрытый клиент не содержит ни формул, ни промптов (D5). Один VPS +
Postgres, Stripe test→live.

---

## 9. Риски и открытые решения

**Риски (по убыванию):**
1. **Экономика LLM + чарджбэки** — маржа-на-покупке, микро-резерв+per-attempt debit+
   `UNIQUE(run_id,step_seq)`+llm_steps (D4/D7), per-run floor, live-price, Radar, кап top-up.
2. **Смерть недокументированного Apple-эндпоинта** — ASA-провайдер как вторая нога (Фаза 4);
   D3-кэш смягчает частоту.
3. **Латентность под троттлингом** — D2 (джоба=кейворд, полный-префикс-shortcut) + D3 (hit=0
   fetch) держат прогон throttle-bound ~35–55 мин (`spec 04.6`); честный стрим прогресса (D7).
4. **Защита логики** — принципиально неполна; MVP-компромисс Фазы 1 (но со СЕРВЕРНЫМ счётом),
   полный разворот Фазы 3.
5. **Сложность рефактора оркестратора** (§7) — недооценивать нельзя; это control-flow inversion.
6. **Оверинжиниринг** — Postgres-очередь + один контейнер закрывают всё до десятков тысяч
   джоб/сек.

**Решено:** (D9) промпты в UI не показываются вообще — окончательно.

**Открытые решения (за пользователем):**
- Лицензирование: self-host Keygen vs Merchant-of-Record (Paddle/Lemon Squeezy — мировой налог).
- Кредит: 1 = $0.01 (прозрачно) vs абстрактный (гибче в маркетинге, легче ошибиться в марже).
- Windows-подпись: Azure Trusted Signing (если доступен физлицу) vs OV-cert+HSM.
- Насколько рано разворот (Фаза 3) — зависит от угрозы клонирования.
- Free-tier новым ключам — снижает трение vs абьюз генерацией ключей (тогда привязка к
  verified-email/карте).
