// Cloud DEV-STUB (ONLY behind DEV=1, outside the prod path). Fully MOCK: holds runs/balance
// in memory so the localhost UI comes up and is clickable without the cloud. There is NO proprietary
// logic here — no P/D/Score formulas, no prompts: all numbers are synthetic, just to populate the UI.
// Real data will arrive over WSS from @aso/server. The prod build never enters here (makeCloudLink).

import type {
  RunSummary, RunAction, BalanceView, TopupResponse, RunState, ModelInfo, TopupPackage,
  BusinessContext, KeywordEntry, LlmLogPublic, AssemblyResult,
  KeywordsLiteView, CompetitorsView, ExportFormat, ExportArtifact,
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
  drained: number; // DEV: how many keyphrases the drain simulator has already "debited"
}

export interface StubBackend {
  balanceCredits(): number;
  listRuns(): Promise<RunSummary[]>;
  createRun(brief: string, config: unknown): Promise<{ run_id: string }>;
  getRun(runId: string): Promise<RunSnapshot>;
  listKeywords(runId: string, query: Record<string, unknown>): Promise<KeywordPage>;
  getKeyword(runId: string, keyword: string): Promise<KeywordHit>;
  getLlmLog(runId: string, page: number): Promise<LlmLogPage>;
  controlRun(runId: string, action: RunAction): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  getBalance(): Promise<BalanceView>;
  getModels(): Promise<ModelInfo[]>;
  getPackages(): Promise<TopupPackage[]>;
  topup(packageId: string): Promise<TopupResponse>;
  // spec 09 (mock projections — real aggregation lives on the server)
  keywordsLite(runId: string): Promise<KeywordsLiteView>;
  competitors(runId: string): Promise<CompetitorsView>;
  exportArtifact(runId: string, format: ExportFormat, ann?: { pinned?: string[]; notes?: Record<string, string> }): Promise<ExportArtifact>;
}

// Synthetic top-up catalog for the offline UI (source of truth — server query kind="packages").
const DEV_PACKAGES: TopupPackage[] = [
  { id: "small", credits: 500, priceUsd: 500, label: "Starter" },
  { id: "medium", credits: 1500, priceUsd: 1500, label: "Pro", bonusPct: 5 },
  { id: "large", credits: 5000, priceUsd: 5000, label: "Studio", bonusPct: 12 },
];

// Synthetic model registry for the offline run form (source of truth — server query kind="models").
const DEV_MODELS: ModelInfo[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", pricePerKeyphrase: 0.02, note: "fast, cheap (default)" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", pricePerKeyphrase: 0.06 },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", pricePerKeyphrase: 0.18, note: "maximum quality" },
];

