// @aso/server/orchestrator — insights & exports (spec 09). Pure functions ONLY: every value
// here is a RE-PROJECTION of run data that already exists (keywords with P/D/R/score + raw
// evidence, SERP top-10s, assembly, coverage). Nothing in this module may trigger an Apple
// request, an LLM call, or a credit debit — that is the acceptance gate for the whole pack.
//
// The artifacts must stay auditable outside the app: the formulas footer repeats the four
// PUBLIC formulas from the landing math section (no internal weights beyond what is public).

import type {
  KeywordEntry, AssemblyResult, RunConfig,
  KeywordLite, KeywordsLiteView, CompetitorsView, CompetitorRow, CompetitorAppearance,
  ExportFormat, ExportArtifact, RunSnapshot,
} from "@aso/shared";

// ── Shared input for the report builders ─────────────────────────────────────

export interface ReportInput {
  config: RunConfig;
  phase: string;
  createdAt: string;
  keywords: KeywordEntry[];
  assembly: AssemblyResult | null;
  sampleCount: number;
  /** The user's LOCAL pins/notes (spec 09 §7), passed transiently for rendering only. */
  pinned?: string[];
  notes?: Record<string, string>;
  /** Stamp for filenames/headers — injected for testability. */
  now?: Date;
}

// ── keywords-lite (spec 09 §3) ───────────────────────────────────────────────

export function toLite(keywords: KeywordEntry[]): KeywordsLiteView {
  const items: KeywordLite[] = keywords.map((k) => ({
    keyword: k.keyword,
    score: k.metrics.score ?? null,
    P: k.metrics.P ?? null,
    D: k.metrics.D ?? null,
    R: k.metrics.R ?? null,
    status: k.status,
    source: k.source,
    childCount: k.metrics.childCount ?? 0,
    brandQuery: k.metrics.brandQuery === true,
    unsuggested: k.metrics.unsuggested === true,
    degraded: k.degraded === true,
    ...(k.probedAt ? { probedAt: k.probedAt } : {}),
  }));
  return { items };
}

// ── Findings counts (spec 09 §4) ─────────────────────────────────────────────

export function findingsCounts(keywords: KeywordEntry[]): { brandTraps: number; phantom: number; degraded: number } {
  let brandTraps = 0, phantom = 0, degraded = 0;
  for (const k of keywords) {
    if (k.metrics.brandQuery === true) brandTraps++;
    if (k.metrics.unsuggested === true) phantom++;
    if (k.degraded === true) degraded++;
  }
  return { brandTraps, phantom, degraded };
}

// ── Competitor aggregation (spec 09 §2) ──────────────────────────────────────
// Group per-keyword topApps by app identity across all keywords with D known.
// O(keywords × serpTop); numbers must be reproducible from the run.json export.

