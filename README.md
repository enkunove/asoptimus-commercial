# ASOptimus — commercial (монорепо)

Коммерческая версия ASO-инструмента: тонкий локальный клиент + толстый облачный сервер.
Форма — «скачанная программа поднимает localhost-UI и делает Apple-запросы; ВСЯ остальная
логика на сервере» (BUILD-PLAN D1). Один репозиторий, обычные папки.

> **Приватность:** этот репозиторий обязан быть **private** — в `server/` лежит весь moat
> (формулы, expander, промпты). Публичным делать нельзя.

## Планы (читать в этом порядке)
- **`BUILD-PLAN.md`** — источник истины по стройке: решения, топология, wire-протокол,
  модель данных, фазы. При расхождении верен он. (Структура репо в D5 описана как полирепо-
  сабмодули — это **устарело**, выбран монорепо; см. раскладку ниже.)
- `ARCHITECTURE.md` — обоснования/ресёрч (биллинг, лицензирование, подпись).
- `PRODUCT.md` — картина продукта и путь пользователя.
- `INTEGRATION.md` — лог сведения клиента и сервера.
- `LANDING-ADDITIONS.md` — что добавить на лендинг (лендинг — отдельный репозиторий).

## Раскладка (папки монорепо)
| Папка | Что | Границы |
|---|---|---|
| `shared/` | контракт: домен-типы + wire-протокол + публичные константы (`@aso/shared`) | zero-secret |
| `server/` | **мозг + касса:** `core` (metrics/assembly/expander/**prompts**), orchestrator, llm-proxy, billing, auth, apple-dispatch, db, api | **весь moat здесь** |
| `client/` | **локальная программа:** apple-fetch, cloud-link, localserver, web-ui + `desktop/` (Tauri .dmg) | ноль проприетарной логики |
| `infra/` | docker-compose (сервер + Postgres), деплой, CI |  |

`server` и `client` берут контракт по tsconfig-алиасу `@aso/shared → ../shared/src`. Границы
moat теперь по папкам: формулы/expander/`locales.ts`/`prompts/` — только в `server/src/core`,
в `client/` их нет как файлов.

## Запуск
- **Сервер (хостинг):** `colima start` → `cd infra && cp .env.example .env` (вписать секреты) →
  `docker compose up --build -d` → `curl localhost:8787/health`. Docker-контекст = корень репо.
- **Клиент (dev):** `cd client && bun install && bun run dev` (localhost-UI).
- **Приложение (.dmg):** `cd client/desktop && bash scripts/build-dmg.sh both` (нужен Rust +
  Apple Developer сертификат для подписи).

Лендинг — отдельный репозиторий/деплой (`../asoptimus-landing`). `_legacy/` (gitignored) —
старая монолитная копия aso-util, справочно.
