# ASOptimus — суперпроект (полирепо)

Коммерческая версия ASO-инструмента: тонкий локальный клиент + толстый облачный сервер.
Форма — «скачанная программа поднимает localhost-UI и делает Apple-запросы; ВСЯ остальная
логика на сервере» (BUILD-PLAN D1).

## Планы (читать в этом порядке)
- **`BUILD-PLAN.md`** — источник истины по стройке: 9 решений, топология, сабмодули,
  wire-протокол, модель данных, фазы. При расхождении верен он.
- `ARCHITECTURE.md` — обоснования/ресёрч (биллинг, лицензирование, подпись).
- `PRODUCT.md` — картина продукта и путь пользователя.
- `LANDING-ADDITIONS.md` — что добавить на лендинг.
- `SETUP-SUBMODULES.md` — как формализовать git-сабмодули против GitHub.

## Сабмодули
| Путь | Репо | Что | Приватность |
|---|---|---|---|
| `shared/` | asoptimus-shared | контракт: типы + протокол + публичные константы | public-safe |
| `server/` | asoptimus-server | мозг + касса (core, orchestrator, llm-proxy, billing, auth, db, api) | **PRIVATE (moat)** |
| `client/` | asoptimus-client | локальная программа (apple-fetch, cloud-link, localserver, web-ui) | аудируемый |
| `landing/`| asoptimus-landing | лендинг | public |

`shared` включается в `server` и `client` через tsconfig-alias `@aso/shared → ../shared/src`
(при разработке из суперпроекта). Формализация сабмодулей — `SETUP-SUBMODULES.md`.

## Границы (moat — структурные)
Формулы, expander, `locales.ts`, `prompts/` — **только** в приватном `server/src/core`.
В `client` их нет как файлов. `shared` — только контракт, zero-secret.

`_legacy/` — старая монолитная копия aso-util (справочно для порта; канонический источник —
соседний `/Users/enkunove/aso-util`).
