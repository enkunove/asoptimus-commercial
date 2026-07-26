# 10 — Projects: the app-centric home system

## 0. Why (product thesis)

The flat runs list makes ASOptimus feel like a one-shot generator: run once for en-US, copy the
metadata, delete the app. The unit of value must shift from "a run's keyword list" to **a living
ASO composition of YOUR app** — the thing ASO giants (AppTweak, AppFollow, Asodesk) sell
subscriptions for. A **Project** is that composition:

- the **business context** (strategic brief) — extracted once, refined by the owner, reused by
  every run;
- the **metadata board** — per-locale title/subtitle/keywords slots assembled from runs, exactly
  like App Store Connect's localization list, with versioning and a "live" pointer;
- the **keyword bank** — every phrase ever measured for this app, deduped per storefront+language,
  with latest metrics and pin/hide curation;
- **positions** — measured proof: where the app actually ranks for its target phrases (fetched
  from the user's own IP through the connected client, our structural moat);
- the **run history** that feeds all of the above.

### The retention flywheel

1. First run (en-US) fills 1 slot of the locale grid. The grid renders **all** slots — 1 filled,
   the rest empty with a credits estimate each. Remaining value is always visible and quantified.
2. Next-best-actions ranks the empty slots (market tiers + cross-localization bonuses — es-MX
   also indexes extra EN keywords on the US storefront, etc.) and staleness ("en-US researched
   62 days ago — the suggest index moved; refresh for ≈N cr").
3. Ship the metadata (copy-ready export) → **mark version live** → "check positions" verifies
   rankings for pennies (no LLM, client-side Apple fetches) → deltas accumulate → reasons to
   return keep regenerating.
4. The bank grows monotonically. Deleting the app = losing the bank + position history.

A beta user with 30 credits sees, after their first ~6-credit run: a board with one locale done,
three ranked suggestions with prices, and a rank-check button. Nothing about that says "done".

## 1. Data model (Postgres; NO migration of old data — the DB is wiped, see §8)

```sql
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,                   -- proj_<uuid>
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,                      -- display name ("NoBettr")
  brand         TEXT NOT NULL DEFAULT '',           -- brand word(s) used in titles
  app_store_id  BIGINT,                             -- trackId (optional; unlocks Positions)
  context       JSONB,                              -- BusinessContext (null until first run confirms)
  versions      JSONB NOT NULL DEFAULT '[]',        -- MetadataVersion[] (append-only, cap 100)
  live_version  INTEGER,                            -- version marked as shipped (null = none)
  archived      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects (user_id);

CREATE TABLE IF NOT EXISTS project_keywords (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storefront  TEXT NOT NULL,                        -- country code ("us")
  language    TEXT NOT NULL,                        -- semantic language ("en")
  keyword     TEXT NOT NULL,
  metrics     JSONB NOT NULL,                       -- {P,D,R,score,status,reason,runId,ts} — latest
  pinned      BOOLEAN NOT NULL DEFAULT false,
  hidden      BOOLEAN NOT NULL DEFAULT false,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, storefront, language, keyword)
);

CREATE TABLE IF NOT EXISTS project_positions (
  id          BIGSERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storefront  TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  position    INTEGER,                              -- 1-based in the SERP; NULL = not in top serpTop*2
  serp_size   INTEGER,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_positions_idx ON project_positions (project_id, storefront, keyword, checked_at);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS project_id TEXT;   -- required for NEW runs (enforced in code)
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs (project_id);
```

`MetadataVersion` (JSONB element of `projects.versions`):

```ts
interface MetadataVersion {
  v: number;                    // 1-based, monotonic
  ts: string;                   // ISO
  note: string;                 // user note or auto ("from run <slug>", "rollback of v3")
  source: { type: "run" | "manual" | "rollback"; runId?: string; fromV?: number };
  locales: Record<string, { title: string; subtitle: string; keywords: string }>;
  // FULL snapshot of every covered locale (not a delta). Locale keys are assembly bucket
  // locales: "en-US", "es-MX", … (primary = `${semanticLanguage}-${COUNTRY}`, extra =
  // core/locales.ts extraLocaleFor).
}
```

MemoryStore mirrors all of this (used by tests and DEV).

## 2. Project lifecycle & run integration

- **Create project**: name (required), brand (required — it was previously part of run config;
  run config keeps `brand` but the form pre-fills from the project), optional App Store URL/id
  (parse trackId out of an `apps.apple.com` URL or a bare number).
- **Runs require `projectId`** (`run.create` message gains `project_id`; reject without it; the
  run row stores it). The run form lives INSIDE a project.
- **Context seeding**: if `project.context` is set, `createRun` copies it into the run state
  before start; `phaseContext` then SKIPS the LLM extraction (emit "using project context") and
  goes straight to `context_review` — the user can still tweak the copy for this run. If
  `project.context` is null (first run), extraction works as today, and **on confirmContext the
  confirmed context is saved to the project** (only if the project's is still null — no clobber).
  Project context is edited any time in Project Settings (structured editor per field); the
  editor is the ONLY place that mutates it after that.
- **On run completion** (manager.finishRun):
  1. **Bank upsert**: every keyword with measurements (metrics.D ≠ null, any status incl.
     excluded) → upsert into `project_keywords` under (config.country, config.semanticLanguage);
     update `metrics`+`updated_at`, PRESERVE `pinned`/`hidden`, keep `first_seen`.
  2. The run's `final` (AssemblyResult) becomes an **apply proposal** surfaced on the run screen
     and the project Overview ("Run <slug> produced metadata for en-US, es-MX — review & save").
- **Apply to project** (explicit user action, per-field selection): given runId + selection
  `{locale: {title?: bool, subtitle?: bool, keywords?: bool}}` + optional inline edits, build the
  next `MetadataVersion` = previous snapshot ⊕ selected fields (⊕ edits), source `run`. Nothing
  is auto-applied — the user chooses what to keep.
- **Manual edit**: Overview "Edit" per locale opens the three fields (char meters against
  config.limits) → new version, source `manual`.
- **Rollback**: any version → "Restore" creates a NEW version copying it (append-only history,
  no rewrites), source `rollback`/`fromV`.
- **Mark live**: sets `live_version` (badge "LIVE" on that version; Overview shows "live vs
  draft" diff hint when the latest version ≠ live). This is the release-cycle hook.
- **Delete/archive**: archive hides from the home grid (reversible); delete cascades (confirm
  modal typing the name; runs keep rows but are orphaned — hide them from lists).

## 3. Positions (rank verification — requires app_store_id and a connected client)

- Tracked set per storefront = phrases of the CURRENT version's locales for that storefront ∪
  pinned bank keywords (cap 50 per check; UI shows the set and lets the user tune pins first).
- "Check positions" → server dispatches FRESH SerpJobs through the user's client (AppleGateway
  needs a `fresh` option that bypasses the cache read; cache write stays), position = 1-based
  index of `app_store_id` in results (search depth: `serpTop×2`, i.e. limit 25 SERP as cached —
  use the raw results length we already get); NULL when absent.
- Each check appends `project_positions` rows → history; UI renders latest + sparkline deltas
  ("↑3", "new", "lost").
- **Fee**: `positionsPerKeyword` (default **0.002 cr**, flat, no model multiplier — override via
  env `POSITIONS_FEE`) × keywords checked, debited via the D4 v5 engine in one ledger row:
  `billing.chargeKeyphrase(userId, "proj:"+projectId, "pos:"+checkId, n×fee)` (checkId =
  uuid; ledger.run_id holds the `proj:` pseudo-id — TEXT, no FK). Insufficient → the check is
  rejected with a top-up nudge (no partial checks).

## 4. Next-best-actions (server-computed, part of the `project` query payload)

Extend `core/locales.ts` with a curated market table (order = priority):

```ts
export interface MarketSlot { locale: string; country: string; language: string; name: string; tier: 1|2|3; note: string; }
export const MARKETS: MarketSlot[] = [
  { locale: "en-US", country: "us", language: "en", name: "United States", tier: 1, note: "the largest store" },
  { locale: "ja-JP", country: "jp", language: "ja", name: "Japan", tier: 1, note: "2nd by revenue; low English competition" },
  { locale: "de-DE", country: "de", language: "de", name: "Germany", tier: 1, note: "largest EU store" },
  { locale: "en-GB", country: "gb", language: "en", name: "United Kingdom", tier: 1, note: "distinct suggest index from the US" },
  { locale: "fr-FR", country: "fr", language: "fr", name: "France", tier: 2, note: "" },
  { locale: "ko-KR", country: "kr", language: "ko", name: "South Korea", tier: 2, note: "" },
  { locale: "es-MX", country: "mx", language: "es", name: "Mexico (Spanish)", tier: 2, note: "es-MX also indexes on the US storefront" },
  { locale: "pt-BR", country: "br", language: "pt", name: "Brazil", tier: 2, note: "" },
  { locale: "it-IT", country: "it", language: "it", name: "Italy", tier: 3, note: "" },
  { locale: "es-ES", country: "es", language: "es", name: "Spain", tier: 3, note: "" },
  { locale: "nl-NL", country: "nl", language: "nl", name: "Netherlands", tier: 3, note: "" },
  { locale: "ru-RU", country: "ru", language: "ru", name: "Russia", tier: 3, note: "" },
  { locale: "tr-TR", country: "tr", language: "tr", name: "Türkiye", tier: 3, note: "" },
  { locale: "pl-PL", country: "pl", language: "pl", name: "Poland", tier: 3, note: "" },
  { locale: "sv-SE", country: "se", language: "sv", name: "Sweden", tier: 3, note: "" },
  { locale: "uk-UA", country: "ua", language: "uk", name: "Ukraine", tier: 3, note: "" },
  { locale: "hi-IN", country: "in", language: "hi", name: "India (Hindi)", tier: 3, note: "storefront defaults to en-GB SERPs" },
];
```

(Keep entries whose `country` exists in `STOREFRONTS`; drop/adjust the rest at implementation
time.) Suggestions array (max 4, priority order):

1. **link-app** — `app_store_id` missing: "Link your App Store listing to verify real rankings"
   (free).
2. **apply-run** — a done run has `final` but its locales were never applied: "Run <slug>
   produced metadata for <locales> — review & save".
3. **new-locale** — top uncovered MARKETS entries (up to 2), each with `quoteFor(150, lastModel)`
   estimate and the tier note; when `extraLocaleFor` of a suggested country adds a bonus bucket,
   say so ("also fills the es-MX slot via cross-localization").
4. **refresh** — covered locale whose newest done run is >45 days old: "en-US data is N days
   old — the suggest index drifts; refresh for ≈Q cr".
5. **check-positions** — live version set, positions never checked (or >14 days): "Verify your
   rankings (≈Q cr)".

Each suggestion: `{ kind, title, detail, credits?: number, action: {…routing payload} }`.

## 5. Protocol & API

Reads — new QueryKinds (`shared/src/protocol.ts` + `QueryData` in `client/src/wire-local.ts`):

- `"projects"` → `ProjectCard[]`: {id, name, brand, appStoreId, archived, localesCovered:
  string[], bankCount, lastActivityTs, runCount, liveVersion, latestVersion}.
- `"project"` `{projectId}` → `ProjectView`: {card fields, context, versionsSummary (v, ts, note,
  source, localeCount, isLive)[], current: MetadataVersion|null, coverage:
  {locale, market?: MarketSlot, title/subtitle/keywords?, sourceRunId?, staleDays?}[],
  suggestions: Suggestion[], positionsSummary?: {checkedAt, tracked, ranked, top10}[per storefront]}.
- `"project-bank"` `{projectId, storefront?, language?, page?}` → paged bank rows.
- `"project-positions"` `{projectId, storefront?}` → latest positions + per-keyword history (last 10 checks).
- `"project-export"` `{projectId, format: "csv"|"json"}` → {filename, mime, content} (current
  version, all locales; bank as a second CSV section or JSON field).

Writes — ONE new message pair (mirrors run.create's client_ref correlation):

```ts
| { t: "project.op"; client_ref: string; op: ProjectOp }
| { t: "project.result"; client_ref: string; ok: boolean; error?: string; data?: unknown }
```

`ProjectOp` (discriminated union, validated server-side, owner-gated):
`create {name, brand, appStoreUrl?}` · `update {projectId, name?, brand?, appStoreUrl?|null}` ·
`updateContext {projectId, context: BusinessContext}` · `applyMetadata {projectId, runId,
selection, edits?, note?}` · `editMetadata {projectId, locales, note?}` · `rollback {projectId,
toV}` · `markLive {projectId, v}` · `bankFlag {projectId, storefront, language, keyword,
pinned?, hidden?}` · `checkPositions {projectId, storefront}` · `archive {projectId, archived}` ·
`delete {projectId, confirmName}`.

`run.create` gains `project_id: string` (reject when missing/foreign). RunSummary gains
`projectId` so lists can scope.

localserver relays (same auth/token pattern as existing /api routes): `GET /api/projects`,
`GET /api/projects/:id`, `GET /api/projects/:id/bank`, `GET /api/projects/:id/positions`,
`GET /api/projects/:id/export?format=`, `POST /api/projects/op` (body = ProjectOp; create included).
`POST /api/runs` body gains `project_id`.

Server REST (`server/src/api/http.ts`) mirrors the same for the future web version — follow the
existing session-token auth pattern used by /api/runs there.

## 6. Web-UI (client/src/web-ui/app.js — vanilla, hash router)

Routes: `#/projects` (new home, default), `#/p/<id>` → Overview, `#/p/<id>/runs`,
`#/p/<id>/keywords`, `#/p/<id>/positions`, `#/p/<id>/settings`, `#/p/<id>/new-run`;
`#/run/<slug>` stays (breadcrumb "‹ ProjectName"), `#/balance`, `#/compare/...` stay.
Old `#/runs` redirects to `#/projects`.

- **Home**: project cards (monogram avatar from name initials; name, brand, mini locale-dots
  (filled/total), bank count, last activity, "Open" + "New run"); "＋ New project" card opens a
  modal (name, brand, App Store URL optional). Empty state: a short pitch of the flywheel
  ("Create your app's project — every run builds its metadata board, keyword bank and rank
  history"). Archived projects behind a toggle.
- **Overview** (the money screen): 
  - locale coverage grid: covered slots render an App-Store-style card (title with brand, subtitle,
    keywords string, char meters vs limits, source run chip, staleness chip); empty MARKET slots
    render dimmed with tier badge + "≈N cr" + "Research" button → prefilled new-run form.
  - version bar: "v<latest>" · history dropdown (each: v, date, note, source, LIVE badge, actions
    Restore/Mark live) · Export (copy per field, copy locale block, CSV/JSON download).
  - next-best-actions panel (max 4 suggestion cards with action buttons).
  - pending proposal banner when an unapplied done run exists → apply modal: per-locale×field
    checkboxes, side-by-side current→proposed diff, inline edit before save, note field.
- **Runs tab**: existing runs list scoped to the project + "New run".
- **Keywords tab**: bank table (keyword, P, D, R, Score, status, source run, updated; sort;
  filter by storefront/language toggle chips; search; pin/hide toggles; hidden collapsed behind
  a toggle; CSV export button reuses project-export).
- **Positions tab**: storefront selector; tracked list with latest position, delta vs previous
  check, sparkline (last 10), "not ranked" states; "Check now (≈N cr)" button (disabled without
  app_store_id → link-app inline form; requires the local client — same connectivity states the
  run screen already handles).
- **Settings tab**: name/brand/App Store link; structured context editor (productSummary
  textarea, audience textarea, antiSemantics textarea, jobsToBeDone/featureVocabulary/competitors
  as tag-list editors); archive/delete danger zone.
- **New-run form**: the existing form, minus brand (pre-filled from project, editable), with the
  server quote box as-is; locale can arrive pre-selected from a suggestion card.
- **Run screen addition**: when the run is done and has `final`: "Save to project" panel
  (same apply modal).

Design language: keep the existing styles.css system (cards, chips, meters); add only what's
needed. No new frameworks.

## 7. Server internals

- `db/types.ts` + `postgres-store.ts` + `memory-store.ts`: ProjectRow CRUD, versions append
  (read-modify-write inside a transaction; versions capped at 100 — drop oldest beyond cap but
  never the live one), bank upsert batch, positions insert/list, runs list by project.
- `orchestrator/manager.ts`: project ops handler (owner-gated), context seeding on createRun,
  finishRun bank upsert + proposal event ("📦 metadata proposal ready — review & save on the
  project page"), checkPositions (client presence via hub, gateway fresh serp, fee, rows).
- `apple-dispatch/gateway.ts`: `serp(query, storefront, lang, opts?: {fresh?: boolean})` —
  `fresh` skips the cache READ (still writes). Positions uses fresh; replay never calls it.
- `api/wss.ts`: query kinds + project.op dispatch; `api/http.ts`: REST mirrors.
- Config: `defaultRunConfig`/`validateRunConfig` untouched except `project_id` plumbed at the
  message level (NOT inside RunConfig — keep config pure).
- Billing: `POSITIONS_FEE` in prices.ts (flat, env-overridable). Nothing else changes.
- Admin (`api/admin.ts`): add projects count to the overview payload if trivial; otherwise skip.

## 8. No migration — wipe

Existing data is DISPOSABLE (pre-prod). Deploy performs `docker compose down -v` (drops the
volume: users, wallets, runs — everything) and boots fresh. schema.sql just gains the new tables
above; no data-migration code is written at all. Local DEV memory-store starts empty as always.

## 9. Tests (bun test, follow existing patterns)

- store (memory): project CRUD; version append/rollback/markLive semantics (append-only, cap,
  live pointer survives); bank upsert preserves flags & first_seen; positions insert/list.
- manager-level (mock stack, like integration.test.ts): create project → run (mock) → context
  saved to project on confirm; finishRun upserts bank; applyMetadata builds v1 from selection;
  second apply builds v2 with untouched locales carried over; rollback creates v3 = v1;
  run.create without project_id rejected; foreign project rejected.
- quote/fee: positions fee debit path idempotent by key.
- web-ui is not unit-tested (matches现状) — but `bunx tsc --noEmit` must pass in client/ and
  server/, and `bun test` green in server/.

## 10. Out of scope (explicitly, to keep the agent focused)

- Web (non-desktop) UI, admin SPA changes, landing changes.
- Auto-refresh scheduling, email nudges (future: staleness digests).
- Competitor tracking per project (future — the appNiche data is already per-run).
- Multi-user/team projects.
