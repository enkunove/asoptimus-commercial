/* ASOptimus localhost UI — vanilla JS (spec 07 + BUILD-PLAN D1/D8/D9).
   Talks ONLY to 127.0.0.1. Every /api call carries the per-launch token (D8).
   No LLM internals in the UI: users pay in credits per keyphrase (D4), so token
   counts/costs are never shown (spec 09 §0). R reasons stay visible per keyword. */
"use strict";

const app = document.getElementById("app");
const TOKEN = document.querySelector('meta[name="aso-token"]')?.content ?? "";

let storefrontsCache = null;
let modelsCache = null;
let packagesCache = null;
let session = null;
let currentSlug = null;
let currentBalance = null;
let kwQuery = { sort: "score", dir: "desc", status: "", source: "", insight: "", q: "", page: 0 };
let expandedKeyword = null;
let kwDetailCache = { kw: null, html: "" }; // last rendered detail — live refresh must not flash "Loading…"
let expandedCompetitor = null;
let runAnnotations = {};      // keyword → {pinned, note} for the currently open run (local-only, spec 09 §7)
let annotationsSlug = null;
let runsForCompare = [];      // runs list cached per run screen (for "Compare with previous")

const OVERSHOOT_PCT = 0.1; // up to +10% keyphrases — included in the price (D4 v3)

// ---------- API (D8 token on every request) ----------

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), "X-ASO-Token": TOKEN };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { fields: data.fields });
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- webview-safe dialogs ----------
// The desktop webview has NO working window.confirm/alert (same as window.open) — native
// dialogs silently return undefined and buttons look dead. Modal-based replacement.

function uiConfirm(text) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h2>Confirm</h2>
      <p>${esc(text)}</p>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="cf-yes">Yes</button>
        <button id="cf-no">Cancel</button>
      </div>`);
    const done = (v) => { document.getElementById("modal-overlay")?.remove(); resolve(v); };
    m.querySelector("#cf-yes").addEventListener("click", () => done(true));
    m.querySelector("#cf-no").addEventListener("click", () => done(false));
  });
}

// ---------- toast (small non-blocking confirmation, e.g. "export saved") ----------

function toast(html, isError) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = `toast ${isError ? "toast-error" : ""}`;
  el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- exports (spec 09 §1/§6): the local program saves straight to ~/Downloads ----------

async function exportRun(slug, format) {
  try {
    const res = await api(`/api/runs/${encodeURIComponent(slug)}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    });
    toast(`✓ <b>${esc(res.filename)}</b> saved to <span class="mono small" title="${esc(res.path)}">${esc(shortPath(res.path))}</span>`);
  } catch (e) {
    toast(`✗ export failed: ${esc(e.message)}`, true);
  }
}
function shortPath(p) {
  const parts = String(p || "").split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

// ---------- pins & notes (spec 09 §7): local file via the relay, zero cloud traffic ----------

async function loadAnnotations(slug, force) {
  if (!force && annotationsSlug === slug) return runAnnotations;
  try {
    const res = await api(`/api/runs/${encodeURIComponent(slug)}/annotations`);
    runAnnotations = res.annotations || {};
  } catch { runAnnotations = {}; }
  annotationsSlug = slug;
  return runAnnotations;
}
async function saveAnnotation(slug, keyword, patch) {
  const res = await api(`/api/runs/${encodeURIComponent(slug)}/annotations`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword, ...patch }),
  });
  runAnnotations = res.annotations || {};
  annotationsSlug = slug;
  return runAnnotations;
}
function isPinned(keyword) { return !!(runAnnotations[keyword] && runAnnotations[keyword].pinned); }
// ---------- SSE / polling ----------

let sseOk = false;
function startLive() {
  try {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
    es.onopen = () => (sseOk = true);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "run-changed") scheduleLiveRefresh(msg.slug);
        else if (msg.type === "balance") setBalance(msg.credits);
        else if (msg.type === "run-paused") { pauseReasons[msg.slug] = msg.reason || ""; pauseCodes[msg.slug] = msg.code || ""; scheduleLiveRefresh(msg.slug); }
        else if (msg.type === "phase" || msg.type === "feed") scheduleLiveRefresh(msg.slug);
      } catch {}
    };
    es.onerror = () => (sseOk = false);
  } catch { sseOk = false; }
  setInterval(() => { if (!sseOk) scheduleLiveRefresh(null); }, 3000);
}

const pauseReasons = {}; // slug → pause reason text (fallback signal)
const pauseCodes = {};   // slug → structured reason code (run.paused.code) — primary signal
// Does it look like the run stopped from running out of credits (D4 v4 hard-stop) — text fallback.
function isCreditsPause(text) { return /credit|balance|top.?up/i.test(String(text || "")); }
let liveTimer = null, lastLive = 0;
function scheduleLiveRefresh(slug) {
  const hash = location.hash || "#/runs";
  const onList = hash.startsWith("#/runs");
  const onThisRun = currentSlug && hash.startsWith("#/run/") && (!slug || slug === currentSlug);
  if (!onList && !onThisRun) return;
  if (liveTimer) return;
  const wait = Math.max(0, lastLive + 2000 - Date.now());
  liveTimer = setTimeout(async () => {
    liveTimer = null; lastLive = Date.now();
    try {
      if (location.hash.startsWith("#/run/") && currentSlug) await updateRun(currentSlug);
      else if ((location.hash || "#/runs").startsWith("#/runs")) await refreshRunsList();
    } catch {}
  }, wait);
}
async function refreshRunsList() {
  if (newRunOpen) return;
  const a = document.activeElement;
  if (a && app.contains(a) && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName)) return;
  await viewRuns();
}

// ---------- header balance ----------

const balWidget = document.getElementById("balance-widget");
function setBalance(credits) {
  const prev = currentBalance;
  currentBalance = credits == null ? null : Number(credits);
  const el = document.getElementById("bal-credits");
  if (el) {
    el.textContent = credits == null ? "—" : Number(credits).toLocaleString();
    // Live drain (D4 v4): flash the debit/top-up tick — credits melt in real time.
    if (prev != null && currentBalance != null && currentBalance !== prev) {
      el.classList.remove("bal-flash-down", "bal-flash-up");
      void el.offsetWidth; // restart the animation
      el.classList.add(currentBalance < prev ? "bal-flash-down" : "bal-flash-up");
    }
  }
  // If the run form is open, re-evaluate the estimate against the new balance.
  updateQuoteUI();
}
async function refreshBalance() {
  try {
    const b = await api("/api/balance");
    setBalance(b.credits);
  } catch {}
}
function bindHeader() {
  document.getElementById("bal-topup")?.addEventListener("click", openTopup);
  document.getElementById("bal-credits")?.addEventListener("click", () => { location.hash = "#/balance"; });
  document.getElementById("bal-logout")?.addEventListener("click", async () => {
    if (!(await uiConfirm("Log out? The session token will be removed from this computer."))) return;
    await api("/api/logout", { method: "POST" });
    session = null;
    location.hash = "";
    boot();
  });
}

// ---------- top-up (modal, no window.prompt) ----------
// 1 credit = $1, NO free tier (D4). Package catalog comes FROM THE SERVER (query kind="packages"), not hardcoded.
async function openTopup() {
  const modal = openModal(`
    <h2>Top up balance</h2>
    <p class="muted small">1 credit = $1. Payment happens on a secure Paddle page.</p>
    <div class="topup-grid" id="topup-grid"><div class="muted small">loading packages…</div></div>
    <div id="topup-custom"></div>
    <div id="topup-msg" class="small muted" style="margin-top:10px"></div>`);
  const grid = modal.querySelector("#topup-grid");
  const msg = modal.querySelector("#topup-msg");

  // One checkout launcher for packages AND custom amounts.
  const launchCheckout = async (selection) => {
    msg.textContent = "creating a payment link…";
    try {
      const res = await api("/api/topup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      if (res.checkoutUrl) {
        // The desktop webview has no working window.open — the local app opens the system browser.
        try {
          await api("/api/open-external", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: res.checkoutUrl }),
          });
        } catch {
          window.open(res.checkoutUrl, "_blank", "noopener");
        }
        msg.innerHTML = `<span class="check-ok">✓ opened the payment page in the browser</span>`;
        setTimeout(refreshBalance, 1200);
      } else {
        msg.textContent = "the server did not return a payment link";
      }
    } catch (e) { msg.innerHTML = `<span class="check-fail">✗ ${esc(e.message)}</span>`; }
  };

  let cat;
  try {
    cat = await getPackages();
  } catch (e) {
    grid.innerHTML = `<span class="check-fail">failed to load packages: ${esc(e.message)}</span>`;
    return;
  }
  const pkgs = cat.packages;
  grid.innerHTML = pkgs.length ? pkgs.map((p) => `
    <button class="topup-pkg" data-pkg="${esc(p.id)}">
      <div class="topup-credits">${Number(p.credits).toLocaleString()} cr</div>
      ${p.bonusPct ? `<div class="topup-bonus">+${p.bonusPct}% bonus</div>` : ""}
      <div class="topup-price">$${Number(p.priceUsd).toLocaleString()}</div>
      ${p.label ? `<div class="topup-label small muted">${esc(p.label)}</div>` : ""}
    </button>`).join("") : `<span class="muted small">packages unavailable</span>`;
  grid.querySelectorAll(".topup-pkg").forEach((b) =>
    b.addEventListener("click", () => launchCheckout({ packageId: b.dataset.pkg })));

  // Custom amount (server-configured; hidden when the server disables it).
  const customBox = modal.querySelector("#topup-custom");
  if (cat.custom) {
    const { minCredits, maxCredits, usdPerCredit } = cat.custom;
    customBox.innerHTML = `
      <div class="topup-custom">
        <div class="topup-or"><span>or your own amount</span></div>
        <div class="row" style="flex-wrap:nowrap">
          <input type="number" id="custom-credits" min="${minCredits}" max="${maxCredits}" step="1"
            value="${minCredits}" inputmode="numeric" style="max-width:130px">
          <button class="primary" id="custom-buy">Buy</button>
        </div>
        <p class="hint" style="margin-top:6px">$${usdPerCredit} per credit, no bonus · ${minCredits}–${maxCredits.toLocaleString()} credits · packages above are the better deal</p>
        <div class="field-error" id="custom-error"></div>
      </div>`;
    const input = customBox.querySelector("#custom-credits");
    const buy = customBox.querySelector("#custom-buy");
    const errEl = customBox.querySelector("#custom-error");
    const parse = () => {
      const n = Number(input.value);
      const ok = Number.isInteger(n) && n >= minCredits && n <= maxCredits;
      errEl.textContent = ok || input.value === "" ? "" : `whole number between ${minCredits} and ${maxCredits}`;
      buy.disabled = !ok;
      buy.textContent = ok ? `Buy ${n.toLocaleString()} cr — $${(n * usdPerCredit).toLocaleString()}` : "Buy";
      return ok ? n : null;
    };
    input.addEventListener("input", parse);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && parse() != null) buy.click(); });
    buy.addEventListener("click", () => {
      const n = parse();
      if (n != null) launchCheckout({ customCredits: n });
    });
    parse();
  }
}

