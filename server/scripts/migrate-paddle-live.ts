// One-shot sandbox → live Paddle catalog migration. ADDITIVE ONLY: this script never
// updates, archives, or deletes anything in either environment — it audits live first,
// creates only what is missing, and prints the sandbox → live id mapping plus a
// ready-to-paste live env block.
//
//   PADDLE_LIVE_API_KEY=pdl_live_… bun run scripts/migrate-paddle-live.ts [--dry-run]
//
// Env:
//   PADDLE_LIVE_API_KEY     [required] live API key (Paddle → Developer tools → API keys).
//                           Needs read+write on products, prices, discounts, notification settings.
//   PADDLE_SANDBOX_API_KEY  [optional] sandbox source key; falls back to PADDLE_API_KEY when
//                           that one is pdl_sdbx_…. Needs at least prices read.
//   PADDLE_WEBHOOK_URL      [optional] live webhook destination
//                           (default https://api.asoptimus.com/webhooks/paddle)
//   PADDLE_PRODUCT_NAME     [optional] product name if the sandbox key can't read products
//                           (default "ASOptimus credits")
//   PADDLE_PRODUCT_TAX      [optional] tax category fallback (default "standard")
//
// Idempotent: re-running skips everything that already exists (match: product by name,
// price by name + amount + currency + billing cycle, discount by code/description,
// notification destination by URL). An existing destination is NEVER touched — recreating
// one would rotate its endpoint_secret_key and break verification of future deliveries.

const DRY = process.argv.includes("--dry-run");

const SANDBOX_API = "https://sandbox-api.paddle.com";
const LIVE_API = "https://api.paddle.com";

const liveKey = (process.env.PADDLE_LIVE_API_KEY ?? "").trim();
const sbxKey = (process.env.PADDLE_SANDBOX_API_KEY ?? "").trim() ||
  ((process.env.PADDLE_API_KEY ?? "").trim().startsWith("pdl_sdbx_") ? (process.env.PADDLE_API_KEY ?? "").trim() : "");

if (!liveKey) fail("PADDLE_LIVE_API_KEY is not set. Create a live API key in Paddle → Developer tools → Authentication → API keys.");
if (liveKey.startsWith("pdl_sdbx_")) fail("PADDLE_LIVE_API_KEY is a SANDBOX key (pdl_sdbx_…) — pass the live key.");
if (!sbxKey) fail("No sandbox source key: set PADDLE_SANDBOX_API_KEY (or PADDLE_API_KEY with a pdl_sdbx_… value).");

const WEBHOOK_URL = (process.env.PADDLE_WEBHOOK_URL ?? "https://api.asoptimus.com/webhooks/paddle").trim();
const FALLBACK_PRODUCT_NAME = (process.env.PADDLE_PRODUCT_NAME ?? "ASOptimus credits").trim();
const FALLBACK_PRODUCT_TAX = (process.env.PADDLE_PRODUCT_TAX ?? "standard").trim();

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function api(base: string, key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.detail ?? data?.error?.code ?? res.statusText;
    const err: any = new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function list(base: string, key: string, path: string): Promise<any[]> {
  const out: any[] = [];
  let after = "";
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api(base, key, "GET", `${path}${sep}per_page=200${after ? `&after=${after}` : ""}`);
    out.push(...(page.data ?? []));
    if (!page?.meta?.pagination?.has_more || !page.data?.length) return out;
    after = page.data[page.data.length - 1].id;
  }
}

/** Price identity for matching sandbox ↔ live (ids differ across environments by design). */
function priceKey(p: any): string {
  const cyc = p.billing_cycle ? `${p.billing_cycle.frequency}/${p.billing_cycle.interval}` : "one-time";
  return `${p.name ?? p.description}|${p.unit_price?.amount}|${p.unit_price?.currency_code}|${cyc}`;
}

const created: string[] = [];
const skipped: string[] = [];
const priceMap: Record<string, string> = {}; // sandbox pri_ → live pri_

// ── 1. Source: sandbox catalog ──────────────────────────────────────────────
const sbxPrices = (await list(SANDBOX_API, sbxKey, "/prices?status=active")).filter((p) => !/test|junk|delete/i.test(p.name ?? ""));
if (!sbxPrices.length) fail("Sandbox has no active prices — nothing to migrate.");
console.log(`Sandbox: ${sbxPrices.length} active price(s) across ${new Set(sbxPrices.map((p) => p.product_id)).size} product(s).`);

// Product details (the scoped sandbox key may 403 on products — fall back to defaults).
const sbxProducts = new Map<string, any>();
for (const pid of new Set(sbxPrices.map((p) => p.product_id as string))) {
  try {
    sbxProducts.set(pid, (await api(SANDBOX_API, sbxKey, "GET", `/products/${pid}`)).data);
  } catch (e: any) {
    console.warn(`  ! sandbox key cannot read ${pid} (${e.message}) — using fallback name "${FALLBACK_PRODUCT_NAME}" / tax "${FALLBACK_PRODUCT_TAX}"`);
    sbxProducts.set(pid, { id: pid, name: FALLBACK_PRODUCT_NAME, tax_category: FALLBACK_PRODUCT_TAX, description: null });
  }
}

