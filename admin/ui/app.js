"use strict";
/**
 * ASOptimus Admin SPA — single-file vanilla JS application (no frameworks, no libs).
 *
 * Architecture, top to bottom:
 *   1. state    — one closure-scoped object: auth token, mock flag, in-memory fixtures
 *                 copy, live-screen poll timer, transient UI prefills, open modal handle.
 *   2. utils    — esc() HTML escaping (EVERY interpolated server/user string goes through
 *                 it), date/money/credit/token formatters, short-id renderer, debounce.
 *   3. api      — api(path, opts): live mode fetches /admin/api/* with the bearer token;
 *                 mock mode (?mock=1) loads ./fixtures.json once and serves every
 *                 endpoint — including mutations, which edit the in-memory copy — with
 *                 zero network traffic. Any 401 while authed wipes the token → login.
 *   4. widgets  — toast, modal (confirm + form, Enter submits / Escape closes), error
 *                 banner with Retry, pager, badges, hand-rolled SVG finance chart.
 *   5. router   — hash routing (#/overview … #/live); clears the Live poll interval on
 *                 every navigation; all screens are behind auth.
 *   6. screens  — one render function per screen: login, overview, users, user detail,
 *                 runs, run detail, waitlist, finance, live.
 * Nothing leaks outside this IIFE.
 */
