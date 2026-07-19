# ASOptimus Admin Panel — build spec

**Read this document fully before writing any code. It is deliberately self-contained: you
must NOT read anything outside the `admin/` folder — every contract, style token, data
shape and acceptance criterion you need is in here. The backend already exists and is not
your concern.**

---

## 0. What you are building

A single-admin web panel for ASOptimus (an App Store keyword-research SaaS: users buy
credits, run keyword analyses; the operator needs total visibility over users, money and
runs). The panel is a **static SPA** — plain HTML + vanilla JS + CSS, **no frameworks, no
build step, no external JS libraries, no npm**. It is served by the existing API server
under the path prefix `/admin`, and talks to a JSON API under `/admin/api/*` on the same
origin.

Deliverables — exactly three files, replacing the placeholders in `admin/ui/`:

```
admin/ui/index.html
admin/ui/app.js
admin/ui/styles.css
```

`admin/ui/fixtures.json` already exists (do not delete it) — it powers mock mode (§6).

Hard rules:
- **All asset and API URLs must be relative or origin-absolute with the `/admin` prefix in
  mind**: the page is served at `/admin`, so reference assets as `./app.js`, `./styles.css`,
  `./fixtures.json`, and call the API as `/admin/api/...`.
- English only, everywhere.
- No emoji as icons; inline SVG only. Charts are hand-rolled inline SVG (§8.5) — no chart libs.
- Fonts via Google Fonts `<link>` (the panel is private; CDN is acceptable here):
  `Space Grotesk` (500, 700) and `JetBrains Mono` (400, 600).

---

## 1. Authentication

- The admin logs in with a single **admin token** (a long secret string).
- Login screen: one password-type input + button "Unlock". On submit call
  `GET /admin/api/me` with the token (§3). Success → store the token in `localStorage`
  (`aso_admin_token`) and enter the app. Failure → inline error ("wrong token" on 401,
  "admin API disabled" on 404, otherwise the error text).
- EVERY API request carries `Authorization: Bearer <token>`.
- Any API response with status 401 anywhere in the app → wipe the stored token and show
  the login screen again.
- A "Lock" button in the sidebar footer clears the token and returns to login.

---

## 2. Screens

Hash routing: `#/overview` (default), `#/users`, `#/users/<id>`, `#/runs`, `#/runs/<id>`,
`#/waitlist`, `#/finance`, `#/live`. Layout: fixed left sidebar (nav + lock), scrollable
main column, max-width 1400px.

```
┌──────────┬──────────────────────────────────────────────┐
│ ASOptimus│  <screen title>                    <actions> │
│ ADMIN    │                                              │
│          │  [tiles row]                                 │
│ Overview │  [panels / tables / charts]                  │
│ Users    │                                              │
│ Runs     │                                              │
│ Waitlist │                                              │
│ Finance  │                                              │
│ Live     │                                              │
│          │                                              │
│ ⊘ Lock   │                                              │
└──────────┴──────────────────────────────────────────────┘
```

### 2.1 Overview (`#/overview`) — the "how is my business" screen

Data: `GET /admin/api/overview` (§3.1).

- **Tiles row 1 (people):** total users · new in 7d · new in 30d · waitlist pending /
  invited / signed-up (three small numbers in one tile).
- **Tiles row 2 (money):** credits granted (split paid/free in small text) · credits spent
  · outstanding (granted − spent; the operator's liability) · approx revenue $ · COGS $
  (total, 30d in small text) · approx margin $ (green when positive).
- **Runs panel:** horizontal bar per phase from `runs.byPhase` (label, count, bar scaled to
  max), plus "N active right now" and "N total" chips above.
- **Live strip:** connected clients count + active orchestrators count (link to `#/live`).
- Refresh button in the header re-fetches.

### 2.2 Users (`#/users`)

Data: `GET /admin/api/users?q=&page=&pageSize=50` (§3.2).

- Search input (debounced 300ms, matches email substring) + paged table.
- Columns: Email · Created · Balance · Granted · Spent · Runs · Last run · Licenses ·
  Sessions · Waitlist badge (`—` / `invited` / `signed up`).
- Row click → `#/users/<id>`.

### 2.3 User detail (`#/users/<id>`)

Data: `GET /admin/api/users/:id` (§3.3).

- Header: email, id (mono), created date, paddle customer id (mono, `—` when null).
- **Tiles:** balance · granted · spent · this user's COGS $ · margin proxy $ (spent − COGS —
  label it "spend vs COGS").
