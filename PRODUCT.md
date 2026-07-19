# ASOptimus — full product picture (Path B, local-UI variant)

Chosen model: **the downloaded program spins up a local site (localhost) and makes the
Apple requests; ALL other logic lives on the cloud server.** Essentially it's the current aso-util
with the business logic moved to the cloud, leaving exactly two things local — serving the UI
and fetching Apple. Complements `ARCHITECTURE.md` (technical decisions there; the holistic
picture and user journey here).

> **The current source of truth for the build is `BUILD-PLAN.md`** (topology, submodules,
> protocol, billing, phases). On any conflict, it wins.

---

## 1. Product shape in one paragraph

The user downloads a **program** (.dmg/.exe/.AppImage) from the landing page — that's the
"full-fledged .app/.exe". The program spins up a **local site on localhost** and opens it
in the browser (like aso-util today). Everything is in this UI: runs, results, balance, payment. But
now the UI calls not local logic but the **cloud server**, where the whole brain lives
(orchestrator, metrics, expander, prompts, LLM, credits). The local program does exactly
two things: serves the UI and **hits Apple from the user's IP** on the server's command.

Key idea: **"everything except Apple requests is on the backend"** is achieved literally. The local
program contains no formulas, no expander, no prompts, no LLM key, no credit
gating — only the Apple fetch and bare UI rendering. Crack it open — there's nothing to steal.

---

## 2. Three parts and where things live

```
┌─────────────────────── USER's machine ─────────────────────────────┐
│  Browser → localhost:PORT — local UI (runs, balance, payment)       │
│        │  (calls the cloud server, NOT local logic)                 │
│        ▼                                                            │
│  LOCAL PROGRAM (downloaded, Bun process):                           │
│   ├─ serves the UI on localhost                                    │
│   ├─ holds session-token (OS secure store) + WSS to the cloud      │
│   ├─ fetches Apple from the user's IP (native, no CORS) ← the ONLY │
│   │    local "logic": 429 backoff, returning the raw response       │
│   └─ relay: run commands → cloud, progress → browser               │
└──────────────────────────────┼─────────────────────────────────────┘
                               │ WSS/HTTPS
┌──────────────────────── SERVER (brain) ─┴───────────────────────────┐
│  Orchestrator (state machine, expander, metrics, assembly)          │
│  LLM proxy (prompts are assembled here; client sends only data)      │
│  Billing (wallet+ledger — source of truth, reserve/settle, hard-stop)│
│  Auth (key → session-token, device-bound)                           │
│  Postgres (users, wallet, ledger, licenses, run-log, job-queue)      │
│  Paddle (top-up, webhooks, MoR)                                           │
└──────────────────────────────────────────────────────────────────────┘
      Apple (autocomplete + search) ◄── requests from the USER's IP (via the program)
```

| Part | What it is | Technically |
|---|---|---|
| **Local UI** | the localhost site the user sees | same UI as aso-util (`server/public/*`), but it pulls data from the cloud API, not from local logic |
| **Local program** | the "program" from the download | Bun process: serves the UI on localhost + holds a WSS to the server + **fetches Apple from the user's IP** + secure-stores the key. NO business logic |
| **Server** | brain + cash register | long-lived process (Railway/Fly/VPS) + Postgres + Paddle. Section 7 in ARCHITECTURE.md |

Why the program does the Apple fetch, not the browser: browser JS can't hit the Apple hints
(CORS + the ban on `User-Agent`/preflight for `X-Apple-Store-Front`) — decision #0. A native
local process is untouched by CORS. Why locally rather than server-side: so requests go from the
user's IP and Apple doesn't ban you (your moat).

**CORS never comes up at all** (clarification from BUILD-PLAN D1): the browser, just like in the current
aso-util, hits ONLY `127.0.0.1` (same-origin). Cross-origin to the cloud goes the program's native
process, and CORS doesn't apply to a native fetch. The browser never talks to the cloud at all.

**UI updates without reinstalling:** on startup the local program pulls fresh
UI assets from your server and caches them — so the UI can be fixed server-side instantly, while the program
stays thin (updated via auto-updater only when its own code changes).

---

## 3. User journey (end-to-end)

**A. Discovery (landing page `asoptimus.com`).**
Sees the banner/offer → "Get started free" → enters email.

**B. Registration and key.**
An **activation key** (`asop_live_…`) arrives by email — it doubles as the user identifier
and the balance anchor. A Paddle customer and wallet are created right away (with N free credits for
the first run, if you decide to offer a free tier).

**C. Downloading the program.**
On the same page — download buttons per OS: `.dmg` (macOS), `.exe/.msi` (Windows),
`.AppImage/.deb` (Linux). This is that "full-fledged .app/.exe" you had in mind.

**D. First launch of the program.**
Installs, launches. The program asks for the key (or catches it via deep-link from the email),
exchanges the key for a short-lived session-token (device-bound), spins up the local site and
opens it in the browser. Launch-at-login is optional.

**E. Working in the local UI.**
Browser at `localhost:PORT`, logged in with the same key. Runs dashboard and balance. Creates a
run: brief + country + model. Hits "Run". (Everything as in aso-util today — but data from the cloud.)