export function aggregateCompetitors(keywords: KeywordEntry[]): CompetitorsView {
  const withSerp = keywords.filter((k) => k.metrics.D != null && (k.metrics.topApps?.length ?? 0) > 0);
  interface Acc {
    trackId: number | null;
    trackName: string;
    appearances: CompetitorAppearance[];
  }
  const byApp = new Map<string, Acc>();
  let slots = 0, openDoors = 0;
  const strengths: number[] = [];

  for (const k of withSerp) {
    k.metrics.topApps.forEach((a, i) => {
      slots++;
      strengths.push(a.strength);
      if (a.strength < 40) openDoors++;
      const key = a.trackId ? `id:${a.trackId}` : `name:${a.trackName.toLowerCase().trim()}`;
      let acc = byApp.get(key);
      if (!acc) {
        acc = { trackId: a.trackId || null, trackName: a.trackName, appearances: [] };
        byApp.set(key, acc);
      }
      acc.appearances.push({
        keyword: k.keyword,
        position: i + 1,
        strength: a.strength,
        score: k.metrics.score ?? null,
      });
    });
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const rows: CompetitorRow[] = [...byApp.values()].map((acc) => {
    const positions = acc.appearances.map((a) => a.position);
    const strengthVals = acc.appearances.map((a) => a.strength);
    const best = acc.appearances
      .filter((a) => a.position <= 3)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, 3)
      .map((a) => a.keyword);
    return {
      trackId: acc.trackId,
      trackName: acc.trackName,
      keywords: acc.appearances.length,
      share: withSerp.length ? acc.appearances.length / withSerp.length : 0,
      avgPosition: round1(mean(positions)),
      avgStrength: Math.round(mean(strengthVals)),
      bestKeywords: best,
      weakSpots: acc.appearances.filter((a) => a.strength < 40).length,
      appearances: [...acc.appearances].sort((a, b) => a.position - b.position),
    };
  });
  rows.sort((a, b) => b.keywords - a.keywords || b.avgStrength - a.avgStrength);

  return {
    items: rows.slice(0, 25),
    summary: {
      distinctApps: byApp.size,
      medianStrength: strengths.length ? median(strengths) : null,
      openDoors,
      keywordsWithSerp: withSerp.length,
    },
  };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ── CSV (spec 09 §1, RFC 4180) ───────────────────────────────────────────────
// Columns are a stable schema; `pinned` (spec 09 §7) is always the last column.

const CSV_HEADER = "keyword,score,P,D,R,status,source,child_count,brand_query,unsuggested,degraded,reason,pinned";

export function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildCsv(keywords: KeywordEntry[], pinned: string[] = []): string {
  const pin = new Set(pinned);
  const rows = sortByScoreDesc(keywords).map((k) => {
    const m = k.metrics;
    return [
      csvEscape(k.keyword),
      m.score ?? "", m.P ?? "", m.D ?? "", m.R ?? "",
      k.status, k.source, m.childCount ?? 0,
      m.brandQuery === true, m.unsuggested === true, k.degraded === true,
      csvEscape(m.reason ?? ""),
      pin.has(k.keyword),
    ].join(",");
  });
  return [CSV_HEADER, ...rows].join("\n") + "\n";
}

function sortByScoreDesc(keywords: KeywordEntry[]): KeywordEntry[] {
  return [...keywords].sort((a, b) => (b.metrics.score ?? -1) - (a.metrics.score ?? -1));
}

// ── Markdown report (spec 09 §1) ─────────────────────────────────────────────

const FORMULAS_MD = `## Formulas (audit the numbers)

\`\`\`
P        = 100 · (0.7·depth + 0.3·rank)                  # demand, from autocomplete probing
strength = 100 · (0.45·volume + 0.15·quality
                 + 0.15·freshness + 0.25·exact-match)    # per top-10 app; D aggregates them
R rubric : 3 core · 2 adjacent · 1 tangent · 0 excluded  # judged against the confirmed brief
score    = 100 · (P/100)^0.6 · ((100−D)/100)^0.4 · (R/3)
\`\`\``;

const FOOTER_LINE = "Generated by ASOptimus — app keywords, measured · https://asoptimus.com";

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function buildMarkdown(input: ReportInput): string {
  const { config, keywords, assembly, sampleCount } = input;
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const f = findingsCounts(keywords);
  const pinnedSet = new Set(input.pinned ?? []);
  const notes = input.notes ?? {};
  const lines: string[] = [];

  lines.push(`# ${config.brand} — keyword run (${config.country.toUpperCase()})`);
  lines.push("");
  lines.push(`Generated ${date} · sample ${sampleCount}/${config.sampleSize} verified keyphrases · phase: ${input.phase}`);
  lines.push("");

  // Shortlist (spec 09 §7): the user's pinned working set goes first.
  const shortlist = keywords.filter((k) => pinnedSet.has(k.keyword));
  if (shortlist.length) {
    lines.push(`## Shortlist (${shortlist.length} pinned)`);
    lines.push("");
    lines.push("| Keyword | Score | P | D | R | Note |");
    lines.push("|---|---:|---:|---:|---:|---|");
    for (const k of sortByScoreDesc(shortlist)) {
      const m = k.metrics;
      lines.push(`| ${mdEscapeCell(k.keyword)} | ${m.score ?? ""} | ${m.P ?? ""} | ${m.D ?? ""} | ${m.R ?? ""} | ${mdEscapeCell(notes[k.keyword] ?? "")} |`);
    }
    lines.push("");
  }

  lines.push("## Ship-ready metadata");
  lines.push("");
  if (assembly?.buckets?.length) {
    assembly.buckets.forEach((b, i) => {
      lines.push(`### ${i === 0 ? "Primary localization" : "Cross-localization"} (${b.locale})`);
      lines.push("");
      const field = (label: string, value: string | null, max: number) => {
        const v = value ?? "";
        lines.push(`- **${label}** (${v.length}/${max}): \`${v || "—"}\``);
      };
      field("Title", b.title, b.budgets.titleSloganMax);
      field("Subtitle", b.subtitle, b.budgets.subtitleMax);
      field("Keywords", b.keywordFieldDraft, b.budgets.keywordsMax);
      lines.push("");
    });
  } else {
    lines.push("_Not assembled yet — the run has not reached the assembling phase._");
    lines.push("");
  }

  const top = sortByScoreDesc(keywords).filter((k) => (k.metrics.score ?? 0) > 0).slice(0, 30);
  lines.push(`## Top ${top.length} keywords`);
  lines.push("");
  if (top.length) {
    lines.push("| # | Keyword | Score | P | D | R |");
    lines.push("|---:|---|---:|---:|---:|---:|");
    top.forEach((k, i) => {
      const m = k.metrics;
      lines.push(`| ${i + 1} | ${mdEscapeCell(k.keyword)} | ${m.score ?? ""} | ${m.P ?? ""} | ${m.D ?? ""} | ${m.R ?? ""} |`);
    });
  } else {
    lines.push("_No scored keywords yet._");
  }
  lines.push("");

  lines.push("## What the engine caught");
  lines.push("");
  lines.push(`- **${f.brandTraps}** dead-brand traps — phrases that autocomplete like demand but are names of weak apps (Score zeroed, evidence kept).`);
  lines.push(`- **${f.phantom}** phantom phrases — never appeared in autocomplete at any prefix (no demand, no budget spent).`);
  if (f.degraded > 0) {
    lines.push(`- **${f.degraded}** degraded probes — measured while the suggestions endpoint was down (marked, never silently guessed).`);
  }
  lines.push("");

  if (assembly?.coverage) {
    const c = assembly.coverage;
    lines.push(`**Coverage:** ${c.phrasesCovered} phrases covered · Score ${c.scoreCovered}/${c.scoreTotal} (${Math.round(c.coveredShare * 100)}%).`);
    lines.push("");
  }

  lines.push(FORMULAS_MD);
  lines.push("");
  lines.push("---");
  lines.push(FOOTER_LINE);
  lines.push("");
  return lines.join("\n");
}

// ── run.json (spec 09 §1): everything the UI SHOWS, machine-readable ─────────
// state.usage (LLM token counts / costUsd) is internal COGS — the UI no longer displays it
// (spec 09 §0) and a downloadable, shareable artifact must not resurrect it. Stripped here.

export function buildRunJson(snapshot: RunSnapshot, keywords: KeywordEntry[]): string {
  const { usage: _usage, ...stateNoUsage } = (snapshot.state ?? {}) as Record<string, unknown>;
  return JSON.stringify({ ...snapshot, state: stateNoUsage, keywords }, null, 2) + "\n";
}

// ── Static P×D opportunity-map SVG (spec 09 §3/§6, brand-styled, no libs) ────

export function svgOpportunityMap(keywords: KeywordEntry[], width = 680, height = 360): string {
  const pad = { l: 44, r: 14, t: 14, b: 40 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const x = (D: number) => pad.l + (D / 100) * W;
  const y = (P: number) => pad.t + (1 - P / 100) * H;
  const pts = keywords.filter((k) => k.metrics.P != null && k.metrics.D != null && !k.degraded);
  const dots = pts.map((k) => {
    const m = k.metrics;
    const zero = (m.score ?? 0) <= 0;
    const fill = zero ? "#C22B2B" : k.status === "selected" ? "#F86C1A" : "#0244B5";
    const op = zero ? "0.4" : "0.85";
    return `<circle cx="${x(m.D!).toFixed(1)}" cy="${y(m.P!).toFixed(1)}" r="3" fill="${fill}" fill-opacity="${op}"><title>${escapeXml(k.keyword)} — P ${m.P}, D ${m.D}${m.score != null ? `, score ${m.score}` : ""}</title></circle>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Opportunity map: P versus D scatter">
<rect x="${pad.l}" y="${pad.t}" width="${W / 2}" height="${H / 2}" fill="#F86C1A" fill-opacity="0.07"/>
<text x="${pad.l + 8}" y="${pad.t + 18}" font-size="12" font-weight="700" fill="#BC4406">gold</text>
<rect x="${pad.l}" y="${pad.t}" width="${W}" height="${H}" fill="none" stroke="#191D3A" stroke-width="2"/>
<line x1="${x(50)}" y1="${pad.t}" x2="${x(50)}" y2="${pad.t + H}" stroke="#191D3A" stroke-width="1" stroke-dasharray="4 4" opacity="0.5"/>
<line x1="${pad.l}" y1="${y(50)}" x2="${pad.l + W}" y2="${y(50)}" stroke="#191D3A" stroke-width="1" stroke-dasharray="4 4" opacity="0.5"/>
${dots}
<text x="${pad.l + W / 2}" y="${height - 8}" font-size="11" fill="#565B76" text-anchor="middle">D — harder →</text>
<text x="12" y="${pad.t + H / 2}" font-size="11" fill="#565B76" text-anchor="middle" transform="rotate(-90 12 ${pad.t + H / 2})">P — more demand ↑</text>
</svg>`;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ── Self-contained HTML report (spec 09 §6) ──────────────────────────────────
// Client-facing artifact: NO LLM internals, NO token/cost numbers, NO credit numbers.
// Zero external requests: inline CSS, system font stack, inline SVG.

export function buildHtml(input: ReportInput): string {
  const { config, keywords, assembly, sampleCount } = input;
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const f = findingsCounts(keywords);
  const comp = aggregateCompetitors(keywords);
  const top = sortByScoreDesc(keywords).filter((k) => (k.metrics.score ?? 0) > 0).slice(0, 30);
  const esc = escapeXml;

  const metaBlock = assembly?.buckets?.length
    ? assembly.buckets.map((b, i) => `
      <div class="panel">
        <h3>${i === 0 ? "Primary localization" : "Cross-localization"} (${esc(b.locale)})</h3>
        ${[["Title", b.title, b.budgets.titleSloganMax], ["Subtitle", b.subtitle, b.budgets.subtitleMax], ["Keywords", b.keywordFieldDraft, b.budgets.keywordsMax]]
          .map(([label, v, max]) => {
            const val = (v as string | null) ?? "";
            return `<div class="field"><span class="lbl">${label}</span><code>${esc(val || "—")}</code><span class="count">${val.length}/${max}</span></div>`;
          }).join("")}
      </div>`).join("")
    : `<p class="muted">Not assembled yet — the run has not reached the assembling phase.</p>`;

  const topRows = top.map((k, i) => {
    const m = k.metrics;
    return `<tr><td class="num">${i + 1}</td><td class="kw">${esc(k.keyword)}</td><td class="num"><b>${m.score ?? ""}</b></td><td class="num">${m.P ?? ""}</td><td class="num">${m.D ?? ""}</td><td class="num">${m.R ?? ""}</td></tr>`;
  }).join("");

  const compRows = comp.items.slice(0, 10).map((c, i) =>
    `<tr><td class="num">${i + 1}</td><td>${esc(c.trackName)}</td><td class="num">${c.keywords}</td><td class="num">${Math.round(c.share * 100)}%</td><td class="num">${c.avgPosition}</td><td class="num">${c.avgStrength}</td><td class="num">${c.weakSpots}</td></tr>`).join("");

  const coverage = assembly?.coverage
    ? `<p><b>Coverage:</b> ${assembly.coverage.phrasesCovered} phrases covered · Score ${assembly.coverage.scoreCovered}/${assembly.coverage.scoreTotal} (${Math.round(assembly.coverage.coveredShare * 100)}%).</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.brand)} — keyword report (${esc(config.country.toUpperCase())}) · ASOptimus</title>
<style>
  :root { --bg:#FDF3DA; --ink:#191D3A; --muted:#565B76; --blue:#0244B5; --blue-soft:#E3EAFB; --orange:#F86C1A; --orange-deep:#BC4406; --red:#C22B2B; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 28px; letter-spacing:-0.01em; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 34px 0 12px; }
  h3 { font-size: 15px; margin: 0 0 10px; }
  .sub { color: var(--muted); margin: 0 0 22px; }
  .panel { background:#fff; border:2.5px solid var(--ink); border-radius:14px; padding:16px 18px; margin-bottom:14px; box-shadow:4px 4px 0 var(--ink); }
  .muted { color: var(--muted); }
  .tiles { display:flex; gap:12px; flex-wrap:wrap; }
  .tile { flex:1 1 180px; background:#fff; border:2.5px solid var(--ink); border-radius:12px; padding:12px 14px; box-shadow:4px 4px 0 var(--ink); }
  .tile .v { font-size:26px; font-weight:800; color:var(--orange-deep); }
  .tile .l { color:var(--muted); font-size:13px; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; background:#fff; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #E9DDBC; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); border-bottom:2px solid var(--ink); }
  th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.kw { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px; }
  .tablebox { border:2.5px solid var(--ink); border-radius:12px; overflow:hidden; box-shadow:4px 4px 0 var(--ink); }
  .field { display:flex; gap:10px; align-items:baseline; margin:6px 0; flex-wrap:wrap; }
  .field .lbl { font-weight:700; min-width:76px; }
  .field code { background:var(--bg); border:1.5px solid var(--ink); border-radius:8px; padding:2px 8px; word-break:break-all; }
  .field .count { color:var(--muted); font-size:12px; }
  .cap { color:var(--muted); font-size:12.5px; margin:6px 0 0; }
  pre.formulas { background:#fff; border:2.5px solid var(--ink); border-radius:12px; padding:14px 16px; overflow-x:auto; font-size:12.5px; box-shadow:4px 4px 0 var(--ink); }
  .svgbox { background:#fff; border:2.5px solid var(--ink); border-radius:12px; padding:10px; box-shadow:4px 4px 0 var(--ink); }
  .svgbox svg { width:100%; height:auto; display:block; }
  footer { margin-top:44px; padding-top:14px; border-top:2.5px solid var(--ink); color:var(--muted); font-size:13px; }
  footer a { color: var(--blue); }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(config.brand)} <span class="muted">· ${esc(config.country.toUpperCase())}</span></h1>
  <p class="sub">Keyword run report · generated ${date} · ${sampleCount}/${config.sampleSize} verified keyphrases</p>

  <div class="tiles">
    <div class="tile"><div class="v">${f.brandTraps}</div><div class="l">dead-brand traps caught — autocomplete like demand, are names of weak apps; Score zeroed</div></div>
    <div class="tile"><div class="v">${f.phantom}</div><div class="l">phantom phrases filtered — never appeared in autocomplete at any prefix</div></div>
    ${f.degraded ? `<div class="tile"><div class="v">${f.degraded}</div><div class="l">degraded probes disclosed — measured while the suggestions endpoint was down</div></div>` : ""}
  </div>

  <h2>Ship-ready metadata</h2>
  ${metaBlock}

  <h2>Top ${top.length} keywords</h2>
  <div class="tablebox"><table>
    <thead><tr><th class="num">#</th><th>Keyword</th><th class="num">Score</th><th class="num">P</th><th class="num">D</th><th class="num">R</th></tr></thead>
    <tbody>${topRows || `<tr><td colspan="6" class="muted">no scored keywords yet</td></tr>`}</tbody>
  </table></div>

  <h2>Opportunity map</h2>
  <div class="svgbox">${svgOpportunityMap(keywords)}</div>
  <p class="cap">Each dot is a probed phrase. Up-left = high demand, low difficulty. Orange = selected for metadata; red = Score zeroed.</p>

  <h2>Competitor landscape</h2>
  <p class="cap" style="margin-bottom:8px">Apps competing in the top-10s of this run's keyword sample — not a market-share study.</p>
  <div class="tablebox"><table>
    <thead><tr><th class="num">#</th><th>App</th><th class="num">Keywords</th><th class="num">Share</th><th class="num">Avg pos</th><th class="num">Avg strength</th><th class="num">Weak spots</th></tr></thead>
    <tbody>${compRows || `<tr><td colspan="7" class="muted">no SERP data yet</td></tr>`}</tbody>
  </table></div>

  ${coverage}

  <h2>Formulas (audit the numbers)</h2>
  <pre class="formulas">P        = 100 · (0.7·depth + 0.3·rank)                  # demand, from autocomplete probing
strength = 100 · (0.45·volume + 0.15·quality
                 + 0.15·freshness + 0.25·exact-match)    # per top-10 app; D aggregates them
R rubric : 3 core · 2 adjacent · 1 tangent · 0 excluded  # judged against the confirmed brief
score    = 100 · (P/100)^0.6 · ((100−D)/100)^0.4 · (R/3)</pre>

  <footer>Generated by ASOptimus — app keywords, measured · <a href="https://asoptimus.com">asoptimus.com</a></footer>
</div>
</body>
</html>
`;
}

// ── Export dispatcher (spec 09 §1/§6) ────────────────────────────────────────

const MIME: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
};

export function exportFilename(brand: string, country: string, format: ExportFormat, now = new Date()): string {
  const slug = brand.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  const date = now.toISOString().slice(0, 10);
  const suffix = format === "html" ? "-report" : "";
  return `${slug}-${country.toLowerCase()}-${date}${suffix}.${format === "md" ? "md" : format}`;
}

export function buildExport(
  format: ExportFormat,
  input: ReportInput,
  snapshot: RunSnapshot,
): ExportArtifact {
  const now = input.now ?? new Date();
  const filename = exportFilename(input.config.brand, input.config.country, format, now);
  let content: string;
  switch (format) {
    case "csv": content = buildCsv(input.keywords, input.pinned ?? []); break;
    case "md": content = buildMarkdown(input); break;
    case "json": content = buildRunJson(snapshot, input.keywords); break;
    case "html": content = buildHtml(input); break;
    default: throw new Error(`unknown export format: ${format satisfies never}`);
  }
  return { filename, mime: MIME[format], content };
}