- **Actions row:**
  - "Grant credits" → modal: number input (1–1000, integer), note input (required),
    confirm → `POST /admin/api/users/:id/grant` → success toast with new balance, re-fetch.
  - "Reissue key" → confirm modal ("Emails a fresh activation key to the user") →
    `POST /admin/api/users/:id/reissue-key`.
- **Licenses table:** key hash prefix (mono), status badge, device bound (yes/no),
  revoked-at; per active row a "Revoke" button → confirm modal →
  `POST /admin/api/users/:id/revoke-license` with `{ "keyHash": <full key_hash> }`.
- **Runs table:** brand · country · phase badge · sample N/M · credits spent · COGS $ ·
  updated; row click → `#/runs/<runId>`.
- **Ledger table** (most recent first): ts · type badge (grant green / debit gray /
  refund+chargeback red) · Δ credits · run id (mono, short) · ref (mono, short) · note.

### 2.4 Runs (`#/runs`)

Data: `GET /admin/api/runs?page=&pageSize=50&phase=` (§3.4).

- Phase filter select (all + each phase) + paged table.
- Columns: User email · Brand · Country · Phase badge (+ `paused` badge when paused) ·
  Sample N/M · Credits spent · COGS $ · Margin (spent − COGS, red when negative!) · Updated.
- Row click → `#/runs/<id>`.

### 2.5 Run detail (`#/runs/<id>`)

Data: `GET /admin/api/runs/:id` (§3.5).

- Header: brand · country · user email (link to user) · run id (mono) · phase/paused badges.
- **Tiles:** sample count/size · credits spent · COGS $ · LLM calls · tokens in/out (small).
- **Config panel:** pretty key-value list of `snapshot.config` (model, sampleSize,
  batchSize, country, semanticLanguage, …).
- **Events feed:** scrollable mono list of `snapshot.events` (ts + kind + text), newest last.
- **Assembly panel** (only when `snapshot.assembly` non-null): per bucket show title /
  subtitle / keywords with char counts; coverage line.

### 2.6 Waitlist (`#/waitlist`)

Data: `GET /admin/api/waitlist?status=&page=` (§3.6).

- Counts chips: pending / invited / signed up (from `counts`).
- **Import panel:** textarea ("one email per line, commas also fine"), optional note input,
  button "Add to waitlist" → `POST /admin/api/waitlist/import` → toast
  "added N, skipped M duplicates, K invalid", refresh.
- **Invite controls:** button "Invite all pending (N)" → confirm modal (says it SENDS
  EMAILS) → `POST /admin/api/waitlist/invite` with `{}`; per-row "Invite" button for a
  single pending email → same endpoint with `{ "emails": ["..."] }`.
- Table: email · added · invited (— when null) · signed up (— when null) · note ·
  per-row actions: Invite (pending only) · Remove (confirm →
  `DELETE /admin/api/waitlist/:email`, URL-encode the email).
- Status filter select: all / pending / invited / signed_up.
- **Beta banner** on top: from `GET /admin/api/beta` — "Beta gate: ON — only invited
  waitlist emails can sign up; each signup is granted N free credits" or
  "Beta gate: OFF — signups are open" (read-only; the gate is env-controlled).

### 2.7 Finance (`#/finance`)

Data: `GET /admin/api/finance?days=30` (§3.7). Range select: 7 / 30 / 90 days.

- **Chart:** grouped daily bars — granted (blue), spent (orange), COGS $ (red line
  overlaid, right-hand scale hint in caption). Inline SVG per §8.5; every day is one group;
  missing days are zeros. Caption explains the three series.
- **Recent top-ups table:** ts · email · credits · ref (mono short).

### 2.8 Live (`#/live`)

Data: `GET /admin/api/live` (§3.8). Auto-refresh every 5s while the screen is open (clear
the interval on route change!).

- **Connected clients panel:** userId (mono short) · email · device fp (mono short).
- **Active orchestrators panel:** run id short · user email · phase badge · paused ·
  sample count. Row click → `#/runs/<id>`.
- Empty states: "no clients connected", "no active runs".

---

## 3. API contract (complete; the backend implements EXACTLY this)

