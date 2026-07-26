// @aso/server/orchestrator — Projects (spec 10): pure view-building over store rows.
// Cards, coverage grid, next-best-actions, proposals, bank paging, positions history, exports.
// NO I/O here — the RunManager owns the store/billing/hub and gates ownership; these functions
// turn already-loaded rows into the wire projections from @aso/shared.

import type {
  BusinessContext, MetadataVersion, MetadataLocaleFields, ProjectCard, ProjectView,
  ProjectVersionSummary, ProjectCoverageSlot, ProjectSuggestion, ProjectProposal,
  ProjectPositionsSummary, ProjectBankPage, ProjectPositionsView, ExportArtifact,
  AssemblyResult,
} from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";
import type { ProjectRow, ProjectKeywordRow, ProjectPositionRow, RunRow } from "../db/index.ts";
import { MARKETS, marketForLocale, extraLocaleFor } from "../core/locales.ts";
import { DEFAULT_MODEL } from "../billing/prices.ts";

const STALE_AFTER_DAYS = 45;       // spec 10 §4.4: the suggest index drifts
const POSITIONS_STALE_DAYS = 14;   // spec 10 §4.5
const TRACKED_CAP = 50;            // spec 10 §3

export function latestVersion(p: ProjectRow): MetadataVersion | null {
  return p.versions.length ? p.versions[p.versions.length - 1] : null;
}

export function runSlug(runId: string): string {
  return runId.replace(/^run_/, "").slice(0, 8);
}

/** Parse an App Store link or bare number into a trackId. Throws on garbage (user typo —
 *  surfacing it beats silently unlinking Positions). */
export function parseAppStoreId(input: string): number {
  const s = String(input).trim();
  const bare = s.match(/^\d{5,}$/);
  if (bare) return Number(s);
  const m = s.match(/apps\.apple\.com\/.*\/?id(\d+)/i) ?? s.match(/\bid(\d+)\b/);
  if (m) return Number(m[1]);
  throw new Error("could not parse an App Store id — paste the apps.apple.com listing URL or the numeric id");
}

/** Locales a run's assembly covers: primary `${lang}-${COUNTRY}` (+ extraLocaleFor bucket). */
function runLocales(run: RunRow): string[] {
  const cfg = run.config;
  const out = [`${cfg.semanticLanguage}-${cfg.country.toUpperCase()}`];
  const extra = cfg.extraLocale ? extraLocaleFor(cfg.country) : null;
  if (extra) out.push(extra);
  return out;
}

function daysSince(ts: string | Date | undefined): number | undefined {
  if (!ts) return undefined;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((Date.now() - t) / 864e5));
}

/** Model of the most recent run (estimates quote against what the user actually uses). */
export function lastRunModel(runs: RunRow[]): string {
  const newest = [...runs].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
  return newest?.config.model ?? DEFAULT_MODEL;
}

export function buildProjectCard(p: ProjectRow, bankCount: number, runs: RunRow[]): ProjectCard {
  const current = latestVersion(p);
  const runTs = runs.map((r) => String(r.updated_at ?? "")).sort().at(-1) ?? "";
  const ownTs = String(p.updated_at ?? p.created_at ?? "");
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    appStoreId: p.app_store_id == null ? null : Number(p.app_store_id),
    archived: p.archived,
    localesCovered: current ? Object.keys(current.locales) : [],
    bankCount,
    lastActivityTs: [runTs, ownTs].sort().at(-1) || new Date().toISOString(),
    runCount: runs.length,
    liveVersion: p.live_version,
    latestVersion: current?.v ?? null,
  };
}

/** The apply proposal a done run carries: its AssemblyResult buckets as locale fields. */
export function proposalLocales(final: AssemblyResult | null): Record<string, MetadataLocaleFields> | null {
  if (!final?.buckets?.length) return null;
  const locales: Record<string, MetadataLocaleFields> = {};
  for (const b of final.buckets) {
    locales[b.locale] = { title: b.title ?? "", subtitle: b.subtitle ?? "", keywords: b.keywordFieldDraft ?? "" };
  }
  return locales;
}

