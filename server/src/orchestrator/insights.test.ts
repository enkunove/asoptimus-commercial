// spec 09 unit tests: CSV builder (RFC 4180 torture), competitor aggregator (numbers
// reproducible by an independent naive implementation), findings counts vs CSV column sums,
// markdown/html sanity (no LLM internals, no external requests, formulas present).

import { describe, test, expect } from "bun:test";
import type { KeywordEntry, KeywordMetrics, TopApp, RunSnapshot } from "@aso/shared";
import {
  toLite, findingsCounts, aggregateCompetitors, buildCsv, buildMarkdown, buildHtml,
  buildRunJson, buildExport, exportFilename, csvEscape, median,
} from "./insights.ts";

// ── fixture: ~30 keywords with brand traps, phantoms, degraded, errors, SERPs ──

function app(name: string, id: number, strength: number): TopApp {
  return { trackId: id, trackName: name, ratingCount: 1000, rating: 4.5, updatedDaysAgo: 30, match: 1, strength };
}

type KwPartial = Partial<Omit<KeywordEntry, "metrics">> & { keyword: string; metrics?: Partial<KeywordMetrics> };

function kw(partial: KwPartial): KeywordEntry {
  return {
    status: "rated", source: "suggest", addedAt: "2026-07-19T10:00:00Z", probedAt: "2026-07-19T10:05:00Z",
    degraded: false,
    ...partial,
    metrics: {
      P: 60, L: 4, rank: 2, unsuggested: false, childCount: 3, D: 40, serpSize: 25,
      topApps: [], R: 3, reason: "core job of the app", score: 55, brandQuery: false,
      ...(partial.metrics ?? {}),
    },
  } as KeywordEntry;
}

function fixture(): KeywordEntry[] {
  const items: KeywordEntry[] = [];
  // 20 ordinary scored keywords sharing three competitor apps at varying positions.
  for (let i = 0; i < 20; i++) {
    items.push(kw({
      keyword: `habit phrase ${String(i).padStart(2, "0")}`,
      status: i < 4 ? "selected" : "rated",
      source: (["seed", "suggest", "competitor", "expansion"] as const)[i % 4],
      metrics: {
        P: 40 + i * 2, D: 30 + i, R: i % 5 === 0 ? 2 : 3, score: 20 + i * 3,
        topApps: [
          app("Streaks", 111, 80 - i),      // strong app, every SERP, position 1
          app("HabitKit", 222, 35),          // weak app (strength < 40) — the "open door"
          ...(i % 2 === 0 ? [app("Loop Habits", 333, 60)] : []),
        ],
      },
    }));
  }
  // 3 dead-brand traps (brandQuery → score zeroed) — still carry a real SERP.
  for (let i = 0; i < 3; i++) {
    items.push(kw({
      keyword: `deadapp name ${i}`,
      metrics: { brandQuery: true, score: 0, P: 70, D: 20, topApps: [app("DeadApp", 900 + i, 10)] },
    }));
  }
  // 4 phantom phrases (unsuggested → no SERP, no D).
  for (let i = 0; i < 4; i++) {
    items.push(kw({
      keyword: `phantom phrase ${i}`, status: "excluded",
      metrics: { unsuggested: true, P: 0, D: null, score: 0, topApps: [], R: null, reason: null },
    }));
  }
  // 2 degraded probes (P unknown).
  for (let i = 0; i < 2; i++) {
    items.push(kw({
      keyword: `degraded phrase ${i}`, degraded: true,
      metrics: { P: null, D: 50, score: 30, topApps: [app("Streaks", 111, 70)] },
    }));
  }
  // 1 error row with CSV-hostile reason.
  items.push(kw({
    keyword: "error phrase", status: "error", error: "boom",
    metrics: { score: null, R: 0, reason: 'has "quotes", commas,\nand a newline', topApps: [], D: null },
  }));
  return items;
}

// Minimal RFC 4180 parser (independent of the builder) for round-trip checks.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