let sbxDiscounts: any[] | null = null;
try {
  sbxDiscounts = (await list(SANDBOX_API, sbxKey, "/discounts?status=active")).filter((d) => !/test|junk/i.test(`${d.description ?? ""} ${d.code ?? ""}`));
} catch {
  console.warn("  ! sandbox key cannot read discounts — skipping discount migration (the app references none).");
}

// ── 2. Audit live (read before any write) ───────────────────────────────────
const liveProducts = await list(LIVE_API, liveKey, "/products?status=active,archived");
const livePrices = await list(LIVE_API, liveKey, "/prices?status=active,archived");
const liveByKey = new Map(livePrices.map((p) => [priceKey(p), p]));
console.log(`Live: ${liveProducts.length} product(s), ${livePrices.length} price(s) already exist.`);

// ── 3. Products + prices (create only what's missing) ───────────────────────
const productMap: Record<string, string> = {};
for (const [sbxId, sp] of sbxProducts) {
  const existing = liveProducts.find((lp) => lp.name === sp.name);
  if (existing) {
    productMap[sbxId] = existing.id;
    skipped.push(`product "${sp.name}" → ${existing.id} (already in live${existing.status === "archived" ? ", ARCHIVED — review in dashboard" : ""})`);
  } else if (DRY) {
    productMap[sbxId] = "pro_DRY_RUN";
    created.push(`[dry-run] product "${sp.name}" (tax ${sp.tax_category})`);
  } else {
    const r = await api(LIVE_API, liveKey, "POST", "/products", {
      name: sp.name,
      tax_category: sp.tax_category,
      ...(sp.description ? { description: sp.description } : {}),
      ...(sp.image_url ? { image_url: sp.image_url } : {}),
      ...(sp.custom_data ? { custom_data: sp.custom_data } : {}),
    });
    productMap[sbxId] = r.data.id;
    created.push(`product "${sp.name}" → ${r.data.id}`);
  }
}

for (const sp of sbxPrices) {
  const existing = liveByKey.get(priceKey(sp));
  if (existing) {
    priceMap[sp.id] = existing.id;
    skipped.push(`price "${sp.name}" (${sp.unit_price.amount} ${sp.unit_price.currency_code}) → ${existing.id} (already in live${existing.status === "archived" ? ", ARCHIVED — review in dashboard" : ""})`);
    continue;
  }
  if (DRY) {
    priceMap[sp.id] = "pri_DRY_RUN";
    created.push(`[dry-run] price "${sp.name}" ${sp.unit_price.amount} ${sp.unit_price.currency_code} (qty ${sp.quantity?.minimum}–${sp.quantity?.maximum})`);
    continue;
  }
  const r = await api(LIVE_API, liveKey, "POST", "/prices", {
    product_id: productMap[sp.product_id],
    description: sp.description ?? sp.name,
    name: sp.name,
    unit_price: { amount: sp.unit_price.amount, currency_code: sp.unit_price.currency_code },
    tax_mode: sp.tax_mode,
    ...(sp.billing_cycle ? { billing_cycle: sp.billing_cycle } : {}),
    ...(sp.trial_period ? { trial_period: sp.trial_period } : {}),
    ...(sp.quantity ? { quantity: sp.quantity } : {}),
    ...(sp.unit_price_overrides?.length ? { unit_price_overrides: sp.unit_price_overrides } : {}),
    ...(sp.custom_data ? { custom_data: sp.custom_data } : {}),
  });
  priceMap[sp.id] = r.data.id;
  created.push(`price "${sp.name}" → ${r.data.id}`);
}

// ── 4. Discounts ─────────────────────────────────────────────────────────────
const discountMap: Record<string, string> = {};
if (sbxDiscounts?.length) {
  const liveDiscounts = await list(LIVE_API, liveKey, "/discounts?status=active,archived,expired,used");
  for (const sd of sbxDiscounts) {
    const match = liveDiscounts.find((ld) => (sd.code ? ld.code === sd.code : ld.description === sd.description));
    if (match) {
      discountMap[sd.id] = match.id;
      skipped.push(`discount "${sd.code ?? sd.description}" → ${match.id} (already in live)`);
      continue;
    }
    if (DRY) { created.push(`[dry-run] discount "${sd.code ?? sd.description}"`); continue; }
    const r = await api(LIVE_API, liveKey, "POST", "/discounts", {
      description: sd.description,
      type: sd.type,
      amount: sd.amount,
      ...(sd.currency_code ? { currency_code: sd.currency_code } : {}),
      ...(sd.code ? { code: sd.code, enabled_for_checkout: true } : {}),
      recur: sd.recur,
      ...(sd.maximum_recurring_intervals != null ? { maximum_recurring_intervals: sd.maximum_recurring_intervals } : {}),
      ...(sd.usage_limit != null ? { usage_limit: sd.usage_limit } : {}),
      // restrict_to carries SANDBOX ids — translate through the price map, drop unknowns.
      ...(sd.restrict_to?.length ? { restrict_to: sd.restrict_to.map((id: string) => priceMap[id] ?? productMap[id]).filter(Boolean) } : {}),
      ...(sd.expires_at ? { expires_at: sd.expires_at } : {}),
      ...(sd.custom_data ? { custom_data: sd.custom_data } : {}),
    });
    discountMap[sd.id] = r.data.id;
    created.push(`discount "${sd.code ?? sd.description}" → ${r.data.id}`);
  }
}

