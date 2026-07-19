# ASOptimus — buildable blueprint (single source of truth for the build)

This document is the one you **start writing code from**. It goes deeper than `ARCHITECTURE.md`
(decisions/rationale) and `PRODUCT.md` (product picture): it captures the key architectural
decisions after a deep re-think, the full map of the repository and all submodules, the wire
protocol "local program ↔ server", the data model, and the build order. On any conflict, this
document wins over ARCHITECTURE/PRODUCT (their headers point here). The spec `aso-util/spec/*`
remains the truth for **domain logic** (P/D/Score formulas, assembly, prompts) — the commercial
version does not change it, only redistributes it across machines —
**with one explicit exception: the transparency principle 2 / 07.5 is relaxed (see D9).**

Chosen model (confirmed by the user): **the downloaded program serves a localhost UI
and makes the Apple requests; ALL other logic runs on the cloud server.** Below is exactly how
to assemble this so it works correctly.

> Revision 2: the plan went through adversarial validation by two subagents against the real
> aso-util code. All confirmed findings are incorporated (marked `[fix]` next to the decision/section).

---

## 0. What forced a re-think of the architecture (non-obvious facts from the spec + code)

1. **Popularity is computed via adaptive prefix probing (`spec/03.1`, `src/metrics/popularity.ts`).**
   And it's not "hit one URL" — it's a whole procedure: first the **full** prefix `K` is fetched
   (if `K` is absent from its suggestions → `unsuggested` in **one** request, early exit); otherwise —
   an ascending ladder `K[0:1..N]` with early stop at the minimal `L`; then one more fetch of
   `K + " "` for `childCount`; along the way all suggestions seen (`seenTerms`) become new
   candidates with `source="suggest"`. Naive one-URL-at-a-time delegation = thousands of cloud
   round-trips **and** loss of the one-request shortcut for unsuggested. → D2.
2. **The Apple cache in the spec is per-machine (`spec/01.4`).** In the cloud it becomes
   network-wide, but with careful semantics for computing `L` (otherwise the cache breaks the metric itself). → D3.
3. **Resumability rested on an atomic state file (`spec/04.4`).** In the cloud the source of
   truth is a Postgres event log; "client dropped mid-run" is a new failure class; and an
   **LLM call is an external paid side effect** which, under naive replay, executes
   twice. → D4, D7.
4. **Transparency (`spec` principle 2, `07.5`) requires showing FULL prompts in the UI** — yet
   the prompts are declared a moat and the client is untrusted. A direct contradiction. → D9.

---

## 1. Nine decisions (the core of the re-think)

### D1 — Topology "variant β": the browser talks ONLY to localhost

The browser (localhost UI) communicates **exclusively** with the local program on `127.0.0.1`.
Only **the program itself** (a native process) goes outbound to the cloud. The browser never
contacts the cloud at all.

```
Browser ──HTTP/SSE──► localhost:PORT (local program) ──WSS/HTTPS──► cloud
                                        └──fetch──► Apple (user's IP)
```

Why:
- **CORS disappears as a problem entirely.** The browser, just as in today's aso-util, hits only
  `127.0.0.1` (same-origin with the page). Cross-origin is done by the native Bun process, and
  CORS does not apply to native fetch.
- **The session token lives in one place** — in the program (OS secure store); the browser has
  nothing to leak.
- **Minimal delta from current code** — today the browser already talks only to localhost;
  the only change is that the program, instead of a local orchestrator, **relays** commands to the cloud.

### D2 — Coarse Apple jobs that reproduce the EXACT probing procedure `[fix]`

The unit of work is a whole job, not "one URL". `ProbeJob` **encapsulates the entire
`getPopularity` procedure from `popularity.ts`**, so that one keyword = one cloud round-trip and
the one-request shortcut for unsuggested is not lost:

`ProbeJob` execution algorithm on the client (strict):
1. Take/fetch the **full** prefix `K`. If `K` does not appear in its suggestions →
   return the result `unsuggested` (fetch nothing further). *(That's the very shortcut from
   `popularity.ts` — without it an unsuggested keyword costs N requests instead of one.)*
2. Otherwise — walk the ladder `K[0:1], K[0:2] … ` **strictly in ascending length order**; for each
   prefix: if it is in `prefill` (cache, D3) — take the content from there without hitting the
   network; otherwise fetch from Apple (own throttling). Stop at the **minimal** `L` where `K`
   appeared. **You must not skip a shorter cache-miss prefix in favor of a longer cache-hit one** —
   `L` is a minimum, order is mandatory.
3. Once `K` is found — fetch/take `K + " "` (for `childCount`).
4. Return `JobResult.raw` = **the full suggestion arrays for EVERY prefix actually touched**
   (fetched or taken from prefill — doesn't matter; but the server already has the prefill, so
   over the wire the client sends only what was actually fetched) + the array for `K + " "`.

