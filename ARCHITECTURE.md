# ASOptimus — commercial version architecture

Planning document. Based on live research 2026-07 (Tauri/signing, Paddle billing,
licensing, backend patterns). Technical terms in English; reasoning originally in Russian.

> **The current source of truth for the build is `BUILD-PLAN.md`** ("variant β" topology,
> submodules, wire protocol, D4 billing, phases). This document holds the rationale/research
> behind it; where they diverge, BUILD-PLAN wins.

---

## −1. Decision #0: why "just a website" won't work (everything depends on this)

**The browser cannot hit Apple's autosuggest endpoint on its own** — and that is the source
of Popularity, the heart of the product. Two hard reasons:
1. **CORS**: Apple does not return `Access-Control-Allow-Origin` for your domain → the browser
   blocks reading the cross-origin response.
2. **Forbidden headers**: hints require a custom `X-Apple-Store-Front` (triggers a
   preflight that Apple never answers permissively), and the browser won't let JS set
   `User-Agent` at all.

So there are only two paths, and this is a FUNDAMENTAL fork:

- **Path A — website + server-side Apple fetching.** Simplest UX (no installs), but
  all requests come from YOUR server IP → Apple bans you as you grow → you need a
  **proxy farm** (residential proxies, money + gray zone). You lose the moat (free
  distributed crawling) and the local-privacy story. You become "yet another ASO SaaS".
  At the start, with low volume, it may survive on a server IP + aggressive cache — but the
  bet rots as you grow.
- **Path B — website + thin local agent (RECOMMENDED).** All UI/billing/tutorial/balance
  live on a **regular website**; locally there is only a **tiny headless agent** (or a
  browser extension) that can do exactly one thing: "the server told me to hit these Apple
  URLs → fetched from the user's IP → returned the raw response". Preserves the moat and the
  local story, and it is far smaller than a full desktop app — no need to pack UI and server
  into Tauri, only a fetch agent.

**Important simplification relative to the sections below:** the "desktop app" in this
document can be reduced to a **thin local agent with no UI**, keeping the entire interface
as a website. Agent options: a browser extension (easy install, but store review + MV3
limits on UA) or a mini desktop binary (more reliable, but install friction + signing for
3 OSes). Sections 2–3 (role inversion, thin client) still hold — the "client" is now just a
small agent, and the UI lives on the web.

Recommendation: **Path B.** Your product sells precisely on locality/transparency/cheap
unbannable crawling — that's the differentiator from expensive SaaS; kill locality (Path A)
and you enter their field without their budgets.

---

## 0. Verdict on your idea

The idea is **fundamentally sound and buildable** — nothing wrong with it. It's harder than
it looks, but that complexity is unavoidable for a metered commercial tool — not because you
overcomplicated it, but because "usage-based payment + local execution + logic protection"
objectively requires a source-of-truth backend.

Three corrections to your plan, in descending order of importance:

1. **Role inversion (the big one).** Don't try to hide logic on the user's machine — it's
   impossible (industry consensus: compiled/obfuscated/WASM code "buys time, not secrecy",
   and AI-assisted reversing has only gotten faster). Instead, **move all valuable logic to
   the server and make the local client a dumb executor**. Then reverse-engineering the
   client yields nothing proprietary — there's nothing to steal.

2. **Your real risk is not logic protection but LLM economics + chargebacks.** The variable
   cost of a run (token spend) and 100% chargeback risk sit on you. This is cured by billing
   architecture (reserve-then-settle, margin on purchase, hard-stop at zero), and the plan
   gives it as much space as protection.

3. **Paddle is a merchant of record, not a wallet.** Paddle takes the money (and, as MoR,
   owns sales tax/VAT, invoicing and payment disputes), but it knows nothing about credits
   and cannot gate a run. The source of truth for the balance must be **your DB**; Paddle
   is only for taking money.

Everything else in your plan is right: activation key as identifier, balance in the
app, top-up from the app and from the landing page via Paddle, hard-stop at zero, "the
frontend can do nothing without the backend".

---

## 1. Trust model (foundation of everything)

> **The user's machine is UNTRUSTED and disposable. The server is the only trusted
> party.** We design so that a fully cracked client gives away nothing valuable —
> only the ability to hit the Apple URLs the server told it to.

Three consequences follow, to be accepted as given:

- Code cannot be hidden on the client. Compiling to a binary raises the cost of attack
  (useful — it "buys time") but provides no secrecy.