// Generic modal (overlay + card). Returns the content root.
function openModal(innerHtml) {
  document.getElementById("modal-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-card"><button class="modal-close" title="Close">✕</button><div class="modal-body"></div></div>`;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);
  const bodyEl = overlay.querySelector(".modal-body");
  bodyEl.innerHTML = innerHtml;
  document.body.appendChild(overlay);
  return bodyEl;
}

// ---------- boot / activation gate ----------

async function boot() {
  try {
    session = await api("/api/session");
  } catch (e) {
    app.innerHTML = `<div class="banner error">Could not reach the local app: ${esc(e.message)}</div>`;
    return;
  }
  const nav = document.getElementById("topnav");
  if (!session.activated) {
    balWidget.hidden = true;
    if (nav) nav.style.visibility = "hidden";
    return viewLogin();
  }
  balWidget.hidden = false;
  if (nav) nav.style.visibility = "visible";
  bindHeader();
  refreshBalance();
  render();
}

// ============================================================
// Screen 0: login by activation key (login-by-key)
// ============================================================

function viewLogin() {
  currentSlug = null;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="panel login-card">
        <h1>Activate ASOptimus</h1>
        <p class="muted">Enter the activation key from your email — it looks like <span class="mono">asop_live_…</span>.
        The key is exchanged for a cloud session and stored only on this computer (D1).</p>
        <label>Activation key</label>
        <input id="key-input" placeholder="asop_live_..." autocomplete="off" spellcheck="false">
        <div class="row" style="margin-top:12px">
          <button class="primary" id="key-activate">Activate</button>
          <span id="key-result" class="small"></span>
        </div>
        <p class="hint" style="margin-top:14px">No key? It arrives by email after signing up at asoptimus.com.</p>
      </div>
    </div>`;
  const input = document.getElementById("key-input");
  const out = document.getElementById("key-result");
  const go = async () => {
    out.innerHTML = "activating…";
    try {
      await api("/api/activate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: input.value }),
      });
      out.innerHTML = `<span class="check-ok">✓ done</span>`;
      setTimeout(boot, 400);
    } catch (e) {
      out.innerHTML = `<span class="check-fail">✗ ${esc(e.message)}</span>`;
    }
  };
  document.getElementById("key-activate").addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  input.focus();
}

// ============================================================
// Router (post-activation)
// ============================================================

async function render() {
  const hash = location.hash || "#/runs";
  try {
    if (hash.startsWith("#/balance")) return await viewBalance();
    const cmpMatch = hash.match(/^#\/compare\/([^/]+)\/([^/]+)/);
    if (cmpMatch) return await viewCompare(decodeURIComponent(cmpMatch[1]), decodeURIComponent(cmpMatch[2]));
    const runMatch = hash.match(/^#\/run\/([^/]+)/);
    if (runMatch) return await viewRun(decodeURIComponent(runMatch[1]));
    return await viewRuns();
  } catch (e) {
    app.innerHTML = `<div class="banner error">Error: ${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", () => {
  if (!session?.activated) return;
  expandedKeyword = null; expandedCompetitor = null; kwQuery.page = 0; render();
});

async function getStorefronts() {
  if (!storefrontsCache) storefrontsCache = await api("/api/storefronts");
  return storefrontsCache;
}
async function getModels() {
  // Model registry + pricePerKeyphrase comes from the server (D4 v3) — do NOT hardcode.
  if (!modelsCache) {
    const res = await api("/api/models");
    modelsCache = Array.isArray(res.models) ? res.models : [];
  }
  return modelsCache;
}
async function getPackages() {
  // TopupCatalog (packages + custom range) comes from the server — do NOT hardcode.
  if (!packagesCache) {
    const res = await api("/api/packages");
    packagesCache = {
      packages: Array.isArray(res.packages) ? res.packages : [],
      custom: res.custom || null, // null → custom top-ups disabled on this server
    };
  }
  return packagesCache;
}
/** Model by id from the server registry (for the estimate). */
function modelById(id) { return (modelsCache || []).find((m) => m.id === id) || null; }
/** Default form model: Haiku (D4 v3), else the first from the registry. */
function defaultModel(models, cfgDefault) {
  return (
    models.find((m) => m.id === cfgDefault) ||
    models.find((m) => /haiku/i.test(m.id)) ||
    models[0] || null
  );
}

// ---------- live run ESTIMATE (D4 v4, usage-based): ≈ sampleSize × pricePerKeyphrase ----------
// This is an ESTIMATE, not a reserve: credits are debited in real time as keyphrases are produced.
function computeQuote(sampleSize, model) {
  const price = model ? Number(model.pricePerKeyphrase) : 0;
  return { price, quote: Math.ceil((Number(sampleSize) || 0) * price) };
}
// Re-render the estimate box against the current sampleSize/model/balance. No-op if the form is absent.
function updateQuoteUI() {
  const box = document.getElementById("quote-box");
  const ssEl = document.getElementById("f-samplesize");
  const modelEl = document.getElementById("f-model");
  if (!box || !ssEl || !modelEl) return;
  const sampleSize = Number(ssEl.value);
  const model = modelById(modelEl.value);
  const { price, quote } = computeQuote(sampleSize, model);
  const maxTotal = Math.ceil(quote * (1 + OVERSHOOT_PCT)); // overshoot is debited TOO
  const known = currentBalance != null;
  const enough = !known || currentBalance >= quote;
  box.innerHTML = `
    <div class="quote-main">
      <div><span class="quote-approx">≈</span> <span class="quote-value">${quote.toLocaleString()}</span> <span class="muted">credits — estimate</span></div>
      <div class="muted small">${sampleSize} keyphrases × ${price} cr/keyphrase${model ? ` · ${esc(model.name)}` : ""}</div>
    </div>
    <p class="quote-note small muted">An estimate, not a fixed price: credits are debited <b>as the run goes, in real time</b> —
      exactly for the keyphrases produced. The system may add <b>up to +${Math.round(OVERSHOOT_PCT * 100)}%</b> keyphrases
      (finishing hypothesis branches already started) — <b>those are debited too</b>, so the total can reach
      ≈${maxTotal.toLocaleString()} cr (+${Math.round(OVERSHOOT_PCT * 100)}% over the estimate).</p>
    ${known ? (enough
      ? `<p class="small check-ok">Balance: ${currentBalance.toLocaleString()} cr — should cover the estimate.</p>`
      : `<div class="quote-short"><span class="check-warn">Balance: ${currentBalance.toLocaleString()} cr — below the estimate. The run will start and debit as it goes; when credits run out it pauses, you top up and resume from that point.</span> <button type="button" class="primary small" id="quote-topup">Top up now</button></div>`)
      : `<p class="small muted">Checking balance…</p>`}`;
  // Usage-based debit, no reserve → do NOT block the form: the server debits actuals and pauses at zero on its own.
  box.querySelector("#quote-topup")?.addEventListener("click", openTopup);
}

// ============================================================
// Screen: balance + ledger (D4)
// ============================================================

async function viewBalance() {
  currentSlug = null;
  app.innerHTML = `<div class="loading">Loading…</div>`;
  const b = await api("/api/balance");
  setBalance(b.credits);
  const ledger = Array.isArray(b.ledger) ? b.ledger : [];
  const typeName = { grant: "top-up", debit: "debit", settle: "settlement", refund: "refund", chargeback: "chargeback" };
  app.innerHTML = `
    <div class="row spread"><h1>Balance</h1><button class="primary" id="bal-topup-2">Top up</button></div>
    <div class="panel">
      <div class="bal-big"><span class="value">${Number(b.credits ?? 0).toLocaleString()}</span> <span class="muted">credits</span></div>
      <p class="muted small">1 credit = $1. Debited per verified sample keyphrase (D4). No free tier — top-up only.</p>
    </div>
    <div class="panel">
      <h2>Transaction history</h2>
      ${ledger.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th class="num">Δ credits</th><th>Run</th></tr></thead>
        <tbody>${ledger.map((r) => `
          <tr><td class="small">${new Date(r.ts).toLocaleString()}</td>
          <td><span class="badge ${r.delta >= 0 ? "green" : "gray"}">${esc(typeName[r.type] || r.type)}</span></td>
          <td class="num ${r.delta >= 0 ? "score-hi" : "score-zero"}">${r.delta >= 0 ? "+" : ""}${Number(r.delta).toLocaleString()}</td>
          <td class="mono small">${r.runId ? esc(r.runId) : "—"}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No transactions yet.</p>`}
    </div>`;
  document.getElementById("bal-topup-2")?.addEventListener("click", openTopup);
}

// ============================================================
// Screen: run list + new-run form (spec 07.4)
// ============================================================

let newRunOpen = false;

async function viewRuns() {
  currentSlug = null;
  const [{ runs }, sf, models] = await Promise.all([api("/api/runs"), getStorefronts(), getModels()]);

  const phaseBadge = (r) => {
    if (r.failed) return `<span class="badge red">error</span>`;
    if (r.paused) return `<span class="badge yellow">⏸ paused</span>`;
    const names = { created: "created", context: "context", context_review: "awaiting review", seeding: "seeding", loop: "loop", improving: "improving", assembling: "assembling", done: "done" };
    return `<span class="badge ${r.phase === "done" ? "green" : ""}">${names[r.phase] || r.phase}</span>`;
  };

  app.innerHTML = `
    <div class="row spread">
      <h1>Runs</h1>
      <button class="primary" id="new-run">+ New run</button>
    </div>
    <div id="new-run-form"></div>
    ${runs.length === 0 && !newRunOpen ? `
      <div class="empty-state panel">
        <h2>Drop in a description of your app —<br>get the best keywords, title and subtitle back</h2>
        <p>You need a brief: what the app does, who it's for, competitors, market.</p>
        <p><button class="primary" id="new-run-2">Create your first run</button></p>
      </div>` : `
      <div class="cards">
        ${runs.map((r) => `
          <div class="card" data-slug="${esc(r.runId)}">
            <div class="menu row">
              ${r.phase === "done" ? `<button class="small cmp" data-slug="${esc(r.runId)}" title="Compare with another run">⇄</button>` : ""}
              <button class="small danger del" data-slug="${esc(r.runId)}" title="Delete">✕</button>
            </div>
            <h3>${esc(r.brand)} · ${esc((r.country || "").toUpperCase())}</h3>
            <div class="row">${phaseBadge(r)} <span class="muted small">${new Date(r.updatedAt).toLocaleString()}</span></div>
            <div style="margin:8px 0"><div class="progress"><div style="width:${Math.min(100, (r.sampleCount / (r.sampleSize || 1)) * 100)}%"></div></div>
            <span class="small muted">${r.sampleCount}/${r.sampleSize} verified keywords</span></div>
            ${r.topKeywords.length ? `<div class="small" style="margin-top:6px">${r.topKeywords.map((k) => `<span class="badge gray">${esc(k.keyword)} · ${k.score}</span>`).join(" ")}</div>` : ""}
          </div>`).join("")}
      </div>`}`;

  document.getElementById("new-run")?.addEventListener("click", () => toggleNewRun(sf, models));
  document.getElementById("new-run-2")?.addEventListener("click", () => toggleNewRun(sf, models));
  document.querySelectorAll(".card[data-slug]").forEach((c) =>
    c.addEventListener("click", (e) => {
      if (e.target.closest(".menu")) return;
      location.hash = `#/run/${encodeURIComponent(c.dataset.slug)}`;
    }));
  document.querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`Delete run ${b.dataset.slug}?`))) return;
      try { await api(`/api/runs/${encodeURIComponent(b.dataset.slug)}`, { method: "DELETE" }); } catch (err) { toast(`✗ ${esc(err.message)}`, true); }
      render();
    }));
  document.querySelectorAll(".cmp").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openCompareModal(runs, b.dataset.slug);
    }));
  if (newRunOpen) renderNewRunForm(sf, models);
}

