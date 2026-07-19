// Job router: the server decides WHAT to fetch (Probe/Serp/Hints), the client decides HOW.
// Each job → the matching apple/ function → JobResult (always RAW material, no metrics, D2).

import type { AppleHttp } from "./apple/http";
import type { Job, JobResult } from "@aso/shared";
import { executeProbe } from "./apple/probe";
import { searchApps } from "./apple/search";
import { fetchHints } from "./apple/hints";

/** Execute one job against Apple. Throws on error — the caller sends job.error. */
export async function executeJob(http: AppleHttp, job: Job): Promise<JobResult> {
  switch (job.kind) {
    case "probe":
      return await executeProbe(http, job);
    case "serp": {
      // reconcile v2: the server sets country (SerpJob.country) — the client does NOT reverse-map storefront ids.
      const raw = await searchApps(http, job.query, job.country, job.lang);
      return { job_id: job.job_id, kind: "serp", raw };
    }
    case "hints": {
      const raw = await fetchHints(http, job.term, job.storefront);
      return { job_id: job.job_id, kind: "hints", raw };
    }
    default: {
      // Exhaustiveness check: a new JobKind in the contract will require a branch here.
      const _exhaustive: never = job;
      throw new Error(`unknown job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