// ── 5. Notification destination (NEVER touch an existing one: recreating rotates
//       endpoint_secret_key and silently breaks verification of future deliveries) ──
let webhookSecretLine = "";
const liveNotif = await list(LIVE_API, liveKey, "/notification-settings");
const existingDest = liveNotif.find((n) => n.destination === WEBHOOK_URL);
if (existingDest) {
  skipped.push(`notification destination ${WEBHOOK_URL} → ${existingDest.id} (already in live${existingDest.active ? "" : ", INACTIVE — re-enable it in the dashboard"}) — left untouched`);
  const full = await api(LIVE_API, liveKey, "GET", `/notification-settings/${existingDest.id}`).catch(() => null);
  const secret = full?.data?.endpoint_secret_key;
  webhookSecretLine = secret
    ? `PADDLE_WEBHOOK_SECRET=${secret}`
    : `PADDLE_WEBHOOK_SECRET=<existing destination ${existingDest.id}; copy the secret from Paddle → Developer tools → Notifications>`;
} else if (DRY) {
  created.push(`[dry-run] notification destination ${WEBHOOK_URL} (transaction.completed)`);
  webhookSecretLine = "PADDLE_WEBHOOK_SECRET=<printed on real run>";
} else {
  const r = await api(LIVE_API, liveKey, "POST", "/notification-settings", {
    description: "ASOptimus server — credit grants",
    destination: WEBHOOK_URL,
    type: "url",
    traffic_source: "platform",
    subscribed_events: ["transaction.completed"],
  });
  created.push(`notification destination ${WEBHOOK_URL} → ${r.data.id}`);
  webhookSecretLine = `PADDLE_WEBHOOK_SECRET=${r.data.endpoint_secret_key}`;
}

// ── 6. Report: mapping + ready-to-paste live env block ───────────────────────
console.log(`\n${DRY ? "DRY RUN — nothing was created." : "Done."}`);
if (created.length) console.log(`\nCreated:\n  ${created.join("\n  ")}`);
if (skipped.length) console.log(`\nAlready in live (skipped):\n  ${skipped.join("\n  ")}`);
console.log("\nSandbox → live id map:");
for (const [s, l] of [...Object.entries(priceMap), ...Object.entries(discountMap)]) console.log(`  ${s} → ${l}`);

// TOPUP_PACKAGES_JSON / PADDLE_CREDIT_PRICE_ID with live ids, derived from the current env.
const curPkgs = process.env.TOPUP_PACKAGES_JSON;
let pkgLine = "TOPUP_PACKAGES_JSON=<set TOPUP_PACKAGES_JSON in the environment to translate it here>";
if (curPkgs) {
  try {
    const pkgs = JSON.parse(curPkgs);
    for (const p of Object.values<any>(pkgs)) {
      if (p.paddlePriceId) {
        if (!priceMap[p.paddlePriceId]) console.warn(`  ! no live mapping for ${p.paddlePriceId} — check the package config`);
        p.paddlePriceId = priceMap[p.paddlePriceId] ?? p.paddlePriceId;
      }
    }
    pkgLine = `TOPUP_PACKAGES_JSON=${JSON.stringify(pkgs)}`;
  } catch { /* leave placeholder */ }
}
const curCredit = process.env.PADDLE_CREDIT_PRICE_ID;
const creditLine = curCredit
  ? `PADDLE_CREDIT_PRICE_ID=${priceMap[curCredit] ?? `<no live mapping for ${curCredit}>`}`
  : "# PADDLE_CREDIT_PRICE_ID=<live pri_ of the ONE-credit price, if custom amounts are wanted>";

console.log(`
──── live .env block (paste into the PROD environment only — after verification passes) ────
PADDLE_API_KEY=<your pdl_live_… key — never commit it>
# PADDLE_ENV stays UNSET for live (unset it if the prod env still has PADDLE_ENV=sandbox)
PADDLE_CLIENT_TOKEN=<live_… client-side token from Paddle → Developer tools → Client tokens>
${webhookSecretLine}
${creditLine}
${pkgLine}
─────────────────────────────────────────────────────────────────────────────────────────────`);
if (!DRY) console.log("Store the webhook secret now — Paddle shows endpoint_secret_key only while the destination exists; do NOT recreate the destination to \"get it again\".");