(function () {

  /* ============================== 1. state ============================== */

  const TOKEN_KEY = "aso_admin_token";
  const PHASES = ["created", "context", "context_review", "seeding", "loop",
                  "improving", "assembling", "done"];

  const state = {
    token: "",
    authed: false,
    mock: false,
    fx: null,               // in-memory fixtures copy (mock mode)
    fxPromise: null,
    liveTimer: null,
    modal: null,
    userSearchPrefill: "",  // set when following a "user" link from a run
  };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  /* ============================== 2. utils ============================== */

  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const pad2 = n => String(n).padStart(2, "0");

  function fmtDate(iso) {              // → "YYYY-MM-DD HH:MM" local, or "—"
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
           `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function credits(n) {                // up to 2 decimals, no unit
    if (n == null || isNaN(n)) return "—";
    return String(Math.round(Number(n) * 100) / 100);
  }

  function signCredits(n) {
    return (n > 0 ? "+" : "") + credits(n);
  }

  function money(n) {                  // $ prefix, always 2 decimals
    if (n == null || isNaN(n)) return "—";
    const v = Math.round(Number(n) * 100) / 100;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
  }

  function fmtInt(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function monoShort(id) {             // long ids: 10 chars + … with full value in title
    if (id == null || id === "") return "<span class=\"muted\">—</span>";
    const s = String(id);
    const short = s.length > 10 ? s.slice(0, 10) + "…" : s;
    return `<span class="mono" title="${esc(s)}">${esc(short)}</span>`;
  }

  function dash(v) { return (v == null || v === "") ? "—" : esc(v); }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  const round2 = n => Math.round(n * 100) / 100;

  const SVG_LOCK =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';
  const SVG_REFRESH =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>';

  /* ============================== 3. api ============================== */

  function api(path, opts) {
    return state.mock ? mockApi(path, opts || {}) : liveApi(path, opts || {});
  }

  async function liveApi(path, opts) {
    const token = opts.token !== undefined ? opts.token : state.token;
    let res;
    try {
      res = await fetch("/admin/api" + path, {
        method: opts.method || "GET",
        headers: Object.assign(
          { "Authorization": "Bearer " + token },
          opts.body ? { "Content-Type": "application/json" } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, "network error — " + (e && e.message ? e.message : e));
    }
    if (res.status === 401) {
      if (opts.token === undefined && state.authed) forceLogout();
      throw new ApiError(401, "unauthorized");
    }
    if (!res.ok) {
      let msg = res.status === 404 ? "admin API disabled" : "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) { /* keep default message */ }
      throw new ApiError(res.status, msg);
    }
    return res.json();
  }

  /* ---- mock mode: everything below serves from the fixtures copy ---- */

  function loadFixtures() {
    if (!state.fxPromise) {
      state.fxPromise = fetch("./fixtures.json").then(r => {
        if (!r.ok) throw new ApiError(r.status, "failed to load fixtures.json (HTTP " + r.status + ")");
        return r.json();
      }).then(j => { state.fx = j; });
    }
    return state.fxPromise;
  }

  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

  function wlCounts(items) {
    let pending = 0, invited = 0, signedUp = 0;
    items.forEach(w => {
      if (w.signedUpAt) signedUp++;
      else if (w.invitedAt) invited++;
      else pending++;
    });
    return { pending, invited, signedUp };
  }

  function paginate(items, q, defSize) {
    const page = Math.max(0, parseInt(q.get("page") || "0", 10) || 0);
    const pageSize = Math.max(1, parseInt(q.get("pageSize") || String(defSize), 10) || defSize);
    return { total: items.length, page, pageSize,
             items: items.slice(page * pageSize, (page + 1) * pageSize) };
  }

  const deep = x => JSON.parse(JSON.stringify(x));

  async function mockApi(path, opts) {
    await loadFixtures();
    const token = opts.token !== undefined ? opts.token : state.token;
    if (token !== "mock") {
      if (opts.token === undefined && state.authed) forceLogout();
      throw new ApiError(401, "unauthorized");
    }
    const method = opts.method || "GET";
    const body = opts.body || {};
    const F = state.fx;
    const qIdx = path.indexOf("?");
    const q = new URLSearchParams(qIdx >= 0 ? path.slice(qIdx + 1) : "");
    const seg = (qIdx >= 0 ? path.slice(0, qIdx) : path).split("/").filter(Boolean);
    const now = () => new Date().toISOString();

    /* --- misc --- */
    if (seg[0] === "me") return { ok: true };
    if (seg[0] === "beta") return deep(F.beta);

    /* --- overview (waitlist counts kept in sync with mutations) --- */
    if (seg[0] === "overview") {
      const o = deep(F.overview);
      o.waitlist = wlCounts(F.waitlist.items);
      return o;
    }

    /* --- users --- */
    if (seg[0] === "users" && seg.length === 1) {
      const needle = (q.get("q") || "").toLowerCase();
      const items = F.users.items.filter(u => u.email.toLowerCase().includes(needle));
      return deep(paginate(items, q, 50));
    }
    if (seg[0] === "users" && seg.length === 2) return deep(F.userDetail);
    if (seg[0] === "users" && seg[2] === "grant" && method === "POST") {
      const n = body.credits;
      if (!Number.isInteger(n) || n < 1 || n > 1000)
        throw new ApiError(400, "credits must be an integer between 1 and 1000");
      if (!body.note || !String(body.note).trim())
        throw new ApiError(400, "note is required");
      const ud = F.userDetail;
      ud.user.balance = round2(ud.user.balance + n);
      ud.user.granted = round2(ud.user.granted + n);
      ud.ledger.unshift({ ts: now(), type: "grant", delta: n, runId: null,
                          ref: "admin_mock_" + Date.now(), note: String(body.note) });
      const listed = F.users.items.find(u => u.id === seg[1]);
      if (listed) {
        listed.balance = round2(listed.balance + n);
        listed.granted = round2(listed.granted + n);
      }
      F.overview.credits.granted = round2(F.overview.credits.granted + n);
      F.overview.credits.outstanding = round2(F.overview.credits.outstanding + n);
      return { ok: true, balance: ud.user.balance };
    }
    if (seg[0] === "users" && seg[2] === "reissue-key" && method === "POST")
      return { ok: true };
    if (seg[0] === "users" && seg[2] === "revoke-license" && method === "POST") {
      const lic = F.userDetail.licenses.find(l => l.keyHash === body.keyHash);
      if (!lic) throw new ApiError(400, "license not found");
      lic.status = "revoked";
      lic.revokedAt = now();
      return { ok: true };
    }

    /* --- runs --- */
    if (seg[0] === "runs" && seg.length === 1) {
      const phase = q.get("phase") || "";
      const items = phase ? F.runs.items.filter(r => r.phase === phase) : F.runs.items;
      return deep(paginate(items, q, 50));
    }
    if (seg[0] === "runs" && seg.length === 2) return deep(F.runDetail);

    /* --- waitlist --- */
    if (seg[0] === "waitlist" && seg.length === 1 && method === "GET") {
      const status = q.get("status") || "all";
      const all = F.waitlist.items;
      const items = all.filter(w =>
        status === "pending"   ? !w.invitedAt :
        status === "invited"   ? (w.invitedAt && !w.signedUpAt) :
        status === "signed_up" ? !!w.signedUpAt : true);
      const page = paginate(items, q, 100);
      return deep(Object.assign({ counts: wlCounts(all) }, page));
    }
    if (seg[0] === "waitlist" && seg[1] === "import" && method === "POST") {
      let added = 0, duplicates = 0, invalid = 0;
      (body.emails || []).forEach(raw => {
        const email = String(raw).trim();
        if (!EMAIL_RE.test(email)) { invalid++; return; }
        const exists = F.waitlist.items.some(w => w.email.toLowerCase() === email.toLowerCase());
        if (exists) { duplicates++; return; }
        F.waitlist.items.push({ email, addedAt: now(), invitedAt: null,
                                signedUpAt: null, note: body.note || null });
        added++;
      });
      F.waitlist.total = F.waitlist.items.length;
      return { added, duplicates, invalid };
    }
    if (seg[0] === "waitlist" && seg[1] === "invite" && method === "POST") {
      const targets = body.emails
        ? F.waitlist.items.filter(w => body.emails.includes(w.email))
        : F.waitlist.items.filter(w => !w.invitedAt);
      targets.forEach(w => { if (!w.invitedAt) w.invitedAt = now(); }); // re-send keeps original
      return { invited: targets.length, failed: [] };
    }
    if (seg[0] === "waitlist" && seg.length === 2 && method === "DELETE") {
      const email = decodeURIComponent(seg[1]);
      const i = F.waitlist.items.findIndex(w => w.email === email);
      if (i < 0) throw new ApiError(404, "not on the waitlist");
      F.waitlist.items.splice(i, 1);
      F.waitlist.total = F.waitlist.items.length;
      return { ok: true };
    }

    /* --- finance: zero-fill the requested window ending at the last fixture day --- */
    if (seg[0] === "finance") {
      const days = Math.max(1, parseInt(q.get("days") || "30", 10) || 30);
      const src = F.finance.series;
      const map = new Map(src.map(d => [d.date, d]));
      const lastDate = src.length ? src[src.length - 1].date
                                  : new Date().toISOString().slice(0, 10);
      const end = new Date(lastDate + "T00:00:00Z").getTime();
      const series = [];
      for (let i = days - 1; i >= 0; i--) {
        const key = new Date(end - i * 86400000).toISOString().slice(0, 10);
        series.push(map.get(key) ||
          { date: key, granted: 0, grantedPaid: 0, spent: 0, cogsUsd: 0 });
      }
      return { series: deep(series), recentTopups: deep(F.finance.recentTopups) };
    }

    /* --- live --- */
    if (seg[0] === "live") return deep(F.live);

    throw new ApiError(404, "unknown mock endpoint: " + path);
  }

  /* ============================== 4. widgets ============================== */

  function toast(msg, kind) {
    let wrap = $(".toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    const t = document.createElement("div");
    t.className = "toast" + (kind === "error" ? " error" : "");
    t.textContent = msg;          // textContent — no injection possible
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 220); }, 4000);
  }

  /**
   * openModal — overlay + card. The card is a <form>: Enter submits, Escape (and the
   * Cancel button, and clicking the overlay) closes. onConfirm(form) may throw — the
   * message shows inline and the modal stays open.  `body` is trusted template HTML —
   * callers escape all data interpolated into it.
   */
  function openModal(opts) {
    closeModal();
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML =
      `<form class="modal" novalidate>
         <h3>${esc(opts.title)}</h3>
         <div class="modal-body">${opts.body || ""}</div>
         <div class="modal-error" hidden></div>
         <div class="modal-actions">
           <button type="button" class="m-cancel">Cancel</button>
           <button type="submit" class="m-confirm ${opts.danger ? "danger" : "primary"}">${esc(opts.confirmLabel || "Confirm")}</button>
         </div>
       </form>`;
    document.body.appendChild(ov);
    const form = $("form", ov);
    const errEl = $(".modal-error", ov);
    const confirmBtn = $(".m-confirm", ov);
    const onKey = e => { if (e.key === "Escape") close(); };
    function close() {
      document.removeEventListener("keydown", onKey);
      ov.remove();
      state.modal = null;
    }
    document.addEventListener("keydown", onKey);
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
    $(".m-cancel", ov).addEventListener("click", close);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      errEl.hidden = true;
      confirmBtn.disabled = true;
      try {
        if (opts.onConfirm) await opts.onConfirm(form);
        close();
      } catch (err) {
        errEl.textContent = err && err.message ? err.message : String(err);
        errEl.hidden = false;
        confirmBtn.disabled = false;
      }
    });
    state.modal = { close };
    const first = $("input, textarea, select", form);
    (first || confirmBtn).focus();
  }

  function closeModal() { if (state.modal) state.modal.close(); }

  function errorBanner(container, err, retry) {
    container.innerHTML =
      `<div class="error-banner"><span>${esc(err && err.message ? err.message : err)}</span>
         <button type="button" class="retry">Retry</button></div>`;
    $(".retry", container).addEventListener("click", retry);
  }

  function pagerHTML(page, total, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return `<div class="pager">
      <button type="button" class="pg-back" ${page <= 0 ? "disabled" : ""}>&larr; Back</button>
      <span class="pg-label">page ${page + 1} of ${pages}</span>
      <button type="button" class="pg-next" ${page >= pages - 1 ? "disabled" : ""}>Next &rarr;</button>
    </div>`;
  }

  function wirePager(root, page, onPage) {
    const b = $(".pg-back", root), n = $(".pg-next", root);
    if (b) b.addEventListener("click", () => onPage(page - 1));
    if (n) n.addEventListener("click", () => onPage(page + 1));
  }

  function wireRows(root) {           // tr.clickable[data-href] → navigate
    root.querySelectorAll("tr.clickable[data-href]").forEach(tr => {
      tr.addEventListener("click", e => {
        if (e.target.closest("button, a")) return;
        location.hash = tr.dataset.href;
      });
    });
  }

  function tableHTML(cols, rowsHTML, emptyText) {
    if (!rowsHTML) return `<div class="empty">${esc(emptyText || "nothing here")}</div>`;
    const ths = cols.map(c =>
      `<th${c.startsWith(">") ? " class=\"num\"" : ""}>${esc(c.replace(/^>/, ""))}</th>`).join("");
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rowsHTML}</tbody></table>`;
  }

  /* --- badges --- */

  function phaseBadge(phase, paused) {
    const cls = (phase === "done" || phase === "created") ? " gray" : "";
    let html = `<span class="badge${cls}">${esc(phase)}</span>`;
    if (paused) html += ` <span class="badge yellow">paused</span>`;
    return html;
  }

  function waitlistBadge(w) {
    if (!w) return `<span class="muted">—</span>`;
    if (w.signedUpAt) return `<span class="badge">signed up</span>`;
    if (w.invitedAt) return `<span class="badge yellow">invited</span>`;
    return `<span class="badge gray">pending</span>`;
  }

  function ledgerBadge(type) {
    const cls = type === "grant" ? "" :
                type === "debit" ? " gray" : " red";   // refund / chargeback → red
    return `<span class="badge${cls}">${esc(type)}</span>`;
  }

  function tile(label, valueHTML, subHTML, titleAttr) {
    return `<div class="tile"${titleAttr ? ` title="${esc(titleAttr)}"` : ""}>
      <div class="value">${valueHTML}</div>
      <div class="label">${esc(label)}</div>
      ${subHTML ? `<div class="sub">${subHTML}</div>` : ""}
    </div>`;
  }

  /* --- SVG finance chart (hand-rolled, SPEC §8.5) --- */

  function niceCeil(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    const f = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : m <= 7.5 ? 7.5 : 10;
    return f * p;
  }

  function financeChartSVG(series) {
    const W = 1100, H = 320, padL = 54, padR = 62, padT = 16, padB = 34;
    const pw = W - padL - padR, ph = H - padT - padB;
    const n = Math.max(1, series.length);
    const maxC = niceCeil(Math.max(1, ...series.map(s => Math.max(s.granted || 0, s.spent || 0))));
    const maxG = niceCeil(Math.max(0.01, ...series.map(s => s.cogsUsd || 0)));
    const gw = pw / n;
    const bw = Math.max(2, Math.min(16, (gw - 6) / 2));
    const yC = v => padT + ph - (v / maxC) * ph;
    const yG = v => padT + ph - (v / maxG) * ph;
    const X = i => padL + i * gw + gw / 2;
    const parts = [];

    [0.25, 0.5, 0.75].forEach(f => {
      const y = (padT + ph * f).toFixed(1);
      parts.push(`<line x1="${padL}" y1="${y}" x2="${padL + pw}" y2="${y}" stroke="var(--line-soft)" stroke-width="1.5"/>`);
    });

    const step = Math.ceil(n / 12);
    const linePts = [];
    series.forEach((s, i) => {
      const cx = X(i);
      if (s.granted > 0) {
        const y = yC(s.granted);
        parts.push(`<rect x="${(cx - bw - 1).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + ph - y).toFixed(1)}" fill="var(--accent)"><title>${esc(s.date)} — granted ${esc(credits(s.granted))} cr (paid ${esc(credits(s.grantedPaid))})</title></rect>`);
      }
      if (s.spent > 0) {
        const y = yC(s.spent);
        parts.push(`<rect x="${(cx + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + ph - y).toFixed(1)}" fill="var(--orange)"><title>${esc(s.date)} — spent ${esc(credits(s.spent))} cr</title></rect>`);
      }
      linePts.push(`${cx.toFixed(1)},${yG(s.cogsUsd || 0).toFixed(1)}`);
      if (i % step === 0)
        parts.push(`<text class="chart-label" x="${cx.toFixed(1)}" y="${padT + ph + 20}" text-anchor="middle">${esc(s.date.slice(5))}</text>`);
    });

    parts.push(`<polyline points="${linePts.join(" ")}" fill="none" stroke="var(--red)" stroke-width="2.5"/>`);
    if (n <= 31) series.forEach((s, i) => {
      parts.push(`<circle cx="${X(i).toFixed(1)}" cy="${yG(s.cogsUsd || 0).toFixed(1)}" r="3.2" fill="var(--red)"><title>${esc(s.date)} — COGS ${esc(money(s.cogsUsd || 0))}</title></circle>`);
    });

    parts.push(`<rect x="${padL}" y="${padT}" width="${pw}" height="${ph}" fill="none" stroke="var(--text)" stroke-width="2"/>`);
    [0, 0.5, 1].forEach(f => {
      parts.push(`<text class="chart-label" x="${padL - 8}" y="${(yC(maxC * f) + 4).toFixed(1)}" text-anchor="end">${esc(credits(maxC * f))}</text>`);
      parts.push(`<text class="chart-label" x="${padL + pw + 8}" y="${(yG(maxG * f) + 4).toFixed(1)}" text-anchor="start">${esc(money(maxG * f))}</text>`);
    });

    return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily credits granted and spent with COGS overlay">${parts.join("")}</svg>`;
  }

  /* ============================== 5. router ============================== */

  function clearLive() {
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  }

  function forceLogout() {
    localStorage.removeItem(TOKEN_KEY);
    state.token = "";
    state.authed = false;
    clearLive();
    closeModal();
    renderLogin("Session expired — unlock again.");
  }

  function onRoute() {
    if (!state.authed) return;
    clearLive();
    closeModal();
    const seg = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const name = seg[0] || "overview";
    setActiveNav(name);
    const main = $("#main");
    if (name === "users" && seg[1])      screenUserDetail(main, decodeURIComponent(seg[1]));
    else if (name === "users")           screenUsers(main);
    else if (name === "runs" && seg[1])  screenRunDetail(main, decodeURIComponent(seg[1]));
    else if (name === "runs")            screenRuns(main);
    else if (name === "waitlist")        screenWaitlist(main);
    else if (name === "finance")         screenFinance(main);
    else if (name === "live")            screenLive(main);
    else                                 screenOverview(main);
  }

  function setActiveNav(name) {
    const map = { overview: "overview", users: "users", runs: "runs",
                  waitlist: "waitlist", finance: "finance", live: "live" };
    const active = map[name] || "overview";
    document.querySelectorAll(".nav a").forEach(a =>
      a.classList.toggle("active", a.dataset.nav === active));
  }

  function renderShell() {
    $("#app").innerHTML =
      `<aside class="sidebar">
         <div class="brand"><span class="brand-name">ASOptimus</span><span class="brand-chip">ADMIN</span></div>
         ${state.mock ? `<span class="mock-flag">MOCK MODE</span>` : ""}
         <nav class="nav">
           <a href="#/overview" data-nav="overview">Overview</a>
           <a href="#/users" data-nav="users">Users</a>
           <a href="#/runs" data-nav="runs">Runs</a>
           <a href="#/waitlist" data-nav="waitlist">Waitlist</a>
           <a href="#/finance" data-nav="finance">Finance</a>
           <a href="#/live" data-nav="live">Live</a>
         </nav>
         <div class="side-foot"><button type="button" id="lockBtn">${SVG_LOCK}Lock</button></div>
       </aside>
       <main class="main" id="main"></main>`;
    $("#lockBtn").addEventListener("click", () => {
      localStorage.removeItem(TOKEN_KEY);
      state.token = "";
      state.authed = false;
      clearLive();
      closeModal();
      renderLogin();
    });
  }

  /** Screen header (title + Refresh) + a fresh content container. */
  function screenFrame(main, title) {
    main.innerHTML =
      `<div class="screen-head"><h1>${esc(title)}</h1>
         <div class="head-actions"><button type="button" class="refresh-btn">${SVG_REFRESH}Refresh</button></div>
       </div>
       <div class="screen-content"><div class="loading">Loading…</div></div>`;
    $(".refresh-btn", main).addEventListener("click", onRoute);
    return $(".screen-content", main);
  }

  /* ============================== 6. screens ============================== */

  /* ---------- login ---------- */

  function renderLogin(msg) {
    state.authed = false;
    clearLive();
    closeModal();
    $("#app").innerHTML =
      `<div class="login-wrap">
         <form class="login-card" id="loginForm">
           <div class="brand"><span class="brand-name">ASOptimus</span><span class="brand-chip">ADMIN</span>
             ${state.mock ? `<span class="mock-flag" style="margin:0">MOCK MODE</span>` : ""}</div>
           <p class="login-hint">Enter the admin token to unlock the panel.</p>
           <input id="tokenInput" type="password" placeholder="admin token" autocomplete="current-password">
           <div class="login-error" id="loginErr" ${msg ? "" : "hidden"}>${esc(msg || "")}</div>
           <button class="primary" type="submit">Unlock</button>
         </form>
       </div>`;
    const form = $("#loginForm"), input = $("#tokenInput"), errEl = $("#loginErr");
    input.focus();
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const t = input.value.trim();
      errEl.hidden = true;
      if (!t) { errEl.textContent = "enter a token"; errEl.hidden = false; return; }
      const btn = $("button", form);
      btn.disabled = true;
      try {
        await api("/me", { token: t });
        state.token = t;
        localStorage.setItem(TOKEN_KEY, t);
        state.authed = true;
        renderShell();
        onRoute();
      } catch (err) {
        errEl.textContent =
          err.status === 401 ? "wrong token" :
          err.status === 404 ? "admin API disabled" :
          (err.message || "login failed");
        errEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  /* ---------- overview ---------- */

  async function screenOverview(main) {
    const c = screenFrame(main, "Overview");
    try {
      const d = await api("/overview");
      renderOverview(c, d);
    } catch (e) {
      errorBanner(c, e, () => screenOverview(main));
    }
  }

  function renderOverview(c, d) {
    const m = d.finance.approxMarginUsd;
    const phases = Object.entries(d.runs.byPhase || {});
    const maxPhase = Math.max(1, ...phases.map(([, v]) => v));
    const bars = phases.map(([k, v]) =>
      `<div class="hbar-row">
         <span class="hbar-label">${esc(k)}</span>
         <div class="hbar-track"><div class="hbar-fill" style="width:${(v / maxPhase * 100).toFixed(1)}%"></div></div>
         <span class="hbar-count">${esc(v)}</span>
       </div>`).join("");

    c.innerHTML =
      `<div class="tiles">
         ${tile("total users", esc(fmtInt(d.users.total)))}
         ${tile("new in 7d", esc(fmtInt(d.users.new7d)))}
         ${tile("new in 30d", esc(fmtInt(d.users.new30d)))}
         <div class="tile"><div class="tri">
           <span><b>${esc(fmtInt(d.waitlist.pending))}</b>pending</span>
           <span><b>${esc(fmtInt(d.waitlist.invited))}</b>invited</span>
           <span><b>${esc(fmtInt(d.waitlist.signedUp))}</b>signed up</span>
         </div><div class="label">waitlist</div></div>
       </div>
       <div class="tiles">
         ${tile("credits granted", esc(credits(d.credits.granted)),
                `paid ${esc(credits(d.credits.grantedPaid))} · free ${esc(credits(d.credits.grantedFree))}`)}
         ${tile("credits spent", esc(credits(d.credits.spent)))}
         ${tile("outstanding", esc(credits(d.credits.outstanding)),
                "granted − spent · operator liability")}
         ${tile("approx revenue", esc(money(d.finance.approxRevenueUsd)),
                "≈ paid credits — slight overestimate",
                "Approximation: paid credits at $1/credit; package bonuses make this a slight overestimate.")}
         ${tile("COGS", esc(money(d.finance.cogsUsd)),
                `30d: ${esc(money(d.finance.cogs30dUsd))}`)}
         <div class="tile"><div class="value ${m < 0 ? "neg" : ""}">${esc(money(m))}</div>
           <div class="label">approx margin</div>
           <div class="sub">revenue − COGS</div></div>
       </div>
       <div class="panel">
         <div class="panel-head"><h2>Runs by phase</h2>
           <div class="chips">
             <span class="chip">${esc(fmtInt(d.runs.active))} active right now</span>
             <span class="chip">${esc(fmtInt(d.runs.total))} total</span>
           </div>
         </div>
         ${bars}
       </div>
       <div class="panel live-strip">
         <div><span class="value-inline">${esc(fmtInt(d.live.connectedClients))}</span> connected clients
           &nbsp;·&nbsp; <span class="value-inline">${esc(fmtInt(d.live.activeOrchestrators))}</span> active orchestrators</div>
         <a href="#/live">Open Live &rarr;</a>
       </div>`;
  }

  /* ---------- users ---------- */

  function screenUsers(main) {
    const c = screenFrame(main, "Users");
    let q = state.userSearchPrefill || "";
    state.userSearchPrefill = "";
    let page = 0;
    c.innerHTML =
      `<div class="toolbar">
         <input id="uq" type="search" placeholder="Search by email…" value="${esc(q)}">
       </div>
       <div class="panel"><div id="ulist"><div class="loading">Loading…</div></div></div>`;
    const listEl = $("#ulist", c);
    const input = $("#uq", c);
    input.addEventListener("input", debounce(() => {
      q = input.value.trim();
      page = 0;
      load();
    }, 300));

    async function load() {
      listEl.innerHTML = `<div class="loading">Loading…</div>`;
      let d;
      try {
        d = await api(`/users?q=${encodeURIComponent(q)}&page=${page}&pageSize=50`);
      } catch (e) { errorBanner(listEl, e, load); return; }
      const rows = d.items.map(u =>
        `<tr class="clickable" data-href="#/users/${esc(encodeURIComponent(u.id))}">
           <td>${esc(u.email)}</td>
           <td class="num">${esc(fmtDate(u.createdAt))}</td>
           <td class="num">${esc(credits(u.balance))}</td>
           <td class="num">${esc(credits(u.granted))}</td>
           <td class="num">${esc(credits(u.spent))}</td>
           <td class="num">${esc(fmtInt(u.runs))}</td>
           <td class="num">${esc(fmtDate(u.lastRunAt))}</td>
           <td class="num">${esc(fmtInt(u.licenses))}</td>
           <td class="num">${esc(fmtInt(u.activeSessions))}</td>
           <td>${waitlistBadge(u.waitlist)}</td>
         </tr>`).join("");
      listEl.innerHTML =
        tableHTML(["email", ">created", ">balance (cr)", ">granted (cr)", ">spent (cr)",
                   ">runs", ">last run", ">licenses", ">sessions", "waitlist"],
                  rows, "no users match") +
        pagerHTML(d.page, d.total, d.pageSize);
      wireRows(listEl);
      wirePager(listEl, d.page, p => { page = p; load(); });
    }
    load();
  }

  /* ---------- user detail ---------- */

  async function screenUserDetail(main, id) {
    const c = screenFrame(main, "User detail");
    const reload = () => screenUserDetail(main, id);
    let d;
    try {
      d = await api("/users/" + encodeURIComponent(id));
    } catch (e) { errorBanner(c, e, reload); return; }
    const u = d.user;
    const marginProxy = round2(u.spent - d.cogsUsd);

    const licRows = d.licenses.map(l =>
      `<tr>
         <td><span class="mono" title="${esc(l.keyHash)}">${esc(l.keyHashPrefix)}…</span></td>
         <td><span class="badge${l.status === "active" ? "" : " red"}">${esc(l.status)}</span></td>
         <td>${l.deviceBound ? "yes" : "no"}</td>
         <td class="num">${esc(fmtDate(l.revokedAt))}</td>
         <td class="num">${l.status === "active"
           ? `<button type="button" class="danger btn-sm lic-revoke" data-kh="${esc(l.keyHash)}" data-prefix="${esc(l.keyHashPrefix)}">Revoke</button>` : ""}</td>
       </tr>`).join("");

    const runRows = d.runs.map(r =>
      `<tr class="clickable" data-href="#/runs/${esc(encodeURIComponent(r.runId))}">
         <td>${esc(r.brand)}</td>
         <td><span class="mono">${esc(String(r.country).toUpperCase())}</span></td>
         <td>${phaseBadge(r.phase, r.paused)}</td>
         <td class="num">${esc(fmtInt(r.sampleCount))} / ${esc(fmtInt(r.sampleSize))}</td>
         <td class="num">${esc(credits(r.creditsSpent))}</td>
         <td class="num">${esc(money(r.cogsUsd))}</td>
         <td class="num">${esc(fmtDate(r.updatedAt))}</td>
       </tr>`).join("");

    const ledgerRows = d.ledger.map(l =>
      `<tr>
         <td class="num" style="text-align:left">${esc(fmtDate(l.ts))}</td>
         <td>${ledgerBadge(l.type)}</td>
         <td class="num${l.delta < 0 ? "" : ""}">${esc(signCredits(l.delta))}</td>
         <td>${monoShort(l.runId)}</td>
         <td>${monoShort(l.ref)}</td>
         <td>${dash(l.note)}</td>
       </tr>`).join("");

    c.innerHTML =
      `<div class="panel detail-head">
         <div>
           <h2>${esc(u.email)}</h2>
           <div class="meta">
             ${monoShort(u.id)}
             <span>created ${esc(fmtDate(u.createdAt))}</span>
             <span>paddle ${monoShort(u.paddleCustomerId)}</span>
             ${waitlistBadge(u.waitlist)}
           </div>
         </div>
       </div>
       <div class="tiles">
         ${tile("balance (cr)", esc(credits(u.balance)))}
         ${tile("granted (cr)", esc(credits(u.granted)))}
         ${tile("spent (cr)", esc(credits(u.spent)))}
         ${tile("COGS", esc(money(d.cogsUsd)))}
         <div class="tile"><div class="value ${marginProxy < 0 ? "neg" : ""}">${esc(money(marginProxy))}</div>
           <div class="label">spend vs COGS</div><div class="sub">margin proxy: spent − COGS</div></div>
       </div>
       <div class="actions-row">
         <button type="button" class="primary" id="grantBtn">Grant credits</button>
         <button type="button" id="reissueBtn">Reissue key</button>
       </div>
       <div class="panel"><h2>Licenses</h2>
         ${tableHTML(["key", "status", "device bound", ">revoked at", ">"], licRows, "no licenses")}
       </div>
       <div class="panel"><h2>Runs</h2>
         ${tableHTML(["brand", "country", "phase", ">sample", ">spent (cr)", ">cogs", ">updated"],
                     runRows, "no runs yet")}
       </div>
       <div class="panel"><h2>Ledger</h2>
         ${tableHTML(["ts", "type", ">Δ (cr)", "run", "ref", "note"], ledgerRows, "empty ledger")}
       </div>`;
    wireRows(c);

    $("#grantBtn", c).addEventListener("click", () => {
      openModal({
        title: "Grant credits",
        confirmLabel: "Grant",
        body: `<p class="muted" style="margin:0">Adds credits to <b>${esc(u.email)}</b> and writes a grant ledger entry.</p>
               <label for="gcCredits">Credits (integer, 1–1000)</label>
               <input id="gcCredits" name="credits" type="number" min="1" max="1000" step="1">
               <label for="gcNote">Note (required)</label>
               <input id="gcNote" name="note" type="text" placeholder="e.g. support comp">`,
        onConfirm: async form => {
          const n = Number(form.credits.value);
          const note = form.note.value.trim();
          if (!Number.isInteger(n) || n < 1 || n > 1000)
            throw new Error("Credits must be an integer between 1 and 1000.");
          if (!note) throw new Error("A note is required.");
          const r = await api(`/users/${encodeURIComponent(id)}/grant`,
                              { method: "POST", body: { credits: n, note } });
          toast(`Granted ${n} credits — new balance ${credits(r.balance)}`);
          reload();
        },
      });
    });

    $("#reissueBtn", c).addEventListener("click", () => {
      openModal({
        title: "Reissue activation key",
        confirmLabel: "Reissue",
        body: `<p>Emails a fresh activation key to <b>${esc(u.email)}</b>.</p>`,
        onConfirm: async () => {
          await api(`/users/${encodeURIComponent(id)}/reissue-key`, { method: "POST", body: {} });
          toast("Activation key reissued — email sent");
        },
      });
    });

    c.querySelectorAll(".lic-revoke").forEach(btn => {
      btn.addEventListener("click", () => {
        const kh = btn.dataset.kh, prefix = btn.dataset.prefix;
        openModal({
          title: "Revoke license",
          confirmLabel: "Revoke",
          danger: true,
          body: `<p>Revoke license <span class="mono">${esc(prefix)}…</span>? The bound device loses access immediately.</p>`,
          onConfirm: async () => {
            await api(`/users/${encodeURIComponent(id)}/revoke-license`,
                      { method: "POST", body: { keyHash: kh } });
            toast(`License ${prefix}… revoked`);
            reload();
          },
        });
      });
    });
  }

  /* ---------- runs ---------- */

  function screenRuns(main) {
    const c = screenFrame(main, "Runs");
    let phase = "", page = 0;
    c.innerHTML =
      `<div class="toolbar">
         <label class="toolbar-label">Phase
           <select id="phaseSel">
             <option value="">all</option>
             ${PHASES.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}
           </select>
         </label>
       </div>
       <div class="panel"><div id="rlist"><div class="loading">Loading…</div></div></div>`;
    const listEl = $("#rlist", c);
    $("#phaseSel", c).addEventListener("change", e => {
      phase = e.target.value;
      page = 0;
      load();
    });

    async function load() {
      listEl.innerHTML = `<div class="loading">Loading…</div>`;
      let d;
      try {
        d = await api(`/runs?page=${page}&pageSize=50&phase=${encodeURIComponent(phase)}`);
      } catch (e) { errorBanner(listEl, e, load); return; }
      const rows = d.items.map(r => {
        const margin = round2(r.creditsSpent - r.cogsUsd);
        return `<tr class="clickable" data-href="#/runs/${esc(encodeURIComponent(r.runId))}">
          <td>${esc(r.userEmail)}</td>
          <td>${esc(r.brand)}</td>
          <td><span class="mono">${esc(String(r.country).toUpperCase())}</span></td>
          <td>${phaseBadge(r.phase, r.paused)}</td>
          <td class="num">${esc(fmtInt(r.sampleCount))} / ${esc(fmtInt(r.sampleSize))}</td>
          <td class="num">${esc(credits(r.creditsSpent))}</td>
          <td class="num">${esc(money(r.cogsUsd))}</td>
          <td class="num${margin < 0 ? " neg" : ""}">${esc(money(margin))}</td>
          <td class="num">${esc(fmtDate(r.updatedAt))}</td>
        </tr>`;
      }).join("");
      listEl.innerHTML =
        tableHTML(["user", "brand", "country", "phase", ">sample", ">spent (cr)",
                   ">cogs", ">margin", ">updated"], rows, "no runs in this phase") +
        pagerHTML(d.page, d.total, d.pageSize);
      wireRows(listEl);
      wirePager(listEl, d.page, p => { page = p; load(); });
    }
    load();
  }

  /* ---------- run detail ---------- */

  async function screenRunDetail(main, id) {
    const c = screenFrame(main, "Run detail");
    let d;
    try {
      d = await api("/runs/" + encodeURIComponent(id));
    } catch (e) { errorBanner(c, e, () => screenRunDetail(main, id)); return; }
    const snap = d.snapshot, st = snap.state, cfg = snap.config || {}, ctx = snap.context || {};

    const kv = obj => `<dl class="kv">${Object.entries(obj).map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}</dl>`;

    const events = (snap.events || []).map(ev =>
      `<div class="ev"><span class="ev-ts">${esc(fmtDate(ev.ts))}</span>
         <span class="ev-kind">${esc(ev.kind)}</span>
         <span class="ev-text">${esc(ev.text)}</span></div>`).join("");

    let assemblyHTML = "";
    if (snap.assembly) {
      const buckets = (snap.assembly.buckets || []).map(b =>
        `<div class="bucket">
           <div class="b-row"><span class="badge gray">${esc(b.locale)}</span></div>
           <div class="b-row"><b>Title:</b> ${esc(b.title)}<span class="b-chars">${esc(String(b.title || "").length)} chars</span></div>
           <div class="b-row"><b>Subtitle:</b> ${esc(b.subtitle)}<span class="b-chars">${esc(String(b.subtitle || "").length)} chars</span></div>
           <div class="b-row"><b>Keywords:</b> <span class="kw">${esc(b.keywordFieldDraft)}</span><span class="b-chars">${esc(String(b.keywordFieldDraft || "").length)} chars</span></div>
         </div>`).join("");
      const cov = snap.assembly.coverage;
      const covLine = cov
        ? `<p class="caption">Coverage: ${esc(fmtInt(cov.phrasesCovered))} phrases · score ${esc(fmtInt(cov.scoreCovered))} / ${esc(fmtInt(cov.scoreTotal))} · ${esc(Math.round((cov.coveredShare || 0) * 100))}% covered</p>`
        : "";
      assemblyHTML = `<div class="panel"><h2>Assembly</h2>${buckets}${covLine}</div>`;
    }

    c.innerHTML =
      `<div class="panel detail-head">
         <div>
           <h2>${esc(cfg.brand || "run")} · <span class="mono">${esc(String(cfg.country || "").toUpperCase())}</span></h2>
           <div class="meta">
             <a href="#/users" class="user-link">${esc(d.userEmail)}</a>
             ${monoShort(st.runId)}
             <span>created ${esc(fmtDate(st.createdAt))}</span>
             <span>updated ${esc(fmtDate(st.updatedAt))}</span>
           </div>
           ${st.failed ? `<div class="notice-line"><span class="badge red">failed</span> ${esc(st.failed)}</div>` : ""}
           ${st.notice ? `<div class="notice-line">${esc(st.notice)}</div>` : ""}
         </div>
         <div>${phaseBadge(st.phase, st.paused)}</div>
       </div>
       <div class="tiles">
         ${tile("sample", `${esc(fmtInt(snap.sampleCount))} / ${esc(fmtInt(cfg.sampleSize != null ? cfg.sampleSize : snap.sampleCount))}`)}
         ${tile("credits spent", esc(credits(snap.creditsSpent)))}
         ${tile("COGS", esc(money(d.cogsUsd)))}
         ${tile("LLM calls", esc(fmtInt(d.llm.calls)))}
         <div class="tile"><div class="value sm">${esc(fmtInt(d.llm.inputTokens))} / ${esc(fmtInt(d.llm.outputTokens))}</div>
           <div class="label">tokens in / out</div></div>
       </div>
       <div class="two-col">
         <div class="panel"><h2>Config</h2>${kv(cfg)}</div>
         <div class="panel"><h2>Context</h2>${kv(ctx)}</div>
       </div>
       <div class="panel"><h2>Events</h2>
         ${events ? `<div class="events">${events}</div>` : `<div class="empty">no events</div>`}
       </div>
       ${assemblyHTML}`;

    const userLink = $(".user-link", c);
    if (userLink) userLink.addEventListener("click", () => {
      state.userSearchPrefill = d.userEmail;
    });
    const evBox = $(".events", c);
    if (evBox) evBox.scrollTop = evBox.scrollHeight;   // newest last, scrolled into view
  }

  /* ---------- waitlist ---------- */

  function screenWaitlist(main) {
    const c = screenFrame(main, "Waitlist");
    let status = "all", page = 0, pendingCount = 0;
    c.innerHTML =
      `<div id="betaBanner"></div>
       <div class="toolbar">
         <div class="chips" id="wlChips"></div>
         <div class="wl-controls">
           <label class="toolbar-label">Status
             <select id="wlStatus">
               <option value="all">all</option>
               <option value="pending">pending</option>
               <option value="invited">invited</option>
               <option value="signed_up">signed up</option>
             </select>
           </label>
           <button type="button" class="primary" id="inviteAllBtn" disabled>Invite all pending</button>
         </div>
       </div>
       <div class="panel"><h2>Add to waitlist</h2>
         <textarea id="wlEmails" rows="4" placeholder="one email per line — commas also fine"></textarea>
         <div class="import-row">
           <input id="wlNote" type="text" placeholder="note (optional), e.g. producthunt">
           <button type="button" class="primary" id="wlImportBtn">Add to waitlist</button>
         </div>
       </div>
       <div class="panel"><div id="wlList"><div class="loading">Loading…</div></div></div>`;

    const listEl = $("#wlList", c), chipsEl = $("#wlChips", c),
          inviteAllBtn = $("#inviteAllBtn", c), bannerEl = $("#betaBanner", c);

    api("/beta").then(b => {
      bannerEl.innerHTML = b.gated
        ? `<div class="beta-banner on">Beta gate: ON — only invited waitlist emails can sign up; each signup is granted ${esc(b.grantCredits)} free credits.</div>`
        : `<div class="beta-banner off">Beta gate: OFF — signups are open.</div>`;
    }).catch(e => {
      bannerEl.innerHTML = `<div class="beta-banner off">Beta gate: unavailable (${esc(e.message)})</div>`;
    });

    $("#wlStatus", c).addEventListener("change", e => {
      status = e.target.value;
      page = 0;
      load();
    });

    $("#wlImportBtn", c).addEventListener("click", async () => {
      const emails = $("#wlEmails", c).value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      if (!emails.length) { toast("Nothing to add — paste some emails first", "error"); return; }
      const note = $("#wlNote", c).value.trim();
      try {
        const r = await api("/waitlist/import",
                            { method: "POST", body: { emails, note: note || undefined } });
        toast(`added ${r.added}, skipped ${r.duplicates} duplicates, ${r.invalid} invalid`);
        $("#wlEmails", c).value = "";
        load();
      } catch (e) { toast(e.message, "error"); }
    });

    inviteAllBtn.addEventListener("click", () => {
      openModal({
        title: "Invite all pending",
        confirmLabel: "Send invites",
        body: `<p>This SENDS EMAILS: an invitation email goes out to all <b>${esc(pendingCount)}</b> pending waitlist addresses.</p>`,
        onConfirm: async () => {
          const r = await api("/waitlist/invite", { method: "POST", body: {} });
          toast(`Invited ${r.invited}`);
          if (r.failed && r.failed.length)
            toast(`${r.failed.length} failed — first: ${r.failed[0].email}: ${r.failed[0].error}`, "error");
          load();
        },
      });
    });

    async function load() {
      listEl.innerHTML = `<div class="loading">Loading…</div>`;
      let d;
      try {
        d = await api(`/waitlist?status=${encodeURIComponent(status)}&page=${page}&pageSize=100`);
      } catch (e) { errorBanner(listEl, e, load); return; }
      pendingCount = d.counts.pending;
      chipsEl.innerHTML =
        `<span class="chip">${esc(fmtInt(d.counts.pending))} pending</span>
         <span class="chip">${esc(fmtInt(d.counts.invited))} invited</span>
         <span class="chip">${esc(fmtInt(d.counts.signedUp))} signed up</span>`;
      inviteAllBtn.textContent = `Invite all pending (${fmtInt(pendingCount)})`;
      inviteAllBtn.disabled = pendingCount === 0;

      const rows = d.items.map(w => {
        const pending = !w.invitedAt;
        return `<tr>
          <td>${esc(w.email)}</td>
          <td class="num">${esc(fmtDate(w.addedAt))}</td>
          <td class="num">${esc(fmtDate(w.invitedAt))}</td>
          <td class="num">${esc(fmtDate(w.signedUpAt))}</td>
          <td>${dash(w.note)}</td>
          <td class="num">
            ${pending ? `<button type="button" class="btn-sm wl-invite" data-email="${esc(w.email)}">Invite</button>` : ""}
            <button type="button" class="btn-sm danger wl-remove" data-email="${esc(w.email)}">Remove</button>
          </td>
        </tr>`;
      }).join("");
      listEl.innerHTML =
        tableHTML(["email", ">added", ">invited", ">signed up", "note", ">"],
                  rows, "waitlist is empty for this filter") +
        pagerHTML(d.page, d.total, d.pageSize);
      wirePager(listEl, d.page, p => { page = p; load(); });

      listEl.querySelectorAll(".wl-invite").forEach(btn =>
        btn.addEventListener("click", () => {
          const email = btn.dataset.email;
          openModal({
            title: "Invite to beta",
            confirmLabel: "Send invite",
            body: `<p>Sends an invitation email to <b>${esc(email)}</b>.</p>`,
            onConfirm: async () => {
              const r = await api("/waitlist/invite",
                                  { method: "POST", body: { emails: [email] } });
              if (r.failed && r.failed.length)
                throw new Error(r.failed[0].email + ": " + r.failed[0].error);
              toast(`Invited ${email}`);
              load();
            },
          });
        }));

      listEl.querySelectorAll(".wl-remove").forEach(btn =>
        btn.addEventListener("click", () => {
          const email = btn.dataset.email;
          openModal({
            title: "Remove from waitlist",
            confirmLabel: "Remove",
            danger: true,
            body: `<p>Remove <b>${esc(email)}</b> from the waitlist?</p>`,
            onConfirm: async () => {
              await api("/waitlist/" + encodeURIComponent(email), { method: "DELETE" });
              toast(`Removed ${email}`);
              load();
            },
          });
        }));
    }
    load();
  }

  /* ---------- finance ---------- */

  function screenFinance(main) {
    const c = screenFrame(main, "Finance");
    let days = 30;
    c.innerHTML =
      `<div class="toolbar">
         <label class="toolbar-label">Range
           <select id="finDays">
             <option value="7">7 days</option>
             <option value="30" selected>30 days</option>
             <option value="90">90 days</option>
           </select>
         </label>
       </div>
       <div id="finBody"><div class="loading">Loading…</div></div>`;
    const bodyEl = $("#finBody", c);
    $("#finDays", c).addEventListener("change", e => {
      days = parseInt(e.target.value, 10);
      load();
    });

    async function load() {
      bodyEl.innerHTML = `<div class="loading">Loading…</div>`;
      let d;
      try {
        d = await api(`/finance?days=${days}`);
      } catch (e) { errorBanner(bodyEl, e, load); return; }
      const maxCogs = Math.max(0, ...d.series.map(s => s.cogsUsd || 0));
      const topups = d.recentTopups.map(t =>
        `<tr>
           <td class="num" style="text-align:left">${esc(fmtDate(t.ts))}</td>
           <td>${esc(t.email)}</td>
           <td class="num">${esc(credits(t.credits))}</td>
           <td>${monoShort(t.ref)}</td>
         </tr>`).join("");
      bodyEl.innerHTML =
        `<div class="panel">
           <div class="panel-head"><h2>Daily credits &amp; COGS — last ${esc(days)} days</h2></div>
           ${financeChartSVG(d.series)}
           <p class="caption">Blue bars — credits granted · orange bars — credits spent (left scale, credits).
             Red line — COGS in USD on the right-hand scale (period max ${esc(money(maxCogs))}).</p>
         </div>
         <div class="panel"><h2>Recent top-ups</h2>
           ${tableHTML(["ts", "email", ">credits", "ref"], topups, "no top-ups yet")}
         </div>`;
    }
    load();
  }

  /* ---------- live ---------- */

  function screenLive(main) {
    const c = screenFrame(main, "Live");
    c.innerHTML =
      `<div class="two-col">
         <div class="panel"><h2>Connected clients</h2><div id="liveClients"><div class="loading">Loading…</div></div></div>
         <div class="panel"><h2>Active orchestrators</h2><div id="liveOrch"><div class="loading">Loading…</div></div></div>
       </div>
       <p class="caption">Auto-refreshes every 5 seconds while this screen is open.</p>`;
    const clientsEl = $("#liveClients", c), orchEl = $("#liveOrch", c);

    async function load() {
      let d;
      try {
        d = await api("/live");
      } catch (e) {
        clearLive();
        errorBanner(c, e, () => screenLive(main));
        return;
      }
      const clientRows = d.clients.map(cl =>
        `<tr>
           <td>${monoShort(cl.userId)}</td>
           <td>${esc(cl.email)}</td>
           <td>${monoShort(cl.deviceFp)}</td>
         </tr>`).join("");
      clientsEl.innerHTML = clientRows
        ? tableHTML(["user id", "email", "device fp"], clientRows)
        : `<div class="empty">no clients connected</div>`;

      const orchRows = d.orchestrators.map(o =>
        `<tr class="clickable" data-href="#/runs/${esc(encodeURIComponent(o.runId))}">
           <td>${monoShort(o.runId)}</td>
           <td>${esc(o.userEmail)}</td>
           <td>${phaseBadge(o.phase, o.paused)}</td>
           <td class="num">${esc(fmtInt(o.sampleCount))}</td>
         </tr>`).join("");
      orchEl.innerHTML = orchRows
        ? tableHTML(["run", "user", "phase", ">sample"], orchRows)
        : `<div class="empty">no active runs</div>`;
      wireRows(orchEl);
    }
    load();
    state.liveTimer = setInterval(load, 5000);
  }

  /* ============================== boot ============================== */

  function boot() {
    state.mock = new URLSearchParams(location.search).get("mock") === "1";
    state.token = localStorage.getItem(TOKEN_KEY) || "";
    window.addEventListener("hashchange", onRoute);
    if (!location.hash)
      location.replace(location.pathname + location.search + "#/overview");
    if (!state.token) { renderLogin(); return; }
    $("#app").innerHTML = `<div class="login-wrap"><div class="loading">Loading…</div></div>`;
    api("/me").then(() => {
      state.authed = true;
      renderShell();
      onRoute();
    }).catch(err => {
      localStorage.removeItem(TOKEN_KEY);
      state.token = "";
      renderLogin(err && err.status === 401 ? "" : (err && err.message) || "");
    });
  }

  boot();
})();