/** Done runs whose final was never applied into a version (spec 10 §2) — newest first. */
export function buildProposals(p: ProjectRow, runs: RunRow[]): ProjectProposal[] {
  const appliedRunIds = new Set(p.versions.filter((v) => v.source.type === "run" && v.source.runId).map((v) => v.source.runId!));
  return runs
    .filter((r) => r.phase === "done" && r.final && !appliedRunIds.has(r.id))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .map((r) => ({ runId: r.id, ts: String(r.updated_at ?? ""), locales: proposalLocales(r.final)! }))
    .filter((x) => x.locales && Object.keys(x.locales).length > 0);
}

/** Coverage grid (spec 10 §6): MARKETS order first (covered or dimmed-with-estimate), then any
 *  covered locale outside the table (e.g. extra buckets like en-AU). */
export function buildCoverage(p: ProjectRow, runs: RunRow[], estimateCredits: number): ProjectCoverageSlot[] {
  const current = latestVersion(p);
  const covered = current?.locales ?? {};

  // sourceRunId: newest version that carries this locale from a run.
  const sourceRun = (locale: string): string | undefined => {
    for (let i = p.versions.length - 1; i >= 0; i--) {
      const v = p.versions[i];
      if (v.source.type === "run" && v.source.runId && v.locales[locale]) return v.source.runId;
    }
    return undefined;
  };
  // staleDays: newest DONE run whose assembly covers this locale.
  const stale = (locale: string): number | undefined => {
    const done = runs.filter((r) => r.phase === "done" && runLocales(r).includes(locale));
    const newest = done.map((r) => String(r.updated_at ?? "")).sort().at(-1);
    return newest ? daysSince(newest) : undefined;
  };

  const slots: ProjectCoverageSlot[] = [];
  for (const m of MARKETS) {
    const fields = covered[m.locale];
    slots.push(fields
      ? { locale: m.locale, covered: true, market: m, fields, sourceRunId: sourceRun(m.locale), staleDays: stale(m.locale) }
      : { locale: m.locale, covered: false, market: m, estimateCredits });
  }
  for (const locale of Object.keys(covered)) {
    if (MARKETS.some((m) => m.locale === locale)) continue;
    slots.push({ locale, covered: true, market: marketForLocale(locale), fields: covered[locale], sourceRunId: sourceRun(locale), staleDays: stale(locale) });
  }
  return slots;
}

/** Next-best-actions (spec 10 §4): max 4, fixed priority order. */
export function buildSuggestions(args: {
  project: ProjectRow;
  runs: RunRow[];
  coverage: ProjectCoverageSlot[];
  proposals: ProjectProposal[];
  positions: ProjectPositionRow[];
  quote: number;             // quoteFor(150, lastModel)
  positionsFee: number;
  trackedCount: number;
}): ProjectSuggestion[] {
  const { project, coverage, proposals, positions, quote } = args;
  const out: ProjectSuggestion[] = [];

  if (!project.app_store_id) {
    out.push({
      kind: "link-app",
      title: "Link your App Store listing",
      detail: "Paste the apps.apple.com URL to verify real rankings for your target phrases — free.",
      action: { go: "settings" },
    });
  }

  const prop = proposals[0];
  if (prop) {
    out.push({
      kind: "apply-run",
      title: `Run ${runSlug(prop.runId)} produced metadata for ${Object.keys(prop.locales).join(", ")}`,
      detail: "Review the proposed title/subtitle/keywords and save them to the board.",
      action: { go: "apply", runId: prop.runId },
    });
  }

  const uncovered = coverage.filter((s) => !s.covered && s.market);
  for (const slot of uncovered.slice(0, 2)) {
    const m = slot.market!;
    const extra = extraLocaleFor(m.country);
    const extraCovered = extra ? coverage.some((s) => s.covered && s.locale === extra) : true;
    const bonus = extra && !extraCovered ? ` Also fills the ${extra} slot via cross-localization.` : "";
    out.push({
      kind: "new-locale",
      title: `Research ${m.name} (${m.locale})`,
      detail: `${m.note ? m.note + ". " : ""}Tier ${m.tier} market.${bonus}`,
      credits: quote,
      action: { go: "new-run", country: m.country, language: m.language, locale: m.locale },
    });
  }

  const staleSlot = coverage
    .filter((s) => s.covered && (s.staleDays ?? 0) > STALE_AFTER_DAYS)
    .sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0))[0];
  if (staleSlot) {
    const country = staleSlot.market?.country ?? staleSlot.locale.split("-")[1]?.toLowerCase() ?? "us";
    const language = staleSlot.market?.language ?? staleSlot.locale.split("-")[0];
    out.push({
      kind: "refresh",
      title: `${staleSlot.locale} data is ${staleSlot.staleDays} days old`,
      detail: `The suggest index drifts — refresh the research for ≈${quote} cr.`,
      credits: quote,
      action: { go: "new-run", country, language, locale: staleSlot.locale },
    });
  }

  if (project.live_version != null && project.app_store_id) {
    const lastCheck = positions.map((r) => String(r.checked_at ?? "")).sort().at(-1);
    const age = lastCheck ? daysSince(lastCheck) : undefined;
    if (lastCheck === undefined || (age ?? 0) > POSITIONS_STALE_DAYS) {
      const est = Math.round(args.trackedCount * args.positionsFee * 100) / 100;
      out.push({
        kind: "check-positions",
        title: "Verify your rankings",
        detail: lastCheck
          ? `Last check was ${age} days ago — rankings move. ≈${est} cr for ${args.trackedCount} phrases.`
          : `Your live metadata has never been rank-checked. ≈${est} cr for ${args.trackedCount} phrases.`,
        credits: est,
        action: { go: "positions" },
      });
    }
  }

  return out.slice(0, 4);
}

