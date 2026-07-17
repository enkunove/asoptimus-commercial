/* ASOptimus localhost-UI — vanilla JS (spec 07 + BUILD-PLAN D1/D8/D9).
   Говорит ТОЛЬКО с 127.0.0.1. Все /api идут с per-launch токеном (D8).
   LLM-журнал показывает LlmLogPublic: выходы + токены/стоимость, БЕЗ промптов (D9). */
"use strict";

const app = document.getElementById("app");
const TOKEN = document.querySelector('meta[name="aso-token"]')?.content ?? "";

let storefrontsCache = null;
let modelsCache = null;
let packagesCache = null;
let session = null;
let currentSlug = null;
let currentBalance = null;
let kwQuery = { sort: "score", dir: "desc", status: "", source: "", q: "", page: 0 };
let expandedKeyword = null;

const OVERSHOOT_PCT = 0.1; // до +10% кейфраз — включено в цену (D4 v3)

// ---------- API (токен D8 на каждом запросе) ----------

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
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n ?? 0);
}
function usageLine(u) {
  const total = (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0);
  let s = `LLM: ${u.calls ?? 0} вызовов · ${fmtTokens(total)} токенов`;
  if (u.costUsd !== null && u.costUsd !== undefined) s += ` · ~$${u.costUsd.toFixed(2)}`;
  return s;
}

// ---------- SSE / поллинг ----------

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

const pauseReasons = {}; // slug → текст причины паузы (запасной сигнал)
const pauseCodes = {};   // slug → структурный код причины (run.paused.code) — основной сигнал
// Похоже ли, что прогон встал из-за нехватки кредитов (D4 v4 hard-stop) — текстовый fallback.
function isCreditsPause(text) { return /кредит|credit|баланс|balance|пополн|top.?up/i.test(String(text || "")); }
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

// ---------- баланс в шапке ----------

const balWidget = document.getElementById("balance-widget");
function setBalance(credits) {
  const prev = currentBalance;
  currentBalance = credits == null ? null : Number(credits);
  const el = document.getElementById("bal-credits");
  if (el) {
    el.textContent = credits == null ? "—" : Number(credits).toLocaleString();
    // Живой дренаж (D4 v4): подсветить тик списания/пополнения — кредиты тают в реальном времени.
    if (prev != null && currentBalance != null && currentBalance !== prev) {
      el.classList.remove("bal-flash-down", "bal-flash-up");
      void el.offsetWidth; // рестарт анимации
      el.classList.add(currentBalance < prev ? "bal-flash-down" : "bal-flash-up");
    }
  }
  // Если открыта форма прогона — пере-оценить оценку против нового баланса.
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
    if (!confirm("Выйти? Session-token будет удалён с этого компьютера.")) return;
    await api("/api/logout", { method: "POST" });
    session = null;
    location.hash = "";
    boot();
  });
}

// ---------- пополнение (модалка, без window.prompt) ----------
// 1 кредит = $1, free-tier НЕТ (D4). Каталог пакетов — С СЕРВЕРА (query kind="packages"), не хардкод.
async function openTopup() {
  const modal = openModal(`
    <h2>Пополнить баланс</h2>
    <p class="muted small">1 кредит = $1. Оплата — на защищённой странице Stripe.</p>
    <div class="topup-grid" id="topup-grid"><div class="muted small">загрузка пакетов…</div></div>
    <div id="topup-msg" class="small muted" style="margin-top:10px"></div>`);
  const grid = modal.querySelector("#topup-grid");
  let pkgs = [];
  try {
    pkgs = await getPackages();
  } catch (e) {
    grid.innerHTML = `<span class="check-fail">не удалось загрузить пакеты: ${esc(e.message)}</span>`;
    return;
  }
  if (!pkgs.length) { grid.innerHTML = `<span class="muted small">пакеты недоступны</span>`; return; }
  grid.innerHTML = pkgs.map((p) => `
    <button class="topup-pkg" data-pkg="${esc(p.id)}">
      <div class="topup-credits">${Number(p.credits).toLocaleString()} кр.</div>
      ${p.bonusPct ? `<div class="topup-bonus">+${p.bonusPct}% бонус</div>` : ""}
      <div class="topup-price">$${Number(p.priceUsd).toLocaleString()}</div>
      ${p.label ? `<div class="topup-label small muted">${esc(p.label)}</div>` : ""}
    </button>`).join("");
  grid.querySelectorAll(".topup-pkg").forEach((b) =>
    b.addEventListener("click", async () => {
      const msg = modal.querySelector("#topup-msg");
      msg.textContent = "создаю ссылку на оплату…";
      try {
        const res = await api("/api/topup", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packageId: b.dataset.pkg }),
        });
        if (res.checkoutUrl) {
          window.open(res.checkoutUrl, "_blank", "noopener");
          msg.innerHTML = `<span class="check-ok">✓ открыл страницу оплаты в новой вкладке</span>`;
          setTimeout(refreshBalance, 1200);
        } else {
          msg.textContent = "сервер не вернул ссылку на оплату";
        }
      } catch (e) { msg.innerHTML = `<span class="check-fail">✗ ${esc(e.message)}</span>`; }
    }));
}