Base: same origin, prefix `/admin/api`. All endpoints require `Authorization: Bearer
<ADMIN_TOKEN>`; wrong/missing token → `401 {"error":"unauthorized"}`; admin API disabled on
the server → `404`. All errors: `{"error": "<message>"}` with 4xx/5xx.

### 3.1 `GET /admin/api/overview`
```json
{
  "users": { "total": 128, "new7d": 12, "new30d": 41 },
  "waitlist": { "pending": 210, "invited": 74, "signedUp": 38 },
  "runs": { "total": 402, "active": 3,
            "byPhase": { "created": 4, "context": 1, "context_review": 2, "seeding": 1,
                          "loop": 2, "improving": 0, "assembling": 0, "done": 392 } },
  "credits": { "granted": 5120, "grantedPaid": 4260, "grantedFree": 860,
               "spent": 3487.5, "outstanding": 1632.5 },
  "finance": { "approxRevenueUsd": 4260, "cogsUsd": 512.4, "cogs30dUsd": 214.9,
               "approxMarginUsd": 3747.6 },
  "live": { "connectedClients": 2, "activeOrchestrators": 3 }
}
```
Notes: `approxRevenueUsd` = paid credits (package bonuses make it a slight overestimate —
say so in a tile tooltip/caption). `active` runs = orchestrators currently in memory.

### 3.2 `GET /admin/api/users?q=<substr>&page=0&pageSize=50`
```json
{ "total": 128, "page": 0, "pageSize": 50, "items": [
  { "id": "usr_Ab3xY9kQz", "email": "maker@studio.dev", "createdAt": "2026-07-01T10:00:00Z",
    "balance": 12.5, "granted": 40, "spent": 27.5, "runs": 3,
    "lastRunAt": "2026-07-18T20:11:00Z", "licenses": 1, "activeSessions": 1,
    "paddleCustomerId": "ctm_01h...", 
    "waitlist": { "invitedAt": "2026-06-20T09:00:00Z", "signedUpAt": "2026-07-01T10:00:00Z" } }
] }
```
`waitlist` is `null` for users who never were on it. `lastRunAt`/`paddleCustomerId` nullable.

### 3.3 `GET /admin/api/users/:id`
```json
{
  "user": { "...": "same shape as one item of 3.2" },
  "cogsUsd": 3.42,
  "licenses": [
    { "keyHash": "a1b2c3d4e5f6...64hex", "keyHashPrefix": "a1b2c3d4",
      "status": "active", "deviceBound": true, "revokedAt": null }
  ],
  "ledger": [
    { "ts": "2026-07-18T20:15:00Z", "type": "debit", "delta": -0.02,
      "runId": "run_9f2...", "ref": null, "note": null },
    { "ts": "2026-07-15T11:00:00Z", "type": "grant", "delta": 26,
      "runId": null, "ref": "txn_01h...", "note": null },
    { "ts": "2026-07-01T10:00:01Z", "type": "grant", "delta": 30,
      "runId": null, "ref": "beta_usr_Ab3xY9kQz", "note": "beta welcome grant" }
  ],
  "runs": [
    { "runId": "run_9f2ab...", "brand": "Somna", "country": "us", "phase": "done",
      "paused": false, "sampleCount": 150, "sampleSize": 150, "creditsSpent": 3.0,
      "cogsUsd": 0.41, "createdAt": "2026-07-18T18:00:00Z",
      "updatedAt": "2026-07-18T20:11:00Z" }
  ]
}
```
404 when the user id does not exist. Ledger is the FULL history, newest first.

### 3.4 `GET /admin/api/runs?page=0&pageSize=50&phase=<optional>`
```json
{ "total": 402, "page": 0, "pageSize": 50, "items": [
  { "runId": "run_9f2ab...", "userEmail": "maker@studio.dev", "brand": "Somna",
    "country": "us", "phase": "loop", "paused": false, "sampleCount": 61,
    "sampleSize": 150, "creditsSpent": 1.22, "cogsUsd": 0.19,
    "updatedAt": "2026-07-19T14:00:00Z" }
] }
```
Sorted by `updatedAt` desc. `phase` filters exactly.

