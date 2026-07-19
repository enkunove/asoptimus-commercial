// @aso/server/apple-dispatch — job execution channel. Two implementations:
//  • WssJobChannel — sends job.dispatch to a real client via ClientHub, awaits job.result.
//  • LoopbackJobChannel — DEV bench (DEV=1 only): executes the job locally against mock-apple,
//    REPRODUCING the client-side ProbeJob algorithm (D2: shortcut → early-stop ladder → childTerms).
//    In PROD jobs go to a real client (WssJobChannel); this algorithm lives in the client repo.

import type { Job, ProbeJob, SerpJob, HintsJob, JobResult, ProbeResult, RawHints } from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";
import { ClientHub } from "./hub.ts";
import { mockHints, mockSerp } from "./mock-apple.ts";

export interface JobChannel {
  run(job: Job): Promise<JobResult>;
  readonly kind: "wss" | "loopback";
}

export class WssJobChannel implements JobChannel {
  readonly kind = "wss" as const;
  constructor(private hub: ClientHub, private userId: string) {}
  run(job: Job): Promise<JobResult> {
    return this.hub.dispatchJob(this.userId, job.job_id, { t: "job.dispatch", job });
  }
}

export class LoopbackJobChannel implements JobChannel {
  readonly kind = "loopback" as const;

  async run(job: Job): Promise<JobResult> {
    if (job.kind === "probe") return this.execProbe(job);
    if (job.kind === "serp") return this.execSerp(job);
    return this.execHints(job as HintsJob);
  }

  /** DEV reproduction of the client ProbeJob algorithm (D2). Returns ONLY prefixes that were
   *  actually "fetched" (in prod this code lives in the client repo). */
  private execProbe(job: ProbeJob): ProbeResult {
    const K = normalizeKeyword(job.keyword);
    const fetched: Record<string, RawHints> = {};
    const take = (prefix: string): RawHints => {
      if (job.prefill[prefix]) return job.prefill[prefix]; // from D3 cache — no "network"
      if (fetched[prefix]) return fetched[prefix];
      const terms = mockHints(prefix); // "network" (mock)
      fetched[prefix] = terms;
      return terms;
    };

    // 1. Full prefix K — detect unsuggested in a single request (shortcut D2).
    const full = take(K);
    if (!full.some((t) => normalizeKeyword(t) === K)) {
      return { job_id: job.job_id, kind: "probe", fetched, childTerms: null, unsuggested: true };
    }
    // 2. Ascending ladder, early stop at the minimal L (order is mandatory).
    for (const prefix of job.prefixLadder) {
      const terms = take(prefix);
      if (terms.some((t) => normalizeKeyword(t) === K)) break;
    }
    // 3. childTerms for childCount: from childPrefill (D3 cache, reconcile v2) or a "fetch".
    const childTerms = job.childPrefill ?? mockHints(K + " ");
    return { job_id: job.job_id, kind: "probe", fetched, childTerms, unsuggested: false };
  }

  private execSerp(job: SerpJob): JobResult {
    return { job_id: job.job_id, kind: "serp", raw: mockSerp(job.query) };
  }

  private execHints(job: HintsJob): JobResult {
    return { job_id: job.job_id, kind: "hints", raw: mockHints(job.term) };
  }
}