The client **computes no metric whatsoever**. `P/L/rank/childCount` + harvesting `seenTerms` into
new candidates is done by the server (`@aso/core/metrics/popularity.ts`) — **over the union
`prefill ∪ returned raw`, keyed by prefix** (otherwise, if the matching prefix was in cache and
only shorter misses came over the wire, the server would find `K` nowhere and wrongly set
`P=0` — a confirmed blocker, closed by this rule).

The early stop is a mechanical string match (`K ∈ suggestions?`); the ladder is deterministic
from `K`. Nothing proprietary (formulas, expander strategy, prompts) is in the job — **the very
methodology "popularity = f(prefix depth, rank)" is partially visible from the job's shape; we
accept this as a non-secret: the secret is the constants (0.7/0.3) and the strategy, not the idea
(`spec/03.1` describes it anyway).**

The other jobs:
- `SerpJob{ query, storefront, lang }` — one iTunes Search request, raw JSON (for D).
- `HintsJob{ term, storefront }` — single suggestions for **independent** needs: leaders'
  "children" for `hypothesize` and the alphabet-soup expander. (childCount does NOT go here — it
  lives inside ProbeJob, otherwise it's an extra round-trip per keyword.)

### D3 — Network-wide server-side cache of raw Apple responses `[fix]`

The server keeps a cache of **raw** Apple responses (`sha1(method+url+storefront)`, TTL). Per
job: first check the cache → put what's found into `prefill` (probe) or don't send the job at all
(everything cached) → the client fetches only the misses → what returns is **written through** to
the cache.

**Critical for correctness (closed blocker):** the server computes `L/rank/childCount/seenTerms`
over `prefill ∪ raw` (D2), not over the returned raw alone. The client computes the early stop
locally over `prefill ∪ fetched`, strictly in ascending length order.

The win and its honest limits:
- Cache hit = the Apple request **does not happen at all**; a cache miss still goes via the
  **user's IP** (the server never contacts Apple). The anti-ban story stays intact.
- The speedup is **aggregate / on repeat runs**, NOT a reduction of the peak burst: the first
  user in a fresh niche still fetches a cold ladder from their own IP (same as local
  aso-util). Not a regression, but also not "magically fewer bans on the first run".
- The data is public and identical per storefront — no cross-user leakage of anything private.
- **A client-side local cache is recommended (not "optional"): it saves a re-fetch when an
  unfinished job reconnects (D7).** A soft measure against `L` drift: shorter TTL for
  short, highly reused prefixes (otherwise a near-TTL short prefix + a fresh matching prefix
  produce a temporally inconsistent ladder).

### D4 — Payment PER KEYPHRASE, debit in REAL TIME (usage-based) + internal COGS accounting `[fix v4]`

**User's decision (supersedes both the earlier per-token billing AND the earlier reserve/settle variant):**
usage-based — **you pay exactly for what was used; credits are debited in real time as the
run proceeds**. The unit = a verified keyphrase from the sample. The user sets sampleSize (slider)
and the model — and IMMEDIATELY sees a cost **estimate**. **1 credit = $1. NO free tier. Top-up of
credits only** (Paddle, $1/credit, packages in config).

- **The debit unit is a verified keyphrase** (the sample counter of spec 04.1: rated/selected/bench with
  R≥1). Price = `pricePerKeyphrase[model]` credits; **stronger model → pricier keyphrase**
  (Haiku < Sonnet < Opus). Default model — **Haiku** (user changes it in the form).
- **Debit happens in REAL TIME, on actuals:** as soon as a keyword becomes a verified keyphrase
  (rated, R≥1, included in the sample) — `pricePerKeyphrase[model]` is **immediately debited atomically**
  (`UPDATE wallet SET balance=balance-:p WHERE balance>=:p`), idempotent by `(run_id, keyword)`
  (`UNIQUE`, see §5). Credits melt LIVE as the run proceeds (the balance widget updates in real time).
  No reserve/settle/refund: **as many keyphrases produced, that many debited**.
- **The upfront figure is an ESTIMATE, not a hold:** the form shows `≈ sampleSize × pricePerKeyphrase[model]`
  live as the slider/model changes. Footnote: "the system may add **up to +10%** keyphrases (it finishes
  hypothesis branches already started) — **those are debited too**; the total may be up to +10% above the estimate".