### 3.5 `GET /admin/api/runs/:id`
```json
{
  "userEmail": "maker@studio.dev",
  "cogsUsd": 0.41,
  "llm": { "calls": 15, "inputTokens": 51000, "outputTokens": 5100, "costUsd": 0.41 },
  "debits": 150,
  "snapshot": {
    "state": { "runId": "run_9f2ab...", "phase": "done", "paused": false, "failed": null,
               "notice": null, "hintsEndpointDown": false,
               "createdAt": "2026-07-18T18:00:00Z", "updatedAt": "2026-07-18T20:11:00Z",
               "usage": { "inputTokens": 51000, "outputTokens": 5100, "cacheReadTokens": 0,
                          "cacheWriteTokens": 0, "calls": 15, "costUsd": 0.41, "byTask": {} },
               "http": { "requestsMade": 610, "cacheHits": 240, "throttleWaitMs": 84000 } },
    "config": { "brand": "Somna", "country": "us", "semanticLanguage": "en",
                "sampleSize": 150, "batchSize": 20, "model": "claude-haiku-4-5" },
    "context": { "productSummary": "…", "category": "…", "audience": "…" },
    "events": [ { "ts": "2026-07-18T18:00:05Z", "kind": "🧠", "text": "context: analyzing the brief" } ],
    "assembly": null,
    "keywordCount": 412, "sampleCount": 150, "creditsSpent": 3.0
  }
}
```
`snapshot.config`/`context` may contain more keys than shown — render key-value generically.
`assembly`, when non-null: `{ "buckets": [{ "locale": "en-US", "title": "...", "subtitle":
"...", "keywordFieldDraft": "..." }], "coverage": { "phrasesCovered": 18, "scoreCovered":
812, "scoreTotal": 990, "coveredShare": 0.82 } }` (buckets carry more fields; show the ones
listed).

### 3.6 Waitlist
`GET /admin/api/waitlist?status=all|pending|invited|signed_up&page=0&pageSize=100`
```json
{ "total": 322, "counts": { "pending": 210, "invited": 74, "signedUp": 38 },
  "page": 0, "pageSize": 100, "items": [
  { "email": "eager@dev.io", "addedAt": "2026-06-01T00:00:00Z", "invitedAt": null,
    "signedUpAt": null, "note": "producthunt" }
] }
```
`POST /admin/api/waitlist/import` body `{ "emails": ["a@b.c", "x@y.z"], "note": "batch-1" }`
→ `{ "added": 2, "duplicates": 0, "invalid": 0 }` (invalid = not email-shaped, skipped).
`POST /admin/api/waitlist/invite` body `{}` (all pending) or `{ "emails": ["a@b.c"] }` →
`{ "invited": 1, "failed": [] }`; `failed` items: `{ "email": "...", "error": "..." }`.
Inviting an already-invited email re-sends the email and keeps the original `invitedAt`.
`DELETE /admin/api/waitlist/:email` (URL-encoded) → `{ "ok": true }`.

### 3.7 `GET /admin/api/finance?days=30`
```json
{ "series": [
    { "date": "2026-07-18", "granted": 120, "grantedPaid": 100, "spent": 88.4, "cogsUsd": 11.2 },
    { "date": "2026-07-19", "granted": 0, "grantedPaid": 0, "spent": 12.1, "cogsUsd": 1.7 }
  ],
  "recentTopups": [
    { "ts": "2026-07-18T13:37:00Z", "email": "maker@studio.dev", "credits": 26, "ref": "txn_01h..." }
  ] }
```
`series` covers exactly the last `days` days, oldest first, zero-filled. `days` ∈ {7,30,90}.

### 3.8 `GET /admin/api/live`
```json
{ "clients": [ { "userId": "usr_Ab3xY9kQz", "email": "maker@studio.dev", "deviceFp": "d41d8cd9…" } ],
  "orchestrators": [ { "runId": "run_9f2ab...", "userEmail": "maker@studio.dev",
                        "phase": "loop", "paused": false, "sampleCount": 61 } ] }
```

### 3.9 Misc
`GET /admin/api/me` → `{ "ok": true }` (token check for login).
`GET /admin/api/beta` → `{ "gated": true, "grantCredits": 30 }`.
`POST /admin/api/users/:id/grant` body `{ "credits": 25, "note": "support comp" }` →
`{ "ok": true, "balance": 37.5 }`. Validation errors → 400 with message.
`POST /admin/api/users/:id/reissue-key` → `{ "ok": true }`.
`POST /admin/api/users/:id/revoke-license` body `{ "keyHash": "<64 hex>" }` → `{ "ok": true }`.

---

## 4. UX behaviors (global)