export function buildVersionsSummary(p: ProjectRow): ProjectVersionSummary[] {
  return [...p.versions].reverse().map((v) => ({
    v: v.v, ts: v.ts, note: v.note, source: v.source,
    localeCount: Object.keys(v.locales).length,
    isLive: p.live_version === v.v,
  }));
}

export function buildPositionsSummary(positions: ProjectPositionRow[]): ProjectPositionsSummary[] | undefined {
  if (!positions.length) return undefined;
  const byStorefront = new Map<string, ProjectPositionRow[]>();
  for (const r of positions) {
    const list = byStorefront.get(r.storefront) ?? [];
    list.push(r);
    byStorefront.set(r.storefront, list);
  }
  const out: ProjectPositionsSummary[] = [];
  for (const [storefront, rows] of byStorefront) {
    // Rows of the LATEST check only: everything sharing the newest checked_at batch (checks
    // insert one row per keyword with ~the same timestamp; group by nearest 5 minutes).
    const newest = rows.map((r) => new Date(r.checked_at ?? 0).getTime()).sort((a, b) => b - a)[0];
    const latest = rows.filter((r) => newest - new Date(r.checked_at ?? 0).getTime() < 5 * 60_000);
    out.push({
      storefront,
      checkedAt: new Date(newest).toISOString(),
      tracked: latest.length,
      ranked: latest.filter((r) => r.position != null).length,
      top10: latest.filter((r) => r.position != null && r.position <= 10).length,
    });
  }
  return out;
}

/** Tracked set for a storefront (spec 10 §3): current version's phrases indexed on that
 *  storefront (its own locale + the extraLocaleFor bucket) ∪ pinned bank keywords, cap 50. */
export function trackedPhrases(p: ProjectRow, storefront: string, bank: ProjectKeywordRow[]): string[] {
  const phrases: string[] = [];
  const current = latestVersion(p);
  if (current) {
    const extra = extraLocaleFor(storefront);
    for (const [locale, fields] of Object.entries(current.locales)) {
      const localeCountry = locale.split("-")[1]?.toLowerCase() ?? "";
      if (localeCountry !== storefront.toLowerCase() && locale !== extra) continue;
      for (const kw of fields.keywords.split(",")) phrases.push(kw);
    }
  }
  for (const row of bank) {
    if (row.storefront === storefront && row.pinned && !row.hidden) phrases.push(row.keyword);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phrases) {
    const k = normalizeKeyword(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= TRACKED_CAP) break;
  }
  return out;
}

