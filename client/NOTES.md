# asoptimus-client — build notes

Thin local client (BUILD-PLAN D1/D5/§3) + desktop wrapper (D6/Phase 2). Spins up the
localhost UI, does Apple fetches per cloud jobs, relays commands/progress/reads. **There is no proprietary
logic here** — no P/D/Score formulas, no assembly/expander, no prompts, no placement weights/
extraLocale/locales. The prod path goes to the real cloud over WSS+HTTPS; the offline stub is only behind `DEV=1`.

## How to run (CLI binary)

```bash
bun install
bun run dev                       # = bun run src/main.ts → http://127.0.0.1:4317, opens the browser
bun run src/main.ts --port 4319 --no-open --data-dir /tmp/aso
bun run build                     # dist/ — 4 bun --compile targets
bun run src/build.ts --sidecar    # sidecar binaries for Tauri (target-triple-suffixed)
```

Environment variables:

| env | purpose | default |
|---|---|---|
| `ASO_CLOUD_WSS` | cloud WSS endpoint (jobs/progress/reads) | `wss://api.asoptimus.com/ws` |
| `ASO_CLOUD_HTTPS` | HTTPS endpoint (activation `/activate`, top-up `/topup`) | `https://api.asoptimus.com` |
| `ASO_DATA_DIR` | data directory (Apple cache, dev-fallback session) | `~/.asoptimus` |
| `ASO_LAUNCH_TOKEN` | per-launch guard token (D8); set by the host wrapper | generated |
| `ASO_SIDECAR=1` | sidecar mode: print `ASOPTIMUS_STATUS` lines to stdout (for the tray) | off |
| `DEV=1` | **offline mode:** cloud dev stub + synthetic activation (NOT prod) | off |
| `ASO_DEV_CREDITS` | DEV-only: the stub's starting balance (for testing the hard-stop) | 500 |

Activation: enter the `asop_live_…` key in the UI. Prod — exchange for a session-token over HTTPS
(`ActivateRequest`→`ActivateResponse`, an `hmac_secret` arrives for signing). `DEV=1` — a synthetic
token without the cloud.

## What was done this iteration (prod-ready)

- **Reconciliation against @aso/shared (reconcile v2 / billing v4):**
  - The browser's read path is on the official contract `query{query_id,kind,params}` →
    `query.result{query_id,data}` / `query.error`. The ad-hoc `q.*`/`cid` from the old `wire-local.ts` is **removed**.
  - `run.create{client_ref}` → wait for the ack `run.created{client_ref, run_id}` (run_id learned from the response).
  - `deleteRun` → `run.control` with `action{type:"delete"}`.
  - Every client→server message is wrapped in a `SignedEnvelope` (HMAC-SHA256 over `hmac_secret`).
  - `SerpJob.country` is taken directly (the storefront→country reverse map is **removed** from `storefront.ts`/`apple-exec`).
  - `ProbeJob.childPrefill` — on a cache hit we do NOT fetch `"<kw> "` (0 network).
  - HTTPS activation `POST /activate` (`ActivateRequest`/`ActivateResponse`); HTTPS top-up `POST /topup`.
- **Prod WSS leg:** default `wss://api.asoptimus.com/ws`; reconnect+resume_job_ids (D7); signing, timeouts.
  The dev stub is **only behind `DEV=1`** (`makeCloudLink`), unreachable from the prod path.
- **Keychain:** session (incl. `hmac_secret`) in the macOS Keychain (`security`); a chmod-600 file is only the fallback.
- **Quote UI (D4 v4, usage-based):** run form — sampleSize slider + model selector (**default Haiku**);
  a live **estimate** `≈ ceil(sampleSize × pricePerKeyphrase)`; a note "up to +10% keyphrases **are debited too**,
  the total is up to +10% above the estimate"; the model list + prices come from the server (`query kind="models"`, `/api/models`),
  **not hardcoded**. The balance drains **in real time** (the server sends `balance` after every debit → SSE →
  a widget with a tick highlight). Credits run out mid-run → a banner "top up, we'll continue from here"
  + top-up + resume. The form does **not gate** start on balance (pay-as-you-go, no reserve). A `#/balance` screen with
  the ledger. No free tier. The LLM log is only `LlmLogPublic` (no prompts, D9).
