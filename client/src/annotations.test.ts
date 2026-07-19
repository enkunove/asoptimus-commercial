// spec 09 §7 acceptance: pins/notes survive restarts (file roundtrip), die with run deletion,
// stay inside the annotations dir for hostile runIds, and — the privacy promise — generate
// ZERO cloud traffic: the localserver annotation routes must never touch the CloudLink.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setDataDir, dataDir } from "./paths.ts";
import {
  readAnnotations, writeAnnotation, deleteAnnotations, pinnedKeywords, notesMap,
} from "./annotations.ts";
import { startLocalServer } from "./localserver.ts";
import type { CloudLink } from "./cloud-link.ts";

const tmp = mkdtempSync(join(tmpdir(), "aso-ann-"));
beforeAll(() => setDataDir(tmp));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("annotations file store", () => {
  test("write → read roundtrip; pin and note merge independently", () => {
    writeAnnotation("run_a", "habit tracker", { pinned: true });
    writeAnnotation("run_a", "habit tracker", { note: "try in title" });
    const all = readAnnotations("run_a");
    expect(all["habit tracker"].pinned).toBe(true);
    expect(all["habit tracker"].note).toBe("try in title");
    expect(pinnedKeywords("run_a")).toEqual(["habit tracker"]);
    expect(notesMap("run_a")).toEqual({ "habit tracker": "try in title" });
  });

  test("notes are capped at 500 chars; empty unpinned entries are pruned", () => {
    writeAnnotation("run_a", "long", { note: "x".repeat(700) });
    expect(readAnnotations("run_a").long.note.length).toBe(500);
    writeAnnotation("run_a", "long", { note: "", pinned: false });
    expect(readAnnotations("run_a").long).toBeUndefined();
  });

  test("hostile runId cannot escape the annotations dir", () => {
    writeAnnotation("../../evil", "kw", { pinned: true });
    expect(existsSync(join(dataDir(), "annotations", ".._.._evil.json"))).toBe(true);
    expect(existsSync(join(tmp, "..", "evil.json"))).toBe(false);
    deleteAnnotations("../../evil");
  });

  test("deleteAnnotations removes the file (annotations die with the run)", () => {
    writeAnnotation("run_b", "kw", { pinned: true });
    deleteAnnotations("run_b");
    expect(readAnnotations("run_b")).toEqual({});
  });
});

describe("localserver annotation routes: zero cloud traffic", () => {
  const cloudCalls: string[] = [];
  // Every CloudLink method records its name; annotation ops must record NOTHING.
  const fakeCloud = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "subscribe") return () => () => {};
      if (prop === "status") return () => ({ mode: "stub", connected: true, balance: 0 });
      return (..._args: unknown[]) => { cloudCalls.push(prop); return Promise.resolve({}); };
    },
  }) as CloudLink;

  const TOKEN = "test-token";
  let server: ReturnType<typeof startLocalServer>;
  let base = "";

  beforeAll(() => {
    server = startLocalServer({
      port: 0, token: TOKEN,
      getCloud: () => fakeCloud,
      isActivated: () => true,
      activate: async () => {}, logout: async () => {},
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  async function call(method: string, path: string, body?: unknown) {
    return fetch(base + path, {
      method,
      headers: { "x-aso-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  test("pin + note + read fire no CloudLink method", async () => {
    cloudCalls.length = 0;
    const post = await call("POST", "/api/runs/run_zero/annotations", { keyword: "focus timer", pinned: true, note: "n1" });
    expect(post.status).toBe(200);
    const get = await call("GET", "/api/runs/run_zero/annotations");
    expect(((await get.json()) as any).annotations["focus timer"].pinned).toBe(true);
    expect(cloudCalls).toEqual([]); // the server stays pin-blind
    deleteAnnotations("run_zero");
  });

  test("keywords with insight=pinned is translated into a local allowlist (no insight leaks)", async () => {
    writeAnnotation("run_pin", "water reminder", { pinned: true });
    cloudCalls.length = 0;
    await call("GET", "/api/runs/run_pin/keywords?insight=pinned");
    expect(cloudCalls).toEqual(["listKeywords"]); // one relay read, nothing else
    deleteAnnotations("run_pin");
  });
});