describe("spec 09 §1 — CSV export", () => {
  test("header, order, quoting torture, pinned column", () => {
    const csv = buildCsv(fixture(), ["habit phrase 03"]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["keyword", "score", "P", "D", "R", "status", "source", "child_count", "brand_query", "unsuggested", "degraded", "reason", "pinned"]);
    expect(rows.length).toBe(1 + fixture().length);
    // sorted by score desc: first data row is the highest score (20+19*3 = 77)
    expect(rows[1][0]).toBe("habit phrase 19");
    expect(Number(rows[1][1])).toBe(77);
    // the hostile reason survives a round-trip byte-exact
    const errRow = rows.find((r) => r[0] === "error phrase")!;
    expect(errRow[11]).toBe('has "quotes", commas,\nand a newline');
    // pinned column reflects the local shortlist
    const pinnedRow = rows.find((r) => r[0] === "habit phrase 03")!;
    expect(pinnedRow[12]).toBe("true");
    expect(rows.find((r) => r[0] === "habit phrase 04")![12]).toBe("false");
  });

  test("findings counts equal CSV column sums (spec 09 §4 acceptance)", () => {
    const items = fixture();
    const f = findingsCounts(items);
    const rows = parseCsv(buildCsv(items)).slice(1);
    expect(f.brandTraps).toBe(rows.filter((r) => r[8] === "true").length);
    expect(f.phantom).toBe(rows.filter((r) => r[9] === "true").length);
    expect(f.degraded).toBe(rows.filter((r) => r[10] === "true").length);
    expect(f).toEqual({ brandTraps: 3, phantom: 4, degraded: 2 });
  });

  test("csvEscape leaves plain fields untouched", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('a "b"')).toBe('"a ""b"""');
  });
});

describe("spec 09 §2 — competitor aggregation", () => {
  test("numbers reproducible by an independent naive implementation", () => {
    const items = fixture();
    const view = aggregateCompetitors(items);

    // Naive recomputation (deliberately different code path).
    const withSerp = items.filter((k) => k.metrics.D != null && k.metrics.topApps.length > 0);
    const naive = new Map<number, { positions: number[]; strengths: number[] }>();
    for (const k of withSerp) {
      k.metrics.topApps.forEach((a, i) => {
        const acc = naive.get(a.trackId) ?? { positions: [], strengths: [] };
        acc.positions.push(i + 1); acc.strengths.push(a.strength);
        naive.set(a.trackId, acc);
      });
    }

    const streaks = view.items.find((r) => r.trackName === "Streaks")!;
    const naiveStreaks = naive.get(111)!;
    expect(streaks.keywords).toBe(naiveStreaks.positions.length);
    expect(streaks.share).toBeCloseTo(naiveStreaks.positions.length / withSerp.length, 10);
    expect(streaks.avgPosition).toBeCloseTo(
      Math.round((naiveStreaks.positions.reduce((s, x) => s + x, 0) / naiveStreaks.positions.length) * 10) / 10, 10);
    expect(streaks.avgStrength).toBe(
      Math.round(naiveStreaks.strengths.reduce((s, x) => s + x, 0) / naiveStreaks.strengths.length));

    // HabitKit is weak everywhere → every appearance is a weak spot.
    const habitkit = view.items.find((r) => r.trackName === "HabitKit")!;
    expect(habitkit.weakSpots).toBe(habitkit.keywords);
    expect(habitkit.avgStrength).toBe(35);

    // bestKeywords: only appearances at position ≤ 3, ranked by that keyword's score, max 3.
    expect(streaks.bestKeywords.length).toBeLessThanOrEqual(3);
    expect(streaks.bestKeywords[0]).toBe("habit phrase 19");

    // summary: open doors = slots with strength < 40 (HabitKit 20× + DeadApp 3× + none else)
    expect(view.summary.keywordsWithSerp).toBe(withSerp.length);
    expect(view.summary.openDoors).toBe(23);
    expect(view.summary.distinctApps).toBe(6); // Streaks, HabitKit, Loop Habits + 3 DeadApps (distinct trackIds)
  });

  test("unsuggested keywords without SERP are excluded; sorted by overlap; ≤25 rows", () => {
    const view = aggregateCompetitors(fixture());
    for (const row of view.items) {
      expect(row.appearances.every((a) => !a.keyword.startsWith("phantom"))).toBe(true);
    }
    const overlaps = view.items.map((r) => r.keywords);
    expect([...overlaps].sort((a, b) => b - a)).toEqual(overlaps);
    expect(view.items.length).toBeLessThanOrEqual(25);
  });

  test("distinct trap apps with distinct ids are separate rows", () => {
    const view = aggregateCompetitors(fixture());
    // Three DeadApp rows share a name but have distinct trackIds → grouped by id.
    expect(view.items.filter((r) => r.trackName === "DeadApp").length).toBe(3);
  });

  test("median helper", () => {
    expect(median([1, 3, 5])).toBe(3);
    expect(median([1, 3, 5, 7])).toBe(4);
  });
});