- **Desktop (Tauri 2.x, macOS):** `client/desktop/` — see below.
- **DoD:** verified offline (`DEV=1`): activation → models/balance → run → live drain → hard-stop →
  top-up → resume; guard D8 (bad Host 403 / no-token 401); D9 (no `prompt`/`system` in `/llm-log`).

## Desktop app (client/desktop/, Tauri 2.x — macOS only)

A native window over the localhost UI (not a browser tab): on startup a free port is picked,
the **compiled Bun binary is launched as a sidecar** (`bundle.externalBin`, name with the target triple from
`build.ts --sidecar`), Rust waits for the stdout marker `ASOPTIMUS_LISTENING <port>` and loads `http://127.0.0.1:<port>`
into the webview; tray (Connected/Disconnected + balance from `ASOPTIMUS_STATUS`, items "Open"/"Top up"/"Quit");
on exit the sidecar is killed. Icons — `scripts/make-icons.sh` (source `gen-icon.mjs`).

```bash
cd client/desktop
bun install
bash scripts/build-dmg.sh both     # arm64 + x64 .dmg (drag-to-Applications)
```

**The only thing the user plugs in at the end (like keys) — Apple Developer ID + signing secrets:**
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (mapped to
`APPLE_PASSWORD`). Without them the `.dmg` builds **unsigned** (dev). Also an installed **Rust
(cargo/rustup)** is required — this build environment doesn't have it, so the `cargo` build itself wasn't executed (the sidecar,
config, scripts, icons are ready and verified). Signing/notarization run inside `tauri build`
automatically when the env secrets are present.

## Contract gaps NOT yet covered by @aso/shared (for the tech lead; we do NOT edit shared from here)

Everything from the old reconcile-v2 list is **closed** (query/query.result, run.created, delete-action,
SignedEnvelope, ActivateRequest/Response+hmac_secret, SerpJob.country, ProbeJob.childPrefill,
ModelInfo.pricePerKeyphrase, RunQuote). Remaining to pin down:

1. **HMAC canonicalization.** We compute `SignedEnvelope.mac` as `HMAC_SHA256(hmac_secret, "${ts}.${nonce}.${JSON.stringify(body)}")`
   (hex). The server (`auth.verifyMessage`) must verify against an **identical** string (the same JSON serializer
   with the same field order) + a ts window of ±5m + nonce replay protection. Pin the format in the contract/docs.
2. **Shape of `query.result.data` per kind** (`data:unknown` in the contract). The client expects (sub-contract, `wire-local.ts`):
   `runs`→`RunSummary[]` · `run`→**`RunSnapshot`** (a superset of `RunState`: + `config`, `events`,
   `keywordCount`, `sampleCount` — the run screen can't recover them from push-only SSE on first load) ·
   `keywords`→`KeywordPage{total,page,pageSize,items}` (pagination/sort/filter — server-side; the UI needs `total`) ·
   `keyword`→`{item:KeywordEntry|null}` · `llm-log`→`LlmLogPage{total,page,items}` · `balance`→`BalanceView` ·
   `models`→`ModelInfo[]`. Ideally lift these projections into the contract as per-kind `data` types.
3. **HTTPS top-up.** Client: `POST {ASO_CLOUD_HTTPS}/topup`, `Authorization: Bearer <session_token>`,
   body `{packageId}` → `TopupResponse{checkoutUrl}`. Pin down the HTTPS leg's auth method and
   the **package catalog** (id/price/credits) — the UI currently has 3 placeholder packages (small/medium/large), the truth is
   the server config; a way to serve the catalog to the client is desirable (e.g. a separate query kind or a field in balance).
4. **Live-balance push.** The UI relies on the server sending `balance{credits}` **after every keyphrase
   debit** (D4 v4 real-time drain) — the widget drains tick by tick. Make sure the orchestrator emits this.
5. **The "credits ran out" pause reason.** The UI detects a credits hard-stop from the `run.paused.reason` text
   (a regex over credit/balance/top-up stems, Russian and English variants — `credit|balans|popoln|top.?up` etc. in the source).
   More robust — a structural flag/reason code in `run.paused`.