- An HMAC signature/secret in the client doesn't stop calling your backend directly (the
  secret is extractable). The goal isn't "impossible to bypass" but "pointless to bypass":
  a bypasser only gains the right to hit Apple URLs the server dictates anyway, and their
  key is metered, rate-limited, and revocable.
- Device fingerprints are spoofable — a heuristic for anomalies, not hard authentication.

---

## 2. Target architecture (end-state)

```
┌───────────────── USER'S MACHINE (untrusted) ──────────────────────┐
│  Tauri shell (native webview)                                     │
│   ├─ tutorial / activation / balance / "Run" button               │
│   └─ run UI  ── localhost ──►  LOCAL WORKER (Bun sidecar)         │
│                                     ├─ holds session-token        │
│                                     ├─ WSS ──────────────────────┼──►  SERVER
│                                     └─ ONLY: fetch Apple URL,     │      (brain)
│                                        local 429 backoff,         │
│                                        return raw response        │
└───────────────────────────────────────────────────────────────────┘
                                                                        │
┌─────────────────────────── SERVER (trusted) ──────────────────────────┘
│  Orchestrator: run state machine, suggest-graph expander,
│                P/D/Score metrics, title/subtitle/keywords assembly
│  LLM-proxy:    prompts are assembled HERE from templates (run_id, stage);
│                the client sends only structured data, not text
│  Billing:      wallet + ledger (source of truth), reserve/settle,
│                hard-stop at zero
│  Auth:         key activation → short-lived session-token
│  Postgres:     wallet, ledger, users, licenses, run event-log, job queue
│  Paddle:       top-up intake (MoR: tax/disputes), webhooks
└───────────────────────────────────────────────────────────────────────┘
        Apple (autocomplete + search) ◄─── requests go out from the USER'S IP
```

**Who holds what:**