/** Bank paging/sort/filter, server-side (spec 10 §5 "project-bank"). */
export function bankPage(rows: ProjectKeywordRow[], params: Record<string, unknown>): ProjectBankPage {
  const buckets = new Map<string, { storefront: string; language: string; count: number }>();
  for (const r of rows) {
    const key = `${r.storefront}|${r.language}`;
    const b = buckets.get(key) ?? { storefront: r.storefront, language: r.language, count: 0 };
    b.count++;
    buckets.set(key, b);
  }

  let items = rows;
  const storefront = params.storefront ? String(params.storefront) : "";
  if (storefront) items = items.filter((r) => r.storefront === storefront);
  const language = params.language ? String(params.language) : "";
  if (language) items = items.filter((r) => r.language === language);
  const hiddenCount = items.filter((r) => r.hidden).length;
  if (String(params.showHidden ?? "") !== "1") items = items.filter((r) => !r.hidden);
  const q = params.q ? normalizeKeyword(String(params.q)) : "";
  if (q) items = items.filter((r) => r.keyword.includes(q));
  const pinnedOnly = String(params.pinned ?? "") === "1";
  if (pinnedOnly) items = items.filter((r) => r.pinned);

  const sort = String(params.sort ?? "score");
  const dir = String(params.dir ?? "desc") === "asc" ? 1 : -1;
  const val = (r: ProjectKeywordRow): number | string => {
    switch (sort) {
      case "keyword": return r.keyword;
      case "P": return r.metrics.P ?? -1;
      case "D": return r.metrics.D ?? -1;
      case "R": return r.metrics.R ?? -1;
      case "status": return r.metrics.status;
      case "updated": return String(r.updated_at ?? "");
      default: return r.metrics.score ?? -1;
    }
  };
  items = [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // pins float regardless of sort
    const va = val(a), vb = val(b);
    return va < vb ? -dir : va > vb ? dir : 0;
  });

  const total = items.length;
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize ?? 50)));
  const page = Math.max(0, Number(params.page ?? 0));
  return {
    total, page, pageSize,
    buckets: [...buckets.values()].sort((a, b) => b.count - a.count),
    hiddenCount,
    items: items.slice(page * pageSize, (page + 1) * pageSize).map((r) => ({
      storefront: r.storefront, language: r.language, keyword: r.keyword,
      metrics: r.metrics, pinned: r.pinned, hidden: r.hidden,
      firstSeen: String(r.first_seen ?? ""), updatedAt: String(r.updated_at ?? ""),
    })),
  };
}

/** Positions view: latest rank + delta + last-10 history per tracked keyword (spec 10 §5/§6). */
export function positionsView(args: {
  project: ProjectRow;
  positions: ProjectPositionRow[];    // all storefronts, checked_at ascending
  bank: ProjectKeywordRow[];
  storefront?: string;
  fee: number;
}): ProjectPositionsView {
  const { project, positions, bank, fee } = args;
  const storefronts = [...new Set(positions.map((r) => r.storefront))];
  // Default storefront: requested → has history → primary locale of the current version → us.
  const current = latestVersion(project);
  const fromVersion = current ? Object.keys(current.locales)[0]?.split("-")[1]?.toLowerCase() : undefined;
  const storefront = args.storefront || storefronts[0] || fromVersion || "us";

  const tracked = trackedPhrases(project, storefront, bank);
  const rows = positions.filter((r) => r.storefront === storefront);
  const byKeyword = new Map<string, ProjectPositionRow[]>();
  for (const r of rows) {
    const list = byKeyword.get(r.keyword) ?? [];
    list.push(r); // ascending — newest last
    byKeyword.set(r.keyword, list);
  }

  const keywords = [...new Set([...tracked, ...byKeyword.keys()])];
  const items = keywords.map((keyword) => {
    const history = (byKeyword.get(keyword) ?? []).slice(-10).reverse(); // newest first
    const latest = history[0];
    const prev = history[1];
    const delta = latest?.position != null && prev?.position != null ? prev.position - latest.position : null;
    return {
      keyword,
      position: latest?.position ?? null,
      serpSize: latest?.serp_size ?? null,
      checkedAt: latest ? String(latest.checked_at ?? "") : "",
      delta,
      history: history.map((h) => ({ position: h.position, checkedAt: String(h.checked_at ?? "") })),
    };
  }).sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || a.keyword.localeCompare(b.keyword));

  const lastCheck = rows.map((r) => String(r.checked_at ?? "")).sort().at(-1) ?? null;
  return {
    storefront, storefronts, tracked,
    checkedAt: lastCheck,
    items,
    feePerKeyword: fee,
    estimateCredits: Math.round(tracked.length * fee * 100) / 100,
  };
}

