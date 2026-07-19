// @aso/server/apple-dispatch — network-wide raw-data cache (D3) + prefill/childPrefill assembly +
// job dispatch + write-through + idempotency by job_id (D7). The prefill∪fetched merge and childCount
// live HERE (the right home for the D2/D3 blocker); the orchestrator gets ready raw data for metrics.
//
// Replay mode (D7): raw data comes ONLY from apple_cache; a miss = the frontier of durable history
// (ReplayFrontier) — the job is not dispatched, the client is not touched.

import { randomUUID } from "node:crypto";
import type { Store, AppleCacheRow } from "../db/index.ts";
import type { RawHints, RawSerp, ProbeJob, SerpJob, HintsJob, ProbeResult, SerpResult, HintsResult } from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";
import { prefixLadder } from "../core/metrics/popularity.ts";
import type { JobChannel } from "./channel.ts";
import { ReplayFrontier } from "../replay.ts";

const TTL_MS = 7 * 24 * 3600 * 1000; // D3: raw-data TTL

export interface ProbeRaw {
  /** prefill ∪ fetched, key = prefix (for computePopularity, D2/D3). */
  prefixHints: Record<string, RawHints>;
  childTerms: RawHints | null;
  unsuggested: boolean;
}

export class AppleGateway {
  private replaying = false;

  constructor(
    private store: Store,
    private channel: JobChannel,
    private runId: string,
    /** 2-letter country code of the run — goes into SerpJob.country (reconcile v2). */
    private country: string,
  ) {}

  /** Enable replay mode (cache-only, ReplayFrontier on a miss). */
  setReplay(on: boolean) { this.replaying = on; }

  private hintsKey(storefront: number, prefix: string) { return `hints:${storefront}:${prefix}`; }
  private serpKey(storefront: number, lang: string, query: string) { return `serp:${storefront}:${lang}:${query}`; }

  private fresh(row: AppleCacheRow | null): AppleCacheRow | null {
    if (!row) return null;
    if (Date.now() - Date.parse(row.fetched_at) > TTL_MS) return null;
    return row;
  }
  private async getHintsCache(storefront: number, prefix: string): Promise<RawHints | null> {
    const row = this.fresh(await this.store.getCache(this.hintsKey(storefront, prefix)));
    return row ? (row.body as RawHints) : null;
  }
  private async putHintsCache(storefront: number, prefix: string, hints: RawHints, url = "") {
    await this.store.putCache({
      cache_key: this.hintsKey(storefront, prefix), url, storefront, status: 200,
      body: hints, fetched_at: new Date().toISOString(),
    });
  }

  /** ProbeJob: assemble prefill/childPrefill from cache → dispatch → write-through → merge (D2/D3). */
  async probe(keyword: string, storefront: number): Promise<ProbeRaw> {
    const K = normalizeKeyword(keyword);
    const ladder = prefixLadder(K);

    if (this.replaying) return this.replayProbe(K, ladder, storefront);

    const prefill: Record<string, RawHints> = {};
    for (const p of ladder) {
      const c = await this.getHintsCache(storefront, p);
      if (c) prefill[p] = c;
    }
    const childCached = await this.getHintsCache(storefront, K + " ");

    const job: ProbeJob = {
      job_id: randomUUID(), kind: "probe", run_id: this.runId,
      keyword: K, storefront, prefixLadder: ladder, prefill,
      // reconcile v2: dedicated childPrefill field (not the prefill["K "] convention). Present in
      // cache → the client does NOT fetch childTerms.
      ...(childCached ? { childPrefill: childCached } : {}),
    };
    await this.store.insertJob({ job_id: job.job_id, run_id: this.runId, kind: "probe", payload: job, status: "dispatched", result: null, deadline: null });

    const result = (await this.channel.run(job)) as ProbeResult;
    await this.store.updateJob(job.job_id, { status: "done", result });

    // write-through of what was actually fetched (D3).
    for (const [p, hints] of Object.entries(result.fetched)) await this.putHintsCache(storefront, p, hints);
    if (result.childTerms && !childCached) await this.putHintsCache(storefront, K + " ", result.childTerms);

    // merge prefill∪fetched.
    const prefixHints: Record<string, RawHints> = { ...prefill };
    for (const [p, h] of Object.entries(result.fetched)) prefixHints[p] = h;

    return {
      prefixHints,
      childTerms: result.childTerms ?? childCached ?? null,
      unsuggested: result.unsuggested,
    };
  }

  /** Replay probe: reconstruct ProbeRaw from cache (write-through made all fetches durable). */
  private async replayProbe(K: string, ladder: string[], storefront: number): Promise<ProbeRaw> {
    const prefixHints: Record<string, RawHints> = {};
    for (const p of ladder) {
      const c = await this.getHintsCache(storefront, p);
      if (c) prefixHints[p] = c;
    }
    const fullK = prefixHints[K];
    if (fullK === undefined) throw new ReplayFrontier(`probe ${K}`);
    const unsuggested = !fullK.some((t) => normalizeKeyword(t) === K);
    if (unsuggested) return { prefixHints, childTerms: null, unsuggested: true };
    const child = await this.getHintsCache(storefront, K + " ");
    if (child === null) throw new ReplayFrontier(`probe ${K} childTerms`);
    return { prefixHints, childTerms: child, unsuggested: false };
  }

  /** SerpJob: cache → dispatch → write-through. */
  async serp(query: string, storefront: number, lang: string): Promise<RawSerp> {
    const q = normalizeKeyword(query);
    const key = this.serpKey(storefront, lang, q);
    const cached = this.fresh(await this.store.getCache(key));
    if (cached) return cached.body as RawSerp;
    if (this.replaying) throw new ReplayFrontier(`serp ${q}`);

    const job: SerpJob = { job_id: randomUUID(), kind: "serp", run_id: this.runId, query: q, storefront, country: this.country, lang };
    await this.store.insertJob({ job_id: job.job_id, run_id: this.runId, kind: "serp", payload: job, status: "dispatched", result: null, deadline: null });
    const result = (await this.channel.run(job)) as SerpResult;
    await this.store.updateJob(job.job_id, { status: "done", result });

    await this.store.putCache({ cache_key: key, url: "", storefront, status: 200, body: result.raw, fetched_at: new Date().toISOString() });
    return result.raw;
  }

  /** HintsJob: cache → dispatch → write-through. */
  async hints(term: string, storefront: number): Promise<RawHints> {
    const t = normalizeKeyword(term);
    const cached = await this.getHintsCache(storefront, t);
    if (cached) return cached;
    if (this.replaying) throw new ReplayFrontier(`hints ${t}`);

    const job: HintsJob = { job_id: randomUUID(), kind: "hints", run_id: this.runId, term: t, storefront };
    await this.store.insertJob({ job_id: job.job_id, run_id: this.runId, kind: "hints", payload: job, status: "dispatched", result: null, deadline: null });
    const result = (await this.channel.run(job)) as HintsResult;
    await this.store.updateJob(job.job_id, { status: "done", result });

    await this.putHintsCache(storefront, t, result.raw);
    return result.raw;
  }
}