| Component | Responsibility | What it does NOT contain |
|---|---|---|
| Tauri shell | native webview with UI, tutorial, activation, balance display, run button, auto-update | no business logic, no provider key, no session-token (that's in the worker) |
| Local worker (Bun sidecar) | serves the UI on localhost; holds WSS to the server; **executes only fetches to Apple at server-specified URLs** + local backoff; stores session-token in the OS secure store | metrics, prompts, expander, orchestration — nothing proprietary |
| Server | ALL logic: orchestrator, expander, metrics, LLM calls, credit gating, auth | — |

Why Apple requests are local: distributing outbound traffic across user IPs sidesteps
Apple's per-IP throttling (our key advantage, already verified). If crawling ran from
the server, the server would get banned. So the Apple I/O is delegated to the client while
the **strategy** of those requests stays on the server.

---

## 3. Flow of a single run (end-state)

```
1. UI (webview) → localhost worker: "start run, brief X"
2. Worker → server (WSS, session-token): run.create
3. Server: auth ok? → RESERVE credits (max-cost estimate) in one DB transaction
           balance < reserve → refusal ("top up your balance"), the run does not start
4. Server (orchestrator) drives the state machine. When an Apple request is needed:
      Server → worker (WSS): job {job_id, run_id, stage, apple_urls, deadline}
      Worker: fetch from the user's IP, 429 → local backoff, return raw
      Server: parses the raw response, computes P/D, accumulates the suggest harvest
5. When an LLM is needed (context/rate/hypothesize/phrase):
      The server itself assembles the prompt from the stage template + structured data,
      before the call — HARD-STOP: remainder > 0? otherwise stop with a clear status
      calls the LLM with its own key, meters input+output tokens
6. Progress streams to the UI via SSE (Last-Event-ID, replay-then-tail on disconnect)
7. Finish: SETTLE — debit the actual cost, return the reserve difference,
           write to the ledger (the ledger is authoritative — no provider metering)
```

Key point: **the frontend physically cannot do anything without the server** — every run
requires both Apple-fetch jobs (sent by the server) and LLM calls (only the server has the
key), plus credit approval. No connection / no balance → the worker sits idle.

---

## 4. Billing: usage-based credits (the most financially dangerous part)

**The source of truth is your DB, not Paddle.** Paddle (merchant of record) has no notion
of a spendable credit balance — you cannot gate a run with it.

### Object map
- **Paddle**: `Customer` (1:1 with the user, store `ctm_...`), one catalog `Price` (pri_…)
  per top-up package; a `Transaction` per purchase with
  `custom_data={userId, packageId}` — that custom_data comes back verbatim in the webhook
  and routes the grant.
- **Your tables**:
  - `wallet(user_id, balance_cents)`
  - `ledger(id, user_id, delta_cents, type[grant|reserve|settle|refund|chargeback], run_id, paddle_event_id UNIQUE, created_at)` — immutable journal
  - `processed_events(event_id UNIQUE)` — webhook idempotency

### Credit definition and margin
- **1 credit = a fixed monetary unit** (e.g. $0.01), so credits map cleanly onto COGS.
- **Margin is taken on the PURCHASE, not on the debit.** You sell $10 of purchasing power for
  $12–15 (or N credits below their cost). Then the per-run debit = raw
  COGS-in-credits, and the margin is locked in even if a run turns out unexpectedly expensive.
- COGS = LLM token cost (input+output+cached at current model rates) + server overhead
  per run. Add a **per-run floor** (minimum debit) so seemingly cheap runs with long
  context cover the fixed overhead.

### Reserve-then-settle (each step is one DB transaction)
1. **Reserve** at start: MAX-cost estimate = `max_tokens × output_rate × markup`.
   `UPDATE wallet SET balance=balance-:res WHERE user_id=:u AND balance>=:res` — an atomic
   conditional update (or `SELECT ... FOR UPDATE`) serializes one user's concurrent runs
   so both can't pass the check and drive the balance negative.
2. **Hard-stop before EVERY expensive LLM stage**, not just at start — actual
   spend is unknown up front.
3. **Settle** at the end: replace the reserve with the actual cost, return the difference.
   The idempotency key for each reserve/settle is `run_id`, so retries/duplicate webhooks are no-ops.

### Top-up webhook
`transaction.completed` → verify `Paddle-Signature` (HMAC-SHA256 over `ts:rawBody` with the
endpoint secret, ±5 min tolerance) → `INSERT processed_events(event_id)` (already there → 200
and exit) → credit a `grant` row to the ledger atomically, idempotency key = the TRANSACTION
id (Paddle may re-deliver the same event under fresh notification ids) → 200 within seconds,
heavy work in the background. Test with the sandbox + the dashboard's webhook simulator; keep
live/sandbox endpoint secrets strictly separate.

### Financial holes (must be closed)
- **Chargeback after spend still hurts.** User topped up → spent (you already paid the
  LLM provider) → disputed the payment. As MoR, Paddle runs the dispute process and its own
  fraud screening, but the disputed amount (plus their dispute fee) is clawed back from your
  payout; nobody rolls back the credits/COGS. Mitigation: a cap on top-up size for new
  users, delayed spendability of large first top-ups. Residual risk is yours.
- **Negative balance from a reserve race.** Only atomic `WHERE balance>=reserve`
  or `FOR UPDATE`.
- **Underestimating input tokens** (especially with large context) understates the debit
  severalfold — meter input AND output.
- **Model price drift** silently makes runs unprofitable — peg the debit to current
  rates, don't hardcode.
- No provider-side token metering exists on Paddle — the ledger plus the per-run COGS
  ceiling (estimate fuse) is the only fuse, and that is already the design.

---

## 5. Identity and licensing

- **The key = identity and entitlement anchor**, but **not a bearer for every request.** On
  activation, exchange the key (over TLS) for a **short-lived session-token bound to the
  device fingerprint**. Send it per-request, refresh periodically. This gives revocation,
  expiry, and device-binding without passwords.
- **HMAC signature on every request** (per-session secret) + timestamp (±5 min) + nonce
  (server caches it, kills naive replay). Doesn't stop a reverser, but makes
  replaying an intercepted request and key sharing pointless.
- **Rate-limit per USER** (not per IP — the outbound IP is the user's anyway), by
  tokens/cost/concurrency + a hard cap on simultaneous active runs per user.
  Credits are prepaid → key sharing simply drains the sharer's balance (a natural
  economic disincentive).
- **Passwords/OAuth are unnecessary** for a prepaid tool — they add credential stuffing and
  support load without protecting the balance better than a revocable device-bound key.
  Email binding — only for access recovery and receipts (and you do need it: the key is
  emailed on download).
- **Buy licensing, don't build it.** Rolling your own = reinventing fingerprint activation,
  node-lock, heartbeat/lease, revocation, secure storage. Options: **Keygen** (open-source,
  self-host next to your backend, max control) or a **Merchant-of-Record** (Paddle /
  Lemon Squeezy — they take on worldwide tax + a thin license API). Your own code — only for
  the session-token/HMAC layer, not for reinventing activation.

---

## 6. Desktop packaging and distribution

- **Tauri 2.x, not Electron.** The shell is thin, all logic lives in the Bun worker → Tauri
  (5–10 MB, low RAM, deny-by-default security) is a clean win; webview rendering differences
  don't matter for a tutorial UI.
- **Backend worker as a sidecar:** `bun build --compile --target=<triple>` → one binary per
  target (macOS arm64+x64, Windows x64, Linux x64), registered in `bundle.externalBin`
  (the name must carry the target-triple suffix). Spawning requires `shell:allow-execute` in
  `capabilities/*.json`.
- **Lifecycle (the main footgun):** dynamic free port (no hardcode), health-check
  `/health` before opening the UI, kill any stale process on the port and the child-process
  tree on exit, signal behavior differs on Windows.
- **Signing (without it — OS warnings):**
  - macOS: Apple Developer ($99/yr), Developer ID cert, **notarization** via notarytool +
    stapling. Without it, Gatekeeper blocks. Turnaround — minutes.
  - Windows: since 2023 the private key must live on an HSM token; **EV since 2024 NO longer
    grants instant SmartScreen bypass** — reputation accrues like OV. Best 2026 option —
    **Azure Trusted Signing** (no token, CI integration, cheap), but for individuals it's
    US/Canada only so far. Otherwise an OV cert ~$100–700/yr.
  - Linux: no unified signing; an AppImage can be GPG-signed, but it doesn't verify the
    signature itself. An unsigned AppImage/.deb produces no scare screen like macOS/Windows →
    low priority.
- **Auto-update:** Tauri updater plugin (`tauri signer generate`, public key in the
  config, private key in CI secrets). **Important:** the updater signature is SEPARATE from
  OS signing — every new binary still needs notarization/Authenticode signing. Losing the
  private updater key = existing installs can never be updated again.
- **CI:** `tauri-action` + GitHub Actions matrix (macOS runner for notarization, Windows runner
  for Authenticode). Annual signing cost: ~$100 (Apple) + $0–700 (Windows) + $0 (Linux).

### The "Run" button as you envision it
It stays: the shell shows tutorial/balance/activation, the button spawns the sidecar worker,
which brings up the local UI (like aso-util today) and opens it in the webview. The difference
from today — the UI now talks not to local logic but through the worker to the server, and
everything is metered.

---

## 7. Backend stack (no overengineering)

- **One long-lived process** (Node/Bun/Go/Python) on Railway/Fly.io/Render or a VPS +
  Docker Compose. WebSocket/SSE require a long-lived process — serverless doesn't fit.
- **Postgres = DB + job queue** (`pg-boss`/`graphile-worker`, `FOR UPDATE SKIP LOCKED`) —
  up to tens of thousands of jobs/sec without a separate broker. Add Redis ONLY when you need
  a resumable-stream buffer or pub/sub for a second instance.
- **One instance at the start** → no sticky WS routing needed. Once a second server appears,
  WSS pins to an instance → you'll need a bus (Redis pub/sub/NATS) or sticky routing.
- **Transport:** server→worker commands over WSS (full-duplex); progress to the UI via SSE
  with a unique event-id, Last-Event-ID, replay-then-tail; a monotonic seq on the client for
  deduplication.
- **Job idempotency is mandatory:** `job = {job_id, run_id, stage, apple_urls, deadline}`;
  on reconnect the worker reports completed job_ids; results are deduplicated. Timeouts are
  adaptive and generous (Apple throttling), retries idempotent.
- **The LLM-proxy is NOT an open /chat:** the server assembles prompts from server-side
  templates bound to `(run_id, stage)`; from the client — only structured data, never prompt
  text (otherwise the user runs anything on your key = compute theft, price bypass). Governance
  layer — **LiteLLM Proxy / Helicone**: virtual keys, per-user budgets, spend tracking, audit log.
- **LLM cost control:** route the model by stage cost (Haiku for the cheap parts, the expensive
  model selectively), prompt caching for stable system parts, response caching for deterministic
  inputs (but NOT for stages depending on fresh Apple data — it would serve a stale result).
- **The run state machine is an event-sourced step log in Postgres** (idempotent steps,
  replay up to the last state): resumability without Temporal. Temporal/Inngest — not at
  the start, but keep a path to them if you grow.

---

## 8. What is reused from aso-util

The "code computes, LLM judges" split that already exists maps perfectly onto the inversion:

| aso-util module | Where it goes in the commercial version |
|---|---|
| `metrics/*`, `assembly/*`, `pipeline/orchestrator.ts`, `pipeline/expander.ts`, `llm/prompts/*`, `llm/schemas.ts` | **to the server** (this IS the proprietary logic) |
| `http.ts` (token bucket, cache, retries) + `apple/hints.ts` + `apple/search.ts` | **to the local worker** (this IS the "dumb fetch to Apple"), but WITHOUT deciding *what* to fetch — the server dictates the URLs |
| `llm/claude.ts` | **to the server**, behind the LLM-proxy; the client key/subscription is removed entirely |
| `server/public/*` (UI) | stays the UI, but pulls data via worker↔server |
| `store/*` (local runs on disk) | runs move into the server's Postgres; locally — only the Apple cache |

The formulas and greedy selection are already pure functions with no I/O — they port to the
server one-to-one.

---

## 9. Phased assembly (for a solo dev)

The full end-state is a big refactor. Don't build it all at once. Order:

- **Phase 0 — demand validation (now).** Keep the current local free-beta aso-util alive
  for the landing page/waitlist. While people sign up — you build the commercial side. Don't
  build commerce until there's a demand signal.
- **Phase 1 — thin vertical slice (MVP-money).** Goal: prove that money is gated.
  - Server: auth (key→session-token), wallet+ledger, **LLM-proxy** (move the run's LLM calls
    there), reserve/settle, hard-stop, one Paddle checkout top-up + webhook.
  - Client: no Tauri yet — the same local program, but the LLM goes through your server by
    key; Apple fetch and orchestration temporarily stay local.
  - **Deliberate MVP compromise:** metrics/expander are still local at this stage (exposed),
    but **the money is already under control** — every run is impossible without the server's
    LLM + credit approval. This gates COGS (the main risk) and lets you sell. The proprietary
    logic hides in a compiled Bun binary (literally "buying time").
  - One VPS, Postgres, Paddle sandbox→live. Licensing — Keygen or a simple home-rolled key scheme.
- **Phase 2 — desktop wrapper.** Tauri shell + sidecar, signing/notarization for 3 OSes,
  updater, download buttons on the landing page, key email on download, balance and top-up
  screens inside the app.
- **Phase 3 — hardening via the inversion.** Move orchestration + metrics + expander to the
  server, shrink the local worker to pure Apple fetch (the full model of section 2). Do it
  when revenue/traffic justifies the protection (earlier is premature).
- **Phase 4 — scale.** Second instance + a bus for WS, durable stream (Ably/Redis), possibly
  Temporal, an ASA provider (official popularity), position monitoring as a subscription
  upsell.

---

## 10. Open decisions (yours to make)

1. **Licensing:** self-host Keygen (control, +infra) vs Merchant-of-Record Paddle/
   Lemon Squeezy (they handle worldwide tax, but weaker offline). If you sell globally —
   the MoR tax handling outweighs.
2. **Credit model:** "1 credit = $0.01" (transparent, maps onto COGS) vs abstract
   credits (more marketing flexibility, but easier to botch the margin). Recommendation —
   monetary.
3. **Windows signing:** check whether Azure Trusted Signing is available to you (US/Canada
   for individuals) — if yes, it's cheap; otherwise an OV cert + HSM token.
4. **How early to do the inversion (Phase 3):** depends on who your threat is. For the
   first paying indie devs, reversing is unlikely → MVP-light is fine. Traffic grows/clones
   appear → pull the inversion forward.
5. **Free tier:** whether to grant N free credits to a new key (lowers onboarding friction,
   but opens abuse via key generation — then bind the free tier to a
   verified email/card).

---

## 11. Risk summary (descending)

1. **LLM economics + chargebacks** — you can go into the red. Cured by margin-on-purchase,
   reserve/settle with an atomic gate, per-run floor, MoR fraud screening, a top-up cap for new users.
2. **Dependence on an undocumented Apple endpoint** — can die any day.
   Insurance: an ASA provider (official popularity) as a second leg (Phase 4).
3. **Logic protection** — fundamentally incomplete; softened by the inversion (Phase 3), but
   never absolute. Don't spend disproportionate effort on it at the start.
4. **Overengineering** — Temporal/K8s/microservices will eat a solo dev's time. A Postgres
   queue + one container covers everything up to tens of thousands of jobs/sec.
5. **Latency under throttling** — the server→client→Apple→client→server chain under 429
   yields jobs taking tens of seconds. Adaptive timeouts, idempotent retries, and a UX that
   honestly shows progress.