- Loading: skeleton text "Loading…" in the main column; never a blank screen.
- Every fetch failure → red banner in place of the content with the error text and a
  "Retry" button. 401 → login (see §1).
- Toasts: bottom-right, auto-dismiss 4s, red variant for errors.
- Confirm dialogs: in-app modal (overlay + card), NEVER `window.confirm`/`alert` (they are
  broken in some webviews and are ugly anyway).
- Tables: `—` for null values; dates rendered `YYYY-MM-DD HH:MM` local time; money with 2
  decimals and `$` prefix; credits with up to 2 decimals, no unit (column header says it).
- Long ids (`run_…`, `usr_…`, hashes): render first 10 chars + "…" with `title` attr
  holding the full value, `font-family: mono`.
- Pagination: "← Back / page X of Y / Next →" like-for-like on every paged table.
- Keyboard: Enter submits the login form and modal forms; Escape closes modals.
- Auto-refresh ONLY on Live (§2.8). Everything else refreshes on navigation or the
  explicit Refresh button.

---

## 5. Non-goals (do NOT build)

- No editing of runs (pause/delete) from the admin — read-only except the user actions
  listed (grant / reissue / revoke) and waitlist actions.
- No charts beyond §2.1 phase bars and §2.7 finance chart.
- No websockets/SSE — plain fetch polling only where specified.
- No dark mode. No i18n. No responsive mobile layout (min width 1100px is fine).

---

## 6. Mock mode (how you develop and how acceptance is run)

If the page URL has `?mock=1` (e.g. `admin/ui/index.html?mock=1` opened from any static
server, or `/admin?mock=1`), the app must NOT hit the network: instead it loads
`./fixtures.json` once and serves every "endpoint" from it (the fixtures file has one
top-level key per endpoint — see its structure; keys with path params use `:id`
placeholders and the app picks the single fixture item regardless of the id passed).
Mutations in mock mode (grant, import, invite, delete, revoke, reissue) must update the
in-memory fixture copy so the UI visibly reacts (e.g. import adds rows, grant bumps the
balance), and show the same toasts as live mode. Login in mock mode accepts the token
`mock` (and only it — so the login flow is exercised too).

Mock mode is the primary acceptance environment: **every screen and every action must be
fully demonstrable with `?mock=1` and no backend.**

---

## 7. File/skeleton requirements

- `index.html`: `<!DOCTYPE html>`, `<meta charset>`, viewport, `<title>ASOptimus Admin</title>`,
  Google Fonts links, `<link rel="stylesheet" href="./styles.css">`, root
  `<div id="app"></div>`, `<script src="./app.js"></script>`. `<meta name="robots" content="noindex">`.
- `app.js`: `"use strict"`, a single top comment block explaining the architecture, then:
  state → api helper (token, mock branch) → router → screens → components (toast, modal,
  table helpers, svg chart builders). No globals leaking beyond one namespace object or
  module-pattern closure. No `innerHTML` with UNESCAPED interpolated data — escape all
  server strings through one `esc()` helper (XSS: emails/brands/notes are user input!).
- `styles.css`: tokens first (§8), then components. No CSS frameworks.

---

## 8. Brand guide (the panel must look like this — copy these tokens verbatim)

### 8.1 Tokens
```css
:root {
  --bg: #FDF3DA;            /* cream paper background */
  --panel: #ffffff;
  --text: #191D3A;          /* ink navy */
  --muted: #565B76;
  --border: #191D3A;        /* outlines are ink */
  --line-soft: #F0E4C6;     /* soft row separators */
  --accent: #0244B5;        /* royal blue — primary data/links */
  --accent-soft: #E3EAFB;
  --orange: #F86C1A;        /* fox orange — primary buttons, highlights */
  --orange-deep: #BC4406;   /* orange that passes AA on cream */
  --orange-soft: #FDE3CF;
  --yellow: #8A5A00; --yellow-soft: #FFE9A8;
  --red: #C22B2B;  --red-soft: #FBE3E3;
  --navy: #0A1B4D;
  --sh-sm: 3px 3px 0 var(--text);   /* hard offset shadows — NEVER blur */
  --sh: 5px 5px 0 var(--text);
  --disp: "Space Grotesk", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, monospace;
}
body { background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
```