// Pick the second run for a diff (spec 09 §5): same brand+storefront, both finished.
function openCompareModal(runs, slug) {
  const base = runs.find((r) => r.runId === slug);
  if (!base) return;
  const candidates = runs.filter((r) =>
    r.runId !== slug && r.phase === "done" && r.brand === base.brand && r.country === base.country);
  const modal = openModal(`
    <h2>Compare "${esc(base.brand)}" runs</h2>
    ${candidates.length ? `
      <p class="muted small">Pick the run to diff against — older one becomes the baseline.</p>
      <div class="cmp-pick">${candidates.map((r) => `
        <button class="cmp-cand" data-slug="${esc(r.runId)}">
          <span class="mono small">${esc(r.runId.slice(0, 16))}…</span>
          <span class="muted small">${new Date(r.updatedAt).toLocaleString()} · ${r.sampleCount} keyphrases</span>
        </button>`).join("")}</div>`
      : `<p class="muted">No other finished run of ${esc(base.brand)} · ${esc((base.country || "").toUpperCase())} yet. Re-run the same app later and diff them — that's the pay-per-run answer to tracking subscriptions.</p>`}`);
  modal.querySelectorAll(".cmp-cand").forEach((b) =>
    b.addEventListener("click", () => {
      const other = runs.find((r) => r.runId === b.dataset.slug);
      const [a, bRun] = new Date(other.updatedAt) <= new Date(base.updatedAt) ? [other, base] : [base, other];
      document.getElementById("modal-overlay")?.remove();
      location.hash = `#/compare/${encodeURIComponent(a.runId)}/${encodeURIComponent(bRun.runId)}`;
    }));
}

function toggleNewRun(sf, models) {
  newRunOpen = true;
  renderNewRunForm(sf, models);
  document.getElementById("new-run-form").scrollIntoView({ behavior: "smooth" });
}

function renderNewRunForm(sf, models) {
  const d = sf.defaults;
  models = models || modelsCache || [];
  const el = document.getElementById("new-run-form");
  if (!el) return;
  const defModel = defaultModel(models, d.model);
  el.innerHTML = `
    <div class="panel">
      <div class="row spread"><h2>New run</h2><button id="close-form">✕</button></div>
      <label>Brief: what the app does, who it's for, competitors, market (200 characters minimum)</label>
      <textarea id="brief-text" placeholder="Describe the product…"></textarea>
      <div class="dropzone" id="dropzone">…or drop a .md/.txt brief file here<br><span id="brief-name" class="small"></span></div>
      <input type="file" id="brief-input" accept=".md,.txt,text/*" style="display:none">
      <div class="grid2">
        <div><label>Brand *</label><input id="f-brand" placeholder="Somna"><div class="field-error" id="e-brand"></div></div>
        <div><label>Country (storefront)</label><select id="f-country">${Object.keys(sf.storefronts).map((c) => `<option value="${c}" ${c === d.country ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}</select></div>
        <div><label>Semantic language <span class="pop"><span class="q">?</span><span class="pop-body">The language hypotheses are generated and scored in. Auto-filled from the country, editable.</span></span></label>
          <select id="f-semlang">${["en","ru","de","fr","it","es","pt","nl","sv","ja","ko","zh","tr","uk","pl","hi"].map((l) => `<option ${l === d.semanticLanguage ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div><label>Model</label><select id="f-model">${models.map((m) => `<option value="${esc(m.id)}" ${defModel && m.id === defModel.id ? "selected" : ""}>${esc(m.name)}${m.note ? ` — ${esc(m.note)}` : ""}</option>`).join("") || `<option value="">no models available</option>`}</select>
          <div class="hint">stronger model → pricier keyphrase</div></div>
      </div>
      <label>Sample size (keyphrases): <span id="ss-val">${d.sampleSize}</span></label>
      <input type="range" id="f-samplesize" min="50" max="500" step="10" value="${d.sampleSize}">
      <div id="quote-box" class="quote-box"></div>
      <details class="accordion"><summary>Advanced settings</summary>
        <div class="grid2">
          <div><label>batchSize</label><input id="f-batch" type="number" value="${d.batchSize}" min="5" max="50"></div>
          <div><label>exploreRatio</label><input id="f-explore" type="number" value="${d.exploreRatio}" step="0.05" min="0" max="1"></div>
          <div><label>improvementRounds</label><input id="f-rounds" type="number" value="${d.improvementRounds}" min="0" max="10"></div>
          <div><label>serpTop</label><input id="f-serptop" type="number" value="${d.serpTop}" min="3" max="25"></div>
          <div><label>Apple requests per minute</label><input id="f-rpm" type="number" value="${d.http.requestsPerMinute}" min="1" max="20"></div>
          <div><label>Cache TTL, days</label><input id="f-ttl" type="number" value="${d.http.cacheTtlDays}" min="0" max="90"></div>
          <div><label>Second bucket (cross-localization)</label><select id="f-extra"><option value="true" selected>yes</option><option value="false">no</option></select></div>
          <div><label>Fresh data (ignore cache)</label><select id="f-fresh"><option value="false" selected>no</option><option value="true">yes</option></select></div>
        </div>
        <label>Stopwords (comma-separated)</label>
        <input id="f-stopwords" value="${esc((d.stopwords || []).join(", "))}">
      </details>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="create-run">Create run</button>
        <span id="create-error" class="field-error"></span>
      </div>
    </div>`;

  const semSelect = el.querySelector("#f-semlang");
  el.querySelector("#f-country").addEventListener("change", (e) => {
    const info = sf.storefronts[e.target.value];
    if (info) semSelect.value = info.primaryLanguage;
  });
  el.querySelector("#f-samplesize").addEventListener("input", (e) => { el.querySelector("#ss-val").textContent = e.target.value; updateQuoteUI(); });
  el.querySelector("#f-model").addEventListener("change", updateQuoteUI);
  el.querySelector("#close-form").addEventListener("click", () => { newRunOpen = false; render(); });
  updateQuoteUI(); // initial render of the live estimate

  const dz = el.querySelector("#dropzone"), fi = el.querySelector("#brief-input");
  const loadFile = async (file) => {
    const text = await file.text();
    el.querySelector("#brief-text").value = text;
    el.querySelector("#brief-name").textContent = `✓ ${file.name} (${text.length} chars)`;
  };
  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  fi.addEventListener("change", () => { if (fi.files[0]) loadFile(fi.files[0]); });

  el.querySelector("#create-run").addEventListener("click", async () => {
    const errEl = el.querySelector("#create-error");
    errEl.textContent = "";
    el.querySelector("#e-brand").textContent = "";
    const brand = el.querySelector("#f-brand").value.trim();
    const brief = el.querySelector("#brief-text").value;
    if (!brand) { el.querySelector("#e-brand").textContent = "brand is required"; return; }
    if (brief.replace(/\s+/g, " ").trim().length < 200) { errEl.textContent = "Brief is shorter than 200 meaningful characters."; return; }
    // D4 v4: usage-based real-time debit, no reserve — do NOT gate the start on balance.
    // The server debits actual keyphrases produced and pauses with a top-up notice when credits run out.
    const country = el.querySelector("#f-country").value;
    const config = {
      brand, country,
      semanticLanguage: semSelect.value,
      language: `${semSelect.value}_${country}`,
      sampleSize: Number(el.querySelector("#f-samplesize").value),
      batchSize: Number(el.querySelector("#f-batch").value),
      exploreRatio: Number(el.querySelector("#f-explore").value),
      improvementRounds: Number(el.querySelector("#f-rounds").value),
      serpTop: Number(el.querySelector("#f-serptop").value),
      model: el.querySelector("#f-model").value,
      extraLocale: el.querySelector("#f-extra").value === "true",
      freshData: el.querySelector("#f-fresh").value === "true",
      stopwords: el.querySelector("#f-stopwords").value.split(",").map((s) => s.trim()).filter(Boolean),
      http: { ...d.http, requestsPerMinute: Number(el.querySelector("#f-rpm").value), cacheTtlDays: Number(el.querySelector("#f-ttl").value) },
      limits: d.limits,
    };
    try {
      const res = await api("/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, config }),
      });
      newRunOpen = false;
      location.hash = `#/run/${encodeURIComponent(res.run_id)}`;
    } catch (e) { errEl.textContent = e.message; }
  });
}

// ============================================================
// Screen: run (spec 07.5)
// ============================================================

let runTab = "overview", lastTopSig = "", lastRunData = null, runUpdating = false;

async function viewRun(slug) {
  currentSlug = slug;
  if (runTab === "llm") runTab = "overview";
  const shell = document.getElementById("run-shell");
  if (!shell || shell.dataset.slug !== slug) {
    lastTopSig = ""; lastRunData = null;
    app.innerHTML = `<div id="run-shell" data-slug="${esc(slug)}"><div id="run-top"></div><div id="tab-body"><div class="loading">Loading…</div></div></div>`;
    await loadAnnotations(slug, true);
    try { runsForCompare = (await api("/api/runs")).runs || []; } catch { runsForCompare = []; }
  }
  await updateRun(slug);
}

/** STRICTLY OLDER `done` run of the same brand+country (spec 09 §5 "Compare with previous").
 *  Without the cutoff the oldest run would offer to "compare with previous" against a NEWER
 *  run and every diff sign would come out inverted. */
function previousRunFor(slug, config, beforeIso) {
  const cutoff = beforeIso ? new Date(beforeIso).getTime() : Infinity;
  return runsForCompare
    .filter((r) => r.runId !== slug && r.phase === "done" && !r.paused &&
      r.brand === config.brand && r.country === config.country &&
      new Date(r.updatedAt).getTime() < cutoff)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
}

async function updateRun(slug) {
  if (runUpdating) return;
  runUpdating = true;
  try {
    const data = await api(`/api/runs/${encodeURIComponent(slug)}`);
    if (!data) {
      const body = document.getElementById("tab-body");
      if (body) body.innerHTML = `<div class="banner error">Run not found — it may have been deleted, or the cloud restarted. <a href="#/runs">Back to runs</a></div>`;
      return;
    }
    lastRunData = data;
    renderRunTop(slug, data);
    await renderTab(slug, data);
  } finally { runUpdating = false; }
}

function renderRunTop(slug, data) {
  const top = document.getElementById("run-top");
  if (!top || !data) return;
  const active = document.activeElement;
  if (active && top.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
  const { state, config, context } = data;
  const creditReason = state.paused ? (pauseReasons[slug] || (isCreditsPause(state.notice) ? state.notice : "")) : "";
  // Primary signal — structured code run.paused.code==="credits_out"; the text regex is a fallback.
  const creditsOut = state.paused && (pauseCodes[slug] === "credits_out" || isCreditsPause(pauseReasons[slug]) || isCreditsPause(state.notice));
  const sig = JSON.stringify([state.phase, state.paused, state.notice, state.failed, state.hintsEndpointDown, data.sampleCount, state.usage, state.http, runTab, context, creditsOut]);
  if (sig === lastTopSig) return;
  lastTopSig = sig;

  const phases = [["context", "Context"], ["seeding", "Seeding"], ["loop", "Loop"], ["improving", "Improving"], ["assembling", "Assembling"], ["done", "Done"]];
  const phaseIdx = { created: -1, context: 0, context_review: 0, seeding: 1, loop: 2, improving: 3, assembling: 4, done: 5 }[state.phase] ?? 0;
  const pct = Math.min(100, (data.sampleCount / (config.sampleSize || 1)) * 100);
  const canPause = !state.paused && ["seeding", "loop", "improving", "assembling", "context"].includes(state.phase);
  const canResume = state.paused && state.phase !== "done";
  const canStop = data.sampleCount >= 30 && ["loop", "improving"].includes(state.phase);

  top.innerHTML = `
    <div class="panel">
      <div class="row spread">
        <h1 style="margin:0">${esc(config.brand)} · ${esc((config.country || "").toUpperCase())} <span class="muted small mono">${esc(slug)}</span></h1>
        <div class="row">
          ${canPause ? `<button id="btn-pause">⏸ Pause</button>` : ""}
          ${canResume ? `<button class="primary" id="btn-resume">▶ Resume</button>` : ""}
          ${canStop ? `<button id="btn-stop">⏹ Stop &amp; assemble</button>` : ""}
          ${state.phase === "done" ? `<button id="btn-reassemble">↻ Reassemble</button>` : ""}
          ${state.phase === "done" ? `<button id="btn-report" title="Self-contained HTML report — send it to anyone">⬇ Export report</button>` : ""}
          ${state.phase === "done" && previousRunFor(slug, config, state.updatedAt) ? `<button id="btn-compare" title="Diff against the previous run of this app">⇄ Compare with previous</button>` : ""}
        </div>
      </div>
      <div class="stepper" style="margin:10px 0">
        ${phases.map(([id, name], i) => `<span class="step ${i < phaseIdx ? "done" : ""} ${i === phaseIdx ? (state.paused ? "paused" : "active") : ""}">${state.paused && i === phaseIdx ? "⏸ " : ""}${name}</span>${i < phases.length - 1 ? "→" : ""}`).join("")}
      </div>
      <div class="row">
        <div style="flex:1;min-width:200px"><div class="progress"><div style="width:${pct}%"></div></div>
          <span class="small muted">sample ${data.sampleCount}/${config.sampleSize}</span></div>
        <span class="small muted">Apple: ${state.http.requestsMade} requests · ${state.http.cacheHits} cache hits</span>
      </div>
      ${creditsOut ? `<div class="banner error credits-out" style="margin-top:10px">
        <div><b>Out of credits.</b> The run is paused — top up and it resumes from this point (work done so far is saved, D4).${creditReason && !isCreditsPause(state.notice) ? ` <span class="small muted">${esc(creditReason)}</span>` : ""}</div>
        <div class="row" style="margin-top:8px"><button class="primary" id="btn-credit-topup">Top up</button>${canResume ? `<button id="btn-credit-resume">▶ Resume</button>` : ""}</div>
      </div>` : ""}
      ${state.hintsEndpointDown ? `<div class="banner warn" style="margin-top:10px">Apple's autocomplete endpoint is unavailable — Popularity is running degraded.</div>` : ""}
      ${state.notice && !creditsOut ? `<div class="banner warn" style="margin-top:10px">${esc(state.notice)}</div>` : ""}
      ${state.failed ? `<div class="banner error" style="margin-top:10px">${esc(state.failed)}</div>` : ""}
    </div>
    ${state.phase === "context_review" ? renderContextReview(context) : ""}
    <div class="tabs">
      <a href="javascript:void 0" data-tab="overview" class="${runTab === "overview" ? "active" : ""}">Overview</a>
      <a href="javascript:void 0" data-tab="keywords" class="${runTab === "keywords" ? "active" : ""}">Keywords</a>
      <a href="javascript:void 0" data-tab="competitors" class="${runTab === "competitors" ? "active" : ""}">Competitors</a>
      <a href="javascript:void 0" data-tab="assembly" class="${runTab === "assembly" ? "active" : ""}">Assembly</a>
    </div>`;

  top.querySelector("#btn-report")?.addEventListener("click", () => exportRun(slug, "html"));
  top.querySelector("#btn-compare")?.addEventListener("click", () => {
    const prev = previousRunFor(slug, config, state.updatedAt);
    if (prev) location.hash = `#/compare/${encodeURIComponent(prev.runId)}/${encodeURIComponent(slug)}`;
  });
  top.querySelector("#btn-pause")?.addEventListener("click", () => control(slug, "pause"));
  top.querySelector("#btn-resume")?.addEventListener("click", () => control(slug, "resume"));
  top.querySelector("#btn-credit-topup")?.addEventListener("click", openTopup);
  top.querySelector("#btn-credit-resume")?.addEventListener("click", () => control(slug, "resume"));
  top.querySelector("#btn-stop")?.addEventListener("click", () => control(slug, "stopAndAssemble"));
  top.querySelector("#btn-reassemble")?.addEventListener("click", () => control(slug, "reassemble"));
  top.querySelectorAll(".tabs a").forEach((t) =>
    t.addEventListener("click", () => {
      runTab = t.dataset.tab; lastTopSig = "";
      renderRunTop(slug, lastRunData); renderTab(slug, lastRunData);
    }));
  bindContextReview(slug, context);
}

async function control(slug, action, payload) {
  try {
    await api(`/api/runs/${encodeURIComponent(slug)}/control`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(payload || {}) }),
    });
    setTimeout(render, 300);
  } catch (e) { toast(`✗ ${esc(e.message)}`, true); }
}

