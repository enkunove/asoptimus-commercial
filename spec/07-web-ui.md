# 07 — Web interface

The UI is the entire product: there is no other way to interact with it. Character requirements: clear and pleasant; full transparency — every number drills down to raw data, every LLM decision — down to the full prompt and response.

## 7.1 Startup and technology

- The binary starts an HTTP server **on 127.0.0.1 only**, port 4310 (flags: `--port`, `--no-open`, `--data-dir`) and opens the system browser.
- Frontend: **no build step and no external dependencies** — `index.html` + `app.js` + `styles.css` (vanilla JS, served from the binary). No CDNs, chart libraries, or frameworks; all visualization is tables, div progress bars, and minimal inline SVG.
- SPA routing by hash (`#/setup`, `#/runs`, `#/run/<slug>`, `#/run/<slug>/llm`); deep links work.
- Liveness: SSE `GET /api/events` (the server pushes on any run's state change; the client re-fetches data). Fallback — polling every 3 s.
- Dark/light theme via `prefers-color-scheme`; system font; tidy spacing. Tables don't lag at 500+ rows (pagination by 100 or virtualization).

## 7.2 HTTP API

| Endpoint | Description |
|---|---|
| `GET /api/providers` | adapter registry + each one's auth status (`verifyAuth`) |
| `POST /api/providers/:id/auth` | `{ method, payload }` → setAuth; response ok/error as text |
| `GET /api/runs` | run list (slug, brand, country, phase, progress, updatedAt, usage) |
| `POST /api/runs` | create a run: multipart (brief file or text) + config |
| `GET /api/runs/:slug` | full state: phase, counters, context, final fields, validate, usage |
| `GET /api/runs/:slug/keywords?sort=&dir=&status=&q=&page=` | keywords with metrics |
| `GET /api/runs/:slug/keywords/:kw` | details: topApps of the SERP, L/rank/childCount, reason, status history |
| `POST /api/runs/:slug/control` | `{ action: start\|pause\|resume\|stopAndAssemble\|reassemble\|exclude(kw)\|confirmContext\|editContext(patch) }` |
| `GET /api/runs/:slug/llm-log?page=` | LLM call log (full prompts/responses) |
| `GET /api/runs/:slug/export.md` / `export.json` | report / state export |
| `DELETE /api/runs/:slug` | delete a run |
| `GET /api/events` | SSE: `{ type: "run-changed", slug }` |

## 7.3 Screen 1: provider selection and authorization (`#/setup`)

Shown on first launch and always reachable from the menu ("Provider"). If no provider is authorized — all other routes redirect here.

```
┌──────────────────────────────────────────────┐
│  ASO-Util · Choose an LLM provider           │
│                                              │
│  ┌─ Claude (Anthropic) ────────┐  ┌─ ░░░░ ─┐ │
│  │  ● not connected            │  │ Others │ │
│  │  [Connect]                  │  │ soon   │ │
│  └─────────────────────────────┘  └────────┘ │
└──────────────────────────────────────────────┘
```

- The cards render from the adapter registry (`06.1`); an inactive placeholder card "More providers — coming soon" exists from v1 (the design honestly shows the architecture is extensible).
- Clicking "Connect" expands the card: **two tabs per authMethods** — "Subscription" (instructions with copyable `ant auth login` / `claude setup-token` commands + a field for a manual token + the honest banner from `06.2`) and "API key" (an input field + a link to console.anthropic.com).
- The "Verify and save" button → `POST auth` → a green check with the `detail` from `verifyAuth` (what exactly got connected) or red error text.
- On success — default model selection (a radio list from `listModels` with prices) and a transition to `#/runs`.

## 7.4 Screen 2: run list (`#/runs`)

- Run cards: brand + country, phase (badge), sample progress bar `117/150`, date, usage line, top-3 keywords by Score. Click → the run screen. Card menu: delete, clone (for another country, `01.5`).
- The "New run" button → a form: drag & drop zone for `.md/.txt` (or a "paste text" textarea), fields brand / country / **semantic language** (auto-filled from the country, editable — `01.3`) / sampleSize (slider) / model (select with prices), an "Advanced settings" accordion (`01.3`). Submit → the run is created, redirect to its screen, the `context` phase starts immediately.
- Empty state (no runs): friendly onboarding "Upload a description of your app — get the best keywords, title, and subtitle" + a link to a sample brief (we serve `fixtures/sample-brief.md`).

## 7.5 Screen 3: run (`#/run/<slug>`)

**Header (always visible):** brand · country · phase stepper `Context → Seeding → Loop → Improving → Assembly → Done` (active highlighted; paused — an orange pause overlaid); sample progress bar; LLM usage ("14 calls · 182k tokens · ~$1.9", click → breakdown); Apple HTTP counters (requests/cache hits); control buttons per `04.4`; a yellow degradation banner on `hintsEndpointDown`.

**"Context" step (phase context_review):** cards for the context fields (`01.2`) with inline editing; buttons "Go" / "Save edits". Caption: "This is the only thing you need to confirm — everything else runs on its own."

**"Overview" tab:**
- tiles: sample size; median Score of the top 20; Score covered (after assembly); errors; LLM calls;
- a live event feed from `events.jsonl` (autoscroll, human-readable lines): `14:02 ✓ habit tracker → P=80 D=63 Score=54 · 14:03 🧠 hypothesize: +20 hypotheses (14 exploit / 6 explore) · ...`;
- a Score distribution histogram made of div bars (buckets of 10).

**"Keywords" tab (the main one):**
- table: Keyword · Score · P · D · R · status · source(seed/suggest/competitor/expansion/explore) · childCount · reason (truncated, full in a tooltip);
- click-to-sort (default Score desc), a text filter, filters by status/source; Score color: ≥50 green, 25–49 yellow, 1–24 gray, 0 dim red; `speculative` — a purple tag;
- **row expansion — the transparency showcase:** the top-10 search results for the keyword (icon, name, ratings, update, AppStrength bar), the line "P=80 because the phrase appeared at prefix \"habi\" (4 of 13 characters) at position 2" — template-generated from raw data; the full R reason with a "show LLM call" link (an anchor into the log); an "Exclude" button;
- every P/D/Score column header has a "?" icon with a popover: the formula from `03` and the current config's weights.

**"Assembly" tab** (active from the assembling phase; before that — a placeholder with an explanation):
- **two field blocks**: "Primary localization (en-US)" and "Cross-localization (es-MX)" (`05.9`) — each with Title / Subtitle / Keywords in monospace, per-character counters `27/30` (turning red on overflow), words highlighted with intensity proportional to contribution; the cross-localization block has a popover "what this is and where to paste it in App Store Connect";
- a checklist of validation rules T/S/K/X/W + X4 with ✓/✗ and messages;
- a coverage table: top-50 phrases by Score → covered or not, by which bucket and which fields (T/S/K badges ×2), PlacementWeight;
- a "Top uncovered" block — what didn't fit even into the second bucket;
- in the done phase: "Copy" buttons on each field, "Export .md", "Export .json", "Reassemble", "Keep digging".

**"LLM log" tab (`#/run/<slug>/llm`):**
- call list: time · task (context/seeds/rate/hypothesize/phrase) · model · duration · tokens (in/out/cache) · cost · status;
- clicking expands the call in full: system prompt, user prompt, response (syntax-highlighted JSON), validation errors and retries. Nothing is hidden — this is the promised "how it works" transparency;
- a summary line: the run's total tokens and cost.

## 7.6 UI quality criteria (checked at acceptance)

1. Open the run screen — within 3 seconds it's clear: which phase, how much is left, what's happening right now.
2. No orphan numbers: every P/D/Score has a path to the raw data in ≤2 clicks; every R score — a path to the full LLM call.
3. The path "download the binary → launch → authorize with an API key → upload a brief → the run is going" can be walked without documentation; all hints live inside the UI.
4. Pause/resume/binary restart lose not a single piece of data and never confuse the UI.
5. Both themes look tidy; no horizontal page scroll at any width from 1024px up.
