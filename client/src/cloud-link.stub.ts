// DEV-STUB облака (ТОЛЬКО за DEV=1, вне прод-пути). Полностью МОК: держит прогоны/баланс
// в памяти, чтобы localhost-UI поднялся и был кликабелен без облака. Здесь НЕТ проприетарной
// логики — ни формул P/D/Score, ни промптов: все числа синтетические, только для наполнения UI.
// Реальные данные придут по WSS из @aso/server. Прод-сборка сюда не заходит (makeCloudLink).

import type {
  RunSummary, RunAction, BalanceView, TopupResponse, RunState, ModelInfo, TopupPackage,
  BusinessContext, KeywordEntry, LlmLogPublic, AssemblyResult,
} from "@aso/shared";
import type { RelayEvent } from "./cloud-link";
import type { KeywordPage, LlmLogPage, RunSnapshot, KeywordHit, FeedEvent } from "./wire-local";

interface StubRun {
  id: string;
  brand: string;
  country: string;
  phase: RunState["phase"];
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  config: any;
  context: BusinessContext | null;
  keywords: KeywordEntry[];
  events: FeedEvent[];
  llm: LlmLogPublic[];
  assembly: AssemblyResult | null;
  usage: RunState["usage"];
  http: RunState["http"];
  drained: number; // DEV: сколько кейфраз уже «списано» симулятором дренажа
}

export interface StubBackend {
  balanceCredits(): number;
  listRuns(): Promise<RunSummary[]>;
  createRun(brief: string, config: unknown): Promise<{ run_id: string }>;
  getRun(runId: string): Promise<RunSnapshot>;
  listKeywords(runId: string, query: Record<string, string>): Promise<KeywordPage>;
  getKeyword(runId: string, keyword: string): Promise<KeywordHit>;
  getLlmLog(runId: string, page: number): Promise<LlmLogPage>;
  controlRun(runId: string, action: RunAction): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  getBalance(): Promise<BalanceView>;
  getModels(): Promise<ModelInfo[]>;
  getPackages(): Promise<TopupPackage[]>;
  topup(packageId: string): Promise<TopupResponse>;
}

// Синтетический каталог пополнения для оффлайн-UI (истина — серверный query kind="packages").
const DEV_PACKAGES: TopupPackage[] = [
  { id: "small", credits: 500, priceUsd: 500, label: "Старт" },
  { id: "medium", credits: 1500, priceUsd: 1500, label: "Про", bonusPct: 5 },
  { id: "large", credits: 5000, priceUsd: 5000, label: "Студия", bonusPct: 12 },
];

// Синтетический реестр моделей для оффлайн-формы прогона (истина — серверный query kind="models").
const DEV_MODELS: ModelInfo[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", pricePerKeyphrase: 0.02, note: "быстрая, дешёвая (дефолт)" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", pricePerKeyphrase: 0.06 },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", pricePerKeyphrase: 0.18, note: "максимальное качество" },
];

