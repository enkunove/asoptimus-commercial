# @aso/server — cloud server image (Bun). MONOREPO: build context = repo root
# (see infra/docker-compose.yml: context: .., dockerfile: server/Dockerfile). The @aso/shared contract
# comes from ./shared and resolves via the ../shared/src tsconfig alias. Bun executes TS directly.

FROM oven/bun:1
WORKDIR /app

# Server manifest + lockfile — the dependency layer is cached separately from sources.
COPY server/package.json server/bun.lock ./server/
RUN cd server && bun install --frozen-lockfile

# The contract (@aso/shared) + server sources.
COPY shared ./shared
COPY server/tsconfig.json ./server/
COPY server/src ./server/src

WORKDIR /app/server
ENV PORT=8787
EXPOSE 8787

# HTTP (REST + SSE) + WSS /ws. Secrets/config come via env (see infra/.env.example).
# The migrate service uses this same image and runs `bun run migrate`.
CMD ["bun", "run", "src/main.ts"]