// Универсальная модалка (overlay + карточка). Возвращает корень содержимого.
function openModal(innerHtml) {
  document.getElementById("modal-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-card"><button class="modal-close" title="Закрыть">✕</button><div class="modal-body"></div></div>`;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);
  const bodyEl = overlay.querySelector(".modal-body");
  bodyEl.innerHTML = innerHtml;
  document.body.appendChild(overlay);
  return bodyEl;
}

// ---------- загрузка / гейт активации ----------

async function boot() {
  try {
    session = await api("/api/session");
  } catch (e) {
    app.innerHTML = `<div class="banner error">Не удалось связаться с локальной программой: ${esc(e.message)}</div>`;
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
// Экран 0: логин по ключу активации (login-by-key)
// ============================================================

function viewLogin() {
  currentSlug = null;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="panel login-card">
        <h1>Активация ASOptimus</h1>
        <p class="muted">Введите ключ активации из письма — вида <span class="mono">asop_live_…</span>.
        Ключ обменивается на сессию у облака и хранится только на этом компьютере (D1).</p>
        <label>Ключ активации</label>
        <input id="key-input" placeholder="asop_live_..." autocomplete="off" spellcheck="false">
        <div class="row" style="margin-top:12px">
          <button class="primary" id="key-activate">Активировать</button>
          <span id="key-result" class="small"></span>
        </div>
        <p class="hint" style="margin-top:14px">Нет ключа? Он приходит на почту после оформления на asoptimus.com.</p>
      </div>
    </div>`;
  const input = document.getElementById("key-input");
  const out = document.getElementById("key-result");
  const go = async () => {
    out.innerHTML = "активирую…";
    try {
      await api("/api/activate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: input.value }),
      });
      out.innerHTML = `<span class="check-ok">✓ готово</span>`;
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
// Роутер (после активации)
// ============================================================

async function render() {
  const hash = location.hash || "#/runs";
  try {
    if (hash.startsWith("#/balance")) return await viewBalance();
    const runMatch = hash.match(/^#\/run\/([^/]+)(\/llm)?/);
    if (runMatch) return await viewRun(decodeURIComponent(runMatch[1]), runMatch[2] ? "llm" : null);
    return await viewRuns();
  } catch (e) {
    app.innerHTML = `<div class="banner error">Ошибка: ${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", () => {
  if (!session?.activated) return;
  expandedKeyword = null; kwQuery.page = 0; render();
});

async function getStorefronts() {
  if (!storefrontsCache) storefrontsCache = await api("/api/storefronts");
  return storefrontsCache;
}
async function getModels() {
  // Реестр моделей + pricePerKeyphrase приходит с сервера (D4 v3) — НЕ хардкодим.
  if (!modelsCache) {
    const res = await api("/api/models");
    modelsCache = Array.isArray(res.models) ? res.models : [];
  }
  return modelsCache;
}
async function getPackages() {
  // Каталог пополнения — с сервера (query kind="packages") — НЕ хардкодим.
  if (!packagesCache) {
    const res = await api("/api/packages");
    packagesCache = Array.isArray(res.packages) ? res.packages : [];
  }
  return packagesCache;
}
/** Модель по id из серверного реестра (для расчёта квота). */
function modelById(id) { return (modelsCache || []).find((m) => m.id === id) || null; }
/** Дефолтная модель формы: Haiku (D4 v3), иначе — первая из реестра. */
function defaultModel(models, cfgDefault) {
  return (
    models.find((m) => m.id === cfgDefault) ||
    models.find((m) => /haiku/i.test(m.id)) ||
    models[0] || null
  );
}

// ---------- живая ОЦЕНКА прогона (D4 v4, usage-based): ≈ sampleSize × pricePerKeyphrase ----------
// Это ОЦЕНКА, не резерв: кредиты списываются в реальном времени по мере появления кейфраз.
function computeQuote(sampleSize, model) {
  const price = model ? Number(model.pricePerKeyphrase) : 0;
  return { price, quote: Math.ceil((Number(sampleSize) || 0) * price) };
}
// Перерисовать блок оценки против текущего sampleSize/модели/баланса. No-op, если формы нет.
function updateQuoteUI() {
  const box = document.getElementById("quote-box");
  const ssEl = document.getElementById("f-samplesize");
  const modelEl = document.getElementById("f-model");
  if (!box || !ssEl || !modelEl) return;
  const sampleSize = Number(ssEl.value);
  const model = modelById(modelEl.value);
  const { price, quote } = computeQuote(sampleSize, model);
  const maxTotal = Math.ceil(quote * (1 + OVERSHOOT_PCT)); // overshoot ТОЖЕ списывается
  const known = currentBalance != null;
  const enough = !known || currentBalance >= quote;
  box.innerHTML = `
    <div class="quote-main">
      <div><span class="quote-approx">≈</span> <span class="quote-value">${quote.toLocaleString()}</span> <span class="muted">кредитов — оценка</span></div>
      <div class="muted small">${sampleSize} кейфраз × ${price} кр/кейфраза${model ? ` · ${esc(model.name)}` : ""}</div>
    </div>
    <p class="quote-note small muted">Оценка, не фикс-цена: кредиты списываются <b>по ходу прогона, в реальном времени</b> —
      ровно за произведённые кейфразы. Система может добить <b>до +${Math.round(OVERSHOOT_PCT * 100)}%</b> кейфраз
      (завершает начатые ветки гипотез) — <b>они тоже списываются</b>, итог может быть до
      ≈${maxTotal.toLocaleString()} кр. (+${Math.round(OVERSHOOT_PCT * 100)}% к оценке).</p>
    ${known ? (enough
      ? `<p class="small check-ok">На балансе ${currentBalance.toLocaleString()} кр. — должно хватить на оценку.</p>`
      : `<div class="quote-short"><span class="check-warn">На балансе ${currentBalance.toLocaleString()} кр. — меньше оценки. Прогон пойдёт и будет списывать по ходу; когда кредиты кончатся — встанет на паузу, пополнишь и продолжишь с этого места.</span> <button type="button" class="primary small" id="quote-topup">Пополнить сейчас</button></div>`)
      : `<p class="small muted">Баланс уточняется…</p>`}`;
  // Списание usage-based, не резерв → форму НЕ блокируем: сервер спишет по факту и сам поставит паузу на нуле.
  box.querySelector("#quote-topup")?.addEventListener("click", openTopup);
}

// ============================================================
// Экран: баланс + леджер (D4)
// ============================================================

async function viewBalance() {
  currentSlug = null;
  app.innerHTML = `<div class="loading">Загрузка…</div>`;
  const b = await api("/api/balance");
  setBalance(b.credits);
  const ledger = Array.isArray(b.ledger) ? b.ledger : [];
  const typeName = { grant: "пополнение", debit: "списание", settle: "финализация", refund: "возврат", chargeback: "чарджбэк" };
  app.innerHTML = `
    <div class="row spread"><h1>Баланс</h1><button class="primary" id="bal-topup-2">Пополнить</button></div>
    <div class="panel">
      <div class="bal-big"><span class="value">${Number(b.credits ?? 0).toLocaleString()}</span> <span class="muted">кредитов</span></div>
      <p class="muted small">1 кредит = $1. Списывается по проверенным кейфразам выборки (D4). Free-tier нет — только пополнение.</p>
    </div>
    <div class="panel">
      <h2>История операций</h2>
      ${ledger.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Тип</th><th class="num">Δ кредитов</th><th>Прогон</th></tr></thead>
        <tbody>${ledger.map((r) => `
          <tr><td class="small">${new Date(r.ts).toLocaleString()}</td>
          <td><span class="badge ${r.delta >= 0 ? "green" : "gray"}">${esc(typeName[r.type] || r.type)}</span></td>
          <td class="num ${r.delta >= 0 ? "score-hi" : "score-zero"}">${r.delta >= 0 ? "+" : ""}${Number(r.delta).toLocaleString()}</td>
          <td class="mono small">${r.runId ? esc(r.runId) : "—"}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">Операций пока нет.</p>`}
    </div>`;
  document.getElementById("bal-topup-2")?.addEventListener("click", openTopup);
}

// ============================================================
// Экран: список прогонов + форма нового прогона (spec 07.4)
// ============================================================

let newRunOpen = false;

async function viewRuns() {
  currentSlug = null;
  const [{ runs }, sf, models] = await Promise.all([api("/api/runs"), getStorefronts(), getModels()]);

  const phaseBadge = (r) => {
    if (r.failed) return `<span class="badge red">ошибка</span>`;
    if (r.paused) return `<span class="badge yellow">⏸ пауза</span>`;
    const names = { created: "создан", context: "контекст", context_review: "ждёт подтверждения", seeding: "посев", loop: "цикл", improving: "улучшение", assembling: "сборка", done: "готово" };
    return `<span class="badge ${r.phase === "done" ? "green" : ""}">${names[r.phase] || r.phase}</span>`;
  };

  app.innerHTML = `
    <div class="row spread">
      <h1>Прогоны</h1>
      <button class="primary" id="new-run">+ Новый прогон</button>
    </div>
    <div id="new-run-form"></div>
    ${runs.length === 0 && !newRunOpen ? `
      <div class="empty-state panel">
        <h2>Загрузи описание своего приложения —<br>получишь лучшие ключевые слова, title и subtitle</h2>
        <p>Нужен текст брифа: что делает апка, для кого, конкуренты, рынок.</p>
        <p><button class="primary" id="new-run-2">Создать первый прогон</button></p>
      </div>` : `
      <div class="cards">
        ${runs.map((r) => `
          <div class="card" data-slug="${esc(r.runId)}">
            <div class="menu row">
              <button class="small danger del" data-slug="${esc(r.runId)}" title="Удалить">✕</button>
            </div>
            <h3>${esc(r.brand)} · ${esc((r.country || "").toUpperCase())}</h3>
            <div class="row">${phaseBadge(r)} <span class="muted small">${new Date(r.updatedAt).toLocaleString()}</span></div>
            <div style="margin:8px 0"><div class="progress"><div style="width:${Math.min(100, (r.sampleCount / (r.sampleSize || 1)) * 100)}%"></div></div>
            <span class="small muted">${r.sampleCount}/${r.sampleSize} проверенных кейвордов</span></div>
            <div class="small muted">${usageLine({ calls: r.usage.calls, inputTokens: r.usage.totalTokens, outputTokens: 0, cacheReadTokens: 0, costUsd: r.usage.costUsd })}</div>
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
      if (!confirm(`Удалить прогон ${b.dataset.slug}?`)) return;
      try { await api(`/api/runs/${encodeURIComponent(b.dataset.slug)}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
      render();
    }));
  if (newRunOpen) renderNewRunForm(sf, models);
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
      <div class="row spread"><h2>Новый прогон</h2><button id="close-form">✕</button></div>
      <label>Бриф: что делает апка, для кого, конкуренты, рынок (минимум 200 символов)</label>
      <textarea id="brief-text" placeholder="Опишите продукт…"></textarea>
      <div class="dropzone" id="dropzone">…или перетащите сюда .md/.txt файл брифа<br><span id="brief-name" class="small"></span></div>
      <input type="file" id="brief-input" accept=".md,.txt,text/*" style="display:none">
      <div class="grid2">
        <div><label>Бренд *</label><input id="f-brand" placeholder="Somna"><div class="field-error" id="e-brand"></div></div>
        <div><label>Страна (storefront)</label><select id="f-country">${Object.keys(sf.storefronts).map((c) => `<option value="${c}" ${c === d.country ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}</select></div>
        <div><label>Язык семантики <span class="pop"><span class="q">?</span><span class="pop-body">Язык, на котором генерируются и оцениваются гипотезы. Автоподставляется по стране, редактируем.</span></span></label>
          <select id="f-semlang">${["en","ru","de","fr","it","es","pt","nl","sv","ja","ko","zh","tr","uk","pl","hi"].map((l) => `<option ${l === d.semanticLanguage ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div><label>Модель</label><select id="f-model">${models.map((m) => `<option value="${esc(m.id)}" ${defModel && m.id === defModel.id ? "selected" : ""}>${esc(m.name)}${m.note ? ` — ${esc(m.note)}` : ""}</option>`).join("") || `<option value="">нет доступных моделей</option>`}</select>
          <div class="hint">мощнее модель → дороже кейфраза</div></div>
      </div>
      <label>Размер выборки (кейфраз): <span id="ss-val">${d.sampleSize}</span></label>
      <input type="range" id="f-samplesize" min="50" max="500" step="10" value="${d.sampleSize}">
      <div id="quote-box" class="quote-box"></div>
      <details class="accordion"><summary>Расширенные настройки</summary>
        <div class="grid2">
          <div><label>batchSize</label><input id="f-batch" type="number" value="${d.batchSize}" min="5" max="50"></div>
          <div><label>exploreRatio</label><input id="f-explore" type="number" value="${d.exploreRatio}" step="0.05" min="0" max="1"></div>
          <div><label>improvementRounds</label><input id="f-rounds" type="number" value="${d.improvementRounds}" min="0" max="10"></div>
          <div><label>serpTop</label><input id="f-serptop" type="number" value="${d.serpTop}" min="3" max="25"></div>
          <div><label>Запросов к Apple в минуту</label><input id="f-rpm" type="number" value="${d.http.requestsPerMinute}" min="1" max="20"></div>
          <div><label>TTL кэша, дней</label><input id="f-ttl" type="number" value="${d.http.cacheTtlDays}" min="0" max="90"></div>
          <div><label>Вторая корзина (кросс-локализация)</label><select id="f-extra"><option value="true" selected>да</option><option value="false">нет</option></select></div>
          <div><label>Свежие данные (игнорировать кэш)</label><select id="f-fresh"><option value="false" selected>нет</option><option value="true">да</option></select></div>
        </div>
        <label>Стоп-слова (через запятую)</label>
        <input id="f-stopwords" value="${esc((d.stopwords || []).join(", "))}">
      </details>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="create-run">Создать прогон</button>
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
  updateQuoteUI(); // первичная отрисовка живого квота

  const dz = el.querySelector("#dropzone"), fi = el.querySelector("#brief-input");
  const loadFile = async (file) => {
    const text = await file.text();
    el.querySelector("#brief-text").value = text;
    el.querySelector("#brief-name").textContent = `✓ ${file.name} (${text.length} симв.)`;
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
    if (!brand) { el.querySelector("#e-brand").textContent = "укажите бренд"; return; }
    if (brief.replace(/\s+/g, " ").trim().length < 200) { errEl.textContent = "Бриф короче 200 осмысленных символов."; return; }
    // D4 v4: списание usage-based в реальном времени, без резерва — старт НЕ гейтим балансом.
    // Сервер спишет по факту произведённых кейфраз и сам поставит паузу «пополни», если кредиты кончатся.
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
// Экран: прогон (spec 07.5)
// ============================================================

let runTab = "overview", lastTopSig = "", lastRunData = null, runUpdating = false;

async function viewRun(slug, subroute) {
  currentSlug = slug;
  if (subroute === "llm") runTab = "llm";
  const shell = document.getElementById("run-shell");
  if (!shell || shell.dataset.slug !== slug) {
    lastTopSig = ""; lastRunData = null;
    app.innerHTML = `<div id="run-shell" data-slug="${esc(slug)}"><div id="run-top"></div><div id="tab-body"><div class="loading">Загрузка…</div></div></div>`;
  }
  await updateRun(slug);
}

async function updateRun(slug) {
  if (runUpdating) return;
  runUpdating = true;
  try {
    const data = await api(`/api/runs/${encodeURIComponent(slug)}`);
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
  // Основной сигнal — структурный код run.paused.code==="credits_out"; текстовый regex — запасной.
  const creditsOut = state.paused && (pauseCodes[slug] === "credits_out" || isCreditsPause(pauseReasons[slug]) || isCreditsPause(state.notice));
  const sig = JSON.stringify([state.phase, state.paused, state.notice, state.failed, state.hintsEndpointDown, data.sampleCount, state.usage, state.http, runTab, context, creditsOut]);
  if (sig === lastTopSig) return;
  lastTopSig = sig;

  const phases = [["context", "Контекст"], ["seeding", "Посев"], ["loop", "Цикл"], ["improving", "Улучшение"], ["assembling", "Сборка"], ["done", "Готово"]];
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
          ${canPause ? `<button id="btn-pause">⏸ Пауза</button>` : ""}
          ${canResume ? `<button class="primary" id="btn-resume">▶ Возобновить</button>` : ""}
          ${canStop ? `<button id="btn-stop">⏹ Остановить и собрать</button>` : ""}
          ${state.phase === "done" ? `<button id="btn-reassemble">↻ Пересобрать</button>` : ""}
        </div>
      </div>
      <div class="stepper" style="margin:10px 0">
        ${phases.map(([id, name], i) => `<span class="step ${i < phaseIdx ? "done" : ""} ${i === phaseIdx ? (state.paused ? "paused" : "active") : ""}">${state.paused && i === phaseIdx ? "⏸ " : ""}${name}</span>${i < phases.length - 1 ? "→" : ""}`).join("")}
      </div>
      <div class="row">
        <div style="flex:1;min-width:200px"><div class="progress"><div style="width:${pct}%"></div></div>
          <span class="small muted">выборка ${data.sampleCount}/${config.sampleSize}</span></div>
        <span class="small pop">${usageLine(state.usage)} <span class="q">?</span>
          <span class="pop-body">${Object.entries(state.usage.byTask || {}).map(([t, u]) => `<div><b>${t}</b>: ${u.calls} выз. · in ${fmtTokens(u.inputTokens)} / out ${fmtTokens(u.outputTokens)}${u.costUsd != null ? ` · $${u.costUsd}` : ""}</div>`).join("") || "разбивка появится по ходу"}</span></span>
        <span class="small muted">Apple: ${state.http.requestsMade} запросов · ${state.http.cacheHits} кэш-хитов</span>
      </div>
      ${creditsOut ? `<div class="banner error credits-out" style="margin-top:10px">
        <div><b>Кредиты кончились.</b> Прогон на паузе — пополни баланс, и он продолжится с этого места (уже сделанное сохранено, D4).${creditReason && !isCreditsPause(state.notice) ? ` <span class="small muted">${esc(creditReason)}</span>` : ""}</div>
        <div class="row" style="margin-top:8px"><button class="primary" id="btn-credit-topup">Пополнить</button>${canResume ? `<button id="btn-credit-resume">▶ Продолжить</button>` : ""}</div>
      </div>` : ""}
      ${state.hintsEndpointDown ? `<div class="banner warn" style="margin-top:10px">Эндпоинт автоподсказок Apple недоступен — Popularity в режиме деградации.</div>` : ""}
      ${state.notice && !creditsOut ? `<div class="banner warn" style="margin-top:10px">${esc(state.notice)}</div>` : ""}
      ${state.failed ? `<div class="banner error" style="margin-top:10px">${esc(state.failed)}</div>` : ""}
    </div>
    ${state.phase === "context_review" ? renderContextReview(context) : ""}
    <div class="tabs">
      <a href="javascript:void 0" data-tab="overview" class="${runTab === "overview" ? "active" : ""}">Обзор</a>
      <a href="javascript:void 0" data-tab="keywords" class="${runTab === "keywords" ? "active" : ""}">Кейворды</a>
      <a href="javascript:void 0" data-tab="assembly" class="${runTab === "assembly" ? "active" : ""}">Сборка</a>
      <a href="javascript:void 0" data-tab="llm" class="${runTab === "llm" ? "active" : ""}">LLM-журнал</a>
    </div>`;

  top.querySelector("#btn-pause")?.addEventListener("click", () => control(slug, "pause"));
  top.querySelector("#btn-resume")?.addEventListener("click", () => control(slug, "resume"));
  top.querySelector("#btn-credit-topup")?.addEventListener("click", openTopup);
  top.querySelector("#btn-credit-resume")?.addEventListener("click", () => control(slug, "resume"));
  top.querySelector("#btn-stop")?.addEventListener("click", () => control(slug, "stopAndAssemble"));
  top.querySelector("#btn-reassemble")?.addEventListener("click", () => control(slug, "reassemble"));
  top.querySelectorAll(".tabs a").forEach((t) =>
    t.addEventListener("click", () => {
      runTab = t.dataset.tab; lastTopSig = "";
      location.hash = runTab === "llm" ? `#/run/${encodeURIComponent(slug)}/llm` : `#/run/${encodeURIComponent(slug)}`;
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
  } catch (e) { alert(e.message); }
}

// ---------- шаг «Контекст» ----------

function renderContextReview(ctx) {
  if (!ctx) return "";
  const field = (name, label, value, multiline) => `
    <div><label>${label}</label>
    ${multiline ? `<textarea data-ctx="${name}">${esc(Array.isArray(value) ? value.join("\n") : value)}</textarea>`
      : `<input data-ctx="${name}" value="${esc(value)}">`}</div>`;
  return `
    <div class="panel" id="ctx-review">
      <h2>Шаг «Контекст»: проверьте, что LLM правильно понял продукт</h2>
      <p class="muted small">Это единственное, что нужно подтвердить — дальше всё само.</p>
      <div class="grid2">
        ${field("productSummary", "Продукт одним абзацем", ctx.productSummary, true)}
        ${field("audience", "Аудитория", ctx.audience, true)}
        ${field("category", "Категория", ctx.category)}
        ${field("targetLanguage", "Язык семантики", ctx.targetLanguage)}
        ${field("jobsToBeDone", "Jobs to be done (по строке)", ctx.jobsToBeDone, true)}
        ${field("featureVocabulary", "Словарь фич (по строке)", ctx.featureVocabulary, true)}
        ${field("competitors", "Конкуренты (по строке)", ctx.competitors, true)}
        ${field("antiSemantics", "Анти-семантика: чем апка НЕ является", ctx.antiSemantics, true)}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="ctx-go">Выглядит верно, поехали →</button>
        <button id="ctx-save">Сохранить правки</button>
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

// ---------- вкладки ----------

async function renderTab(slug, runData) {
  const body = document.getElementById("tab-body");
  if (!body || !runData) return;
  const active = document.activeElement;
  if (active && body.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
  if (runTab === "llm" && body.querySelector("details.llm-call[open]")) return;
  const wrap0 = body.querySelector(".table-wrap");
  const scroll = wrap0 ? { left: wrap0.scrollLeft, top: wrap0.scrollTop } : null;
  const h = body.offsetHeight;
  if (h) body.style.minHeight = h + "px";
  try {
    if (runTab === "overview") await renderOverview(body, slug, runData);
    else if (runTab === "keywords") await renderKeywords(body, slug, runData);
    else if (runTab === "assembly") renderAssembly(body, slug, runData);
    else if (runTab === "llm") await renderLlmLog(body, slug);
  } finally {
    body.style.minHeight = "";
    if (scroll) { const w = body.querySelector(".table-wrap"); if (w) { w.scrollLeft = scroll.left; w.scrollTop = scroll.top; } }
  }
}

async function renderOverview(body, slug, data) {
  const kw = await api(`/api/runs/${encodeURIComponent(slug)}/keywords?sort=score&dir=desc`);
  const top20 = kw.items.filter((k) => (k.metrics.score ?? 0) > 0).slice(0, 20);
  const median = top20.length ? top20[Math.floor(top20.length / 2)].metrics.score : 0;
  const errors = kw.items.filter((k) => k.status === "error").length;
  const cov = data.assembly?.coverage;
  const buckets = new Array(10).fill(0);
  let histTotal = 0;
  for (const k of kw.items) {
    const s = k.metrics.score;
    if (s == null || s <= 0) continue;
    buckets[Math.min(9, Math.floor(s / 10))]++; histTotal++;
  }
  const maxB = Math.max(1, ...buckets);
  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="value">${data.sampleCount}</div><div class="label">размер выборки</div></div>
      <div class="tile"><div class="value">${median ?? 0}</div><div class="label">медианный Score топ-20</div></div>
      <div class="tile"><div class="value">${cov ? Math.round(cov.coveredShare * 100) + "%" : "—"}</div><div class="label">покрыто Score</div></div>
      <div class="tile"><div class="value">${errors}</div><div class="label">ошибок</div></div>
      <div class="tile"><div class="value">${data.state.usage.calls}</div><div class="label">LLM-вызовов</div></div>
    </div>
    <div class="panel"><h2>Живая лента</h2>
      <div class="feed" id="feed">${data.events.map((e) => `<div><span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>${esc(e.kind)} ${esc(e.text)}</div>`).join("") || '<div class="muted">событий пока нет</div>'}</div>
    </div>
    ${histTotal > 0 ? `
    <div class="panel"><h2>Распределение Score (${histTotal} кейвордов с Score > 0)</h2>
      <div class="hist">${buckets.map((b) => `<div class="bar" style="height:${(b / maxB) * 100}%"><span>${b || ""}</span></div>`).join("")}</div>
      <div class="hist-labels">${buckets.map((_, i) => `<div>${i * 10}–${i * 10 + 9}</div>`).join("")}</div>
    </div>` : ""}`;
  const feed = document.getElementById("feed");
  if (feed) feed.scrollTop = feed.scrollHeight;
}

// --- Кейворды ---

async function renderKeywords(body, slug, runData) {
  const params = new URLSearchParams({ sort: kwQuery.sort, dir: kwQuery.dir, page: String(kwQuery.page) });
  if (kwQuery.q) params.set("q", kwQuery.q);
  if (kwQuery.status) params.set("status", kwQuery.status);
  if (kwQuery.source) params.set("source", kwQuery.source);
  const kw = await api(`/api/runs/${encodeURIComponent(slug)}/keywords?${params}`);

  const scoreClass = (s) => s == null ? "" : s >= 50 ? "score-hi" : s >= 25 ? "score-mid" : s >= 1 ? "score-low" : "score-zero";
  const sortArrow = (col) => kwQuery.sort === col ? (kwQuery.dir === "desc" ? " ↓" : " ↑") : "";
  const th = (col, label, num) => `<th data-sort="${col}" class="${num ? "num" : ""}">${label}${sortArrow(col)}</th>`;

  body.innerHTML = `
    <div class="panel">
      <div class="row">
        <input id="kw-q" placeholder="фильтр по тексту" style="max-width:220px" value="${esc(kwQuery.q)}">
        <select id="kw-status" style="max-width:170px"><option value="">все статусы</option>${["candidate", "verified", "rated", "selected", "bench", "excluded", "error"].map((s) => `<option ${kwQuery.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <select id="kw-source" style="max-width:170px"><option value="">все источники</option>${["seed", "suggest", "competitor", "expansion"].map((s) => `<option ${kwQuery.source === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <span class="muted small">${kw.total} кейвордов</span>
      </div>
      <div class="table-wrap">
      <table>
        <thead><tr>
          ${th("keyword", "Кейворд")}${th("score", "Score", true)}${th("P", "P", true)}${th("D", "D", true)}${th("R", "R", true)}
          ${th("status", "Статус")}<th>Источник</th>${th("childCount", "Дети", true)}<th>Обоснование R</th>
        </tr></thead>
        <tbody>
          ${kw.items.map((k) => `
            <tr class="expandable" data-kw="${esc(k.keyword)}">
              <td class="mono">${esc(k.keyword)}${k.speculative ? ' <span class="badge violet">spec</span>' : ""}${k.degraded ? ' <span class="badge yellow">degraded</span>' : ""}${k.metrics.brandQuery ? ' <span class="badge red">бренд</span>' : ""}</td>
              <td class="num ${scoreClass(k.metrics.score)}">${k.metrics.score ?? ""}</td>
              <td class="num">${k.degraded ? "—" : (k.metrics.P ?? "")}</td>
              <td class="num">${k.metrics.D ?? ""}</td>
              <td class="num">${k.metrics.R ?? ""}</td>
              <td><span class="badge ${k.status === "excluded" || k.status === "error" ? "red" : k.status === "selected" ? "green" : "gray"}">${k.status}</span></td>
              <td><span class="badge gray">${esc(k.source)}</span>${k.strategy ? ` <span class="muted small">${k.strategy}</span>` : ""}</td>
              <td class="num">${k.metrics.childCount || ""}</td>
              <td title="${esc(k.metrics.reason ?? "")}" class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.metrics.reason ?? "")}</td>
            </tr>
            ${expandedKeyword === k.keyword ? `<tr class="detail"><td colspan="9" id="kw-detail">Загрузка…</td></tr>` : ""}
          `).join("")}
        </tbody>
      </table>
      </div>
      <div class="row" style="margin-top:10px">
        ${kw.page > 0 ? `<button id="kw-prev">← Назад</button>` : ""}
        <span class="muted small">страница ${kw.page + 1} из ${Math.max(1, Math.ceil(kw.total / kw.pageSize))}</span>
        ${(kw.page + 1) * kw.pageSize < kw.total ? `<button id="kw-next">Вперёд →</button>` : ""}
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
  body.querySelector("#kw-prev")?.addEventListener("click", () => { kwQuery.page--; renderKeywords(body, slug, runData); });
  body.querySelector("#kw-next")?.addEventListener("click", () => { kwQuery.page++; renderKeywords(body, slug, runData); });
  body.querySelectorAll("tr.expandable").forEach((tr) =>
    tr.addEventListener("click", () => {
      expandedKeyword = expandedKeyword === tr.dataset.kw ? null : tr.dataset.kw;
      renderKeywords(body, slug, runData);
    }));

  if (expandedKeyword) {
    const cell = document.getElementById("kw-detail");
    if (cell) {
      try {
        const { item } = await api(`/api/runs/${encodeURIComponent(slug)}/keywords/${encodeURIComponent(expandedKeyword)}`);
        if (!item) { cell.textContent = "кейворд не найден"; return; }
        cell.innerHTML = renderKeywordDetail(item, slug);
        cell.querySelector(".btn-exclude")?.addEventListener("click", async () => {
          if (confirm(`Исключить "${item.keyword}" из прогона?`)) await control(slug, "exclude", { keyword: item.keyword });
        });
      } catch (e) { cell.textContent = e.message; }
    }
  }
}

// Витрина прозрачности ЧИСЕЛ (D9): объяснение P из сырых данных, reason R.
function renderKeywordDetail(k, slug) {
  const m = k.metrics;
  let pExplain;
  if (k.degraded) pExplain = "P недоступен: эндпоинт подсказок не отвечал — Score посчитан с нейтральным P=50.";
  else if (m.unsuggested) pExplain = `P=0: фраза не появилась в автоподсказках ни на одном префиксе — спрос не подтверждён.`;
  else if (m.brandQuery) pExplain = `P=${m.P} — дутый: фраза совпадает с именем непопулярного приложения; реального спроса нет, Score занулён.`;
  else pExplain = `P=${m.P}, потому что фраза появилась в подсказках на префиксе "${esc(k.keyword.slice(0, m.L))}" (${m.L} символов из ${k.keyword.length}) на позиции ${m.rank}.`;
  return `
    <div class="row spread"><h3>${esc(k.keyword)}</h3><button class="danger btn-exclude">⛔ Исключить</button></div>
    <p>${pExplain}${m.childCount ? ` Порождает ${m.childCount} «детей» — long-tail-потенциал.` : ""}</p>
    ${m.R !== null && m.R !== undefined ? `<p><b>R=${m.R}</b>: ${esc(m.reason ?? "")} <a href="#/run/${encodeURIComponent(slug)}/llm">показать LLM-вызов →</a></p>` : ""}
    ${m.topApps?.length ? `
      <h3>Топ-${m.topApps.length} выдачи (serpSize=${m.serpSize}) → D=${m.D}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">#</th><th>Приложение</th><th class="num">Рейтинги</th><th class="num">Оценка</th><th>Обновлено</th><th>Вхождение</th><th>AppStrength</th></tr></thead>
        <tbody>${m.topApps.map((a, i) => `
          <tr><td class="num">${i + 1}</td><td>${esc(a.trackName)}</td>
          <td class="num">${(a.ratingCount || 0).toLocaleString()}</td><td class="num">${(a.rating || 0).toFixed(1)}</td>
          <td>${a.updatedDaysAgo} дн. назад</td>
          <td>${a.match === 1 ? "точное" : a.match === 0.5 ? "все слова" : "нет"}</td>
          <td><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="progress" style="width:120px;flex:none"><div style="width:${a.strength}%"></div></div><span class="num">${a.strength}</span></div></td></tr>`).join("")}
        </tbody></table></div>` : ""}
    ${k.error ? `<p class="check-fail">Ошибка: ${esc(k.error)}</p>` : ""}
    <p class="muted small">статус: ${k.status} · источник: ${k.source}${k.type ? ` · тип: ${k.type}` : ""} · добавлен: ${new Date(k.addedAt).toLocaleString()}${k.probedAt ? ` · обсчитан: ${new Date(k.probedAt).toLocaleString()}` : ""}</p>`;
}

// --- Сборка ---

function renderAssembly(body, slug, data) {
  const asm = data.assembly;
  if (!asm) {
    body.innerHTML = `<div class="panel"><p class="muted">Сборка станет доступна на фазе «assembling». Ускорить: «Остановить и собрать» доступна при выборке ≥ 30.</p></div>`;
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
        <div class="row spread"><h2>${i === 0 ? "Основная локализация" : "Кросс-локализация"} (${esc(b.locale)})</h2></div>
        ${fieldRow("Title", b.title, 30, b.titleWords)}
        ${fieldRow("Subtitle", b.subtitle, 30, b.subtitleWords)}
        ${fieldRow("Keywords", b.keywordFieldDraft, 100, b.speculativeWords)}
        ${b.speculativeWords.length ? `<p class="small"><span class="badge violet">spec</span> спекулятивная добивка: ${b.speculativeWords.map(esc).join(", ")}</p>` : ""}
        <div class="checklist small">${renderChecklist(b.violations)}</div>
      </div>`).join("")}
    <div class="panel">
      <h2>Покрытие: топ-фразы по Score</h2>
      <p class="small muted">Покрыто фраз: ${asm.coverage.phrasesCovered} · Score ${asm.coverage.scoreCovered}/${asm.coverage.scoreTotal} (${Math.round(asm.coverage.coveredShare * 100)}%)</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Фраза</th><th class="num">Score</th><th>Покрыта</th><th>Корзина</th><th>Поля</th><th class="num">PlacementWeight</th></tr></thead>
        <tbody>${asm.coverage.rows.map((r) => `
          <tr><td class="mono">${esc(r.keyword)}</td><td class="num">${r.score}</td>
          <td>${r.covered ? '<span class="check-ok">✓</span>' : '<span class="check-fail">✗</span>'}</td>
          <td>${r.bucket === null ? "—" : r.bucket === 0 ? "основная" : "кросс"}</td>
          <td>${r.fields.map((f) => `<span class="badge gray">${f}</span>`).join(" ")}</td>
          <td class="num">${r.placementWeight || "—"}</td></tr>`).join("")}
        </tbody></table></div>
    </div>
    ${asm.topUncovered.length ? `
    <div class="panel"><h2>Топ непокрытых</h2>
      ${asm.topUncovered.map((u) => `<div class="small">${esc(u.keyword)} <span class="muted">(Score ${u.score}; не хватает: ${u.missingWords.map(esc).join(", ")})</span></div>`).join("")}
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

// --- LLM-журнал (D9: только выходы + числа, НИКАКИХ промптов) ---

let llmPage = 0;
async function renderLlmLog(body, slug) {
  const log = await api(`/api/runs/${encodeURIComponent(slug)}/llm-log?page=${llmPage}`);
  let tIn = 0, tOut = 0, tCache = 0, tCost = 0, hasCost = false;
  for (const e of log.items) {
    tIn += e.tokens?.input ?? 0; tOut += e.tokens?.output ?? 0; tCache += e.tokens?.cacheRead ?? 0;
    if (e.costUsd != null) { tCost += e.costUsd; hasCost = true; }
  }
  body.innerHTML = `
    <div class="panel">
      <h2>Журнал LLM-вызовов <span class="muted small">(${log.total} всего; показываем результат работы и метрики — промпты не раскрываются)</span></h2>
      ${log.items.map((e) => `
        <details class="llm-call">
          <summary>
            <span class="muted small">${new Date(e.ts).toLocaleTimeString()}</span>
            <span class="badge">${esc(e.task)}</span>
            <span class="mono small">${esc(e.model)}</span>
            <span class="small">${((e.durationMs || 0) / 1000).toFixed(1)}s</span>
            <span class="small muted">in ${fmtTokens(e.tokens?.input ?? 0)} / out ${fmtTokens(e.tokens?.output ?? 0)} / cache ${fmtTokens(e.tokens?.cacheRead ?? 0)}</span>
            ${e.costUsd != null ? `<span class="small">$${e.costUsd}</span>` : ""}
            ${e.error ? `<span class="badge red">ошибка</span>` : `<span class="badge green">ok</span>`}
          </summary>
          ${e.error ? `<pre class="check-fail">${esc(e.error)}</pre>` : ""}
          <h3 style="margin:8px 14px 0">${esc(e.stage || "результат")}</h3>
          <pre>${esc(prettyJson(e.output))}</pre>
        </details>`).join("") || `<p class="muted">Вызовов пока не было.</p>`}
      <div class="row" style="margin-top:10px">
        ${llmPage > 0 ? `<button id="llm-prev">← Назад</button>` : ""}
        ${(llmPage + 1) * 50 < log.total ? `<button id="llm-next">Вперёд →</button>` : ""}
        <span class="muted small">на странице: in ${fmtTokens(tIn)} / out ${fmtTokens(tOut)} / cache ${fmtTokens(tCache)}${hasCost ? ` · $${tCost.toFixed(3)}` : ""}</span>
      </div>
    </div>`;
  body.querySelector("#llm-prev")?.addEventListener("click", () => { llmPage--; renderLlmLog(body, slug); });
  body.querySelector("#llm-next")?.addEventListener("click", () => { llmPage++; renderLlmLog(body, slug); });
}
function prettyJson(v) {
  try { return typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { return String(v); }
}

// ---------- старт ----------

startLive();
boot();
