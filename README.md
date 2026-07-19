# ASOptimus — commercial (monorepo)

Commercial version of the ASO tool: thin local client + fat cloud server.
Form factor — "a downloaded program brings up a localhost UI and makes the Apple requests; ALL other
logic lives on the server" (BUILD-PLAN D1). One repository, plain folders.

> **Privacy:** this repository must stay **private** — `server/` contains the entire moat
> (formulas, expander, prompts). It must never be made public.

## Plans (read in this order)
- **`BUILD-PLAN.md`** — source of truth for the build: decisions, topology, wire protocol,
  data model, phases. On any conflict, it wins. (The repo structure in D5 is described as polyrepo
  submodules — that is **outdated**; monorepo was chosen instead, see the layout below.)
- `ARCHITECTURE.md` — rationale/research (billing, licensing, code signing).
- `PRODUCT.md` — product picture and the user journey.
- `INTEGRATION.md` — log of wiring the client and server together.
- `LANDING-ADDITIONS.md` — what to add to the landing page (the landing is a separate repository).

## Layout (monorepo folders)
| Folder | What | Boundaries |
|---|---|---|
| `shared/` | contract: domain types + wire protocol + public constants (`@aso/shared`) | zero-secret |
| `server/` | **brain + till:** `core` (metrics/assembly/expander/**prompts**), orchestrator, llm-proxy, billing, auth, apple-dispatch, db, api | **the whole moat lives here** |
| `client/` | **local program:** apple-fetch, cloud-link, localserver, web-ui + `desktop/` (Tauri .dmg) | zero proprietary logic |
| `infra/` | docker-compose (server + Postgres), deploy, CI |  |

`server` and `client` consume the contract via the tsconfig alias `@aso/shared → ../shared/src`. The moat
boundaries are now folder-based: formulas/expander/`locales.ts`/`prompts/` live only in `server/src/core`;
`client/` has no such files at all.

## Running
- **Server (hosted):** `colima start` → `cd infra && cp .env.example .env` (fill in secrets) →
  `docker compose up --build -d` → `curl localhost:8787/health`. Docker context = repo root.
- **Client (dev):** `cd client && bun install && bun run dev` (localhost UI).
- **App (.dmg):** `cd client/desktop && bash scripts/build-dmg.sh both` (requires Rust +
  an Apple Developer certificate for signing).

The landing page is a separate repository/deploy (`../asoptimus-landing`). `_legacy/` (gitignored) —
the old monolithic copy of aso-util, kept for reference.
