# 09 — Insights & Exports (zero-marginal-cost feature pack)

Status: approved for implementation. Companion to spec/00–08; nothing here changes the
pipeline, metrics, or billing. Everything in this spec is a **re-projection of data a run
already produces** — the acceptance gate for the whole pack is:

> **No feature in this spec may issue a single new Apple request or LLM call, and none may
> debit credits.** All views/exports read the run state that already exists (keywords with
> P/D/R/score + raw evidence, per-keyword SERP top-10 with AppStrength, assembly + coverage,
> events feed). If a feature seems to need new data — it is out of scope for 09.

Strategic frame: AppTweak sells (a) data, (b) competitor analysis, (c) reports. We do not
compete on continuously-crawled data; we compete on verifiability + pay-per-run. This pack
closes "competitor analysis" and "reports" at indie-sufficient depth, for free.

Priority order = section order. Each section is independently shippable.

---

## 0. Prerequisite (SHIPPED): no LLM internals in the UI

Already done, recorded here for traceability: the LLM call log tab, the
`LLM: N calls · N tokens · ~$` usage lines (run cards, run header, overview tile), and the
"show the LLM call" link are removed from the web-ui. Users pay in credits per verified
keyphrase (D4); token counts/costs are internal COGS and must never appear in user-facing
UI. Per-keyword **R reasons stay visible** — that is the product's transparency promise.
Server-side LLM logging (D9) is untouched: it remains for the operator.

Guard: `grep -riE "tokens|costUsd|llm-log|llm call" client/src/web-ui/` must return only
the header comment of app.js. Add this check to `07-web-ui.md` acceptance.

---

## 1. Exports: .csv / .md / .json  (effort: ~0.5 day)

The landing already promises "export: .md / .json" — the product must not under-deliver
what the landing sells. CSV is the AppTweak-migration bridge: their users live in
spreadsheets.

**Where.** Run screen → Keywords tab toolbar: an `Export` button (chunky secondary), menu
with three items: `keywords.csv`, `report.md`, `run.json`. Enabled in any phase (exports
whatever is verified so far); disabled only when `sampleCount === 0`.

**Transport.** New relay/WSS read `query kind="export"` params `{runId, format}` → server
builds the artifact string → localserver returns it with `content-disposition: attachment;
filename="<brand>-<country>-<date>.<ext>"`. The browser/webview downloads via a plain
`<a href="/api/runs/:id/export?format=csv">` (add the route to localserver; token-guarded
like every /api). No new deps — CSV/MD are string builders on the server.

**Formats.**
- `keywords.csv` — one row per keyword, columns exactly:
  `keyword,score,P,D,R,status,source,child_count,brand_query,unsuggested,degraded,reason`.
  RFC 4180 quoting (reasons contain commas/quotes). UTF-8, no BOM. Sorted by score desc.
- `report.md` — human-readable run summary: header (brand, storefront, date, sample size),
  ship-ready metadata block (both buckets: title / subtitle / keyword field + char counts),
  top-30 keywords table (keyword, Score, P, D, R), findings summary (see §4 counts),
  coverage line. Formulas footer (same four formulas as the landing math section) so the
  numbers stay auditable outside the app.
- `run.json` — the full RunSnapshot plus the full keyword list (not paginated): everything
  the UI can see, machine-readable. Pretty-printed, stable key order not required.

**Acceptance.**
- CSV opens clean in Google Sheets/Numbers (quoting torture-tested with reasons containing
  `,` `"` and newlines).
- All three exports work mid-run and after `done`, and contain only data already computed.
- No credits debited; no Apple/LLM calls in server logs during export.
- The exported .md renders as valid markdown in GitHub preview.

---

## 2. Competitors tab  (effort: ~1.5 days) — the AppTweak counterpunch

Every measured keyword already carries its SERP top-10 (`metrics.topApps`: trackName,
ratingCount, rating, updatedDaysAgo, match, strength). Aggregating across the run yields a
competitor landscape AppTweak charges for — from cached data.

