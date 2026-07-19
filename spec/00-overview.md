# ASO-Util — Product Overview (v2)

## What it is

**A single executable file** (macOS / Windows / Linux) that generates the strongest possible set of ASO metadata for an iOS app: keywords, title, and subtitle. The user launches the file — a local web dashboard starts automatically and the browser opens:

```
launch the binary
   └─▶ local server (port 4310) + browser opens
         └─▶ [no valid auth] LLM provider selection page
               └─▶ authorization (Claude: subscription OR API key)
                     └─▶ dashboard: run list → new run (upload md/txt brief)
                           └─▶ live run → results
```

All of the pipeline's intelligence is a **built-in orchestrator** that calls the LLM through an adapter layer (`06-llm-adapters.md`). In v1 the only adapter is Claude, but the provider selection page exists from day one, and all code depends only on the adapter interface.

## The only input — a project description file

The user provides **an md/txt file describing the project via the dashboard** (drag & drop or file picker). No "run it inside a repository" mode, no CLI arguments with paths, no Claude Code skills. The orchestrator itself extracts the business context from the brief (the `context` LLM call, see `06`), shows it to the user for confirmation, and then proceeds through the pipeline.

## Division of labor: code computes, the LLM judges

| Deterministic code | Built-in LLM (via adapter) |
|---|---|
| Requests to Apple (suggestions, search results), throttling, cache | Extracting business context from the brief |
| P / D / Score formulas (`03-metrics.md`) | Generating seed hypotheses and new hypotheses in the loop |
| Greedy word selection and layout across fields (`05`) | Scoring relevance R by rubric (with justification) |
| Validation of limits and rules | Phrasing human-readable title/subtitle from the selected words |
| Pipeline state machine (`04`) | — |

## Principles (mandatory during the build)

1. **Deterministic metrics.** Every number is computed by a formula from `03-metrics.md`; the LLM only assigns R by rubric with a written justification. Same cache → same result.
2. **Transparency as a feature.** The user can drill into ANY number down to the raw data (which search results D was computed from, on which prefix P was found) and ANY LLM decision down to the full prompt and response (LLM call log, `07-web-ui.md`). Nothing happens "somewhere inside".
3. **Data — Apple primary sources only.** Store autocomplete suggestions + the official iTunes Search API. Throttling and caching are baked into the HTTP layer (`02`).
4. **Configurable stopping point.** The hypothesis loop runs until `sampleSize` verified keywords + improving rounds (`04-pipeline.md`).
5. **Provider independence.** The orchestrator knows only the `LlmAdapter` interface. Adding an OpenAI adapter in the future must not touch either the pipeline or the UI, other than a new card on the providers page.
6. **Everything local.** The server listens only on 127.0.0.1. Run data and credentials live on the user's disk. The only outbound traffic is requests to Apple and to the LLM provider's API.

## Outputs

1. Final metadata — **two buckets**: primary localization + cross-localization (title `Brand - Slogan` ≤30, subtitle ≤30, keyword field ≤100 in each) — with a coverage report (`05.9`).
2. A complete sortable list of verified keywords with P/D/R/Score.
3. Export: markdown report (button in the UI) + JSON of the run state.

## Non-goals for v1

- Google Play; download/revenue estimates; multiple countries in one run (one storefront per run; a second country = a second run).
- Adapters other than Claude (but the interface and the selection page ship in v1).
- Cloud version, accounts, multi-user — strictly a local tool.

## Glossary

| Term | Meaning |
|---|---|
| **Run** | One "brief → metadata" job for one app and one country; stored in `~/.aso-util/runs/<slug>/` |
| **Adapter** | An implementation of the `LlmAdapter` interface for a specific provider (`06`) |
| **Keyword / phrase** | A normalized search phrase (lowercase, single spaces) |
| **P / D / R / Score** | Keyword strength metrics, formulas in `03-metrics.md` |
| **sampleSize** | Target sample size of verified keywords — the loop's stopping point |
| **Phrase coverage** | All words of the phrase are present in the union of title+subtitle+keywords |

## Spec map and build order

| File | Contents |
|---|---|
| `01-inputs-and-context.md` | Brief, context extraction, run config, data storage |
| `02-data-sources.md` | Apple endpoints, storefront codes, throttling, cache |
| `03-metrics.md` | P, D, R, Score formulas with numeric examples |
| `04-pipeline.md` | Orchestrator: state machine, hypothesis loop, stopping point, controls |
| `05-assembly.md` | Assembling title/subtitle/keywords: greedy coverage, rules, validation |
| `06-llm-adapters.md` | Adapter interface, Claude adapter (subscription + API key), prompt contracts |
| `07-web-ui.md` | The entire UI: provider selection, authorization, runs, live dashboard, transparency |
| `08-architecture.md` | Stack (Bun, single binary), repo structure, acceptance criteria |
| `fixtures/sample-brief.md` | Test brief for e2e acceptance (uploaded into the dashboard) |

Recommended implementation order: 02 → 03 → 06 (adapter) → 04 (orchestrator) → 05 → 07 (UI) → binary builds → acceptance per 08.