function csvCell(s: unknown): string {
  const v = String(s ?? "");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function fileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

/** Copy-ready export of the current version + the bank (spec 10 §5 "project-export"). */
export function exportProject(p: ProjectRow, bank: ProjectKeywordRow[], format: "csv" | "json"): ExportArtifact {
  const current = latestVersion(p);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${fileSlug(p.name)}-project-${date}.${format}`;
  if (format === "json") {
    return {
      filename,
      mime: "application/json; charset=utf-8",
      content: JSON.stringify({
        project: { id: p.id, name: p.name, brand: p.brand, appStoreId: p.app_store_id },
        exportedAt: new Date().toISOString(),
        liveVersion: p.live_version,
        version: current,
        bank: bank.map((r) => ({
          storefront: r.storefront, language: r.language, keyword: r.keyword,
          ...r.metrics, pinned: r.pinned, hidden: r.hidden, updatedAt: r.updated_at,
        })),
      }, null, 2),
    };
  }
  const lines: string[] = [];
  lines.push(`# metadata${current ? ` (v${current.v}${p.live_version === current.v ? ", live" : ""})` : " (no versions yet)"}`);
  lines.push("locale,title,subtitle,keywords");
  for (const [locale, f] of Object.entries(current?.locales ?? {})) {
    lines.push([locale, f.title, f.subtitle, f.keywords].map(csvCell).join(","));
  }
  lines.push("");
  lines.push("# keyword bank");
  lines.push("storefront,language,keyword,P,D,R,score,status,pinned,hidden,updated");
  for (const r of bank) {
    lines.push([
      r.storefront, r.language, r.keyword, r.metrics.P, r.metrics.D, r.metrics.R,
      r.metrics.score, r.metrics.status, r.pinned, r.hidden, r.updated_at,
    ].map(csvCell).join(","));
  }
  return { filename, mime: "text/csv; charset=utf-8", content: lines.join("\n") + "\n" };
}

/** Next MetadataVersion from an apply/edit/rollback (spec 10 §2): previous snapshot ⊕ patch. */
export function mergeLocales(
  prev: MetadataVersion | null,
  patch: Record<string, Partial<MetadataLocaleFields>>,
): Record<string, MetadataLocaleFields> {
  const out: Record<string, MetadataLocaleFields> = {};
  for (const [locale, f] of Object.entries(prev?.locales ?? {})) out[locale] = { ...f };
  for (const [locale, f] of Object.entries(patch)) {
    const base = out[locale] ?? { title: "", subtitle: "", keywords: "" };
    out[locale] = {
      title: f.title !== undefined ? String(f.title) : base.title,
      subtitle: f.subtitle !== undefined ? String(f.subtitle) : base.subtitle,
      keywords: f.keywords !== undefined ? String(f.keywords) : base.keywords,
    };
  }
  return out;
}

export function buildProjectView(args: {
  project: ProjectRow;
  runs: RunRow[];
  bankCount: number;
  bank: ProjectKeywordRow[];
  positions: ProjectPositionRow[];
  quote: number;
  positionsFee: number;
  context: BusinessContext | null;
}): ProjectView {
  const { project, runs } = args;
  const card = buildProjectCard(project, args.bankCount, runs);
  const proposals = buildProposals(project, runs);
  const coverage = buildCoverage(project, runs, args.quote);
  const primarySf = latestVersion(project) ? Object.keys(latestVersion(project)!.locales)[0]?.split("-")[1]?.toLowerCase() : undefined;
  const trackedCount = trackedPhrases(project, primarySf ?? "us", args.bank).length;
  return {
    ...card,
    createdAt: String(project.created_at ?? ""),
    context: args.context,
    versionsSummary: buildVersionsSummary(project),
    current: latestVersion(project),
    coverage,
    suggestions: buildSuggestions({
      project, runs, coverage, proposals, positions: args.positions,
      quote: args.quote, positionsFee: args.positionsFee, trackedCount,
    }),
    proposals,
    positionsSummary: buildPositionsSummary(args.positions),
  };
}
