// Cloud DEV-STUB (ONLY behind DEV=1, outside the prod path). Fully MOCK: holds runs/balance
// in memory so the localhost UI comes up and is clickable without the cloud. There is NO proprietary
// logic here — no P/D/Score formulas, no prompts: all numbers are synthetic, just to populate the UI.
// Real data will arrive over WSS from @aso/server. The prod build never enters here (makeCloudLink).

import type {
  RunSummary, RunAction, BalanceView, TopupRequest, TopupResponse, RunState, ModelInfo, TopupPackage,
  TopupCatalog, BusinessContext, KeywordEntry, LlmLogPublic, AssemblyResult,
  KeywordsLiteView, CompetitorsView, ExportFormat, ExportArtifact, RunQuote,
  ProjectOp, ProjectCard, ProjectView, ProjectBankPage, ProjectPositionsView,
  MetadataVersion, MetadataLocaleFields, ProjectBankRow, MarketSlot, ProjectSuggestion,
} from "@aso/shared";
import type { RelayEvent } from "./cloud-link";
import type { KeywordPage, LlmLogPage, RunSnapshot, KeywordHit, FeedEvent } from "./wire-local";

interface StubRun {
  id: string;
  projectId: string;
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

interface StubProject {
  id: string;
  name: string;
  brand: string;
  appStoreId: number | null;
  archived: boolean;
  context: BusinessContext | null;
  versions: MetadataVersion[];
  liveVersion: number | null;
  createdAt: string;
  updatedAt: string;
  bank: Map<string, ProjectBankRow>; // key: storefront|language|keyword
  positions: Array<{ storefront: string; keyword: string; position: number | null; serpSize: number | null; checkedAt: string }>;
}

export interface StubBackend {
  balanceCredits(): number;
  listRuns(): Promise<RunSummary[]>;
  createRun(brief: string, config: unknown, projectId: string): Promise<{ run_id: string }>;
  getRun(runId: string): Promise<RunSnapshot>;
  listKeywords(runId: string, query: Record<string, unknown>): Promise<KeywordPage>;
  getKeyword(runId: string, keyword: string): Promise<KeywordHit>;
  getLlmLog(runId: string, page: number): Promise<LlmLogPage>;
  controlRun(runId: string, action: RunAction): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  getBalance(): Promise<BalanceView>;
  getModels(): Promise<ModelInfo[]>;
  getQuote(sampleSize: number, model: string): Promise<RunQuote>;
  getPackages(): Promise<TopupCatalog>;
  topup(selection: TopupRequest): Promise<TopupResponse>;
  // spec 09 (mock projections — real aggregation lives on the server)
  keywordsLite(runId: string): Promise<KeywordsLiteView>;
  competitors(runId: string): Promise<CompetitorsView>;
  exportArtifact(runId: string, format: ExportFormat, ann?: { pinned?: string[]; notes?: Record<string, string> }): Promise<ExportArtifact>;
  // spec 10 (mock projects — real logic lives on the server)
  listProjects(): Promise<ProjectCard[]>;
  getProject(projectId: string): Promise<ProjectView>;
  getProjectBank(projectId: string, query: Record<string, unknown>): Promise<ProjectBankPage>;
  getProjectPositions(projectId: string, storefront?: string): Promise<ProjectPositionsView>;
  projectExport(projectId: string, format: "csv" | "json"): Promise<ExportArtifact>;
  projectOp(op: ProjectOp): Promise<unknown>;
}

// Synthetic market slots for the offline coverage grid (the REAL curated table is server-side).
const DEV_MARKETS: MarketSlot[] = [
  { locale: "en-US", country: "us", language: "en", name: "United States", tier: 1, note: "the largest store" },
  { locale: "ja-JP", country: "jp", language: "ja", name: "Japan", tier: 1, note: "2nd by revenue; low English competition" },
  { locale: "de-DE", country: "de", language: "de", name: "Germany", tier: 1, note: "largest EU store" },
  { locale: "en-GB", country: "gb", language: "en", name: "United Kingdom", tier: 1, note: "distinct suggest index from the US" },
  { locale: "es-MX", country: "mx", language: "es", name: "Mexico (Spanish)", tier: 2, note: "es-MX also indexes on the US storefront" },
  { locale: "fr-FR", country: "fr", language: "fr", name: "France", tier: 2, note: "" },
];
const DEV_POSITIONS_FEE = 0.002;

// Synthetic top-up catalog for the offline UI (source of truth — server query kind="packages").
const DEV_PACKAGES: TopupPackage[] = [
  { id: "small", credits: 500, priceUsd: 500, label: "Starter" },
  { id: "medium", credits: 1500, priceUsd: 1500, label: "Pro", bonusPct: 5 },
  { id: "large", credits: 5000, priceUsd: 5000, label: "Studio", bonusPct: 12 },
];

// Custom top-up bounds the stub advertises AND enforces (mirrors the server defaults).
const STUB_CUSTOM = { minCredits: 5, maxCredits: 500, usdPerCredit: 1 };

// Synthetic model registry for the offline run form (source of truth — server query kind="models").
const DEV_MODELS: ModelInfo[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", pricePerKeyphrase: 0.02, note: "fast, cheap (default)" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", pricePerKeyphrase: 0.06 },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", pricePerKeyphrase: 0.18, note: "maximum quality" },
];