// ---------- Context step ----------

function renderContextReview(ctx) {
  if (!ctx) return "";
  const field = (name, label, value, multiline) => `
    <div><label>${label}</label>
    ${multiline ? `<textarea data-ctx="${name}">${esc(Array.isArray(value) ? value.join("\n") : value)}</textarea>`
      : `<input data-ctx="${name}" value="${esc(value)}">`}</div>`;
  return `
    <div class="panel" id="ctx-review">
      <h2>Context step: check that the LLM understood the product</h2>
      <p class="muted small">This is the only thing you confirm — everything after runs on its own.</p>
      <div class="grid2">
        ${field("productSummary", "Product in one paragraph", ctx.productSummary, true)}
        ${field("audience", "Audience", ctx.audience, true)}
        ${field("category", "Category", ctx.category)}
        ${field("targetLanguage", "Semantic language", ctx.targetLanguage)}
        ${field("jobsToBeDone", "Jobs to be done (one per line)", ctx.jobsToBeDone, true)}
        ${field("featureVocabulary", "Feature vocabulary (one per line)", ctx.featureVocabulary, true)}
        ${field("competitors", "Competitors (one per line)", ctx.competitors, true)}
        ${field("antiSemantics", "Anti-semantics: what the app is NOT", ctx.antiSemantics, true)}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="ctx-go">Looks right, go →</button>
        <button id="ctx-save">Save edits</button>
      </div>
    </div>`;
}
function bindContextReview(slug, ctx) {
  const box = document.getElementById("ctx-review");
  if (!box) return;
  const collect = () => {
    const patch = {};
    box.querySelectorAll("[data-ctx]").forEach((el) => {
      const name = el.dataset.ctx;
      const listFields = ["jobsToBeDone", "featureVocabulary", "competitors"];
      patch[name] = listFields.includes(name) ? el.value.split("\n").map((s) => s.trim()).filter(Boolean) : el.value;
    });
    return patch;
  };
  document.getElementById("ctx-save")?.addEventListener("click", async () => { await control(slug, "editContext", collect()); });
  document.getElementById("ctx-go")?.addEventListener("click", async () => {
    await api(`/api/runs/${encodeURIComponent(slug)}/control`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "editContext", ...collect() }),
    });
    await control(slug, "confirmContext");
  });
}