**Where.** Run screen → new tab `Competitors` between `Keywords` and `Assembly`.

**Aggregation (server-side, new `query kind="competitors"` → `{items: CompetitorRow[]}`).**
Group `topApps` across all keywords with `metrics.D != null` by app identity (trackName +
trackId if present in raw SERP; fall back to normalized trackName). Per app compute:
- `keywords` — in how many of the run's keyword top-10s the app appears;
- `share` — that count / number of keywords with SERP data (0..1);
- `avgPosition` — mean 1-based position across appearances;
- `avgStrength` — mean AppStrength;
- `bestKeywords` — top 3 keyword strings by that keyword's score where the app ranks ≤ 3;
- `weakSpots` — count of appearances where the app's strength < 40 (opportunities).
Sort by `keywords` desc; return the top 25 rows.

**UI table.** Columns: `#`, App, Overlap (keywords count + share bar — thin ink-bordered
bar like the assembly rows), Avg pos, Avg strength (small progress bar), Where it's strong
(the 3 `bestKeywords` as gray chips), Weak spots (count chip, orange when > 0). Row expands
(same `tr.expandable` pattern as Keywords) to the full list of shared keywords with the
app's position/strength per keyword.

**Summary tiles above the table** (reuses `.tiles`): distinct apps seen · median top-10
strength across the run ("how hard is this niche") · number of top-10 slots occupied by
weak apps (strength < 40) with label "open doors".