describe("spec 09 §1 — markdown / json / html artifacts", () => {
  const input = {
    config: { brand: "Somna", country: "us", sampleSize: 150 } as any,
    phase: "done", createdAt: "2026-07-19T09:00:00Z",
    keywords: fixture(), assembly: null, sampleCount: 22,
    pinned: ["habit phrase 19"], notes: { "habit phrase 19": "try | in title" },
    now: new Date("2026-07-19T12:00:00Z"),
  };

  test("markdown: header, shortlist with escaped note, top-30 cap, formulas, footer", () => {
    const md = buildMarkdown(input);
    expect(md).toContain("# Somna — keyword run (US)");
    expect(md).toContain("## Shortlist (1 pinned)");
    expect(md).toContain("try \\| in title");
    expect(md).toContain("score    = 100 · (P/100)^0.6 · ((100−D)/100)^0.4 · (R/3)");
    expect(md).toContain("https://asoptimus.com");
    // top table cap: 40 scored keywords → still ≤ 30 rows
    const many = { ...input, keywords: Array.from({ length: 40 }, (_, i) => kw({ keyword: `k${i}`, metrics: { score: i + 1 } })) };
    const md40 = buildMarkdown(many);
    expect(md40).toContain("## Top 30 keywords");
    expect((md40.match(/^\| \d+ \|/gm) ?? []).length).toBe(30);
  });

  test("run.json = snapshot + full keyword list; internal usage COGS stripped", () => {
    const snapshot = {
      keywordCount: 30, sampleCount: 22, creditsSpent: 0.44,
      state: { phase: "done", usage: { inputTokens: 9999, outputTokens: 1234, costUsd: 0.12, calls: 5 } },
    } as unknown as RunSnapshot;
    const parsed = JSON.parse(buildRunJson(snapshot, fixture()));
    expect(parsed.keywords.length).toBe(fixture().length);
    expect(parsed.creditsSpent).toBe(0.44);
    expect(parsed.state.phase).toBe("done");
    expect(parsed.state.usage).toBeUndefined(); // token counts / costUsd never leave in artifacts
  });

  test("html report: self-contained, no LLM internals, no credit numbers", () => {
    const html = buildHtml(input);
    // zero external requests: no http(s) src/href except the footer marketing link
    const external = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/g)].map((m) => m[1]);
    expect(external).toEqual(["https://asoptimus.com"]);
    expect(html).not.toMatch(/token|costUsd|credit/i);
    expect(html).toContain("<svg");
    expect(html).toContain("Somna");
    expect(html).toContain("Competitor landscape");
    // findings numbers match the aggregator
    expect(html).toContain(">3</div><div class=\"l\">dead-brand traps");
  });

  test("export dispatcher: filenames and mimes", () => {
    const now = new Date("2026-07-19T12:00:00Z");
    expect(exportFilename("Somna App!", "us", "csv", now)).toBe("somna-app-us-2026-07-19.csv");
    expect(exportFilename("Somna", "us", "html", now)).toBe("somna-us-2026-07-19-report.html");
    const snapshot = {} as RunSnapshot;
    for (const fmt of ["csv", "md", "json", "html"] as const) {
      const a = buildExport(fmt, input, snapshot);
      expect(a.filename.endsWith(fmt === "md" ? ".md" : `.${fmt}`)).toBe(true);
      expect(a.mime).toContain(fmt === "md" ? "markdown" : fmt);
      expect(a.content.length).toBeGreaterThan(10);
    }
  });

  test("toLite: projection keeps exactly the chart-relevant fields", () => {
    const lite = toLite(fixture());
    expect(lite.items.length).toBe(fixture().length);
    const first = lite.items[0];
    expect(Object.keys(first).sort()).toEqual(
      ["D", "P", "R", "brandQuery", "childCount", "degraded", "keyword", "probedAt", "score", "source", "status", "unsuggested"]);
    const phantom = lite.items.find((i) => i.keyword === "phantom phrase 0")!;
    expect(phantom.unsuggested).toBe(true);
    expect(phantom.D).toBeNull();
  });
});
