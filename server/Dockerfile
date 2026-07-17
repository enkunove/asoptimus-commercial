# @aso/server — образ облачного сервера (Bun). МОНОРЕПО: контекст сборки = корень репозитория
# (см. infra/docker-compose.yml: context: .., dockerfile: server/Dockerfile). Контракт @aso/shared
# берётся из ./shared и резолвится tsconfig-алиасом ../shared/src. Bun исполняет TS напрямую.

FROM oven/bun:1
WORKDIR /app

# Манифест + лок сервера — слой зависимостей кэшируется отдельно от исходников.
COPY server/package.json server/bun.lock ./server/
RUN cd server && bun install --frozen-lockfile

# Контракт (@aso/shared) + исходники сервера.
COPY shared ./shared
COPY server/tsconfig.json ./server/
COPY server/src ./server/src

WORKDIR /app/server
ENV PORT=8787
EXPOSE 8787

# HTTP (REST + SSE) + WSS /ws. Секреты/конфиг — через env (см. infra/.env.example).
# migrate-сервис использует этот же образ и запускает `bun run migrate`.
CMD ["bun", "run", "src/main.ts"]