- **Overshoot IS PAID FOR** (that's usage): produced `sampleSize×1.1` → all of them debited. The orchestrator
  caps the overrun at `sampleSize × 1.1` (does not run away beyond that), but whatever was produced is paid.
  Early stop → only what was produced is debited (naturally — debiting is real-time).
- **Hard stop at zero:** balance can't cover the next keyphrase → the run goes **paused** ("out of
  credits, top up — we'll continue from this point"), resumable. Concurrent runs of one wallet
  are serialized at the debit (atomic `WHERE balance>=:p`) — the balance can't go negative.

The source of truth for the balance is Postgres `wallet`. **BELOW is the INTERNAL COGS accounting** (our tokens):
it **does not touch the user's wallet** (the wallet is debited only per keyphrase, in real
time); it serves to calibrate `pricePerKeyphrase` and act as a fuse. Mechanics:
- **Meter EVERY provider token attempt** (not just the successful one): a logical LLM step = up to 6
  real billable calls (`orchestrator.llm()` up to 3× around `completeJSON()` with 2× internal
  retries — `src/llm/claude.ts`; `trackUsage` records only the last successful one → undercount).
  The llm-proxy records the tokens of every `callOnce` into `llm_steps` (§5) — that is OUR real COGS, not the user's bill.
- **`step_seq`** — a server-side monotonic counter per billable attempt; `UNIQUE(run_id, step_seq)`;
  the step result is persisted BEFORE advance; replay reads it and **does not call Anthropic again** (D7).
- **Model token prices come from a live source** (config/DB, not a hardcoded `PRICES_AS_OF`); the server
  calls Anthropic with an **api_key** (not subscription).
- **Calibration + fuse:** a run's total COGS is compared to revenue (debited keyphrases
  × `pricePerKeyphrase`); if real COGS is systematically above the keyphrase price — raise the price; if
  within a run COGS blows past a reasonable ceiling relative to what's already been debited — a safety
  pause. Margin lives in `pricePerKeyphrase` (a credit is $1 at face value).

(The mitigations of `ARCHITECTURE §4` — webhook idempotency, Radar — remain in force. An idle run at
`context_review` holds nothing: no debits have happened yet — there are no reserves.)

### D5 — Polyrepo on git submodules: every logical module is a separate git repository `[fix]`

**User's decision (supersedes the earlier monorepo variant):** the structure is a superproject
`asoptimus` + git **submodules**, one per logical module. Four submodules:

