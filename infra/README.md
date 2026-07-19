# infra — hosting the ASOptimus server

Everything needed to run the ASOptimus server + Postgres yourself: a
docker-compose stack, an env template, and CI definitions. Lives in the
superproject (it orchestrates the `server` submodule + Postgres); the modules
themselves stay in their own repos.

| File | What it is |
|---|---|
| `docker-compose.yml` | `server` + `postgres` + one-shot `migrate` (BUILD-PLAN §7/§9) |
| `.env.example` | every env var, grouped, marked prod-required / optional |
| `ci/` | GitHub Actions: server image build+push, client binaries + signed `.dmg`, `bun test` |
| `deploy/` | cloud deploy templates (Fly.io) |

The `server` image builds from `../server`, which ships its own Dockerfile
(Bun base, `EXPOSE 8787`). DB migrations live next to the schema in
`server/src/db/` and run via `bun run migrate`.

---

## Local hosting via Colima (macOS)

Prereqs (already installed on this machine): Colima + the Docker CLI with the
`compose` plugin. Everything below is run **from this `infra/` directory** so
that `./.env` is picked up for variable substitution.

```bash
# 1. Start the Docker VM (give it enough headroom for Postgres + Bun).
colima start --cpu 2 --memory 4

# 2. Configure. Copy the template and fill in the REPLACE_ME values.
cd infra
cp .env.example .env
$EDITOR .env            # at minimum set POSTGRES_PASSWORD; for real runs also
                        # ANTHROPIC_API_KEY (api-key!), PADDLE_*, SMTP_*, secrets

# 3. Build + start. Order is automatic: postgres (healthy) → migrate (exits 0)
#    → server. Migrations run every `up`; schema.sql is idempotent.
docker compose up --build -d

# 4. Verify.
curl -s localhost:8787/health           # -> {"ok":true,"ts":"..."}
docker compose ps                        # server should be "healthy"
docker compose logs -f server            # follow logs
```

The server prints its mode on boot, e.g.
`llm=anthropic db=postgres paddle=live apple=client-only` — a quick check that
your `.env` took effect (`mock`/`memory` mean that dependency is unset).

### Migrations

Migrations run automatically via the `migrate` service on every `up`. To run
them by hand (e.g. after editing `schema.sql`):

```bash
docker compose run --rm migrate          # applies server/src/db/schema.sql
```

### Everyday commands

```bash
docker compose ps                        # status + health
docker compose logs -f server            # tail server logs
docker compose restart server            # restart just the server
docker compose down                      # stop (keeps the pgdata volume)
docker compose down -v                   # stop AND delete the DB volume (wipes data)
docker compose up --build -d server      # rebuild after pulling new server code
psql "postgres://asoptimus:<pw>@127.0.0.1:5432/asoptimus"   # inspect (port is
                                         # bound to localhost in the compose file)
```

`colima stop` when you're done; the `pgdata` named volume survives restarts.

### Notes / gotchas

- **Run compose from `infra/`.** `./.env` is auto-loaded for `${VAR}`
  substitution based on the working directory; from elsewhere use
  `docker compose --env-file infra/.env -f infra/docker-compose.yml ...`.
- **`DATABASE_URL` is derived** from `POSTGRES_*` (→ the `postgres` service), so
  there's nothing to keep in sync. Set `DATABASE_URL` in `.env` only to point at
  an external DB (see below) — it then overrides the derived value.
- **`REQUIRE_CLIENT=1`** (the prod default in the template) means the server
  will not run Apple jobs itself — a real client program must connect over WSS
  and fetch from the user's IP (D1/D3). Leave it unset only for an offline
  mock/demo of the happy path.
- The bundled Postgres port is bound to `127.0.0.1` only. Comment that mapping
  out on a shared/public host if you don't need external psql access.

---

## Cloud deploy

The server is a **long-lived process** (WSS + SSE) — do **not** put it on a
serverless/request-scoped platform. Use a container host + managed Postgres.

### Managed Postgres

Point the server at any managed Postgres by setting `DATABASE_URL` (keep
`?sslmode=require`) and removing the `postgres` + `migrate` services from
`docker-compose.yml` (run migrations as a one-off release step instead):

- **Neon** / **Supabase** — serverless Postgres, free tier, copy the pooled
  connection string.
- **Fly Postgres** — `fly postgres create`, then `fly postgres attach`.

Run migrations once against the managed DB before first boot:

```bash
DATABASE_URL=postgres://…?sslmode=require  bun run migrate   # from server/
```

### Fly.io (recommended for a single always-on instance)

A starter `fly.toml` is in `deploy/fly.toml`. From the `server/` repo:

```bash
fly launch --no-deploy --copy-config --dockerfile Dockerfile   # uses server/Dockerfile
fly postgres create && fly postgres attach                     # sets DATABASE_URL
fly secrets set ANTHROPIC_API_KEY=… PADDLE_API_KEY=… PADDLE_WEBHOOK_SECRET=… \
                SMTP_HOST=… SMTP_PORT=587 SMTP_USER=… SMTP_PASS=… SMTP_FROM=… \
                JWT_SECRET=$(openssl rand -hex 32) HMAC_SECRET=$(openssl rand -hex 32) \
                REQUIRE_CLIENT=1
fly deploy
```

The single-instance assumption matches BUILD-PLAN §5 ("one instance → no
sticky-WS needed"). Multi-instance (Redis WS bus, durable stream) is Phase 3.

### Railway

New project → **Deploy from Repo** (the `server` repo) → it builds
`server/Dockerfile`. Add the **Postgres** plugin (injects `DATABASE_URL`). Set
the same secrets as above in the service Variables. Expose the service port
(`8787`) and use the generated domain for `PUBLIC_API_URL`/`PUBLIC_WSS_URL`.

### VPS with Docker

Any VM with Docker + the compose plugin runs this stack as-is:

```bash
git clone --recurse-submodules https://github.com/enkunove/asoptimus.git
cd asoptimus/infra
cp .env.example .env && $EDITOR .env      # real secrets; PUBLIC_* = your domain
docker compose up --build -d
```

Put a TLS terminator in front (Caddy/nginx/Traefik) that proxies `443 →
server:8787` and **upgrades WebSocket** on `/ws` (SSE on `/api/runs/:id/events`
needs buffering disabled — `proxy_buffering off;` in nginx). Point DNS
`api.asoptimus.com` at it.

---

## Env reference

See `.env.example` — every key is grouped and marked `[prod-required]`,
`[optional]`, `[dev-mock]`, or `(not-yet-wired)`. The values the server code
reads today: `PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `MODEL_PRICES_JSON`,
`PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `SIGNUP_FREE_CREDITS`,
`REQUIRE_CLIENT`. The SMTP / `PUBLIC_*` / `JWT_SECRET` / `HMAC_SECRET` keys are
staged for the features that consume them (§9 email, HMAC sessions) — set them
now so a real deploy is complete.