// ---------- tabs ----------

async function renderTab(slug, runData) {
  const body = document.getElementById("tab-body");
  if (!body || !runData) return;
  const active = document.activeElement;
  if (active && body.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
  // An open export menu would be snapped shut by the ~2s live refresh — wait it out.
  if (body.querySelector(".export-menu[open]")) return;
  const wrap0 = body.querySelector(".table-wrap");
  const scroll = wrap0 ? { left: wrap0.scrollLeft, top: wrap0.scrollTop } : null;
  const h = body.offsetHeight;
  if (h) body.style.minHeight = h + "px";
  try {
    if (runTab === "overview") await renderOverview(body, slug, runData);
    else if (runTab === "keywords") await renderKeywords(body, slug, runData);
    else if (runTab === "competitors") await renderCompetitors(body, slug, runData);
    else if (runTab === "assembly") renderAssembly(body, slug, runData);
  } finally {
    body.style.minHeight = "";
    if (scroll) { const w = body.querySelector(".table-wrap"); if (w) { w.scrollLeft = scroll.left; w.scrollTop = scroll.top; } }
  }
}

// Overview = run analytics (spec 09 §3). Everything below is drawn client-side from ONE
// keywords-lite query + the run snapshot: no chart libraries, hand-rolled inline SVG,
// brand palette only (blue = data, orange = highlight, red = zeroed/error).

async function renderOverview(body, slug, data) {
  const lite = await api(`/api/runs/${encodeURIComponent(slug)}/keywords-lite`);
  const items = lite.items || [];

  const scored = items.filter((i) => (i.score ?? 0) > 0).map((i) => i.score).sort((a, b) => b - a);
  const top20 = scored.slice(0, 20);
  const medianTop20 = top20.length ? top20[Math.floor(top20.length / 2)] : 0;
  const errors = items.filter((i) => i.status === "error").length;
  const cov = data.assembly?.coverage;
  const credits = data.creditsSpent ?? 0;

  const findings = {
    brand: items.filter((i) => i.brandQuery).length,
    phantom: items.filter((i) => i.unsuggested).length,
    degraded: items.filter((i) => i.degraded).length,
  };

  const feedHtml = `
    <div class="panel"><h2>Live feed</h2>
      <div class="feed feed-compact" id="feed">${data.events.map((e) => `<div><span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>${esc(e.kind)} ${esc(e.text)}</div>`).join("") || '<div class="muted">no events yet</div>'}</div>
    </div>`;

  const hasCharts = items.some((i) => i.P != null || i.D != null || (i.score ?? 0) > 0);

  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="value">${data.sampleCount}</div><div class="label">sample size</div></div>
      <div class="tile"><div class="value">${medianTop20}</div><div class="label">median Score, top 20</div></div>
      <div class="tile"><div class="value">${cov ? Math.round(cov.coveredShare * 100) + "%" : "—"}</div><div class="label">Score covered</div></div>
      <div class="tile"><div class="value">${credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div><div class="label">credits spent on this run</div></div>
      <div class="tile"><div class="value">${errors}</div><div class="label">errors</div></div>
    </div>
    ${findingsStrip(findings)}
    ${hasCharts ? `
      <div class="ov-grid">
        <div class="panel">
          <h2>Opportunity map</h2>
          ${svgScatter(items)}
          <p class="chart-caption">Each dot is a probed phrase: up-left = high demand, low difficulty. Orange = selected for metadata, red = Score zeroed. Click a dot to open it in the table.${findings.degraded ? ` ${findings.degraded} phrase${findings.degraded > 1 ? "s" : ""} measured without P — suggestions endpoint was down.` : ""}</p>
        </div>
        <div class="ov-side">
          <div class="panel">
            <h2>Pipeline funnel</h2>
            ${funnelChart(items)}
          </div>
          <div class="panel">
            <h2>R distribution</h2>
            ${rDistChart(items)}
            <p class="chart-caption">Relevance verdicts by the judge: 3 core · 2 adjacent · 1 tangent · 0 excluded.</p>
          </div>
        </div>
      </div>
      ${histogramChart(items)}
      ${sourcesChart(items)}
      ${timelineChart(items, data.state.createdAt, data.events)}
    ` : `
      <div class="panel"><p class="muted">Charts appear as keyphrases verify — the engine is still warming up.</p></div>
    `}
    ${feedHtml}`;

  // Findings cards → pre-filtered Keywords tab (spec 09 §4).
  body.querySelectorAll("[data-insight]").forEach((el) =>
    el.addEventListener("click", () => {
      kwQuery = { ...kwQuery, status: "", source: "", q: "", page: 0, insight: el.dataset.insight };
      runTab = "keywords"; lastTopSig = "";
      renderRunTop(slug, lastRunData); renderTab(slug, lastRunData);
    }));
  // Scatter dots → Keywords tab with the phrase prefilled.
  body.querySelector(".svg-scatter")?.addEventListener("click", (e) => {
    const dot = e.target.closest("[data-kw]");
    if (!dot) return;
    kwQuery = { ...kwQuery, status: "", source: "", insight: "", q: dot.dataset.kw, page: 0 };
    runTab = "keywords"; lastTopSig = "";
    renderRunTop(slug, lastRunData); renderTab(slug, lastRunData);
  });

  const feed = document.getElementById("feed");
  if (feed) feed.scrollTop = feed.scrollHeight;
}

// --- Findings strip (spec 09 §4): what the engine caught, first row of Overview ---

function findingsStrip(f) {
  const card = (insight, n, title, text) => `
    <div class="tile finding" data-insight="${insight}" role="button" tabindex="0" title="Show these keywords">
      <div class="value">${n}</div><div class="flabel">${title}</div>
      <div class="label">${text}</div>
    </div>`;
  return `<div class="tiles findings">
    ${card("brandQuery", f.brand, "dead-brand traps caught", "phrases that autocomplete as demand but are just names of weak apps — Score zeroed, evidence in the row")}
    ${card("unsuggested", f.phantom, "phantom phrases filtered", "never appeared in autocomplete at any prefix — no demand, no budget spent on them")}
    ${f.degraded ? card("degraded", f.degraded, "degraded probes disclosed", "measured while the suggestions endpoint was down — marked, never silently guessed") : ""}
  </div>`;
}

// --- P×D opportunity map (spec 09 §3 centerpiece) ---

function svgScatter(items) {
  const pts = items.filter((i) => i.P != null && i.D != null && !i.degraded);
  const W = 680, H = 380, pad = { l: 44, r: 14, t: 14, b: 40 };
  const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  const X = (d) => pad.l + (d / 100) * w;
  const Y = (p) => pad.t + (1 - p / 100) * h;
  const dots = pts.map((i) => {
    const zero = (i.score ?? 0) <= 0;
    const fill = zero ? "var(--red)" : i.status === "selected" ? "var(--orange)" : "var(--accent)";
    return `<circle data-kw="${esc(i.keyword)}" cx="${X(i.D).toFixed(1)}" cy="${Y(i.P).toFixed(1)}" r="3.2" fill="${fill}" fill-opacity="${zero ? 0.35 : 0.85}"><title>${esc(i.keyword)} — P ${i.P} · D ${i.D}${i.score != null ? ` · score ${i.score}` : ""}</title></circle>`;
  }).join("");
  return `<svg class="svg-chart svg-scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="Opportunity map: P versus D scatter of ${pts.length} phrases">
    <rect x="${pad.l}" y="${pad.t}" width="${w / 2}" height="${h / 2}" fill="var(--orange)" fill-opacity="0.07"/>
    <text x="${pad.l + 8}" y="${pad.t + 18}" font-size="12" font-weight="700" fill="var(--orange-deep)">gold</text>
    <rect x="${pad.l}" y="${pad.t}" width="${w}" height="${h}" fill="none" stroke="var(--border)" stroke-width="2"/>
    <line x1="${X(50)}" y1="${pad.t}" x2="${X(50)}" y2="${pad.t + h}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4" opacity="0.45"/>
    <line x1="${pad.l}" y1="${Y(50)}" x2="${pad.l + w}" y2="${Y(50)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4" opacity="0.45"/>
    ${dots}
    <text x="${pad.l + w / 2}" y="${H - 8}" font-size="11" fill="var(--muted)" text-anchor="middle">D — harder →</text>
    <text x="12" y="${pad.t + h / 2}" font-size="11" fill="var(--muted)" text-anchor="middle" transform="rotate(-90 12 ${pad.t + h / 2})">P — more demand ↑</text>
  </svg>`;
}

// --- horizontal bar row (shared by funnel / R dist / sources) ---

function barLine(label, n, max, cls) {
  const pct = max > 0 ? Math.max(n > 0 ? 2 : 0, (n / max) * 100) : 0;
  return `<div class="bar-line"><span class="lbl">${label}</span><div class="track"><div class="fill ${cls || ""}" style="width:${pct}%"></div></div><span class="n">${n}</span></div>`;
}

function funnelChart(items) {
  const inSet = (sts) => items.filter((i) => sts.includes(i.status)).length;
  const candidates = items.length;
  const verified = inSet(["verified", "rated", "selected", "bench"]);
  const rated = inSet(["rated", "selected", "bench"]);
  const selected = inSet(["selected"]);
  const excluded = inSet(["excluded"]);
  const errored = inSet(["error"]);
  return `
    ${barLine("candidates", candidates, candidates)}
    ${barLine("verified", verified, candidates)}
    ${barLine("rated", rated, candidates)}
    ${barLine("selected", selected, candidates)}
    ${excluded ? barLine("excluded", excluded, candidates, "red") : ""}
    ${errored ? barLine("error", errored, candidates, "mutedfill") : ""}`;
}

function rDistChart(items) {
  const withR = items.filter((i) => i.R != null);
  const count = (r) => withR.filter((i) => i.R === r).length;
  const counts = [3, 2, 1, 0].map(count);
  const max = Math.max(1, ...counts);
  const cls = { 3: "", 2: "", 1: "mutedfill", 0: "red" };
  return [3, 2, 1, 0].map((r, idx) => barLine(`R = ${r}`, counts[idx], max, cls[r])).join("");
}

// --- Score histogram with median marker ---

function histogramChart(items) {
  const buckets = new Array(10).fill(0);
  const scores = [];
  for (const i of items) {
    if (i.score == null || i.score <= 0) continue;
    buckets[Math.min(9, Math.floor(i.score / 10))]++;
    scores.push(i.score);
  }
  if (!scores.length) return "";
  scores.sort((a, b) => a - b);
  const med = scores[Math.floor(scores.length / 2)];
  const maxB = Math.max(1, ...buckets);
  return `
    <div class="panel"><h2>Score distribution (${scores.length} keywords with Score &gt; 0)</h2>
      <div class="hist-wrap">
        <div class="hist">${buckets.map((b) => `<div class="bar" style="height:${(b / maxB) * 100}%"><span>${b || ""}</span></div>`).join("")}</div>
        <div class="hist-median" style="left:${Math.min(99, med)}%"><span>median ${med}</span></div>
      </div>
      <div class="hist-labels">${buckets.map((_, i) => `<div>${i * 10}–${i * 10 + 9}</div>`).join("")}</div>
    </div>`;
}

// --- Sources × outcome: which discovery strategy earns its keep ---

function sourcesChart(items) {
  const sources = ["seed", "suggest", "competitor", "expansion"];
  const rows = sources.map((s) => {
    const of = items.filter((i) => i.source === s);
    const scored = of.filter((i) => (i.score ?? 0) > 0);
    const avg = scored.length ? Math.round(scored.reduce((sum, i) => sum + i.score, 0) / scored.length) : 0;
    return { s, total: of.length, avg };
  }).filter((r) => r.total > 0);
  if (!rows.length) return "";
  const maxTotal = Math.max(...rows.map((r) => r.total));
  return `
    <div class="panel"><h2>Where keywords come from — and what they're worth</h2>
      ${rows.map((r) => `
        <div class="src-row">
          <span class="lbl">${r.s}</span>
          <div class="src-bars">
            ${barLine("found", r.total, maxTotal)}
            ${barLine("avg score", r.avg, 100, "orangefill")}
          </div>
        </div>`).join("")}
      <p class="chart-caption">"found" = phrases contributed by the source; "avg score" = their mean Score (0–100) once verified.</p>
    </div>`;
}

// --- Verification timeline: cumulative verified keyphrases over wall-clock ---

function timelineChart(items, createdAt, events) {
  const times = items.filter((i) => i.probedAt).map((i) => Date.parse(i.probedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 2) return "";
  const t0 = Math.min(Date.parse(createdAt) || times[0], times[0]);
  const t1 = times[times.length - 1];
  if (t1 <= t0) return "";
  const W = 680, H = 150, pad = { l: 40, r: 12, t: 10, b: 24 };
  const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * w;
  const Y = (n) => pad.t + (1 - n / times.length) * h;
  const pts = [`${X(t0).toFixed(1)},${Y(0).toFixed(1)}`];
  times.forEach((t, i) => pts.push(`${X(t).toFixed(1)},${Y(i + 1).toFixed(1)}`));
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Paused stretches from the event feed (spec 09 §3): yellow-soft bands, pause → resume.
  const PAUSE = new Set(["⏸", "💳", "⛔"]), RESUME = new Set(["▶"]);
  const bands = [];
  let open = null;
  for (const e of events || []) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (PAUSE.has(e.kind) && open == null) open = t;
    else if (RESUME.has(e.kind) && open != null) { bands.push([open, t]); open = null; }
  }
  if (open != null) bands.push([open, t1]);
  const bandRects = bands
    .map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)])
    .filter(([a, b]) => b > a)
    .map(([a, b]) => `<rect x="${X(a).toFixed(1)}" y="${pad.t}" width="${Math.max(2, X(b) - X(a)).toFixed(1)}" height="${h}" fill="#FFE9A8" fill-opacity="0.75"><title>paused ${fmt(a)}–${fmt(b)}</title></rect>`)
    .join("");

  return `
    <div class="panel"><h2>Verification pace</h2>
      <svg class="svg-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative verified keyphrases over time">
        ${bandRects}
        <rect x="${pad.l}" y="${pad.t}" width="${w}" height="${h}" fill="none" stroke="var(--border)" stroke-width="2"/>
        <polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
        <text x="${pad.l}" y="${H - 6}" font-size="11" fill="var(--muted)">${fmt(t0)}</text>
        <text x="${pad.l + w}" y="${H - 6}" font-size="11" fill="var(--muted)" text-anchor="end">${fmt(t1)}</text>
        <text x="${pad.l - 6}" y="${pad.t + 10}" font-size="11" fill="var(--muted)" text-anchor="end">${times.length}</text>
        <text x="${pad.l - 6}" y="${pad.t + h}" font-size="11" fill="var(--muted)" text-anchor="end">0</text>
      </svg>
      <p class="chart-caption">Cumulative probed phrases over the run's wall-clock.${bands.length ? " Yellow bands = paused stretches." : ""}</p>
    </div>`;
}

// --- Keywords ---

async function renderKeywords(body, slug, runData) {
  await loadAnnotations(slug);
  const params = new URLSearchParams({ sort: kwQuery.sort, dir: kwQuery.dir, page: String(kwQuery.page) });
  if (kwQuery.q) params.set("q", kwQuery.q);
  if (kwQuery.status) params.set("status", kwQuery.status);
  if (kwQuery.source) params.set("source", kwQuery.source);
  if (kwQuery.insight) params.set("insight", kwQuery.insight);
  const kw = await api(`/api/runs/${encodeURIComponent(slug)}/keywords?${params}`);

  const scoreClass = (s) => s == null ? "" : s >= 50 ? "score-hi" : s >= 25 ? "score-mid" : s >= 1 ? "score-low" : "score-zero";
  const sortArrow = (col) => kwQuery.sort === col ? (kwQuery.dir === "desc" ? " ↓" : " ↑") : "";
  const th = (col, label, num) => `<th data-sort="${col}" class="${num ? "num" : ""}">${label}${sortArrow(col)}</th>`;
  const canExport = (runData?.sampleCount ?? 0) > 0;
  const insights = [["", "all insights"], ["pinned", "★ pinned"], ["brandQuery", "brand traps"], ["unsuggested", "phantom"], ["degraded", "degraded"]];

  body.innerHTML = `
    <div class="panel">
      <div class="row">
        <input id="kw-q" placeholder="filter by text" style="max-width:220px" value="${esc(kwQuery.q)}">
        <select id="kw-status" style="max-width:160px"><option value="">all statuses</option>${["candidate", "verified", "rated", "selected", "bench", "excluded", "error"].map((s) => `<option ${kwQuery.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <select id="kw-source" style="max-width:150px"><option value="">all sources</option>${["seed", "suggest", "competitor", "expansion"].map((s) => `<option ${kwQuery.source === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <select id="kw-insight" style="max-width:150px">${insights.map(([v, l]) => `<option value="${v}" ${kwQuery.insight === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="muted small">${kw.total} keywords</span>
        <span style="flex:1"></span>
        ${canExport ? `
        <details class="export-menu" id="export-menu">
          <summary>⬇ Export</summary>
          <div class="export-items">
            <button data-fmt="csv">keywords.csv <span class="muted small">spreadsheet</span></button>
            <button data-fmt="md">report.md <span class="muted small">summary</span></button>
            <button data-fmt="json">run.json <span class="muted small">full data</span></button>
            <button data-fmt="html">report.html <span class="muted small">shareable</span></button>
          </div>
        </details>` : `<button disabled title="Exports appear once keyphrases verify">⬇ Export</button>`}
      </div>
      <div class="table-wrap">
      <table>
        <thead><tr>
          <th title="Pin to your shortlist (stays on this Mac)">★</th>
          ${th("keyword", "Keyword")}${th("score", "Score", true)}${th("P", "P", true)}${th("D", "D", true)}${th("R", "R", true)}
          ${th("status", "Status")}<th>Source</th>${th("childCount", "Children", true)}<th>R reason</th>
        </tr></thead>
        <tbody>
          ${kw.items.map((k) => `
            <tr class="expandable" data-kw="${esc(k.keyword)}">
              <td class="pin-cell"><button class="pin-btn ${isPinned(k.keyword) ? "on" : ""}" data-pin="${esc(k.keyword)}" title="${isPinned(k.keyword) ? "Unpin" : "Pin to shortlist"}">${isPinned(k.keyword) ? "★" : "☆"}</button></td>
              <td class="mono">${esc(k.keyword)}${k.speculative ? ' <span class="badge violet">spec</span>' : ""}${k.degraded ? ' <span class="badge yellow">degraded</span>' : ""}${k.metrics.brandQuery ? ' <span class="badge red">brand</span>' : ""}${runAnnotations[k.keyword]?.note ? ' <span class="badge orange" title="has a note">✎</span>' : ""}</td>
              <td class="num ${scoreClass(k.metrics.score)}">${k.metrics.score ?? ""}</td>
              <td class="num">${k.degraded ? "—" : (k.metrics.P ?? "")}</td>
              <td class="num">${k.metrics.D ?? ""}</td>
              <td class="num">${k.metrics.R ?? ""}</td>
              <td><span class="badge ${k.status === "excluded" || k.status === "error" ? "red" : k.status === "selected" ? "green" : "gray"}">${k.status}</span></td>
              <td><span class="badge gray">${esc(k.source)}</span>${k.strategy ? ` <span class="muted small">${k.strategy}</span>` : ""}</td>
              <td class="num">${k.metrics.childCount || ""}</td>
              <td title="${esc(k.metrics.reason ?? "")}" class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.metrics.reason ?? "")}</td>
            </tr>
            ${expandedKeyword === k.keyword ? `<tr class="detail"><td colspan="10" id="kw-detail">${kwDetailCache.kw === k.keyword ? kwDetailCache.html : "Loading…"}</td></tr>` : ""}
          `).join("")}
        </tbody>
      </table>
      </div>
      <div class="row" style="margin-top:10px">
        ${kw.page > 0 ? `<button id="kw-prev">← Back</button>` : ""}
        <span class="muted small">page ${kw.page + 1} of ${Math.max(1, Math.ceil(kw.total / kw.pageSize))}</span>
        ${(kw.page + 1) * kw.pageSize < kw.total ? `<button id="kw-next">Next →</button>` : ""}
      </div>
    </div>`;

  body.querySelectorAll("th[data-sort]").forEach((el) =>
    el.addEventListener("click", () => {
      const col = el.dataset.sort;
      if (kwQuery.sort === col) kwQuery.dir = kwQuery.dir === "desc" ? "asc" : "desc";
      else { kwQuery.sort = col; kwQuery.dir = "desc"; }
      kwQuery.page = 0; renderKeywords(body, slug, runData);
    }));
  body.querySelector("#kw-q").addEventListener("change", (e) => { kwQuery.q = e.target.value; kwQuery.page = 0; renderKeywords(body, slug, runData); });
  body.querySelector("#kw-status").addEventListener("change", (e) => { kwQuery.status = e.target.value; kwQuery.page = 0; renderKeywords(body, slug, runData); });
  body.querySelector("#kw-source").addEventListener("change", (e) => { kwQuery.source = e.target.value; kwQuery.page = 0; renderKeywords(body, slug, runData); });
  body.querySelector("#kw-insight").addEventListener("change", (e) => { kwQuery.insight = e.target.value; kwQuery.page = 0; renderKeywords(body, slug, runData); });
  body.querySelector("#kw-prev")?.addEventListener("click", () => { kwQuery.page--; renderKeywords(body, slug, runData); });
  body.querySelector("#kw-next")?.addEventListener("click", () => { kwQuery.page++; renderKeywords(body, slug, runData); });
  body.querySelectorAll(".export-items button").forEach((b) =>
    b.addEventListener("click", () => {
      body.querySelector("#export-menu")?.removeAttribute("open");
      exportRun(slug, b.dataset.fmt);
    }));
  body.querySelectorAll(".pin-btn").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const keyword = b.dataset.pin;
      try {
        await saveAnnotation(slug, keyword, { pinned: !isPinned(keyword) });
        renderKeywords(body, slug, runData);
      } catch (err) { toast(`✗ ${esc(err.message)}`, true); }
    }));
  body.querySelectorAll("tr.expandable").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".pin-btn")) return;
      expandedKeyword = expandedKeyword === tr.dataset.kw ? null : tr.dataset.kw;
      renderKeywords(body, slug, runData);
    }));

  if (expandedKeyword) {
    const cell = document.getElementById("kw-detail");
    if (cell) {
      const keyword = expandedKeyword;
      const bindDetail = () => {
        cell.querySelector(".btn-exclude")?.addEventListener("click", async () => {
          if (await uiConfirm(`Exclude "${keyword}" from the run?`)) await control(slug, "exclude", { keyword });
        });
        // Note autosave on blur (spec 09 §7) — local file only, no cloud traffic.
        const noteEl = cell.querySelector("#kw-note");
        noteEl?.addEventListener("blur", async () => {
          const state = cell.querySelector("#kw-note-state");
          try {
            await saveAnnotation(slug, keyword, { note: noteEl.value });
            if (state) state.textContent = "saved ✓";
          } catch (err) { if (state) state.textContent = `not saved: ${err.message}`; }
        });
        noteEl?.addEventListener("click", (e) => e.stopPropagation());
      };
      if (kwDetailCache.kw === keyword) bindDetail(); // cached render is already in the cell
      try {
        const { item } = await api(`/api/runs/${encodeURIComponent(slug)}/keywords/${encodeURIComponent(keyword)}`);
        if (!item) { cell.textContent = "keyword not found"; return; }
        kwDetailCache = { kw: item.keyword, html: renderKeywordDetail(item, slug) };
        cell.innerHTML = kwDetailCache.html;
        bindDetail();
      } catch (e) { if (kwDetailCache.kw !== keyword) cell.textContent = e.message; }
    }
  }
}

