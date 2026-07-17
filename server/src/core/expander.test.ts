// Движок расширения suggest-графа: план волны, фильтр чистых запросов, разбор сырья.
// Порт из aso-util/test/expander.test.ts. runWave (сеть) заменён на harvestWaveResults:
// сервер сети НЕ ходит — оркестратор эмитит HintsJob, harvest разбирает вернувшееся сырьё.

import { describe, expect, test } from "bun:test";
import { planWave, isCleanQuery, SPICE_TOKENS, harvestWaveResults, type ExpansionTask } from "./expander.ts";

describe("isCleanQuery", () => {
  test("чистые запросы проходят", () => {
    expect(isCleanQuery("bac calculator")).toBe(true);
    expect(isCleanQuery("ai bac")).toBe(true);
    expect(isCleanQuery("drink tracker free")).toBe(true);
  });
  test("мусор отсекается", () => {
    expect(isCleanQuery("hush: bedtime doomscroll block")).toBe(false); // пунктуация
    expect(isCleanQuery("a b")).toBe(false); // слова из 1 символа
    expect(isCleanQuery("one two three four five")).toBe(false); // 5 слов
    expect(isCleanQuery("x".repeat(41))).toBe(false); // длина
  });
});

describe("planWave", () => {
  test("приоритет: дети голов → LLM-корни (резерв) → completion слов → soup/spice", () => {
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
    // LLM-направления идут в зарезервированном слоте ДО бэклога слов
    expect(terms[2]).toBe("sober");
    expect(terms[3]).toBe("sober ");
    expect(terms[4]).toBe("breathalyzer");
    expect(terms[5]).toBe("drink");
    expect(terms).toContain("bac calculator c");
    expect(terms).toContain("bac calculator for");
    for (const s of SPICE_TOKENS) expect(terms).toContain(`bac calculator ${s}`);
  });

  test("слот LLM-корней ограничен 8 задачами — бэклог слов не голодает вечно", () => {
    const tasks = planWave({
      provenHeads: [],
      headWords: ["word"],
      llmRoots: ["r1", "r2", "r3", "r4", "r5", "r6"],
      soupLetters: [],
      done: {},
      budget: 100,
    });
    const llmTasks = tasks.filter((t) => t.root.startsWith("r"));
    expect(llmTasks.length).toBe(8); // 4 корня × 2 операции
    expect(tasks.some((t) => t.term === "word")).toBe(true);
  });

  test("done-журнал исключает повторное раскрытие; бюджет соблюдается", () => {
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

describe("harvestWaveResults (чистый разбор сырья)", () => {
  const task = (term: string, opKey = "complete", root = term): ExpansionTask => ({ term, opKey, root });

  test("собирает чистые нормализованные запросы, грязь (пунктуация) отсеивается", () => {
    const res = harvestWaveResults([
      { task: task("bac"), terms: ["bac tracker", "BAC Calculator Pro", "Hush: Bedtime Doomscroll Block"] },
      { task: task("drink"), terms: ["drink calculator pro"] },
    ]);
    // нормализация к lowercase + фильтр isCleanQuery
    expect(res.discovered).toContain("bac tracker");
    expect(res.discovered).toContain("bac calculator pro");
    expect(res.discovered).toContain("drink calculator pro");
    // грязный терм с двоеточием не проходит
    expect(res.discovered.some((d) => d.includes(":"))).toBe(false);
    expect(res.discovered).not.toContain("hush: bedtime doomscroll block");
  });

  test("permanentError:true помечает задачу done; terms:null без него — нет", () => {
    const res = harvestWaveResults([
      { task: task("broken"), terms: null, permanentError: true },
      { task: task("pending"), terms: null },
    ]);
    // битая (permanent) задача помечена done
    expect(res.done).toContainEqual({ root: "broken", opKey: "complete" });
    // временный провал (terms:null без permanentError) НЕ помечается — перевыполнится
    expect(res.done.some((d) => d.root === "pending")).toBe(false);
  });

  test("requestsSpent считает только результаты с непустыми terms", () => {
    const res = harvestWaveResults([
      { task: task("bac"), terms: ["bac tracker"] },
      { task: task("drink"), terms: ["drink calculator pro"] },
      { task: task("broken"), terms: null, permanentError: true },
      { task: task("pending"), terms: null },
    ]);
    expect(res.requestsSpent).toBe(2);
    // done: два успешных + одна permanent-битая, но НЕ временная
    expect(res.done).toEqual([
      { root: "bac", opKey: "complete" },
      { root: "drink", opKey: "complete" },
      { root: "broken", opKey: "complete" },
    ]);
  });
});
