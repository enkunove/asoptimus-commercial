# infra — деплой всего проекта

Живёт в суперпроекте (оркестрирует связку server+postgres), не в модульных репо.

- `docker-compose.yml` — сервер (`server/`) + Postgres для dev/prod (BUILD-PLAN §7).
- `deploy/` — конфиг Railway/Fly/VPS (долгоживущий процесс: WSS/SSE не терпят serverless).
- `ci/` — GitHub Actions: деплой сервера + матрица сборки клиентских бинарей
  (`bun build --compile` под 4 таргета), в Фазе 2 — подпись/нотаризация.

Миграции БД лежат рядом со схемой в `server/src/db/` (запуск `bun run migrate`).