// The NUMBERS transparency showcase (D9): P explained from raw data, R reason.
function renderKeywordDetail(k, slug) {
  const m = k.metrics;
  let pExplain;
  if (k.degraded) pExplain = "P unavailable: the suggestions endpoint was not responding — Score computed with neutral P=50.";
  else if (m.unsuggested) pExplain = `P=0: the phrase never appeared in autocomplete at any prefix — demand not confirmed.`;
  else if (m.brandQuery) pExplain = `P=${m.P} — inflated: the phrase matches the name of an unpopular app; there is no real demand, Score zeroed.`;
  else pExplain = `P=${m.P} because the phrase appeared in suggestions at prefix "${esc(k.keyword.slice(0, m.L))}" (${m.L} of ${k.keyword.length} characters) at rank ${m.rank}.`;
  return `
    <div class="row spread"><h3>${esc(k.keyword)}</h3><button class="danger btn-exclude">⛔ Exclude</button></div>
    <p>${pExplain}${m.childCount ? ` Spawns ${m.childCount} children — long-tail potential.` : ""}</p>
    ${m.R !== null && m.R !== undefined ? `<p><b>R=${m.R}</b>: ${esc(m.reason ?? "")}</p>` : ""}
    ${m.topApps?.length ? `
      <h3>Top ${m.topApps.length} search results (serpSize=${m.serpSize}) → D=${m.D}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">#</th><th>App</th><th class="num">Ratings</th><th class="num">Rating</th><th>Updated</th><th>Match</th><th>AppStrength</th></tr></thead>
        <tbody>${m.topApps.map((a, i) => `
          <tr><td class="num">${i + 1}</td><td>${esc(a.trackName)}</td>
          <td class="num">${(a.ratingCount || 0).toLocaleString()}</td><td class="num">${(a.rating || 0).toFixed(1)}</td>
          <td>${a.updatedDaysAgo}d ago</td>
          <td>${a.match === 1 ? "exact" : a.match === 0.5 ? "all words" : "none"}</td>
          <td><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="progress" style="width:120px;flex:none"><div style="width:${a.strength}%"></div></div><span class="num">${a.strength}</span></div></td></tr>`).join("")}
        </tbody></table></div>` : ""}
    ${k.error ? `<p class="check-fail">Error: ${esc(k.error)}</p>` : ""}
    <div class="note-box">
      <label for="kw-note">Your note <span class="muted small">(private — stays on this computer)</span></label>
      <textarea id="kw-note" maxlength="500" placeholder="e.g. try in the next title iteration…">${esc(runAnnotations[k.keyword]?.note ?? "")}</textarea>
      <span class="muted small" id="kw-note-state">autosaves when you click away</span>
    </div>
    <p class="muted small">status: ${k.status} · source: ${k.source}${k.type ? ` · type: ${k.type}` : ""} · added: ${new Date(k.addedAt).toLocaleString()}${k.probedAt ? ` · probed: ${new Date(k.probedAt).toLocaleString()}` : ""}</p>`;
}