**Honesty rule.** This is *your keyword set's* landscape, not a market share study — say so
in a one-line caption under the tab title ("Apps competing in the top-10s of this run's
keyword sample").

**Acceptance.**
- Numbers reproducible from `run.json` export by an independent script (write the check as
  a unit test on the aggregator with a fixture of ~30 keywords).
- Tab renders in < 50 ms for a 500-keyword run (aggregation is O(keywords × 10)).
- A dead-brand keyword's SERP still counts (its top-10 is real data); `unsuggested`
  keywords without SERP are excluded (no D → no rows).

---

## 3. Overview tab redesign: run analytics  (effort: ~1.5 days)

Current Overview = 4 tiles + feed + one histogram; it wastes the screen where the product
should feel most "alive". All charts below are computed client-side from data already
delivered by existing queries (`run` snapshot + one unpaginated lightweight
`query kind="keywords-lite"` returning `{keyword, score, P, D, R, status, source,
childCount, brandQuery, unsuggested, degraded, probedAt}` for all keywords — add it; it is
a projection, ~60 bytes/keyword, fine up to 500).

Charts are hand-rolled inline SVG in the mascot style — no chart libraries. Palette:
blue #0244B5 (primary data), orange #F86C1A (highlight/selection), ink #191D3A axes,
muted #565B76 labels, red #C22B2B only for zeroed/error. 2px ink borders on plot frames,
no gradients, no glow. Every chart gets a one-line caption explaining what it shows.
Tooltips via `title` attributes (native) — no custom tooltip layer in v1.

**Layout (top to bottom):**

1. **Findings strip (§4)** — see next section; sits first, it's the "wow" row.
2. **P×D opportunity map** (the centerpiece, ~380px tall, left 2/3 width):
   scatter of all keywords with P and D known; x = D (0→100, "harder →"), y = P (0→100,
   "more demand ↑"). Dot radius 3px, blue; `selected` keywords orange; `score = 0` red
   at 40% opacity. Quadrant guides at P=50/D=50 (dashed ink 1px); the top-left quadrant
   (high P, low D) gets a faint orange-ghost background and the label "gold". Clicking a
   dot navigates to the Keywords tab with `q=<keyword>` prefilled. Caption: "Each dot is a
   probed phrase. Up-left = high demand, low difficulty."
3. **Right column next to the map** (1/3 width, stacked):
   - **Pipeline funnel**: horizontal bars candidates → verified → rated → selected, with
     counts; excluded and error as two thin red/gray rows below. Bar = blue fill in
     ink-bordered track (same pattern as landing receipt bars).
   - **R distribution**: four bars for R=3/2/1/0 with counts (blue/blue/muted/red).
     Caption: "Relevance verdicts by the judge."
4. **Score histogram** — keep the existing one, restyle: ink-bordered bars, blue fill,
   move under the map, full width, add a median marker (orange vertical line + label).
5. **Sources × outcome** — grouped bars per source (seed/suggest/competitor/expansion):
   total vs avg score. Answers "which discovery strategy earns its keep". Caption
   accordingly.
6. **Verification timeline** — cumulative line (SVG polyline) of verified keyphrases over
   time from `probedAt`, x = run wall-clock. Shows pace; flat segments = pauses (annotate
   paused stretches with yellow-soft bands if pause events exist in the feed).
7. **Live feed** — keep, move to the bottom, cap height 240px.

Tiles row (sample size · median score top-20 · Score covered · errors) stays on top of all
of it — drop the removed LLM tile, add `credits spent` (from the run's ledger view — this
is user-facing money, honest and useful; server already has per-run debits in the ledger;
add `creditsSpent` to the run snapshot counters).

**Empty/degraded states.** Before seeding: show the strip + a single friendly empty state
("charts appear as keyphrases verify"). Degraded probes (P null) are excluded from the map
and noted in its caption ("N phrases measured without P — suggestions endpoint was down").

**Acceptance.**
- All charts render from one snapshot + one keywords-lite query; network tab shows no
  polling beyond the existing live-refresh.
- 500-keyword run renders Overview in < 100 ms; no layout shift when live-refresh redraws
  (SVGs re-render in place, fixed heights).
- Every number shown is reproducible from `run.json` (same reproducibility test harness as §2).
- `prefers-reduced-motion` honored (no chart entrance animations in that case).

---

## 4. Findings strip: "what the engine caught"  (effort: ~0.5 day)

The differentiators (dead-brand trap, phantom questions, degradation honesty) currently
hide in table badges. Surface them as the first row of Overview — three chunky stat cards
(reuse `.tile` with an icon-free bold headline, orange number, one-line explainer):

- **Dead-brand traps caught** — count of `metrics.brandQuery === true`. Explainer: "phrases
  that autocomplete as demand but are just names of weak apps — Score zeroed, evidence in
  the row."
- **Phantom phrases filtered** — count of `unsuggested === true`. "Never appeared in
  autocomplete at any prefix — no demand, no budget spent on them."
- **Degraded probes disclosed** — count of `degraded === true`; hide the card entirely at 0.
  "Measured while Apple's suggestions endpoint was down — marked, never silently guessed."

Each card links to the Keywords tab pre-filtered (add `brandQuery/unsuggested/degraded`
as recognized values of the existing status/source filter mechanism — implement as a third
`insight` filter select, relay param `insight=`).

**Acceptance:** counts match the CSV export column sums; each card's click lands on a
filtered table whose row count equals the card's number.

---

## 5. Run diff: compare two runs  (effort: ~1 day)

The pay-per-run answer to AppTweak's tracking subscription: re-run the same app later,
diff the runs.

**Where.** Runs list: each finished run card gets a `Compare…` item; choosing two runs of
the same brand+storefront opens `#/compare/<runA>/<runB>`. Also a `Compare with previous`
shortcut on the run screen when an older `done` run with the same brand+country exists.

**Screen.** Three sections:
- **Header tiles**: Δ median top-20 score · keywords gained / lost (present in one run's
  suggest graph but not the other) · Δ credits spent.
- **Movers table**: keywords present in both, columns old→new Score with a small
  ink-bordered delta chip (orange up / red down / gray 0), sorted by |Δscore| desc, top 50.
- **Appeared / disappeared**: two lists of keywords present in only one run (the store's
  suggest graph moved — that IS the market signal), each with its P/D/R in the run where
  it exists.

**Mechanics.** Pure client-side: fetch both runs' keywords-lite (§3 query), join by
normalized keyword string. No server work beyond the existing queries. Guard: comparing
runs with different storefront/semantic language → hard error banner (apples to apples
only).

**Acceptance:** diff of a run with itself is all-zeros; diff is symmetric (A/B swap flips
signs); 2×500 keywords join renders < 100 ms.

---

## 6. Shareable HTML report  (effort: ~1 day)

Agencies sell reports to clients; indies paste screenshots into Slack. Give both a
one-click, self-contained artifact — which doubles as organic marketing.

**Where.** Run screen header, visible when `phase === done`: `Export report` button next to
`Reassemble`. Also an item in the §1 export menu (`report.html`).

**Artifact.** Single self-contained HTML file (inline CSS, zero external requests, no JS
required for reading; target < 300 KB):
- brand-styled (same tokens: cream/ink/blue/orange, Space Grotesk NOT embedded — system
  font stack to keep size; the mascot style carries through borders/shadows/colors);
- content: run header (brand, storefront, date, sample size) → ship-ready metadata block
  (both buckets with char counts) → findings strip (§4 numbers) → top-30 keyword table →
  P×D map as static inline SVG (reuse the §3 renderer server-side or client-side snapshot)
  → competitors top-10 table (§2 data) → coverage summary → formulas appendix;
- footer: "Generated by ASOptimus — app keywords, measured · asoptimus.com" (plain link,
  no tracking params in v1);
- NO raw LLM anything, NO token/cost numbers, NO credit numbers (client-facing artifact:
  agencies don't show their tool costs to clients).

**Mechanics.** Server-side string template fed by the same projections as §§2–4 (one new
`query kind="report-html"`), downloaded through the same localserver attachment route as §1.

**Acceptance:** file opens correctly from `file://` offline; passes the §1 no-new-calls
gate; renders identically in Safari/Chrome; a non-user can understand the run from the
report alone.

---

## 7. Pins & notes on keywords  (effort: ~0.5 day)

ASO is iterative; give the user a place to keep their shortlist and thoughts.

- Pin (☆→★ toggle, first cell of the keyword row) and a free-text note (textarea in the
  expanded row detail, autosaved on blur, 500 chars max).
- Storage: client-side only, in the local data dir (`<dataDir>/annotations/<runId>.json`,
  shape `{[keyword]: {pinned: boolean, note: string, updatedAt: string}}`). NOT synced to
  the cloud — it's the user's private working state on their machine (consistent with the
  local-first story); survives run re-reads, dies with run deletion (delete the file on
  run delete).
- `pinned` becomes a sort option (pinned first) and an `insight` filter value (§4).
- Pinned keywords get a `pinned` column in the CSV export and a "Shortlist" section at the
  top of the .md export (with notes).

**Acceptance:** pins/notes survive app restart; deleting a run removes its annotations
file; exports reflect pins; zero cloud traffic for annotation operations (assert no WSS
messages fired on pin/note).

---

## Cross-cutting rules

- **Style**: everything follows the mascot brand system already in `styles.css` — reuse
  existing classes (`.tiles`, `.panel`, `.badge`, `.progress`, table patterns) before
  inventing new ones. No chart/JS libraries; no emoji as icons; inline SVG only.
- **Language**: English only, everywhere (repo rule).
- **Contract discipline**: every new `query kind` gets (a) its params + result shape added
  to `shared/src/protocol.ts` FIRST, (b) the server handler, (c) the relay route, (d) the
  UI — in that order. The `run_id`/`runId` bug happened because the contract was implied;
  it is now always explicit. camelCase params throughout.
- **Tests**: each server-side aggregation/export (§1 CSV builder, §2 competitor
  aggregator, §6 report data) gets a unit test on a shared ~30-keyword fixture; plus one
  DEV-mode integration test covering: signup → activate → zero-balance gate (create,
  resume blocked, confirmContext blocked) → dev top-up → run to done on mocks → export all
  formats → diff run against itself → competitors aggregation non-empty. This single test
  would have caught every contract/billing bug found on 2026-07-19.
- **Suggested build order**: §1 → §4 → §3 → §2 → §5 → §6 → §7 (exports unblock the
  reproducibility harness the other sections' acceptance depends on).