export function makeStubBackend(emit: (ev: RelayEvent) => void): StubBackend {
  const runs = new Map<string, StubRun>();
  const startCredits = Number(process.env.ASO_DEV_CREDITS ?? 500); // DEV: starting balance (ASO_DEV_CREDITS for hard-stop testing)
  let credits = startCredits; // DEV mock balance; source of truth — server wallet (D4).
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

  // Synthetic keywords (NOT metrics — random numbers to populate the table).
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
          D, serpSize: 25, topApps: [], R, reason: `mock: R=${R} for "${kw}"`, score,
        },
      } satisfies KeywordEntry;
    });
  }

  // DEV real-time debit simulator (D4 v4): one probed keyphrase per tick,
  // atomically decrements the balance and emits a balance event → the widget melts live. At zero — pause
  // "out of credits" (resumable via resume after top-up). NOT prod — offline UI only.
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
      if (r.paused) return; // paused externally — stop
      if (r.drained >= targets.length) {
        if (r.phase === "loop") { r.phase = "improving"; feed(r, "✓", "loop assembled (mock)"); emit({ type: "run-changed", slug: r.id }); }
        return;
      }
      if (credits < price) {
        r.paused = true;
        feed(r, "⛔", "out of credits — top up and we'll continue from here");
        emit({ type: "run-paused", slug: r.id, reason: "Out of credits — top up your balance and we'll continue from here.", code: "credits_out" });
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
      feed(r, "🧠", "context: analyzing the brief (mock)");
      // DEV: context is ready instantly — in reality this is an LLM call on the server.
      r.context = {
        productSummary: "Demo app from the dev-stub. The real context will come from the server.",
        category: "Productivity", jobsToBeDone: ["build habits", "remember to drink water"],
        audience: "young professionals", featureVocabulary: ["streak", "reminder", "goal"],
        competitors: ["Streaks", "Habitica"], antiSemantics: "not a game, not a social network",
        targetLanguage: c.semanticLanguage ?? "en",
      };
      addLlm(r, "context", "Extracting business context from the brief", r.context);
      r.phase = "context_review";
      feed(r, "✓", "context ready — awaiting confirmation");
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
      const creditsSpent = Math.round(ledger
        .filter((l) => l.type === "debit" && l.runId === r.id)
        .reduce((s, l) => s + Math.abs(l.delta), 0) * 100) / 100;
      return {
        state, keywordCount: r.keywords.length,
        sampleCount: r.keywords.filter((k) => k.status !== "candidate").length,
        creditsSpent,
        config: r.config, context: r.context, events: r.events.slice(-100), assembly: r.assembly,
      };
    },

    async listKeywords(runId, query) {
      const r = must(runId);
      let items = [...r.keywords];
      if (query.q) items = items.filter((k) => k.keyword.includes(String(query.q).toLowerCase()));
      if (query.status) items = items.filter((k) => k.status === query.status);
      if (query.source) items = items.filter((k) => k.source === query.source);
      if (query.insight === "brandQuery") items = items.filter((k) => k.metrics.brandQuery === true);
      else if (query.insight === "unsuggested") items = items.filter((k) => k.metrics.unsuggested === true);
      else if (query.insight === "degraded") items = items.filter((k) => k.degraded === true);
      if (Array.isArray(query.only)) {
        const only = new Set((query.only as unknown[]).map((s) => String(s)));
        items = items.filter((k) => only.has(k.keyword));
      }
      const sort = String(query.sort ?? "score"), dir = query.dir === "asc" ? 1 : -1;
      items.sort((a, b) => {
        const va = pick(a, sort), vb = pick(b, sort);
        if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * dir;
        return ((va as number) - (vb as number)) * dir;
      });
      const page = Number(query.page ?? 0), pageSize = 100;
      return { total: items.length, page, pageSize, items: items.slice(page * pageSize, (page + 1) * pageSize) };
    },

    // ── spec 09 mock projections (real logic lives on the server) ──────────

    async keywordsLite(runId) {
      const r = must(runId);
      return {
        items: r.keywords.map((k) => ({
          keyword: k.keyword, score: k.metrics.score ?? null, P: k.metrics.P ?? null,
          D: k.metrics.D ?? null, R: k.metrics.R ?? null, status: k.status, source: k.source,
          childCount: k.metrics.childCount ?? 0, brandQuery: k.metrics.brandQuery === true,
          unsuggested: k.metrics.unsuggested === true, degraded: k.degraded === true,
          ...(k.probedAt ? { probedAt: k.probedAt } : {}),
        })),
      };
    },

    async competitors(runId) {
      must(runId); // stub topApps are empty → an honest empty landscape
      return { items: [], summary: { distinctApps: 0, medianStrength: null, openDoors: 0, keywordsWithSerp: 0 } };
    },

    async exportArtifact(runId, format) {
      const r = must(runId);
      const date = new Date().toISOString().slice(0, 10);
      const slug = (r.brand || "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
      const filename = `${slug}-${r.country}-${date}.${format}`;
      const mime = { csv: "text/csv; charset=utf-8", md: "text/markdown; charset=utf-8", json: "application/json; charset=utf-8", html: "text/html; charset=utf-8" }[format];
      const content = format === "json"
        ? JSON.stringify({ devStub: true, runId, keywords: r.keywords }, null, 2)
        : `dev-stub export (${format}) for ${runId} — real artifacts come from the cloud\n`;
      return { filename, mime, content };
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
        case "pause": r.paused = true; feed(r, "⏸", "paused"); break;
        case "resume": r.paused = false; feed(r, "▶", "resumed"); if (r.phase === "loop") startDrain(r); break;
        case "confirmContext":
          r.phase = "loop"; feed(r, "🌱", "context confirmed → loop (mock)");
          seedKeywords(r);
          addLlm(r, "seeds", "Generating seed keywords", r.keywords.slice(0, 5).map((k) => k.keyword));
          addLlm(r, "rate", "Rating relevance R", r.keywords.map((k) => ({ keyword: k.keyword, R: k.metrics.R })));
          startDrain(r); // DEV: show the live balance drain (D4 v4) — per-keyphrase debit
          break;
        case "editContext":
          if (r.context) Object.assign(r.context, action.patch);
          feed(r, "✎", "context edited");
          break;
        case "exclude": {
          const k = r.keywords.find((x) => x.keyword === action.keyword);
          if (k) { k.status = "excluded"; k.metrics.score = 0; }
          feed(r, "⛔", `excluded "${action.keyword}"`);
          break;
        }
        case "stopAndAssemble":
        case "reassemble":
          r.phase = "assembling"; feed(r, "🧩", "assembly (mock)");
          addLlm(r, "phrase", "Phrasing title/subtitle", { title: "Somna: Habit Tracker" });
          r.assembly = fakeAssembly(); r.phase = "done"; feed(r, "🏁", "done");
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
      // DEV: the real Stripe Checkout URL comes from the server over HTTPS; this one is fake.
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
    if (!r) throw new Error(`run not found: ${runId}`);
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