| Submodule (git repo) | What's inside | Privacy |
|---|---|---|
| `asoptimus-shared` | the contract: wire protocol, domain types, public constants (`@aso/shared`) | public-safe |
| `asoptimus-server` | **the brain:** `@aso/core` (metrics/assembly/expander/**prompts**) + `@aso/server` (orchestrator/llm-proxy/billing/auth/apple-dispatch/db/api) | **PRIVATE** (moat) |
| `asoptimus-client` | **the local program:** `@aso/apple` (fetch primitives) + `@aso/client` (relay/cloud-link/activation) + `@aso/web-ui` | can be made auditable/public |
| `asoptimus-landing` | the landing page (already exists) | public |

Why this is stronger than the earlier CI graph: **the moat separation is now physical, not
enforced by checks.** The formulas, the expander strategy, and the prompts live **only** in the
private `server` repo and cannot end up in `client` in principle — they don't exist there as
files. `shared` is a thin contract (types + protocol), so the well-known pain of submodules
(versioning shared code) is minimal: both depend on `shared`, you bump it rarely. `shared` is
included in `server` and `client` as a **nested submodule**, imported via the tsconfig alias
`@aso/shared` (details — `SETUP-SUBMODULES.md`).

### D6 — Tauri is optional; the MVP "program" = a compiled Bun binary

The "program" at MVP is the same `bun build --compile` binary: it serves the localhost UI and
opens the browser. No Tauri needed to launch (localhost serving already exists in aso-util;
`bun build --compile` already embeds the web UI via `import … with { type: "text" }` and builds 4
targets). Tauri 2.x is **Phase 2**, a UX wrapper (native window, tray, auto-updater, single
code-signing point). Polish, not foundation.

### D7 — Run lifecycle over connection drops; a live client connection gates ANY spend `[fix]`

The run lives on the server (event-sourced log in Postgres). Invariants:
- **A live client connection + sufficient balance is a hard condition for ANY spend, not just
  Apple fetches.** `rate/hypothesize/phrase` operate over data already gathered and could
  "run away" and burn tokens after a disconnect — we forbid it: no live client session → not a
  single LLM call. (Otherwise `spec 04.4` "no surprises with background spend" is violated.)
- **An LLM call is an external side effect; replay does NOT repeat it.** Before calling Anthropic,
  the server writes a `dispatched` event with an idempotent key (`run_id+step_seq`) and **passes
  that key as the idempotency key in the Anthropic request**; the result is persisted BEFORE the
  state advance. Replay after a restart reads the persisted result and doesn't call the provider again.
  (Otherwise a restart mid-LLM-call = double COGS for a single user debit.)
- **Client dropped** → Apple fetch impossible → auto-`paused`; on reconnect: the client sends
  completed `job_id`s, the server deduplicates. **An unfinished ProbeJob** (some prefixes
  fetched but `job.result` not sent) is not on the completed list → the job is re-dispatched
  in full; the server did not write-through those prefixes → the client's local cache (D3)
  saves us from hitting Apple again. (Optional: the client streams partial raw so finished
  prefixes get cached.)
- **Browser closed** → the run continues (the client program stays connected); reopened → SSE
  reattach via `Last-Event-ID` → replay-then-tail. **SSE is relayed through the program (D1): if
  the program restarted, the browser stream is re-established; the server's `run_events.seq` is
  authoritative, not the local one.**
- **Program closed entirely** → same as "client dropped": `paused`, zero background spend.
- **The anti-replay nonce cache** (`ARCHITECTURE §5`) lives in memory and is lost on restart → ±5m window;
  in Phase 4 — a shared store, or bind the window to a per-connection epoch.

### D8 — localhost guard: Host allowlist + Origin, not just a token `[fix]`

Localhost is only conditionally "trusted". A token in the HTML **does not close** the very threat
it names: any co-resident process can simply `GET /` and scrape the token out of the body. Nor
does it protect against **DNS rebinding** (after rebinding, the attacker's domain = same-origin,
reads the HTML, takes the token). So the guard is three layers:
1. **Strict Host allowlist** — reject any `Host` ≠ `127.0.0.1:PORT`/`localhost:PORT`.
   This is the real protection against DNS rebinding.
2. **Origin check** on all state-changing routes (kills blind CSRF).
3. **Per-launch token** in the HTML — against naive CSRF.
**Residual risk, stated explicitly:** a co-resident local process can scrape the token —
a token can't close that in principle; it's outside the threat model of a localhost tool.

### D9 — Prompts are NOT shown in the UI at all (decision made) `[fix]`

`spec` principle 2 / `07.5` required disclosing every LLM call down to the full system and
user prompt. In the commercial version this is **cancelled entirely**: the prompts are the
moat, the client is untrusted, and we give the user no extra information.

**Decision (final):** the cloud LLM journal **contains neither the system nor the user prompt,
in any form** — no body, no "redacted" version, no hint. We show the user only the **output of
the work** (what's useful to them and what they pay for): `R + reason` scores per keyword,
generated hypotheses, the final title/subtitle, plus the run's total tokens/cost. All of these
are model outputs and metrics, not prompts. **Transparency of the NUMBERS remains complete:**
raw SERP/suggestions and the explanation "P=80 because the prefix \"habi\"…" are relayed freely
(raw Apple data is not the moat). The prompts physically live only in the private `server`
repository (D5) and never cross the server boundary outward.

---

## 2. Target topology (variant β)

```
┌───────────────────── The user's MACHINE (untrusted) ──────────────────────────┐
│  Browser: localhost UI (@aso/web-ui) — runs, keywords, assembly, balance       │
│     │  HTTP + SSE, only 127.0.0.1, Host-allowlist + Origin + per-launch token (D8)
│     ▼                                                                          │
│  LOCAL PROGRAM (@aso/client, Bun binary; optional Tauri in Phase 2):            │
│    ├─ localserver: serves @aso/web-ui + relay API/SSE to the cloud (D1)        │
│    ├─ cloud-link: WSS to the cloud, session token from the secure store        │
│    ├─ apple-exec: executes Probe/Serp/Hints jobs via @aso/apple (D2)           │
│    │     (per-IP throttle, full-prefix shortcut, early stop, RAW DATA)         │
│    └─ activation: key → session token, OS keychain                             │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ WSS (commands/jobs/progress) + HTTPS (activation, top-up)
┌──────────────────────────── CLOUD: @aso/server (trusted) ─────┴─────────────────┐
│  orchestrator  — state machine + expander (@aso/core), event-sourced;           │
│                  Apple I/O via apple-dispatch, pause-at-job-boundary (D7)        │
│  apple-dispatch— network-wide raw-data cache (D3) + job queue + WSS channel to clients │
│  llm-proxy     — prompts from @aso/core, Anthropic api_key calls, metering of    │
│                  EVERY attempt, prompt caching, micro-reserve+hard-stop (D4), idem-key │
│  billing       — wallet+ledger (truth), micro-reserve/settle (D4), per-run floor │
│  auth          — key→session-token, device binding, HMAC, revocation, rate/user  │
│  db            — Postgres: users, licenses, wallet, ledger, llm_steps, runs,     │
│                  run_events(event log), jobs, apple_cache, processed_events      │
└──────────────────────────────────────────────────────────────────────────────────┘
        Apple (autocomplete + search) ◄── fetch from the USER'S IP (cache hit = no fetch)
```

---

## 3. Repository and all submodules (polyrepo, git submodules) `[fix]`

Superproject `asoptimus/` + 4 git submodules (D5). `S` = server repo, `C` = client repo,
`∘` = shared. **Moat boundaries are physical: the `core/` and `prompts/` files exist ONLY in the
private `server` repo.**

```
asoptimus/                        ← SUPERPROJECT (git): plans, infra, .gitmodules
├── BUILD-PLAN.md / ARCHITECTURE.md / PRODUCT.md / LANDING-ADDITIONS.md
├── .gitmodules                   # registration of the 4 submodules (URLs under github.com/enkunove/asoptimus-*)
├── SETUP-SUBMODULES.md           # one-time commands: create remotes + submodule add + nested shared
├── infra/                        # docker-compose (server+postgres), deploy (Railway/Fly), CI matrix
│
├── shared/   → submodule asoptimus-shared      ∘  @aso/shared — the contract, zero-I/O, zero-secret
│   └── src/{types.ts, protocol.ts, constants.public.ts, storefronts.public.json, index.ts}
│        # types (from aso-util/src/types.ts); protocol (Probe/Serp/HintsJob, JobResult, SSE — §4);
│        # storefronts.public = ONLY {country→id, primaryLanguage}; do NOT put extraLocale/weights/formulas here
│
├── server/   → submodule asoptimus-server (PRIVATE)   S  brain + cash desk, long-lived process
│   ├── shared/  (nested submodule asoptimus-shared; imported as @aso/shared)
│   └── src/
│      ├── core/                  # @aso/core — PROPRIETARY, zero-I/O:
│      │   ├── metrics/{popularity,difficulty,score}.ts  # P/L/rank/childCount/seenTerms from raw data; D; Score
│      │   ├── assembly/{folding,select,place,validate}.ts # 05.3–05.7 (+X4)
│      │   ├── expander.ts        # planWave/runWave → EMITS Hints jobs (from src/pipeline/expander.ts)
│      │   ├── locales.ts         # extraLocale table (05.9) + placement weights (05.2) — server-only
│      │   ├── prompts/*.md       # context/seeds/rate/hypothesize/phrase — moat (from src/llm/prompts/*)
│      │   └── llm-schemas.ts     # JSON schemas of outputs (06.3)
│      ├── orchestrator/          # state machine (refactor of src/pipeline/orchestrator.ts):
│      │      # pure functions 1:1; loop + getPopularity/runWave → async job emit/await,
│      │      # pause-at-job-boundary, disconnect-resume (control-flow inversion, §7)
│      ├── apple-dispatch/        # D3 cache + job queue + WSS channel + idempotency (D7)
│      ├── llm-proxy/             # prompt assembly + Anthropic api_key + metering of EVERY attempt (D4)
│      ├── billing/               # wallet+ledger, micro-reserve/settle (D4), live price, per-run floor
│      ├── auth/                  # key→session-token, device-bind, HMAC, revocation, rate/user
│      ├── paddle/               # transaction top-up, webhooks (idempotent)
│      ├── db/                    # schema, migrations, repositories, pg-boss/graphile-worker
│      ├── api/                   # REST (activation/balance/top-up) + progress SSE + WSS router
│      └── main.ts                # Bun.serve (HTTP+WSS), graceful shutdown
│
├── client/   → submodule asoptimus-client   C  the downloadable program (bun build --compile)
│   ├── shared/  (nested submodule asoptimus-shared; imported as @aso/shared)
│   └── src/
│      ├── apple/                 # @aso/apple — fetch primitives, NO metrics:
│      │   ├── http.ts            #   token bucket, retries/backoff, local cache (from src/http.ts)
│      │   ├── hints.ts / search.ts #  fetch+parse of raw data (from src/apple/*)
│      │   └── probe.ts           #   NEW: ProbeJob executor (full-prefix shortcut →
│      │        #                       early-stop ladder → childTerms; returns raw data) (D2)
│      ├── cloud-link.ts          # WSS client: session token, receives jobs, returns raw data, relays progress
│      ├── apple-exec.ts          # routing Probe/Serp/Hints → apple/ (D2)
│      ├── localserver.ts         # serves web-ui + relay API/SSE ↔ cloud (D1) + guard (D8)
│      ├── activation.ts          # key → session token; secure store
│      ├── web-ui/                # @aso/web-ui — localhost UI (vanilla, no build step; 07/08):
│      │   └── index.html/app.js/styles.css  # + key login, balance, top-up; talks ONLY to localhost
│      ├── main.ts / build.ts     # free port, health check, open browser, 4 targets
│      └── (Phase 2) desktop/     # OPTIONAL: Tauri 2.x shell, this binary as a sidecar
│
└── landing/  → submodule asoptimus-landing   asoptimus.com (exists): offer, download buttons,
        # email capture → Customer+wallet, email with the key. What to add — LANDING-ADDITIONS.md
```

**Boundaries (moat/correctness) — now at the repository level:**
- `core/` (formulas, expander strategy, `locales.ts`, `prompts/`) is **physically only in the
  private `server` repo**. The client repo does not contain them — no CI graph needed, it's a
  structural guarantee.
- The `client` repo contains only fetch primitives + relay + UI. Fully cracked open, it reveals
  nothing proprietary (D2/§1).
- `shared` — only wire types and PUBLIC constants (review invariant: no formulas, no weights, no
  `extraLocale`). `storefronts.public` carries only `{id, primaryLanguage}`; `extraLocale` (05.9)
  and placement weights (05.2) live in `server/src/core/locales.ts`.

---

## 4. Wire protocol "program ↔ cloud" (`@aso/shared/protocol.ts`) `[fix]`

Two channels: **WSS** (commands/jobs/progress) and **HTTPS** (activation, top-up redirect).
Authentication: `session-token` at connect; every message — HMAC + timestamp(±5m) +
nonce (`ARCHITECTURE §5`).

**Client → server:** `hello{session_token, device_fp, resume_job_ids[]}` ·
`run.create{brief, config}` · `run.control{run_id, action}` · `job.result{job_id, kind, raw}`
· `job.error{job_id, reason, throttle?}`.

**Server → client:** `job.dispatch(Probe|Serp|Hints)` · `run.progress{run_id, seq, event}` ·
`run.phase{run_id, phase, counters}` · `run.paused{run_id, reason}` · `balance{credits}`.

**Job types (the server decides WHAT, the client decides HOW; raw data, not metrics):**
```ts
type RawHints = string[]                        // ordered suggestions of a single request
type ProbeJob = { job_id, kind:'probe', run_id, keyword, storefront,
                  prefixLadder: string[],       // ['k','ke','key',… ,keyword] — deterministic from keyword
                  prefill: Record<string,RawHints> }   // D3 cache (with content, for local early stop)
type ProbeResult = { job_id, kind:'probe',
                  fetched: Record<string,RawHints>,    // ONLY prefixes actually fetched (full arrays)
                  childTerms: RawHints | null,         // suggestions for "keyword " (null if unsuggested)
                  unsuggested: boolean }
type SerpJob  = { job_id, kind:'serp',  run_id, query, storefront, lang }   // → raw Search JSON
type HintsJob = { job_id, kind:'hints', run_id, term, storefront }          // leaders' children / alphabet-soup
```
Over `prefill ∪ fetched` the server computes `L/rank` (and `childCount` — from `childTerms`), and
**harvests `seenTerms` (the union of all suggestions) into new candidates with `source="suggest"`** (this feeds the hypothesis loop —
without the full arrays in `fetched` the harvest is impossible). `job.error{throttle}` → server-side
back-pressure (the analog of `runWave`'s "break on throttle" from `expander.ts`).

**Browser ↔ localhost** (relay, D1, as in `spec/07.2`): the same `/api/runs`, `/api/runs/:id[/keywords|/control]`,
`/api/events`(SSE), `/api/balance`, `/api/topup`(→ Paddle checkout URL) — but the program does not
execute them locally; it translates them into WSS and streams the response back.

---

## 5. Data model (Postgres, `@aso/server/db`) `[fix]`

| Table | Key fields | Purpose |
|---|---|---|
| `users` | `id, email, paddle_customer_id` | identity |
| `licenses` | `key_hash, user_id, device_fp, status, revoked_at` | key→user, device-bind, revocation |
| `wallet` | `user_id PK, balance_credits` | balance — **source of truth** (D4); debit under `FOR UPDATE` |
| `ledger` | `id, user_id, delta, type, run_id, step_seq, paddle_event_id, ts`, **`UNIQUE(run_id, step_seq)` (for debit/settle)**, `paddle_event_id UNIQUE` | immutable journal; idempotency of debits and grants |
| `llm_steps` | `run_id, logical_step, step_seq, request_hash, result_json\|null, valid bool, usage, ts`, `PK(run_id, step_seq)` | every billable attempt = a row (incl. invalid ones); **advance/replay by the last `valid` row of the logical step** — Anthropic is not called again (D7) |
| `processed_events` | `paddle_event_id UNIQUE` | webhook idempotency |
| `runs` | `id, user_id, phase, config, context, final, usage` | run header |
| `run_events` | `run_id, seq, ts, event` | **event-sourced** log (replay, SSE, `Last-Event-ID`) |
| `jobs` | `job_id, run_id, kind, payload, status, result, deadline` | Apple job queue, idempotency (D7) |
| `apple_cache` | `cache_key PK, url, storefront, status, body, fetched_at` | network-wide raw-data cache (D3), TTL |

`step_seq` — a server-side monotonic counter **per billable attempt** (not per logical step), see
D4. The job queue — `FOR UPDATE SKIP LOCKED`. One instance at launch → no sticky-WS needed.

---

## 6. Flow of a single run (stitched with D1–D9)

```
1. Browser → localhost (Host-allowlist+Origin+token, D8): POST /api/runs {brief, config}
2. Program (cloud-link) → cloud (WSS, session-token+HMAC): run.create
3. Server(auth): token ok? → START-FLOOR atomically (D4); insufficient → run.paused("top up")
4. context: llm-proxy (micro-reserve → dispatched event+idem-key → Anthropic api_key →
   meter EVERY attempt → settle to actuals, D4; result into llm_steps BEFORE advance, D7) → context_review
5. Browser confirms context → seeding → loop:
     P/D: orchestrator+expander emit Probe/Serp/Hints jobs. apple-dispatch: D3 cache → misses
       into job.dispatch (probe with prefill). apple-exec: full-prefix shortcut → early stop →
       childTerms → ProbeResult(raw). Server: L/rank/childCount over prefill∪fetched, harvest
       seenTerms, write-through cache.
     rate/hypothesize: llm-proxy (micro-reserve → hard stop → idem call → per-attempt debit).
     ANY spend requires a live client connection (D7).
   Progress: run.progress/phase → relayed into the browser SSE (authoritative run_events.seq).
6. improving (04.2) → assembling: @aso/core greedy+place, 2 buckets; phrase calls; validate
   (T/S/K/X/W/X4). → done.
7. SETTLE: return the floor remainder, final ledger row, the ledger stays authoritative (no provider metering).
```

Not a single step is possible without the server: it sends the Apple jobs, only it has the LLM
key, it approves the credits, and any spend additionally requires a live client. The client sits
idle without a connection/balance.

---

## 7. What migrates from aso-util (file by file, honest about complexity) `[fix]`

| aso-util | Where to | Migration complexity |
|---|---|---|
| `src/types.ts` | `@aso/shared/types.ts` | trivial; + wire types into `protocol.ts` |
| `src/http.ts`, `apple/hints.ts`, `apple/search.ts` | `@aso/apple/*` | almost 1:1; + new `probe.ts` (D2) |
| `apple/storefronts.json` | split: `@aso/shared/storefronts.public.json` (id+lang) + `@aso/core/locales.ts` (extraLocale) | easy split |
| `metrics/*.ts` (pure: `popularityScore`, `computeDifficulty`, `opportunityScore`) | `@aso/core/metrics/*` | **1:1** (pure functions) — but the input is now raw data from jobs |
| `assembly/*.ts` (`selectWords`, `placeWords`, `validate`, `foldKey`) | `@aso/core/assembly/*` | **1:1** (already pure) |
| `pipeline/expander.ts` `planWave` (pure) | `@aso/core/expander.ts` | 1:1 |
| `pipeline/expander.ts` `runWave` (network, inline-blocking) | `@aso/server` | **rewrite** into async job emit; "break on throttle" → server back-pressure |
| `metrics/popularity.ts` `SuggestPopularityProvider.getPopularity` (network) | splits: client-side probe executor (`@aso/apple`) + server-side computation (`@aso/core`) | **rewrite** (network ↔ computation split across machines) |
| `pipeline/orchestrator.ts` (1339 lines) | `@aso/server/orchestrator/*` | **the heaviest piece:** today the loop is `await fetch → raw+metrics inline` + a concurrent `rateInFlight` promise during probing + `checkPause()`→`PauseInterrupt`. All of that → event-driven scatter/gather with pause-at-job-boundary and disconnect-resume. **This is control-flow inversion, not "cut into modules".** Budget Phase 3 accordingly. |
| `pipeline/controls.ts` | `@aso/server/orchestrator/controls.ts` | 1:1, but the guards (`≥30 sample` etc.) become server-side |
| `llm/prompts/*`, `schemas.ts` | `@aso/core/prompts/*`, `llm-schemas.ts` | PROPRIETARY, server only |
| `llm/claude.ts` | `@aso/server/llm-proxy/*` | server, api_key; client subscription/BYO — **removed**; price — live, not hardcoded; meter EVERY attempt (D4) |
| `llm/adapter.ts` | `@aso/server/llm-proxy/adapter.ts` | the registry stays; auth becomes server-side |
| `server/routes.ts`, `sse.ts` | split: `@aso/server/api` (cloud) + `@aso/client/localserver` (relay+guard D8) | medium |
| `server/public/*` | `@aso/web-ui/*` | + key login, balance, top-up; LLM journal per D9 (answers+numbers only, NO prompts) |
| `store/*` | `@aso/server/db` | runs → Postgres; locally — only an optional Apple cache |
| `main.ts`, `build.ts` | `@aso/client/*` | 1:1 |

Unit tests `aso-util/test/*` travel with their modules: metrics/assembly → `@aso/core` (match 1:1),
adapter → `@aso/server`.

---

## 8. Build order (phases) `[fix]`

Polyrepo submodules (D5) make "thin client / fat server" the natural shape from day one —
so **the earlier compromise "metrics/expander temporarily in the client" is cancelled**: all logic
is server-side immediately (otherwise it would physically end up in the client repo — contradicting
D5). This raises the volume of Phase 1, but removes a dirty migration and closes the hole of the
client forging the bill.

- **Phase 0 — demand validation (now).** aso-util lives on as a free local beta for the
  landing page/waitlist. We don't build the commercial version without a demand signal.
- **Phase 1 — vertical slice "thin client, money is gated".** Three repos (`shared/server/
  client`) stand. The server holds **ALL** the logic: `core` (metrics/assembly/expander/prompts) +
  orchestrator (job dispatch, §7 inversion) + llm-proxy (Anthropic api_key, metering of every
  attempt, D4) + billing (wallet+ledger with `UNIQUE(run_id,step_seq)`, micro-reserve/settle,
  llm_steps) + auth (key→session-token) + apple-dispatch (D3 cache, job queue) + one Paddle
  Checkout+webhook. The client: apple-exec (D2) + cloud-link + localserver (guard D8) + web-ui
  (login/balance/top-up) + activation. **No Tauri** — just a localhost binary.
  **Billing invariant:** the only billing authority is the server — the server issues `run_id`/
  `step_seq`, **serializes** the wallet's LLM calls (`FOR UPDATE`), debits by ITS OWN usage,
  never by the client's numbers.
- **Phase 2 — desktop wrapper (D6).** Tauri shell + sidecar (the same binary), signing/
  notarization for 3 OSes, auto-updater, download buttons + email with the key, balance/top-up screen.
- **Phase 3 — scale/insurance.** A second instance + WS bus (Redis pub/sub), durable stream,
  persisted nonce cache, an ASA provider (a second leg against the death of the Apple endpoint),
  position monitoring as an upsell.

**Phase 1 DoD:** new key → activation → brief → a run that is **physically impossible without
the server** (the server sends the Apple jobs, only the server has the LLM key, the server approves
the credits); **the server debits incrementally by ITS OWN usage, serialized, with no races and no
undercounts**; at zero — an honest `paused`; top-up via Paddle replenishes; a server restart
mid-LLM-call does not double COGS (llm_steps); a cracked-open client contains neither formulas nor
prompts (D5). One VPS + Postgres, Paddle sandbox→live.

---

## 9. Risks and open decisions

**Risks (in descending order):**
1. **LLM economics + chargebacks** — margin in `pricePerKeyphrase`, real-time per-keyphrase debits +
   hard stop at zero, internal per-attempt COGS accounting + llm_steps (D4/D7), live price, Radar.
2. **Death of the undocumented Apple endpoint** — the ASA provider as a second leg (Phase 4);
   the D3 cache softens the frequency.
3. **Latency under throttling** — D2 (job=keyword, full-prefix shortcut) + D3 (hit=0
   fetch) keep the run throttle-bound at ~35–55 min (`spec 04.6`); honest progress streaming (D7).
4. **Logic protection** — fundamentally incomplete; the Phase 1 MVP compromise (but with SERVER-side
   billing), full rollout in Phase 3.
5. **Complexity of the orchestrator refactor** (§7) — must not be underestimated; it is a control-flow inversion.
6. **Overengineering** — a Postgres queue + a single container cover everything up to tens of
   thousands of jobs/sec.

**Decided (final, after the questions):**
- (D9) prompts are not shown in the UI at all.
- Billing — usage-based, **real-time** per-keyphrase debits (D4 v4); overshoot is
  paid; the upfront figure is only an estimate. **1 credit = $1, NO free tier, top-up only**.
- Run model: user's choice, **default Haiku**; keyphrase price grows with model power.
- Licensing — **our own** (Postgres keys + session-token + HMAC), no Keygen/Paddle.
- Email — **our own service over SMTP** (provider-agnostic: any SMTP relay; for deliverability
  point it at a transactional SMTP, not a home-grown mail server — spam otherwise).
- The app — **macOS only**, Tauri → **signed `.dmg`** (Developer ID + notarization; Apple
  Developer $99, the certificate is inserted at the end). Not the App Store.
- Hosting — **docker-compose** (server + Postgres), under Colima / any Docker host.

**Open (to be pinned down with numbers at the very end):** the exact `pricePerKeyphrase[model]` and
top-up package sizes.