### 8.2 Core components (reference implementations — reuse these patterns)
```css
.panel { background: var(--panel); border: 2.5px solid var(--border);
  border-radius: 14px; padding: 16px 18px; margin-bottom: 18px; box-shadow: var(--sh-sm); }
button { font-family: var(--disp); font-weight: 500; font-size: 13.5px; cursor: pointer;
  border-radius: 10px; border: 2px solid var(--border); background: var(--panel);
  color: var(--text); padding: 6px 14px; }
button:hover { transform: translate(-1px,-1px); box-shadow: 2px 2px 0 var(--text); }
button.primary { background: var(--orange); color: #fff; font-weight: 700; box-shadow: var(--sh-sm); }
button.danger { color: var(--red); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px;
  font-weight: 600; border: 1.5px solid currentColor;
  background: var(--accent-soft); color: var(--accent); }
.badge.gray { background: var(--bg); color: var(--muted); }
.badge.red { background: var(--red-soft); color: var(--red); }
.badge.yellow { background: var(--yellow-soft); color: var(--yellow); }
.tile { background: var(--panel); border: 2.5px solid var(--border); border-radius: 12px;
  padding: 12px 14px; box-shadow: var(--sh-sm); }
.tile .value { font-family: var(--disp); font-size: 24px; font-weight: 700;
  color: var(--accent); font-variant-numeric: tabular-nums; }
.tile .label { color: var(--muted); font-size: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-family: var(--mono); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .05em; border-bottom: 2px solid var(--border);
  text-align: left; padding: 8px 10px; }
td { padding: 8px 10px; border-bottom: 1px solid var(--line-soft); }
tr.clickable:hover td { background: var(--accent-soft); cursor: pointer; }
```

### 8.3 Sidebar
Cream background, right border `2.5px solid var(--border)`; brand block on top: the word
`ASOptimus` in `--disp` 700 + a small `ADMIN` chip (orange background, white text, mono
10px, radius 6px). Nav items: display font 500, 13.5px; active item = white panel pill
with 2px ink border. Width 200px, full height, fixed.

### 8.4 Visual rules
Rounded 10–14px everywhere; 2–2.5px ink borders; hard offset shadows (no blur, no glow,
no gradients); generous whitespace; numbers always `tabular-nums`. NEVER green — positive
money values use `--accent` blue (margin positive) and `--red` for negative.

### 8.5 SVG charts
Hand-rolled, `viewBox`-scaled to container width. Plot frame: `2px` ink border rect.
Bars: fill `var(--accent)` (granted) / `var(--orange)` (spent); the COGS series is a
polyline `var(--red)` 2.5px. Axis/labels: 11px, `var(--muted)`, mono. Native `<title>`
tooltips per bar. A one-line caption under every chart explaining the series.

---

## 9. Acceptance criteria

1. Open `admin/ui/index.html?mock=1` from any static file server → login with token
   `mock` → all eight screens render with fixture data; every table, chart, badge and
   pagination control matches this spec.
2. Every mutation works in mock mode with visible effect and toast: grant credits (balance
   tile updates), reissue key, revoke license (badge flips), waitlist import (rows appear,
   counts update), invite one + invite all (invitedAt fills), waitlist delete, and each
   confirm modal can be cancelled with Escape.
3. 401 simulation: entering a wrong token at login shows the inline error; a stored bad
   token falls back to the login screen.
4. No console errors on any screen; `esc()` guards every interpolated string (test with a
   fixture email containing `<b>x</b>` — it renders literally; one such email is already
   in the fixtures).
5. Visual: sidebar + tokens exactly per §8; no green anywhere; no blurred shadows; fonts
   load; long ids truncated with title-attr fulltext.
6. All URLs relative/prefix-correct (§0) — the app must work BOTH from
   `/admin` (served) and from a plain static server on any port (mock mode).
7. `fixtures.json` untouched (byte-identical).
8. English-only UI copy; no emoji icons; no external JS.

## 10. Context: how this panel is deployed (informational — no action needed from you)

The API server serves `admin/ui/*` under `/admin` and implements every endpoint of §3
against its Postgres. The admin token is checked server-side (`ADMIN_TOKEN` env). The
"beta gate" shown on the Waitlist screen is controlled by server env (`BETA_GATED`,
`BETA_GRANT_CREDITS`): when ON, only invited waitlist emails can sign up, and each such
signup automatically receives the free-credit grant (that's the `beta_…` ledger ref you
see in fixtures). Invitation emails are sent by the server when you click Invite.
