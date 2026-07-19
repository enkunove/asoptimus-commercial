# Landing: what to add for the commercial version (spec, do NOT touch the site now)

The current `asoptimus-landing/` is a marketing page with a waitlist. For commerce it needs the
additions listed below. The design system stays as is (paper `#FAFAF7`, blueprint blue,
Source Serif 4 + IBM Plex Mono) — everything new must fit into it. Implement as a separate iteration.

## Priority 1 — the "got a key → downloaded → bought credits" funnel

### 1. Signup instead of waitlist (email → activation key)
- Email field + "Get your key" button. Submit → `POST {API}/signup {email}`.
- Backend (`server` repo): create `User` + Stripe `Customer` + `wallet` (opt. N free credits),
  generate an `asop_live_…` key, send it by email. Response — "check your inbox".
- Anti-abuse (BUILD-PLAN §9): free credits only on verified email; optionally — later.
- Submitting the same email twice — idempotent (do not multiply Customers).

### 2. Download section (OS detection + all platforms)
- Big button for the visitor's OS + a list of all: `.dmg` (macOS arm64/x64), `.exe/.msi`
  (Windows x64), `.AppImage/.deb` (Linux x64).
- Links — to release artifacts (GitHub Releases of the `client` repo, or a CDN). Version + checksums.
- Microcopy on "why download a program rather than just use a website": the program makes Apple
  requests from your own IP (no bans, private) — honesty that sells (D1).

### 3. Pricing / credits section
- Explain the model: **1 credit = $0.01** (if you pick the monetary model) or packages.
- Top-up packages (e.g. $10/$25/$50 with a volume bonus — margin is baked into the purchase price, D4).
- A "what one run costs" reference point (an honest range based on COGS).
- CTA "Buy credits" → `POST {API}/checkout {packageId, email|customer}` → redirect to Stripe
  Checkout (Stripe's domain). Return — to `/checkout/success` and `/checkout/cancel`.

### 4. Post-checkout and activation
- `/checkout/success` — "credits granted" (the actual grant happens via the server webhook, not via
  this page; the page merely confirms and suggests opening the program).
- `/activate` (or an onboarding block) — how to paste the key into the program, how to complete the first run.

## Priority 2 — web account (thin, magic-link)

So one can buy/check the balance without launching the program:
- `/account` — magic-link sign-in (email → link), no passwords (BUILD-PLAN §5: there are no passwords).
- Shows: credit balance, debit history (`ledger`, type+delta+date), a top-up button,
  resend-key. Data — `GET {API}/account` with a short-lived token from the link.
- Optional for the MVP: the minimum is signup + download + buy. The full balance/journal lives in
  the program itself (web-ui). The web account is convenient for buying "without installing".

## Priority 3 — legal (mandatory before taking money)
- **Terms of Service**, **Privacy Policy**: what goes to the server (the brief text; Apple credentials
  do NOT go — there are none), that Apple requests come from the user's IP, what we store (email,
  runs, ledger). **Refund Policy** — important for the chargeback position (D4/§9): terms for refunding
  unused credits, no refund for spent ones.
- Links in the footer.

## Server endpoints the site calls (`server/src/api` repo, public)
| Method | Path | Purpose |
|---|---|---|
| POST | `/signup` | email → create User+Customer+wallet, send the key |
| POST | `/checkout` | create a Stripe Checkout Session for a package → `{checkoutUrl}` |
| POST | `/webhooks/stripe` | `checkout.session.completed` → grant in the ledger (idempotent) |
| GET | `/account` | (magic-link token) balance + ledger |
| POST | `/account/resend-key` | resend the key to the email |
| GET | `/download/manifest` | versions/links/checksums of artifacts per OS |

Signup/checkout/webhook — Priority 1 (no selling without them). Account/magic-link —
Priority 2. Legal — before the first real payment.