**F. The run.**
The server starts the run: reserves credits, drives the orchestrator. When an Apple request is needed —
it sends a job to the local program, which fetches from the user's IP. When an LLM is needed — the server calls it
with its own key (before each expensive stage — a hard-stop on the balance). Progress streams into the
localhost UI live (feed, keyword P/D/Score fill) — as in the current aso-util.

**G. Results.**
Finished title/subtitle/keyword field (two buckets), keyword table, coverage, export
.md/.json. The run's actual cost is debited (settle), the balance decreases.

**H. Top-up.**
Balance at zero → the run won't start, an honest "top up" notice. A "Top up" button (on the web AND in
the agent's tray) → Paddle checkout → pick a credit package → payment → the webhook credits the balance.

---

## 4. What the user sees (screens)

- **Landing page** — already done (`asoptimus-landing/`). To add: download buttons + email capture
  (currently waitlist → becomes signup).
- **Local UI** (localhost, reuses the aso-util UI almost as-is):
  - Runs dashboard (cards, as today) + balance widget in the header.
  - New-run form.
  - Run screen: phase stepper, live feed, keywords, assembly, LLM log (all already there).
  - Balance/payment screen + debit history (the ledger, exposed).
  - Difference from aso-util: data comes from the cloud API; key-based auth; balance/payment.
- **Local program** (background, minimal visibility):
  - Optional tray icon: Connected / Disconnected, balance, "Open", "Top up", "Quit".
  - Everything else is invisible: WSS to the server, Apple fetch, serving the UI on localhost.

---

## 5. Anatomy of a run (data flow)

```
web UI ──run──► server: auth? → RESERVE credits (otherwise refuse)
server (orchestrator):
   Apple request needed → WSS → agent → fetch(user IP) → raw → server: P/D, harvest
   LLM needed           → server assembles the prompt(stage) itself → HARD-STOP if balance=0
                          → calls the LLM with its own key → meters tokens
   progress             → SSE → web UI (Last-Event-ID, replay on disconnect)
finish → SETTLE the actual cost → ledger → the ledger stays authoritative (no provider metering)
```

Bottom line: both the web UI and the agent are useless on their own — a run is impossible without the server
(it sends the Apple jobs, only it has the LLM, it approves the credits). This is your "the front
can do nothing without the back", achieved by architecture, not by client-side checks.

---

## 6. Money touchpoints

| Event | Where | What happens |
|---|---|---|
| Registration | site | Customer + wallet created (+ optional free tier) |
| Top-up | site OR agent tray | Paddle checkout → webhook → `grant` in the ledger |
| Run start | server | `reserve` of the estimated cost, refusal if the balance is too low |
| Expensive stage | server | hard-stop at zero |
| Run finish | server | `settle` of the actual cost, refund of the difference |
| Chargeback/refund | Paddle→webhook | `chargeback`/`refund` in the ledger (the risk is on you — section 4 of ARCHITECTURE) |

---

## 7. Buy vs build

| Piece | Decision |
|---|---|
| Landing page | ✅ done |
| Run web UI | reuse from aso-util (move to the web + API calls instead of the local server) |
| Orchestrator/metrics/expander/prompts | move to the server from aso-util (ready-made pure functions) |
| Agent (Apple fetch) | take `http.ts`+`apple/*` from aso-util, trim down to a headless binary |
| Auth/licenses | **buy** (Keygen self-host) or a simple home-grown key scheme at the start |
| Billing | Paddle checkout + your own ledger in Postgres (Paddle is not the source of truth) |
| Server hosting | one Railway/Fly/VPS container + Postgres |
| Agent signing | Apple $99 + Windows (Azure Trusted Signing/OV) + Linux $0 |

---

## 8. Honest friction points (and what to do)

- **Installing the agent is the main conversion barrier.** Users are used to "just a website". Mitigation:
  make the agent maximally invisible (install once, forget, auto-launch), and in onboarding
  honestly explain the "why": the agent = your IP hits Apple instead of our server → data
  doesn't get banned and doesn't leak to us. This is also part of the sales story (local/privacy).
- **The agent isn't running and the user hits Run.** The web UI shows "Agent offline — launch it",
  the server won't start a run without the agent connected.
- **Signing for 3 OSes** is a one-off chore, but without it OS scare-screens will kill installs.
  Automate via `tauri-action`/CI (or, if the agent is headless without Tauri, — your own
  build+sign matrix).
- **Latency** — a run takes minutes (Apple throttling), that's normal; the UI honestly streams
  progress, the user isn't staring at a spinner.
- **Alternative to the agent — a browser extension**: easier to install (not a .app/.exe), but store
  reviews + Manifest V3 restrictions on spoofing `User-Agent`. If install friction is critical —
  test the extension; if control/reliability matters more — a headless agent.

---

## 9. How this maps onto the current code (aso-util)

Nothing is thrown away — everything gets sorted into the three parts:

- **To the server:** `metrics/*`, `assembly/*`, `pipeline/*`, `llm/*` (except the client key).
- **To the agent:** `http.ts`, `apple/hints.ts`, `apple/search.ts` — but *what* to fetch is decided by the server.
- **To the web UI:** `server/public/*` — pulls data via the API instead of the local server.
- **Thrown out:** local Claude auth (the client side of `llm/claude.ts`),
  the subscription/BYO-key path — the LLM now goes only through the server proxy.

The current aso-util meanwhile stays alive as a **free local beta** to validate demand
while the commercial version is being built (Phase 0 in ARCHITECTURE.md).
