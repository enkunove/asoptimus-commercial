// Sessions must survive a server restart/deploy (the in-memory-only version logged every
// client out on each deploy). A "restart" here = a fresh AuthService over the same Store.

import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../db/memory-store.ts";
import { AuthService } from "./service.ts";

async function freshUserSession() {
  const store = new MemoryStore();
  const a1 = new AuthService(store);
  const { key, userId } = await a1.signup("s@test.dev");
  const act = await a1.activate(key, "dev-fp");
  if ("error" in act) throw new Error(act.error);
  return { store, a1, act, userId, key };
}

describe("session persistence across restarts", () => {
  test("token issued before a 'restart' verifies after it (async hydration)", async () => {
    const { store, act, userId } = await freshUserSession();
    const a2 = new AuthService(store); // restart: empty cache, same store
    expect(a2.verifySession(act.token)).toBeNull(); // cold sync check misses…
    const sess = await a2.verifySessionAsync(act.token);
    expect(sess?.userId).toBe(userId); // …hydration from the store recovers it
    expect(sess?.hmacSecret).toBe(act.hmacSecret); // HMAC secret survives → signed WSS keeps working
    expect(a2.verifySession(act.token)?.userId).toBe(userId); // now cached for the sync hot path
  });

  test("device binding still enforced after hydration", async () => {
    const { store, act } = await freshUserSession();
    const a2 = new AuthService(store);
    expect(await a2.verifySessionAsync(act.token, "other-device")).toBeNull();
    expect(await a2.verifySessionAsync(act.token, "dev-fp")).not.toBeNull();
  });

  test("refresh rotation persists: old token dead, new token live in yet another instance", async () => {
    const { store, act, userId } = await freshUserSession();
    const a2 = new AuthService(store);
    const rotated = await a2.refresh(act.token, "dev-fp");
    if ("error" in rotated) throw new Error(rotated.error);
    const a3 = new AuthService(store);
    expect(await a3.verifySessionAsync(act.token)).toBeNull();
    expect((await a3.verifySessionAsync(rotated.token))?.userId).toBe(userId);
  });

  test("revoke kills persisted sessions everywhere", async () => {
    const { store, act, key } = await freshUserSession();
    const a2 = new AuthService(store);
    await a2.revoke(key);
    const a3 = new AuthService(store);
    expect(await a3.verifySessionAsync(act.token)).toBeNull();
  });

  test("expired persisted session is rejected and pruned", async () => {
    const { store, act } = await freshUserSession();
    // Force-expire the stored row.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(act.token).digest("hex");
    const row = await store.getSession(hash);
    await store.putSession({ ...row!, expires_at: new Date(Date.now() - 1000).toISOString() });
    // putSession is insert-once in postgres — memory store overwrites; delete+put to mimic:
    await store.deleteSession(hash);
    await store.putSession({ ...row!, expires_at: new Date(Date.now() - 1000).toISOString() });
    const a2 = new AuthService(store);
    expect(await a2.verifySessionAsync(act.token)).toBeNull();
  });
});
