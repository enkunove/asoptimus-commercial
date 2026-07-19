# 04 — Orchestrator: pipeline, hypothesis loop, stopping point

The orchestrator is the internal module of the binary that drives a run from the brief to the final metadata. It is controlled from the UI (start/pause/resume), writes every change to `state.json` + an event to `events.jsonl`, makes LLM calls through the adapter (`06`), and requests to Apple through the HTTP layer (`02`).

## 4.1 Keyword lifecycle (state machine)

```
candidate ──probe──▶ verified ──rate──▶ rated ──assemble──▶ selected | bench
                 └──▶ error (with reason; retried on the next probe step)
rated with R=0 ──▶ excluded (terminal)
```

**Sample counter** = number of keywords in statuses `rated`+`selected`+`bench` with R ≥ 1. `excluded` and `error` do not count.

## 4.2 Run phases (run state machine)

`created → context → context_review → seeding → loop → improving → assembling → done`
Plus orthogonal flags: `paused` (user pause in any phase), `failed` (fatal error with a message — e.g., authorization dropped).

### Phase: context
The `context` LLM call (brief → the structure from `01`). The result is saved, phase → `context_review`.

### Phase: context_review (the only phase blocking on the user)
The run is halted; the UI shows the context with buttons "Go" / "Edit". Confirmation → `seeding`.

### Phase: seeding
The `seeds` LLM call: context → the first batch of hypotheses (`batchSize`, at least one per semantic type):

| Type | Example for a sleep tracker |
|---|---|
| functional | sleep tracker, smart alarm |
| problem | cant sleep, how to fall asleep fast |
| audience | insomnia help, shift worker sleep |
| adjacent-competitive | sleep sounds, white noise |
| category | health monitor, wellness |

Hypothesis rules (embedded in the prompt, and duplicated by code validation when accepting the response): words of 3+ characters; no third-party brand names (checked against `competitors` from the context — the code drops them silently with an event in the log); no stopwords as standalone keywords; normalization and dedup against everything already known.

### Phase: loop — the core (repeats while sample < sampleSize)

1. **Probe:** the code evaluates all `candidate` keywords (P from suggestions, D from search results — `03`). A slow step due to throttling; progress is visible in the UI per keyword.
2. **Rate:** the `rate` LLM call in batches of ≤25 verified keywords → R + reason for each; the code recomputes Score.
3. **Hypothesize:** the `hypothesize` LLM call — input: the current top 20 by Score, cluster statistics, the leaders' "children" from suggestions (the code pre-fetches `hints("<kw> ")` for the top keywords with childCount>0 and passes the result into the prompt), phrasings from weak competitors' names. Output — a new batch of `batchSize` hypotheses: ~70% exploitation around what's strong, ~30% (`exploreRatio`) exploration of untouched semantic types. The code validates and adds them as `candidate`.
4. → step 1.

### Phase: improving (after the sample is filled)
Up to `improvementRounds` (default 2) more full loop iterations. If during a round not a single new keyword entered the top 20 by Score — the round is spent; if one did — the counter resets. Both spent → `assembling`.

### Phase: assembling
Code: greedy word selection + layout across fields — **two passes**: primary localization, then cross-localization over the remaining uncovered phrases (`05.4`, `05.9`). The `phrase` LLM call — one per bucket: selected words → a human-readable title slogan and subtitle. Code: validation (`05.7`, including the cross-bucket rule X4); on violation — up to 3 `phrase` retries with the violation text in the prompt; after 3 failures — phase `failed` with a clear explanation (in practice this should not happen: the validator checks exactly what the prompt requires). Success → `done`.

### Phase: done
Final fields in state; the UI shows the results and export. The user can press "Reassemble" (repeat assembling, e.g., after manually excluding keywords) or "Keep digging" (one more improving round).

## 4.3 The stopping point — formally

The loop is complete when: sample ≥ `sampleSize` **and** `improvementRounds` consecutive rounds without a top-20 update. No "until it's perfect" — only these two conditions. The user set both parameters when creating the run.

## 4.4 Run controls

| UI action | Behavior |
|---|---|
| Pause | The current atomic step finishes (one HTTP request / one LLM call), flag `paused`, the loop stops |
| Resume | Continues exactly from where it stopped (state on disk is the source of truth) |
| Stop and assemble | Early transition to `assembling` with what has been accumulated (button available at sample ≥ 30) |
| Exclude keyword | Manual transition to `excluded` (e.g., a legally risky word); always available |
| Delete run | With confirmation; deletes the run directory (does not touch the shared cache) |

Binary restart: runs in phases `loop/improving` do NOT resume automatically — they become `paused` (the user resumes from the UI; no surprises with background token spend).

## 4.5 Error handling

- An Apple error on a single keyword → `error` on the keyword, the pipeline continues; no permanent mark — the next probe step retries.
- An LLM call error → 3 retries with backoff (details in `06`); afterwards — `paused` with a banner "provider problem: <text>, check your authorization" and a "Retry" button.
- 401/403 from the provider → immediately `paused` + a redirect hint to the authorization page.
- Invalid JSON from the LLM after all validation retries → an event in the log with the full response, the step repeats; 3 consecutive failures → `paused`.

## 4.6 Budgets (guideline)

At `sampleSize=150`: ~600–1000 requests to Apple ≈ 35–55 minutes of throttling (the cache makes repeat runs nearly instant) and ~15–25 LLM calls (1 context + 1 seeds + ~8 rate + ~8 hypothesize + 1–3 phrase). Tokens and cost of every call are tracked and shown in the UI (`06.5`, `07`).
