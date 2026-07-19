# 08 — Architecture, stack, binary builds, acceptance criteria

## 8.1 Stack

- **Bun ≥ 1.1** as runtime and compiler: `bun build --compile` produces a self-contained executable for each platform (cross-compilation via the `--target` flag).
- Language: TypeScript (Bun runs it directly, no tsc step).
- HTTP server: the built-in `Bun.serve` (no Express).
- Dependencies — minimal: `@anthropic-ai/sdk` (Claude adapter), `fast-xml-parser` (suggestions plist). Everything else — standard APIs. No frontend frameworks or bundlers: static assets (`index.html`, `app.js`, `styles.css`) and prompts (`src/llm/prompts/*.md`) are embedded into the binary via Bun file imports.
- Tests: `bun test`.

## 8.2 Repository structure

```
aso-util/
├── package.json
├── build.ts                  # binary build script for all platforms
├── src/
│   ├── main.ts               # entrypoint: flags (--port,--no-open,--data-dir), server, browser opening
│   ├── server/
│   │   ├── routes.ts         # HTTP API from 07.2
│   │   ├── sse.ts            # /api/events
│   │   └── public/           # index.html, app.js, styles.css (embedded into the binary)
│   ├── store/
│   │   ├── paths.ts          # dataDir, layout from 01.4
│   │   ├── runs.ts           # run CRUD, atomic state writes, events.jsonl
│   │   └── auth.ts           # auth.json (chmod 600), settings.json
│   ├── http.ts               # the SINGLE Apple request layer: token bucket, cache, retries (02.4)
│   ├── apple/
│   │   ├── hints.ts          # suggestions: request + plist/JSON parser (02.1)
│   │   ├── search.ts         # iTunes Search API (02.2)
│   │   └── storefronts.json
│   ├── metrics/
│   │   ├── popularity.ts     # probing + P formula (03.1)
│   │   ├── difficulty.ts     # AppStrength + D (03.2)
│   │   └── score.ts          # Opportunity (03.4)
│   ├── assembly/
│   │   ├── folding.ts        # form folding (05.3)
│   │   ├── select.ts         # greedy selection — pure function (05.4)
│   │   ├── place.ts          # placement across fields (05.5)
│   │   └── validate.ts       # T/S/K/X/W rules (05.7)
│   ├── llm/
│   │   ├── adapter.ts        # interface + registry (06.1)
│   │   ├── claude.ts         # Claude adapter: auth, completeJSON, usage (06.2)
│   │   ├── prompts/          # context.md, seeds.md, rate.md, hypothesize.md, phrase.md
│   │   └── schemas.ts        # JSON schemas of all task outputs (06.3)
│   └── pipeline/
│       ├── orchestrator.ts   # run state machine, the loop (04)
│       └── controls.ts       # pause/resume/stopAndAssemble/exclude (04.4)
├── test/
│   ├── fixtures/             # captured Apple responses + recorded LLM responses
│   ├── metrics.test.ts       # the examples from 03 match to the digit
│   ├── assembly.test.ts      # folding, greedy, validation
│   ├── pipeline.test.ts      # state machine with a mock adapter and mock Apple
│   ├── adapter.test.ts       # schema validation, error handling (mock transport)
│   └── smoke.live.test.ts    # live Apple requests (manual only: bun run smoke)
└── spec/
```

Key rules: formulas and greedy selection are pure functions with no I/O; all I/O lives in `http.ts` / `store/` / `llm/claude.ts`; the orchestrator is testable with a mock adapter (deterministic recorded responses).

## 8.3 Distribution build

`bun run build` (the `build.ts` script) builds into `dist/`:

| File | Target |
|---|---|
| `aso-util-macos-arm64` | `bun-darwin-arm64` |
| `aso-util-macos-x64` | `bun-darwin-x64` |
| `aso-util-linux-x64` | `bun-linux-x64` |
| `aso-util-windows-x64.exe` | `bun-windows-x64` |

Post-build check: each binary is launched with `--help` and `--port 0 --no-open` (the server came up, `GET /api/providers` responds). Browser opening: `open` (macOS) / `xdg-open` (Linux) / `start` (Windows). No installers or auto-updates in v1 — just a file.

## 8.4 Acceptance criteria (definition of done)

**Unit (`bun test`, no network and no LLM):**
1. The numeric examples from `03` match exactly: P("habit tracker", L=4, rank=2)=80; the example's AppStrength=93; Score(80,63,3) per the formula; P=0 → Score=0.
2. Folding — positive: `habits→habit`, `stories→story`, `boxes→box`, `games→game`, `notes→note`, `planes→plane`, `watches→watch`; negative (key = the word): `focus`, `status`, `class`, `press`, `business`, `analysis`, `news`, `lens`, `ios`; critical: key(`planes`) ≠ key(`plan`), key(`news`) ≠ key(`new`).
3. Greedy selection on a 30-phrase fixture: a stable repeatable result, no word repeats across fields, budgets not exceeded.
4. `validate()` catches every rule T1–W1 (a negative fixture per rule).
5. The state machine with a mock adapter: the full path created→…→done; R=0 → excluded; the sample counter ignores excluded/error; a pause mid-loop and a resume don't break the counters.
6. The adapter (mock transport): invalid JSON → one retry → error; 401 → AuthError; costUsd computed from the price list; call logging to llm-log.jsonl.

**Smoke (`bun run smoke`, with network, manual):**
7. hints US `photo` → non-empty list; RU with the Russian word for "photo" as the term → Russian-language suggestions.
8. search `habit tracker` US → ≥10 results with ratings.
9. Throttling: 40 uncached requests take ≥ 60 s; re-probing the same keyword — 0 network requests.

**E2E (manual, with real authorization and `fixtures/sample-brief.md`):**
10. First launch of the binary: the browser opened at `#/setup`; the providers page shows Claude + the placeholder; API-key authorization succeeds, `verifyAuth` is green; a wrong key gives a clear error.
11. Subscription authorization (when `ant` is present): token obtained, the probe call succeeded.
12. A new run with the sample brief: the context is generated and shown for confirmation; after "Go" the loop runs, the feed is live, keywords fill in with non-zero P/D/Score (or an honest unsuggested).
13. Pause → kill the process → restart the binary → the run is paused, resuming continues from where it stopped with no losses.
14. A run with a small sampleSize=30 reaches done: both buckets (primary + cross-localization) are valid (validate green, including X4 — no word repeats across buckets), coverage is shown, .md and .json exports download.
15. The LLM log tab shows every call with the full prompt/response/usage; the header totals match the log.
16. Expanding a keyword row shows the search results and a plain-language explanation of P.
17. Repeat everything on a second OS target (at minimum macOS + Linux; Windows — smoke `--help` + server start).

**Behavioral quality:**
18. Every error message says what to do next; an authorization drop mid-run loses no data (paused + a hint).

## 8.5 Instructions for the builder agent

Order: `http.ts` → `apple/*` (+ capture live fixtures) → `metrics/*` (+ tests per the examples) → `assembly/*` (+ tests) → `llm/` (adapter + prompts + schemas) → `pipeline/` → `server/` + frontend → `build.ts` → acceptance. The spec is self-sufficient; if code and spec contradict — fix the code; on a gap in the spec — make the conservative decision and record it as a comment in the code and a line in the README. The only permitted exploratory behavior is the smoke test of the suggestions endpoint's response format (`02.1`).