export function makeStubBackend(emit: (ev: RelayEvent) => void): StubBackend {
  const runs = new Map<string, StubRun>();
  const projects = new Map<string, StubProject>();
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
      runId: r.id, projectId: r.projectId || null, brand: r.brand, country: r.country, phase: r.phase, paused: r.paused,
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

  function fakeAssembly(r: StubRun): AssemblyResult {
    const brand = r.brand || "Somna";
    const locale = `${r.config.semanticLanguage ?? "en"}-${(r.country || "us").toUpperCase()}`;
    return {
      buckets: [
        { locale, titleWords: ["habit", "tracker"], subtitleWords: ["daily", "goals"],
          keywordFieldDraft: "habit,tracker,daily,goals,focus,sleep", title: `${brand}: Habit Tracker`,
          subtitle: "Build daily goals & focus", budgets: { titleSloganMax: 30, subtitleMax: 30, keywordsMax: 100 },
          speculativeWords: [], violations: [] },
      ],
      coverage: { phrasesCovered: 8, scoreCovered: 240, scoreTotal: 300, coveredShare: 0.8,
        rows: [{ keyword: "habit tracker", score: 54, covered: true, bucket: 0, fields: ["T", "K"], placementWeight: 3 }] },
      topUncovered: [{ keyword: "sleep sounds", score: 30, missingWords: ["sounds"] }],
    };
  }

  // ── projects (spec 10 DEV mirror; the real logic lives on the server) ────

  const mustProject = (projectId: string): StubProject => {
    const p = projects.get(projectId);
    if (!p) throw new Error(`project not found: ${projectId}`);
    return p;
  };
  const latestVersion = (p: StubProject): MetadataVersion | null =>
    p.versions.length ? p.versions[p.versions.length - 1] : null;
  const bankKey = (sf: string, lang: string, kw: string) => `${sf}|${lang}|${kw}`;
  const parseTrackId = (input: string): number => {
    const s = String(input).trim();
    if (/^\d{5,}$/.test(s)) return Number(s);
    const m = s.match(/id(\d+)/i);
    if (m) return Number(m[1]);
    throw new Error("could not parse an App Store id — paste the apps.apple.com URL or the numeric id");
  };
  const appendVersion = (p: StubProject, build: (prev: MetadataVersion | null, v: number) => MetadataVersion): MetadataVersion => {
    const prev = latestVersion(p);
    const version = build(prev, (prev?.v ?? 0) + 1);
    p.versions.push(version);
    while (p.versions.length > 100) {
      const idx = p.versions.findIndex((v) => v.v !== p.liveVersion);
      if (idx < 0) break;
      p.versions.splice(idx, 1);
    }
    p.updatedAt = now();
    return version;
  };
  const mergeLocales = (prev: MetadataVersion | null, patch: Record<string, Partial<MetadataLocaleFields>>) => {
    const out: Record<string, MetadataLocaleFields> = {};
    for (const [l, f] of Object.entries(prev?.locales ?? {})) out[l] = { ...f };
    for (const [l, f] of Object.entries(patch)) {
      const base = out[l] ?? { title: "", subtitle: "", keywords: "" };
      out[l] = {
        title: f.title !== undefined ? String(f.title) : base.title,
        subtitle: f.subtitle !== undefined ? String(f.subtitle) : base.subtitle,
        keywords: f.keywords !== undefined ? String(f.keywords) : base.keywords,
      };
    }
    return out;
  };
  const proposalLocalesOf = (r: StubRun): Record<string, MetadataLocaleFields> | null => {
    if (!r.assembly) return null;
    const out: Record<string, MetadataLocaleFields> = {};
    for (const b of r.assembly.buckets) out[b.locale] = { title: b.title ?? "", subtitle: b.subtitle ?? "", keywords: b.keywordFieldDraft ?? "" };
    return out;
  };
  const projectRuns = (projectId: string): StubRun[] =>
    [...runs.values()].filter((r) => r.projectId === projectId);
  const projectProposals = (p: StubProject) => {
    const applied = new Set(p.versions.filter((v) => v.source.type === "run" && v.source.runId).map((v) => v.source.runId));
    return projectRuns(p.id)
      .filter((r) => r.phase === "done" && r.assembly && !applied.has(r.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({ runId: r.id, ts: r.updatedAt, locales: proposalLocalesOf(r)! }));
  };
  const trackedFor = (p: StubProject, storefront: string): string[] => {
    const out = new Set<string>();
    const current = latestVersion(p);
    if (current) {
      for (const [locale, f] of Object.entries(current.locales)) {
        if ((locale.split("-")[1] ?? "").toLowerCase() !== storefront) continue;
        for (const kw of f.keywords.split(",")) { const k = kw.trim().toLowerCase(); if (k) out.add(k); }
      }
    }
    for (const row of p.bank.values()) if (row.storefront === storefront && row.pinned && !row.hidden) out.add(row.keyword);
    return [...out].slice(0, 50);
  };
  const projectCard = (p: StubProject): ProjectCard => {
    const rs = projectRuns(p.id);
    const current = latestVersion(p);
    return {
      id: p.id, name: p.name, brand: p.brand, appStoreId: p.appStoreId, archived: p.archived,
      localesCovered: current ? Object.keys(current.locales) : [],
      bankCount: p.bank.size,
      lastActivityTs: [p.updatedAt, ...rs.map((r) => r.updatedAt)].sort().at(-1)!,
      runCount: rs.length,
      liveVersion: p.liveVersion,
      latestVersion: current?.v ?? null,
    };
  };
  /** Bank upsert on run completion (metrics refresh; pinned/hidden/firstSeen preserved). */
  const upsertBankFromRun = (r: StubRun) => {
    const p = projects.get(r.projectId);
    if (!p) return;
    const sf = r.country || "us", lang = r.config.semanticLanguage ?? "en";
    const ts = now();
    for (const k of r.keywords) {
      if (k.metrics.D == null) continue;
      const key = bankKey(sf, lang, k.keyword);
      const existing = p.bank.get(key);
      const metrics = { P: k.metrics.P, D: k.metrics.D, R: k.metrics.R, score: k.metrics.score, status: k.status, reason: k.metrics.reason, runId: r.id, ts };
      if (existing) { existing.metrics = metrics; existing.updatedAt = ts; }
      else p.bank.set(key, { storefront: sf, language: lang, keyword: k.keyword, metrics, pinned: false, hidden: false, firstSeen: ts, updatedAt: ts });
    }
    p.updatedAt = ts;
    feed(r, "📦", "metadata proposal ready — review & save on the project page");
  };

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

    async createRun(_brief, config, projectId) {
      // spec 10: runs require a project — mirror the server rejection so DEV surfaces the bug.
      const project = mustProject(String(projectId ?? ""));
      const c: any = config ?? {};
      const id = `run-${Date.now().toString(36)}-${++counter}`;
      const r: StubRun = {
        id, projectId: project.id, brand: c.brand ?? project.brand ?? "Demo", country: c.country ?? "us", phase: "context",
        paused: false, createdAt: now(), updatedAt: now(), config: c, context: null,
        keywords: [], events: [], llm: [], assembly: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, costUsd: 0, byTask: {} },
        http: { requestsMade: 0, cacheHits: 0, throttleWaitMs: 0 },
        drained: 0,
      };
      runs.set(id, r);
      if (project.context) {
        // Context seeding (spec 10 §2): the project context skips extraction; user still reviews.
        r.context = { ...project.context, targetLanguage: c.semanticLanguage ?? project.context.targetLanguage };
        feed(r, "🧠", "using project context — review or edit, then confirm");
      } else {
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
      }
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
        case "confirmContext": {
          // spec 10 §2: the first confirmed context seeds the project (no clobber).
          const proj = projects.get(r.projectId);
          if (proj && !proj.context && r.context) { proj.context = { ...r.context }; proj.updatedAt = now(); }
          r.phase = "loop"; feed(r, "🌱", "context confirmed → loop (mock)");
          seedKeywords(r);
          addLlm(r, "seeds", "Generating seed keywords", r.keywords.slice(0, 5).map((k) => k.keyword));
          addLlm(r, "rate", "Rating relevance R", r.keywords.map((k) => ({ keyword: k.keyword, R: k.metrics.R })));
          startDrain(r); // DEV: show the live balance drain (D4 v4) — per-keyphrase debit
          break;
        }
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
          addLlm(r, "phrase", "Phrasing title/subtitle", { title: `${r.brand}: Habit Tracker` });
          r.assembly = fakeAssembly(r); r.phase = "done"; feed(r, "🏁", "done");
          upsertBankFromRun(r); // spec 10 §2: measured keywords land in the project bank
          break;
      }
      r.updatedAt = now();
      emit({ type: "run-changed", slug: runId });
    },

    async deleteRun(runId) { runs.delete(runId); emit({ type: "run-changed", slug: runId }); },

    async getBalance() { return { credits, ledger: [...ledger].reverse() }; },

    async getModels() { return DEV_MODELS.map((m) => ({ ...m })); },

    async getQuote(sampleSize, model) {
      // DEV mirror of the server curve: linear + progressive tail.
      const mult = model.includes("fable") ? 7.5 : model.includes("opus") ? 4 : model.includes("sonnet") ? 2.5 : 1;
      const quote = Math.max(1, Math.ceil(mult * (0.0276 * sampleSize + 0.0000113 * sampleSize * sampleSize)));
      return { sampleSize, model, pricePerKeyphrase: Math.round((quote / sampleSize) * 10_000) / 10_000, quote, overshootPct: 0.1 };
    },

    async getPackages(): Promise<TopupCatalog> {
      return {
        packages: DEV_PACKAGES.map((p) => ({ ...p })),
        custom: { ...STUB_CUSTOM },
      };
    },

    // ── spec 10: projects (mock; suggestions/coverage simplified, real logic server-side) ──

    async listProjects() {
      return [...projects.values()].map(projectCard).sort((a, b) => b.lastActivityTs.localeCompare(a.lastActivityTs));
    },

    async getProject(projectId) {
      const p = mustProject(projectId);
      const current = latestVersion(p);
      const covered = current?.locales ?? {};
      const proposals = projectProposals(p);
      const quote = 5; // synthetic estimate for empty slots (real: quoteFor(150, lastModel))

      const coverage = DEV_MARKETS.map((m) => covered[m.locale]
        ? { locale: m.locale, covered: true, market: m, fields: covered[m.locale], staleDays: 0 }
        : { locale: m.locale, covered: false, market: m, estimateCredits: quote });
      for (const locale of Object.keys(covered)) {
        if (!DEV_MARKETS.some((m) => m.locale === locale)) coverage.push({ locale, covered: true, fields: covered[locale], staleDays: 0 } as any);
      }

      const suggestions: ProjectSuggestion[] = [];
      if (!p.appStoreId) suggestions.push({ kind: "link-app", title: "Link your App Store listing", detail: "Paste the apps.apple.com URL to verify real rankings — free.", action: { go: "settings" } });
      if (proposals[0]) suggestions.push({ kind: "apply-run", title: `Run ${proposals[0].runId.slice(0, 10)} produced metadata for ${Object.keys(proposals[0].locales).join(", ")}`, detail: "Review the proposed metadata and save it to the board.", action: { go: "apply", runId: proposals[0].runId } });
      for (const slot of coverage.filter((s) => !s.covered).slice(0, 2)) {
        const m = (slot as any).market as MarketSlot;
        suggestions.push({ kind: "new-locale", title: `Research ${m.name} (${m.locale})`, detail: `${m.note ? m.note + ". " : ""}Tier ${m.tier} market.`, credits: quote, action: { go: "new-run", country: m.country, language: m.language, locale: m.locale } });
      }
      if (p.liveVersion != null && p.appStoreId && !p.positions.length) {
        suggestions.push({ kind: "check-positions", title: "Verify your rankings", detail: "Your live metadata has never been rank-checked.", credits: 0.1, action: { go: "positions" } });
      }

      const posSummary = p.positions.length ? (() => {
        const bySf = new Map<string, typeof p.positions>();
        for (const r of p.positions) { const l = bySf.get(r.storefront) ?? []; l.push(r); bySf.set(r.storefront, l); }
        return [...bySf.entries()].map(([storefront, rows]) => {
          const newest = rows.map((r) => r.checkedAt).sort().at(-1)!;
          const latest = rows.filter((r) => r.checkedAt === newest);
          return { storefront, checkedAt: newest, tracked: latest.length, ranked: latest.filter((r) => r.position != null).length, top10: latest.filter((r) => r.position != null && r.position! <= 10).length };
        });
      })() : undefined;

      return {
        ...projectCard(p),
        createdAt: p.createdAt,
        context: p.context,
        versionsSummary: [...p.versions].reverse().map((v) => ({ v: v.v, ts: v.ts, note: v.note, source: v.source, localeCount: Object.keys(v.locales).length, isLive: p.liveVersion === v.v })),
        current,
        coverage,
        suggestions: suggestions.slice(0, 4),
        proposals,
        positionsSummary: posSummary,
      };
    },

    async getProjectBank(projectId, query) {
      const p = mustProject(projectId);
      let items = [...p.bank.values()];
      const buckets = new Map<string, { storefront: string; language: string; count: number }>();
      for (const r of items) {
        const key = `${r.storefront}|${r.language}`;
        const b = buckets.get(key) ?? { storefront: r.storefront, language: r.language, count: 0 };
        b.count++; buckets.set(key, b);
      }
      if (query.storefront) items = items.filter((r) => r.storefront === query.storefront);
      if (query.language) items = items.filter((r) => r.language === query.language);
      const hiddenCount = items.filter((r) => r.hidden).length;
      if (String(query.showHidden ?? "") !== "1") items = items.filter((r) => !r.hidden);
      if (query.q) items = items.filter((r) => r.keyword.includes(String(query.q).toLowerCase()));
      if (String(query.pinned ?? "") === "1") items = items.filter((r) => r.pinned);
      const sort = String(query.sort ?? "score"), dir = String(query.dir ?? "desc") === "asc" ? 1 : -1;
      const val = (r: ProjectBankRow): number | string => {
        switch (sort) {
          case "keyword": return r.keyword;
          case "P": return r.metrics.P ?? -1;
          case "D": return r.metrics.D ?? -1;
          case "R": return r.metrics.R ?? -1;
          case "status": return r.metrics.status;
          case "updated": return r.updatedAt;
          default: return r.metrics.score ?? -1;
        }
      };
      items.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const va = val(a), vb = val(b);
        return va < vb ? -dir : va > vb ? dir : 0;
      });
      const pageSize = 50, page = Math.max(0, Number(query.page ?? 0));
      return {
        total: items.length, page, pageSize,
        buckets: [...buckets.values()], hiddenCount,
        items: items.slice(page * pageSize, (page + 1) * pageSize).map((r) => ({ ...r, metrics: { ...r.metrics } })),
      };
    },

    async getProjectPositions(projectId, storefront) {
      const p = mustProject(projectId);
      const storefronts = [...new Set(p.positions.map((r) => r.storefront))];
      const current = latestVersion(p);
      const sf = storefront || storefronts[0] || (current ? Object.keys(current.locales)[0]?.split("-")[1]?.toLowerCase() : "") || "us";
      const tracked = trackedFor(p, sf);
      const rows = p.positions.filter((r) => r.storefront === sf);
      const byKw = new Map<string, typeof rows>();
      for (const r of rows) { const l = byKw.get(r.keyword) ?? []; l.push(r); byKw.set(r.keyword, l); }
      const keywords = [...new Set([...tracked, ...byKw.keys()])];
      const items = keywords.map((keyword) => {
        const history = (byKw.get(keyword) ?? []).slice(-10).reverse();
        const latest = history[0], prev = history[1];
        return {
          keyword,
          position: latest?.position ?? null,
          serpSize: latest?.serpSize ?? null,
          checkedAt: latest?.checkedAt ?? "",
          delta: latest?.position != null && prev?.position != null ? prev.position - latest.position : null,
          history: history.map((h) => ({ position: h.position, checkedAt: h.checkedAt })),
        };
      }).sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || a.keyword.localeCompare(b.keyword));
      return {
        storefront: sf, storefronts, tracked,
        checkedAt: rows.map((r) => r.checkedAt).sort().at(-1) ?? null,
        items,
        feePerKeyword: DEV_POSITIONS_FEE,
        estimateCredits: Math.round(tracked.length * DEV_POSITIONS_FEE * 100) / 100,
      };
    },

    async projectExport(projectId, format) {
      const p = mustProject(projectId);
      const current = latestVersion(p);
      const date = new Date().toISOString().slice(0, 10);
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
      const filename = `${slug}-project-${date}.${format}`;
      if (format === "json") {
        return {
          filename, mime: "application/json; charset=utf-8",
          content: JSON.stringify({ devStub: true, project: { id: p.id, name: p.name, brand: p.brand }, version: current, bank: [...p.bank.values()] }, null, 2),
        };
      }
      const lines = ["locale,title,subtitle,keywords"];
      for (const [locale, f] of Object.entries(current?.locales ?? {})) lines.push(`${locale},"${f.title}","${f.subtitle}","${f.keywords}"`);
      lines.push("", "storefront,language,keyword,score,status");
      for (const r of p.bank.values()) lines.push(`${r.storefront},${r.language},${r.keyword},${r.metrics.score ?? ""},${r.metrics.status}`);
      return { filename, mime: "text/csv; charset=utf-8", content: lines.join("\n") + "\n" };
    },

    async projectOp(op) {
      switch (op.kind) {
        case "create": {
          const name = String(op.name ?? "").trim();
          const brand = String(op.brand ?? "").trim();
          if (!name) throw new Error("name is required");
          if (!brand) throw new Error("brand is required");
          const id = `proj-${Date.now().toString(36)}-${++counter}`;
          projects.set(id, {
            id, name, brand,
            appStoreId: op.appStoreUrl?.trim() ? parseTrackId(op.appStoreUrl) : null,
            archived: false, context: null, versions: [], liveVersion: null,
            createdAt: now(), updatedAt: now(), bank: new Map(), positions: [],
          });
          return { projectId: id };
        }
        case "update": {
          const p = mustProject(op.projectId);
          if (op.name !== undefined) { const n = String(op.name).trim(); if (!n) throw new Error("name cannot be empty"); p.name = n; }
          if (op.brand !== undefined) { const b = String(op.brand).trim(); if (!b) throw new Error("brand cannot be empty"); p.brand = b; }
          if (op.appStoreUrl !== undefined) p.appStoreId = op.appStoreUrl === null || !String(op.appStoreUrl).trim() ? null : parseTrackId(String(op.appStoreUrl));
          p.updatedAt = now();
          return { ok: true };
        }
        case "updateContext": {
          const p = mustProject(op.projectId);
          p.context = { ...op.context };
          p.updatedAt = now();
          return { ok: true };
        }
        case "applyMetadata": {
          const p = mustProject(op.projectId);
          const r = runs.get(op.runId);
          if (!r || r.projectId !== p.id) throw new Error("run not found in this project");
          const proposed = proposalLocalesOf(r);
          if (!proposed) throw new Error("this run has no assembled metadata yet");
          const patch: Record<string, Partial<MetadataLocaleFields>> = {};
          for (const [locale, pick] of Object.entries(op.selection ?? {})) {
            const prop = proposed[locale];
            if (!prop || !pick) continue;
            const edits = op.edits?.[locale] ?? {};
            const fields: Partial<MetadataLocaleFields> = {};
            if (pick.title) fields.title = edits.title !== undefined ? String(edits.title) : prop.title;
            if (pick.subtitle) fields.subtitle = edits.subtitle !== undefined ? String(edits.subtitle) : prop.subtitle;
            if (pick.keywords) fields.keywords = edits.keywords !== undefined ? String(edits.keywords) : prop.keywords;
            if (Object.keys(fields).length) patch[locale] = fields;
          }
          if (!Object.keys(patch).length) throw new Error("nothing selected to apply");
          const version = appendVersion(p, (prev, v) => ({
            v, ts: now(), note: op.note?.trim() || `from run ${op.runId.slice(0, 10)}`,
            source: { type: "run", runId: op.runId }, locales: mergeLocales(prev, patch),
          }));
          return { version };
        }
        case "editMetadata": {
          const p = mustProject(op.projectId);
          if (!op.locales || !Object.keys(op.locales).length) throw new Error("locales are required");
          const version = appendVersion(p, (prev, v) => ({
            v, ts: now(), note: op.note?.trim() || "manual edit",
            source: { type: "manual" }, locales: mergeLocales(prev, op.locales),
          }));
          return { version };
        }
        case "rollback": {
          const p = mustProject(op.projectId);
          const target = p.versions.find((v) => v.v === Number(op.toV));
          if (!target) throw new Error(`version v${op.toV} not found`);
          const version = appendVersion(p, (_prev, v) => ({
            v, ts: now(), note: `rollback of v${target.v}`,
            source: { type: "rollback", fromV: target.v },
            locales: JSON.parse(JSON.stringify(target.locales)),
          }));
          return { version };
        }
        case "markLive": {
          const p = mustProject(op.projectId);
          if (!p.versions.some((v) => v.v === Number(op.v))) throw new Error(`version v${op.v} not found`);
          p.liveVersion = Number(op.v);
          p.updatedAt = now();
          return { ok: true };
        }
        case "bankFlag": {
          const p = mustProject(op.projectId);
          const row = p.bank.get(bankKey(op.storefront, op.language, op.keyword));
          if (row) {
            if (typeof op.pinned === "boolean") row.pinned = op.pinned;
            if (typeof op.hidden === "boolean") row.hidden = op.hidden;
            row.updatedAt = now();
          }
          return { ok: true };
        }
        case "checkPositions": {
          const p = mustProject(op.projectId);
          if (!p.appStoreId) throw new Error("link your App Store listing first (Settings → App Store URL)");
          const tracked = trackedFor(p, op.storefront);
          if (!tracked.length) throw new Error("nothing to track: save metadata for this storefront or pin bank keywords first");
          const total = Math.round(tracked.length * DEV_POSITIONS_FEE * 10_000) / 10_000;
          if (credits < total) throw new Error(`not enough credits for this check (${total.toFixed(2)} cr) — top up your balance`);
          credits = Math.round((credits - total) * 10_000) / 10_000;
          ledger.push({ ts: now(), type: "debit", delta: -total, runId: `proj:${p.id}` });
          emit({ type: "balance", credits });
          const ts = now();
          for (const keyword of tracked) {
            // Synthetic ranks: stable-ish per keyword, ~1/3 unranked.
            const h = Array.from(keyword).reduce((a, c) => a + c.charCodeAt(0), 0);
            const ranked = h % 3 !== 0;
            p.positions.push({ storefront: op.storefront, keyword, position: ranked ? (h % 25) + 1 : null, serpSize: 25, checkedAt: ts });
          }
          p.updatedAt = ts;
          return { checkId: `chk-${ts}`, storefront: op.storefront, tracked: tracked.length, credits: total, started: true };
        }
        case "archive": {
          const p = mustProject(op.projectId);
          p.archived = op.archived === true;
          p.updatedAt = now();
          return { ok: true };
        }
        case "delete": {
          const p = mustProject(op.projectId);
          if (String(op.confirmName ?? "").trim() !== p.name) throw new Error("confirmation name does not match the project name");
          projects.delete(p.id);
          return { ok: true };
        }
        default:
          throw new Error(`unknown project op: ${(op as any).kind}`);
      }
    },

    async topup(selection) {
      // DEV: the real Paddle checkout URL comes from the server over HTTPS; this one is fake —
      // but validation MIRRORS the server (resolveSelection), so stub-mode testing of the
      // modal's edge cases fails the same way the real server would instead of masking bugs.
      let grant: number;
      if (selection.packageId) {
        const pkg = DEV_PACKAGES.find((p) => p.id === selection.packageId);
        if (!pkg) throw new Error(`unknown package: ${selection.packageId}`);
        grant = Math.round(pkg.credits * (1 + (pkg.bonusPct ?? 0) / 100));
      } else {
        const n = Number(selection.customCredits);
        if (!Number.isInteger(n) || n < STUB_CUSTOM.minCredits || n > STUB_CUSTOM.maxCredits) {
          throw new Error(`customCredits must be a whole number between ${STUB_CUSTOM.minCredits} and ${STUB_CUSTOM.maxCredits}`);
        }
        grant = n;
      }
      credits += grant;
      ledger.push({ ts: now(), type: "grant", delta: grant });
      emit({ type: "balance", credits });
      return { checkoutUrl: `https://sandbox-buy.paddle.com/dev-stub?grant=${grant}` };
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