// --- Competitors (spec 09 §2): the run's SERP top-10 landscape, aggregated server-side ---

async function renderCompetitors(body, slug, runData) {
  const comp = await api(`/api/runs/${encodeURIComponent(slug)}/competitors`);
  const items = comp.items || [];
  const s = comp.summary || { distinctApps: 0, medianStrength: null, openDoors: 0, keywordsWithSerp: 0 };

  if (!items.length) {
    body.innerHTML = `<div class="panel"><h2>Competitors</h2>
      <p class="muted">The landscape appears once keywords get their search-results check (D). Nothing measured yet.</p></div>`;
    return;
  }

  const compKey = (c) => `${c.trackId ?? ""}:${c.trackName}`;
  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="value">${s.distinctApps}</div><div class="label">distinct apps seen in top-10s</div></div>
      <div class="tile"><div class="value">${s.medianStrength ?? "—"}</div><div class="label">median top-10 strength — how hard this niche is</div></div>
      <div class="tile"><div class="value">${s.openDoors}</div><div class="label">open doors — top-10 slots held by weak apps (&lt;40)</div></div>
    </div>
    <div class="panel">
      <div class="row spread"><h2>Who you're up against</h2><span class="muted small">across ${s.keywordsWithSerp} measured keywords</span></div>
      <p class="chart-caption" style="margin:0 0 10px">Apps competing in the top-10s of this run's keyword sample — your niche as measured, not a market-share study.</p>
      <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="num">#</th><th>App</th><th>Overlap</th><th class="num">Avg pos</th><th>Avg strength</th><th>Where it's strong</th><th class="num">Weak spots</th>
        </tr></thead>
        <tbody>
          ${items.map((c, i) => `
            <tr class="expandable" data-comp="${esc(compKey(c))}">
              <td class="num">${i + 1}</td>
              <td><b>${esc(c.trackName)}</b></td>
              <td>
                <div class="row" style="gap:8px;flex-wrap:nowrap">
                  <div class="progress" style="width:90px;flex:none"><div style="width:${Math.round(c.share * 100)}%"></div></div>
                  <span class="small muted">${c.keywords} kw · ${Math.round(c.share * 100)}%</span>
                </div>
              </td>
              <td class="num">${c.avgPosition}</td>
              <td>
                <div class="row" style="gap:8px;flex-wrap:nowrap">
                  <div class="progress" style="width:90px;flex:none"><div style="width:${c.avgStrength}%"></div></div>
                  <span class="num">${c.avgStrength}</span>
                </div>
              </td>
              <td>${c.bestKeywords.length ? c.bestKeywords.map((k) => `<span class="badge gray">${esc(k)}</span>`).join(" ") : '<span class="muted small">—</span>'}</td>
              <td class="num">${c.weakSpots ? `<span class="badge orange">${c.weakSpots}</span>` : '<span class="muted">0</span>'}</td>
            </tr>
            ${expandedCompetitor === compKey(c) ? `
            <tr class="detail"><td colspan="7">
              <h3>${esc(c.trackName)} — shared keywords</h3>
              <div class="table-wrap"><table>
                <thead><tr><th>Keyword</th><th class="num">Their position</th><th class="num">Their strength</th><th class="num">Keyword score</th></tr></thead>
                <tbody>${c.appearances.map((a) => `
                  <tr><td class="mono">${esc(a.keyword)}</td><td class="num">#${a.position}</td><td class="num">${a.strength}</td><td class="num">${a.score ?? ""}</td></tr>`).join("")}
                </tbody></table></div>
            </td></tr>` : ""}
          `).join("")}
        </tbody>
      </table>
      </div>
    </div>`;

  body.querySelectorAll("tr.expandable[data-comp]").forEach((tr) =>
    tr.addEventListener("click", () => {
      expandedCompetitor = expandedCompetitor === tr.dataset.comp ? null : tr.dataset.comp;
      renderCompetitors(body, slug, runData);
    }));
}

// ============================================================
// Screen: run diff (spec 09 §5) — pure client-side join of two keywords-lite lists
// ============================================================

async function viewCompare(aId, bId) {
  currentSlug = null;
  app.innerHTML = `<div class="loading">Comparing…</div>`;
  const [snapA, snapB, liteA, liteB] = await Promise.all([
    api(`/api/runs/${encodeURIComponent(aId)}`),
    api(`/api/runs/${encodeURIComponent(bId)}`),
    api(`/api/runs/${encodeURIComponent(aId)}/keywords-lite`),
    api(`/api/runs/${encodeURIComponent(bId)}/keywords-lite`),
  ]);
  if (!snapA || !snapB) {
    app.innerHTML = `<div class="banner error">One of the runs was not found. <a href="#/runs">Back to runs</a></div>`;
    return;
  }
  const cfgA = snapA.config, cfgB = snapB.config;
  if (cfgA.country !== cfgB.country || cfgA.semanticLanguage !== cfgB.semanticLanguage) {
    app.innerHTML = `
      <div class="row spread"><h1>Compare runs</h1><a href="#/runs">← Runs</a></div>
      <div class="banner error">These runs use different storefronts or semantic languages (${esc(cfgA.country)}/${esc(cfgA.semanticLanguage)} vs ${esc(cfgB.country)}/${esc(cfgB.semanticLanguage)}) — apples to apples only.</div>`;
    return;
  }

  const mapA = new Map(liteA.items.map((i) => [i.keyword, i]));
  const mapB = new Map(liteB.items.map((i) => [i.keyword, i]));
  const movers = [];
  const lost = [];
  for (const [kw, a] of mapA) {
    const b = mapB.get(kw);
    if (b) movers.push({ kw, a, b, delta: (b.score ?? 0) - (a.score ?? 0) });
    else lost.push(a);
  }
  const gained = liteB.items.filter((i) => !mapA.has(i.keyword));
  movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const medTop20 = (lite) => {
    const s = lite.items.map((i) => i.score ?? 0).filter((v) => v > 0).sort((a, b) => b - a).slice(0, 20);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const dMed = medTop20(liteB) - medTop20(liteA);
  const dCredits = (snapB.creditsSpent ?? 0) - (snapA.creditsSpent ?? 0);
  const when = (snap) => new Date(snap.state.updatedAt).toLocaleDateString();
  const deltaChip = (d, digits) => {
    const v = digits ? d.toFixed(digits) : d;
    return d > 0 ? `<span class="delta up">+${v}</span>` : d < 0 ? `<span class="delta down">${v}</span>` : `<span class="delta zero">0</span>`;
  };
  const pdr = (i) => `<span class="muted small">P ${i.P ?? "—"} · D ${i.D ?? "—"} · R ${i.R ?? "—"}${(i.score ?? 0) > 0 ? ` · score ${i.score}` : ""}</span>`;
  const kwList = (arr) => arr.length
    ? `<div class="cmp-list">${arr.sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, 100).map((i) => `<div><span class="mono">${esc(i.keyword)}</span> ${pdr(i)}</div>`).join("")}${arr.length > 100 ? `<div class="muted small">…and ${arr.length - 100} more</div>` : ""}</div>`
    : `<p class="muted small">none</p>`;

  app.innerHTML = `
    <div class="row spread">
      <h1 style="margin-bottom:0">${esc(cfgB.brand)} · ${esc((cfgB.country || "").toUpperCase())} — run diff</h1>
      <a href="#/runs">← Runs</a>
    </div>
    <p class="muted small" style="margin:4px 0 16px">
      <a href="#/run/${encodeURIComponent(aId)}" class="mono">${esc(aId.slice(0, 12))}…</a> (${when(snapA)})
      →
      <a href="#/run/${encodeURIComponent(bId)}" class="mono">${esc(bId.slice(0, 12))}…</a> (${when(snapB)})
      — the store's suggest graph moved between these runs; that movement IS the market signal.
    </p>
    <div class="tiles">
      <div class="tile"><div class="value">${dMed > 0 ? "+" : ""}${dMed}</div><div class="label">Δ median Score, top 20</div></div>
      <div class="tile"><div class="value">${gained.length}</div><div class="label">keywords gained (new in the later run)</div></div>
      <div class="tile"><div class="value">${lost.length}</div><div class="label">keywords lost (gone from the suggest graph)</div></div>
      <div class="tile"><div class="value">${dCredits > 0 ? "+" : ""}${dCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div><div class="label">Δ credits spent</div></div>
    </div>
    <div class="panel">
      <h2>Movers — same keyword, new Score</h2>
      ${movers.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Keyword</th><th class="num">Score, old</th><th class="num">Score, new</th><th class="num">Δ</th></tr></thead>
        <tbody>${movers.slice(0, 50).map((m) => `
          <tr><td class="mono">${esc(m.kw)}</td>
          <td class="num">${m.a.score ?? 0}</td><td class="num">${m.b.score ?? 0}</td>
          <td class="num">${deltaChip(m.delta)}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No keywords are present in both runs.</p>`}
    </div>
    <div class="ov-grid">
      <div class="panel"><h2>Appeared (${gained.length})</h2>${kwList(gained)}</div>
      <div class="panel"><h2>Disappeared (${lost.length})</h2>${kwList(lost)}</div>
    </div>`;
}

// --- Assembly ---

function renderAssembly(body, slug, data) {
  const asm = data.assembly;
  if (!asm) {
    body.innerHTML = `<div class="panel"><p class="muted">Assembly becomes available at the assembling phase. To get there sooner: Stop &amp; assemble is available once the sample is ≥ 30.</p></div>`;
    return;
  }
  const done = data.state.phase === "done";
  const highlight = (text, words) => {
    if (!words || !words.length) return esc(text);
    let html = esc(text);
    for (const w of words) html = html.replace(new RegExp(`(^|[^\\p{L}])(${escapeRe(esc(w))})($|[^\\p{L}])`, "giu"), `$1<span class="word-chip" style="background:var(--accent-soft)">$2</span>$3`);
    return html;
  };
  const fieldRow = (label, value, max, contribWords) => {
    const len = (value ?? "").length;
    return `<div class="meta-field"><label>${label}</label>
      <div class="value"><span>${highlight(value ?? "", contribWords)}</span>
        <span class="char-count ${len > max ? "over" : ""}">${len}/${max}</span>
        ${done ? `<button class="copy-btn" data-copy="${esc(value ?? "")}">⧉</button>` : ""}
      </div></div>`;
  };
  body.innerHTML = `
    ${asm.buckets.map((b, i) => `
      <div class="panel">
        <div class="row spread"><h2>${i === 0 ? "Primary localization" : "Cross-localization"} (${esc(b.locale)})</h2></div>
        ${fieldRow("Title", b.title, 30, b.titleWords)}
        ${fieldRow("Subtitle", b.subtitle, 30, b.subtitleWords)}
        ${fieldRow("Keywords", b.keywordFieldDraft, 100, b.speculativeWords)}
        ${b.speculativeWords.length ? `<p class="small"><span class="badge violet">spec</span> speculative fill: ${b.speculativeWords.map(esc).join(", ")}</p>` : ""}
        <div class="checklist small">${renderChecklist(b.violations)}</div>
      </div>`).join("")}
    <div class="panel">
      <h2>Coverage: top phrases by Score</h2>
      <p class="small muted">Phrases covered: ${asm.coverage.phrasesCovered} · Score ${asm.coverage.scoreCovered}/${asm.coverage.scoreTotal} (${Math.round(asm.coverage.coveredShare * 100)}%)</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Phrase</th><th class="num">Score</th><th>Covered</th><th>Bucket</th><th>Fields</th><th class="num">PlacementWeight</th></tr></thead>
        <tbody>${asm.coverage.rows.map((r) => `
          <tr><td class="mono">${esc(r.keyword)}</td><td class="num">${r.score}</td>
          <td>${r.covered ? '<span class="check-ok">✓</span>' : '<span class="check-fail">✗</span>'}</td>
          <td>${r.bucket === null ? "—" : r.bucket === 0 ? "primary" : "cross"}</td>
          <td>${r.fields.map((f) => `<span class="badge gray">${f}</span>`).join(" ")}</td>
          <td class="num">${r.placementWeight || "—"}</td></tr>`).join("")}
        </tbody></table></div>
    </div>
    ${asm.topUncovered.length ? `
    <div class="panel"><h2>Top uncovered</h2>
      ${asm.topUncovered.map((u) => `<div class="small">${esc(u.keyword)} <span class="muted">(Score ${u.score}; missing: ${u.missingWords.map(esc).join(", ")})</span></div>`).join("")}
    </div>` : ""}`;
  body.querySelectorAll(".copy-btn").forEach((b) =>
    b.addEventListener("click", () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent = "✓"; setTimeout(() => (b.textContent = "⧉"), 1200); }));
}

function renderChecklist(violations) {
  const codes = ["T1", "T2", "S1", "K1", "X1", "X2", "X3", "X4", "W1"];
  const failed = new Map();
  for (const v of violations) { if (!failed.has(v.code)) failed.set(v.code, []); failed.get(v.code).push(v); }
  return codes.map((c) => {
    const items = failed.get(c);
    if (!items) return `<div class="check-ok">✓ ${c}</div>`;
    const cls = items[0].level === "warning" ? "check-warn" : "check-fail";
    const mark = items[0].level === "warning" ? "⚠" : "✗";
    return items.map((v) => `<div class="${cls}">${mark} ${v.code}: ${esc(v.message)}</div>`).join("");
  }).join("");
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------- start ----------

startLive();
boot();
