// Suggest-graph expansion engine: wave planning, clean-query filter, raw-data parsing.
// Port of aso-util/test/expander.test.ts. runWave (network) replaced by harvestWaveResults:
// the server does NOT touch the network — the orchestrator emits HintsJobs, harvest parses the returned raw data.

import { describe, expect, test } from "bun:test";
import { planWave, isCleanQuery, SPICE_TOKENS, harvestWaveResults, type ExpansionTask } from "./expander.ts";

describe("isCleanQuery", () => {
  test("clean queries pass", () => {
    expect(isCleanQuery("bac calculator")).toBe(true);
    expect(isCleanQuery("ai bac")).toBe(true);
    expect(isCleanQuery("drink tracker free")).toBe(true);
  });
  test("junk is rejected", () => {
    expect(isCleanQuery("hush: bedtime doomscroll block")).toBe(false); // punctuation
    expect(isCleanQuery("a b")).toBe(false); // 1-character words
    expect(isCleanQuery("one two three four five")).toBe(false); // 5 words
    expect(isCleanQuery("x".repeat(41))).toBe(false); // length
  });
});

describe("planWave", () => {
  test("priority: head children → LLM roots (reserved slot) → word completion → soup/spice", () => {
    const tasks = planWave({
      provenHeads: ["bac calculator", "alcohol tracker"],
      headWords: ["breathalyzer", "drink"],
      llmRoots: ["sober"],
      soupLetters: ["c", "t"],
      done: {},
      budget: 100,
    });
    const terms = tasks.map((t) => t.term);
    expect(terms[0]).toBe("bac calculator ");
    expect(terms[1]).toBe("alcohol tracker ");
    // LLM directions go into the reserved slot BEFORE the word backlog
    expect(terms[2]).toBe("sober");
    expect(terms[3]).toBe("sober ");
    expect(terms[4]).toBe("breathalyzer");
    expect(terms[5]).toBe("drink");
    expect(terms).toContain("bac calculator c");
    expect(terms).toContain("bac calculator for");
    for (const s of SPICE_TOKENS) expect(terms).toContain(`bac calculator ${s}`);
  });

  test("LLM-root slot capped at 8 tasks — the word backlog never starves forever", () => {
    const tasks = planWave({
      provenHeads: [],
      headWords: ["word"],
      llmRoots: ["r1", "r2", "r3", "r4", "r5", "r6"],
      soupLetters: [],
      done: {},
      budget: 100,
    });
    const llmTasks = tasks.filter((t) => t.root.startsWith("r"));
    expect(llmTasks.length).toBe(8); // 4 roots × 2 operations
    expect(tasks.some((t) => t.term === "word")).toBe(true);
  });

  test("done journal prevents re-expansion; budget is respected", () => {
    const done = { "bac calculator": ["children", "soup:c"] };
    const tasks = planWave({
      provenHeads: ["bac calculator"],
      headWords: [],
      llmRoots: [],
      soupLetters: ["c", "t"],
      done,
      budget: 3,
    });
    expect(tasks.length).toBeLessThanOrEqual(3);
    expect(tasks.some((t) => t.opKey === "children" && t.root === "bac calculator")).toBe(false);
    expect(tasks.some((t) => t.opKey === "soup:c")).toBe(false);
    expect(tasks.some((t) => t.opKey === "soup:t")).toBe(true);
  });
});

describe("harvestWaveResults (pure raw-data parsing)", () => {
  const task = (term: string, opKey = "complete", root = term): ExpansionTask => ({ term, opKey, root });

  test("collects clean normalized queries, dirt (punctuation) is filtered out", () => {
    const res = harvestWaveResults([
      { task: task("bac"), terms: ["bac tracker", "BAC Calculator Pro", "Hush: Bedtime Doomscroll Block"] },
      { task: task("drink"), terms: ["drink calculator pro"] },
    ]);
    // normalization to lowercase + isCleanQuery filter
    expect(res.discovered).toContain("bac tracker");
    expect(res.discovered).toContain("bac calculator pro");
    expect(res.discovered).toContain("drink calculator pro");
    // dirty term with a colon does not pass
    expect(res.discovered.some((d) => d.includes(":"))).toBe(false);
    expect(res.discovered).not.toContain("hush: bedtime doomscroll block");
  });

  test("permanentError:true marks the task done; terms:null without it does not", () => {
    const res = harvestWaveResults([
      { task: task("broken"), terms: null, permanentError: true },
      { task: task("pending"), terms: null },
    ]);
    // broken (permanent) task is marked done
    expect(res.done).toContainEqual({ root: "broken", opKey: "complete" });
    // transient failure (terms:null without permanentError) is NOT marked — it reruns
    expect(res.done.some((d) => d.root === "pending")).toBe(false);
  });

  test("requestsSpent counts only results with non-null terms", () => {
    const res = harvestWaveResults([
      { task: task("bac"), terms: ["bac tracker"] },
      { task: task("drink"), terms: ["drink calculator pro"] },
      { task: task("broken"), terms: null, permanentError: true },
      { task: task("pending"), terms: null },
    ]);
    expect(res.requestsSpent).toBe(2);
    // done: two successes + one permanent failure, but NOT the transient one
    expect(res.done).toEqual([
      { root: "bac", opKey: "complete" },
      { root: "drink", opKey: "complete" },
      { root: "broken", opKey: "complete" },
    ]);
  });
});
