// Projects store semantics (spec 10 §9): CRUD, append-only versions (cap, live pointer
// survives the cap), bank upsert preserving user curation, positions history.

import { describe, test, expect } from "bun:test";
import { MemoryStore } from "./memory-store.ts";
import type { MetadataVersion } from "@aso/shared";

const mkVersion = (v: number, note = ""): MetadataVersion => ({
  v, ts: new Date().toISOString(), note: note || `v${v}`,
  source: { type: "manual" },
  locales: { "en-US": { title: `T${v}`, subtitle: `S${v}`, keywords: `k${v}` } },
});

async function mkStore() {
  const store = new MemoryStore();
  await store.createUser({ id: "u1", email: "p@t.dev", paddle_customer_id: null });
  await store.createProject({
    id: "proj_1", user_id: "u1", name: "NoBettr", brand: "NoBettr",
    app_store_id: null, context: null, versions: [], live_version: null, archived: false,
  });
  return store;
}

describe("projects store: CRUD", () => {
  test("create → get → update → list → delete (cascades bank/positions)", async () => {
    const store = await mkStore();
    let p = await store.getProject("proj_1");
    expect(p?.name).toBe("NoBettr");
    expect(p?.versions).toEqual([]);

    await store.updateProject({ id: "proj_1", brand: "NB", app_store_id: 123456789, archived: true });
    p = await store.getProject("proj_1");
    expect(p?.brand).toBe("NB");
    expect(Number(p?.app_store_id)).toBe(123456789);
    expect(p?.archived).toBe(true);

    expect((await store.listProjectsByUser("u1")).length).toBe(1);
    expect((await store.listProjectsByUser("someone-else")).length).toBe(0);
    expect(await store.countProjects()).toBe(1);

    await store.upsertProjectKeywords("proj_1", "us", "en", [
      { keyword: "habit tracker", metrics: { P: 50, D: 40, R: 3, score: 60, status: "rated", reason: null, runId: "run_x", ts: "t" } },
    ]);
    await store.insertProjectPositions([{ project_id: "proj_1", storefront: "us", keyword: "habit tracker", position: 3, serp_size: 25 }]);
    await store.deleteProject("proj_1");
    expect(await store.getProject("proj_1")).toBeNull();
    expect(await store.countProjectKeywords("proj_1")).toBe(0);
    expect((await store.listProjectPositions("proj_1")).length).toBe(0);
  });
});

describe("projects store: versions are append-only", () => {
  test("append assigns monotonic v via the builder; prev is the latest snapshot", async () => {
    const store = await mkStore();
    const v1 = await store.appendProjectVersion("proj_1", (prev, v) => {
      expect(prev).toBeNull();
      expect(v).toBe(1);
      return mkVersion(v);
    });
    expect(v1.v).toBe(1);
    const v2 = await store.appendProjectVersion("proj_1", (prev, v) => {
      expect(prev?.v).toBe(1);
      return mkVersion(v);
    });
    expect(v2.v).toBe(2);
    const p = await store.getProject("proj_1");
    expect(p?.versions.map((x) => x.v)).toEqual([1, 2]);
  });

  test("cap 100 drops the oldest but NEVER the live version", async () => {
    const store = await mkStore();
    for (let i = 0; i < 3; i++) await store.appendProjectVersion("proj_1", (_p, v) => mkVersion(v));
    await store.updateProject({ id: "proj_1", live_version: 1 }); // v1 marked live
    for (let i = 0; i < 100; i++) await store.appendProjectVersion("proj_1", (_p, v) => mkVersion(v));
    const p = await store.getProject("proj_1");
    expect(p?.versions.length).toBe(100);
    // The live v1 survived the cap; the oldest non-live versions were dropped.
    expect(p?.versions.some((v) => v.v === 1)).toBe(true);
    expect(p?.versions.some((v) => v.v === 2)).toBe(false);
    expect(p?.versions.at(-1)?.v).toBe(103);
  });
});

describe("projects store: keyword bank", () => {
  test("upsert refreshes metrics but preserves pinned/hidden and first_seen", async () => {
    const store = await mkStore();
    const metrics = (score: number) => ({ P: 10, D: 20, R: 2, score, status: "rated" as const, reason: null, runId: "run_a", ts: "t1" });
    await store.upsertProjectKeywords("proj_1", "us", "en", [{ keyword: "habit tracker", metrics: metrics(30) }]);
    await store.setProjectKeywordFlags("proj_1", "us", "en", "habit tracker", { pinned: true, hidden: true });
    const before = (await store.listProjectKeywords("proj_1"))[0];

    await store.upsertProjectKeywords("proj_1", "us", "en", [{ keyword: "habit tracker", metrics: { ...metrics(77), runId: "run_b" } }]);
    const rows = await store.listProjectKeywords("proj_1");
    expect(rows.length).toBe(1); // deduped per (storefront, language, keyword)
    expect(rows[0].metrics.score).toBe(77);
    expect(rows[0].metrics.runId).toBe("run_b");
    expect(rows[0].pinned).toBe(true);
    expect(rows[0].hidden).toBe(true);
    expect(rows[0].first_seen).toBe(before.first_seen);
  });

  test("same keyword under another storefront/language is a separate row; filters work", async () => {
    const store = await mkStore();
    const m = { P: 1, D: 2, R: 1, score: 5, status: "rated" as const, reason: null, runId: "r", ts: "t" };
    await store.upsertProjectKeywords("proj_1", "us", "en", [{ keyword: "habit tracker", metrics: m }]);
    await store.upsertProjectKeywords("proj_1", "de", "de", [{ keyword: "habit tracker", metrics: m }]);
    expect(await store.countProjectKeywords("proj_1")).toBe(2);
    expect((await store.listProjectKeywords("proj_1", { storefront: "de" })).length).toBe(1);
    expect((await store.listProjectKeywords("proj_1", { language: "en" })).length).toBe(1);
  });
});

describe("projects store: positions history", () => {
  test("insert appends; list filters by storefront and keeps chronological order", async () => {
    const store = await mkStore();
    await store.insertProjectPositions([
      { project_id: "proj_1", storefront: "us", keyword: "habit tracker", position: 9, serp_size: 25 },
      { project_id: "proj_1", storefront: "us", keyword: "sleep sounds", position: null, serp_size: 25 },
    ]);
    await store.insertProjectPositions([
      { project_id: "proj_1", storefront: "us", keyword: "habit tracker", position: 4, serp_size: 25 },
      { project_id: "proj_1", storefront: "de", keyword: "habit tracker", position: 2, serp_size: 25 },
    ]);
    const us = await store.listProjectPositions("proj_1", "us");
    expect(us.length).toBe(3);
    const habit = us.filter((r) => r.keyword === "habit tracker").map((r) => r.position);
    expect(habit).toEqual([9, 4]); // history, oldest first
    expect((await store.listProjectPositions("proj_1")).length).toBe(4);
  });
});