export function makeStubBackend(emit: (ev: RelayEvent) => void): StubBackend {
  const runs = new Map<string, StubRun>();
  const startCredits = Number(process.env.ASO_DEV_CREDITS ?? 500); // DEV: стартовый баланс (ASO_DEV_CREDITS для теста hard-stop)
  let credits = startCredits; // DEV mock-баланс; истина — серверный wallet (D4).
  const ledger: BalanceView["ledger"] = [
    { ts: new Date().toISOString(), type: "grant", delta: startCredits },
  ];
  let counter = 0;

  const now = () => new Date().toISOString();
  const feed = (r: StubRun, kind: string, text: string) => {
    r.events.push({ ts: now(), kind, text });
    r.updatedAt = now();
  };

  function summary(r: StubRun): RunSummary {
    const top = [...r.keywords]
      .filter((k) => (k.metrics.score ?? 0) > 0)
      .sort((a, b) => (b.metrics.score ?? 0) - (a.metrics.score ?? 0))
      .slice(0, 3)
      .map((k) => ({ keyword: k.keyword, score: k.metrics.score ?? 0 }));
    return {
      runId: r.id, brand: r.brand, country: r.country, phase: r.phase, paused: r.paused,
      failed: null, sampleCount: r.keywords.filter((k) => k.status !== "candidate").length,
      sampleSize: r.config.sampleSize ?? 150, updatedAt: r.updatedAt,
      usage: { calls: r.usage.calls, totalTokens: r.usage.inputTokens + r.usage.outputTokens, costUsd: r.usage.costUsd },
      topKeywords: top,
    };
  }

  // Синтетические кейворды (НЕ метрики — случайные числа для наполнения таблицы).
  function seedKeywords(r: StubRun) {
    const base = ["habit tracker", "sleep sounds", "focus timer", "daily planner", "meditation", "water reminder", "mood diary", "budget app", "workout log", "language learn", "recipe box", "photo editor"];
    r.keywords = base.map((kw, i) => {
      const P = (i * 7 + 20) % 100, D = (i * 11 + 30) % 100, R = (i % 4);
      const score = R === 0 ? 0 : Math.round(P * 0.5 * (R / 3));
      return {
        keyword: kw, status: R === 0 ? "excluded" : "rated", source: i % 3 === 0 ? "seed" : "suggest",
        addedAt: now(), probedAt: now(), degraded: false,
        metrics: {
          P, L: (i % 5) + 1, rank: (i % 4) + 1, unsuggested: false, childCount: i % 6,
          D, serpSize: 25, topApps: [], R, reason: `mock: R=${R} для «${kw}»`, score,
        },
      } satisfies KeywordEntry;
    });
  }

  // DEV-симулятор списания в реальном времени (D4 v4): по одной проверенной кейфразе за тик,
  // атомарно уменьшает баланс и шлёт balance-событие → виджет тает живьём. На нуле — пауза
  // «кредиты кончились» (резюмируемо через resume после top-up). НЕ прод — только для оффлайн-UI.
  const draining = new Set<string>();
  function priceFor(model: string): number {
    return (DEV_MODELS.find((m) => m.id === model) || DEV_MODELS[0]).pricePerKeyphrase;
  }
  function startDrain(r: StubRun) {
    if (draining.has(r.id)) return;
    draining.add(r.id);
    const price = priceFor(r.config?.model);
    const targets = r.keywords.filter((k) => k.status === "rated");
    const tick = () => {
      draining.delete(r.id);
      if (r.paused) return; // поставили на паузу извне — стоп
      if (r.drained >= targets.length) {
        if (r.phase === "loop") { r.phase = "improving"; feed(r, "✓", "цикл собран (mock)"); emit({ type: "run-changed", slug: r.id }); }
        return;
      }
      if (credits < price) {
        r.paused = true;
        feed(r, "⛔", "кредиты кончились — пополните, продолжим с этого места");
        emit({ type: "run-paused", slug: r.id, reason: "Кредиты кончились — пополните баланс, продолжим с этого места.", code: "credits_out" });
        emit({ type: "run-changed", slug: r.id });
        return;
      }
      credits = Math.round((credits - price) * 100) / 100;
      ledger.push({ ts: now(), type: "debit", delta: -price, runId: r.id });
      r.drained += 1;
      r.updatedAt = now();
      emit({ type: "balance", credits });
      emit({ type: "run-changed", slug: r.id });
      draining.add(r.id);
      setTimeout(tick, 600);
    };
    setTimeout(tick, 600);
  }

  function fakeAssembly(): AssemblyResult {
    return {
      buckets: [
        { locale: "en-US", titleWords: ["habit", "tracker"], subtitleWords: ["daily", "goals"],
          keywordFieldDraft: "habit,tracker,daily,goals,focus,sleep", title: "Somna: Habit Tracker",
          subtitle: "Build daily goals & focus", budgets: { titleSloganMax: 30, subtitleMax: 30, keywordsMax: 100 },
          speculativeWords: [], violations: [] },
      ],
      coverage: { phrasesCovered: 8, scoreCovered: 240, scoreTotal: 300, coveredShare: 0.8,
        rows: [{ keyword: "habit tracker", score: 54, covered: true, bucket: 0, fields: ["T", "K"], placementWeight: 3 }] },
      topUncovered: [{ keyword: "sleep sounds", score: 30, missingWords: ["sounds"] }],
    };
  }

  function addLlm(r: StubRun, task: string, stage: string, output: unknown) {
    const input = 1200 + Math.floor(Math.random() * 800), out = 300 + Math.floor(Math.random() * 400);
    r.llm.push({
      ts: now(), task, model: r.config.model ?? "claude-haiku", stage, output,
      tokens: { input, output: out, cacheRead: 0 }, costUsd: Number(((input + out) * 0.000003).toFixed(4)),
      durationMs: 800 + Math.floor(Math.random() * 1500),
    });
    r.usage.calls += 1; r.usage.inputTokens += input; r.usage.outputTokens += out;
    r.usage.costUsd = (r.usage.costUsd ?? 0) + (input + out) * 0.000003;
  }

  return {
    balanceCredits: () => credits,

    async listRuns() { return [...runs.values()].map(summary); },

    async createRun(_brief, config) {
      const c: any = config ?? {};
      const id = `run-${Date.now().toString(36)}-${++counter}`;
      const r: StubRun = {
        id, brand: c.brand ?? "Demo", country: c.country ?? "us", phase: "context",
        paused: false, createdAt: now(), updatedAt: now(), config: c, context: null,
        keywords: [], events: [], llm: [], assembly: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, costUsd: 0, byTask: {} },
        http: { requestsMade: 0, cacheHits: 0, throttleWaitMs: 0 },
        drained: 0,
      };
      runs.set(id, r);
      feed(r, "🧠", "context: анализирую бриф (mock)");
      // DEV: контекст мгновенно готов — в реале это LLM-вызов на сервере.
      r.context = {
        productSummary: "Демо-приложение из dev-stub. Реальный контекст придёт с сервера.",
        category: "Productivity", jobsToBeDone: ["строить привычки", "не забывать про воду"],
        audience: "молодые профессионалы", featureVocabulary: ["streak", "reminder", "goal"],
        competitors: ["Streaks", "Habitica"], antiSemantics: "не игра, не соцсеть",
        targetLanguage: c.semanticLanguage ?? "en",
      };
      addLlm(r, "context", "Извлечение бизнес-контекста из брифа", r.context);
      r.phase = "context_review";
      feed(r, "✓", "context готов — жду подтверждения");
      emit({ type: "run-changed", slug: id });
      return { run_id: id };
    },

    async getRun(runId) {
      const r = must(runId);
      const state: Omit<RunState, "keywords"> = {
        runId: r.id, phase: r.phase, paused: r.paused, failed: null, notice: null,
        hintsEndpointDown: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
        context: r.context, usage: r.usage, http: r.http, assembly: r.assembly,
      };
      return {
        state, keywordCount: r.keywords.length,
        sampleCount: r.keywords.filter((k) => k.status !== "candidate").length,
        config: r.config, context: r.context, events: r.events.slice(-100), assembly: r.assembly,
      };
    },

    async listKeywords(runId, query) {
      const r = must(runId);
      let items = [...r.keywords];
      if (query.q) items = items.filter((k) => k.keyword.includes(query.q.toLowerCase()));
      if (query.status) items = items.filter((k) => k.status === query.status);
      if (query.source) items = items.filter((k) => k.source === query.source);
      const sort = query.sort ?? "score", dir = query.dir === "asc" ? 1 : -1;
      items.sort((a, b) => {
        const va = pick(a, sort), vb = pick(b, sort);
        if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * dir;
        return ((va as number) - (vb as number)) * dir;
      });
      const page = Number(query.page ?? 0), pageSize = 100;
      return { total: items.length, page, pageSize, items: items.slice(page * pageSize, (page + 1) * pageSize) };
    },

    async getKeyword(runId, keyword) {
      const r = must(runId);
      return { item: r.keywords.find((k) => k.keyword === keyword) ?? null };
    },

    async getLlmLog(runId, page) {
      const r = must(runId);
      const pageSize = 50;
      return { total: r.llm.length, page, items: r.llm.slice(page * pageSize, (page + 1) * pageSize) };
    },

    async controlRun(runId, action) {
      const r = must(runId);
      switch (action.type) {
        case "pause": r.paused = true; feed(r, "⏸", "пауза"); break;
        case "resume": r.paused = false; feed(r, "▶", "возобновлено"); if (r.phase === "loop") startDrain(r); break;
        case "confirmContext":
          r.phase = "loop"; feed(r, "🌱", "контекст подтверждён → цикл (mock)");
          seedKeywords(r);
          addLlm(r, "seeds", "Генерация seed-кейвордов", r.keywords.slice(0, 5).map((k) => k.keyword));
          addLlm(r, "rate", "Оценка релевантности R", r.keywords.map((k) => ({ keyword: k.keyword, R: k.metrics.R })));
          startDrain(r); // DEV: показать живой дренаж баланса (D4 v4) — списание по кейфразе
          break;
        case "editContext":
          if (r.context) Object.assign(r.context, action.patch);
          feed(r, "✎", "контекст отредактирован");
          break;
        case "exclude": {
          const k = r.keywords.find((x) => x.keyword === action.keyword);
          if (k) { k.status = "excluded"; k.metrics.score = 0; }
          feed(r, "⛔", `исключён «${action.keyword}»`);
          break;
        }
        case "stopAndAssemble":
        case "reassemble":
          r.phase = "assembling"; feed(r, "🧩", "сборка (mock)");
          addLlm(r, "phrase", "Формулировка title/subtitle", { title: "Somna: Habit Tracker" });
          r.assembly = fakeAssembly(); r.phase = "done"; feed(r, "🏁", "готово");
          break;
      }
      r.updatedAt = now();
      emit({ type: "run-changed", slug: runId });
    },

    async deleteRun(runId) { runs.delete(runId); emit({ type: "run-changed", slug: runId }); },

    async getBalance() { return { credits, ledger: [...ledger].reverse() }; },

    async getModels() { return DEV_MODELS.map((m) => ({ ...m })); },

    async getPackages() { return DEV_PACKAGES.map((p) => ({ ...p })); },

    async topup(packageId) {
      // DEV: реальный Stripe Checkout URL приходит с сервера по HTTPS; тут — фейковый.
      const pkg = DEV_PACKAGES.find((p) => p.id === packageId);
      const grant = pkg ? Math.round(pkg.credits * (1 + (pkg.bonusPct ?? 0) / 100)) : 500;
      credits += grant;
      ledger.push({ ts: now(), type: "grant", delta: grant });
      emit({ type: "balance", credits });
      return { checkoutUrl: `https://checkout.stripe.com/dev-stub?package=${encodeURIComponent(packageId)}&grant=${grant}` };
    },
  };

  function must(runId: string): StubRun {
    const r = runs.get(runId);
    if (!r) throw new Error(`прогон не найден: ${runId}`);
    return r;
  }
  function pick(k: KeywordEntry, sort: string): number | string {
    switch (sort) {
      case "keyword": return k.keyword;
      case "P": return k.metrics.P ?? -1;
      case "D": return k.metrics.D ?? -1;
      case "R": return k.metrics.R ?? -1;
      case "childCount": return k.metrics.childCount ?? 0;
      case "status": return k.status;
      default: return k.metrics.score ?? -1;
    }
  }
}
