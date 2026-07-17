// @aso/server/apple-dispatch — канал исполнения джоб. Две реализации:
//  • WssJobChannel — отправляет job.dispatch реальному клиенту через ClientHub, ждёт job.result.
//  • LoopbackJobChannel — DEV-стенд (только при DEV=1): исполняет джобу локально по mock-apple,
//    ВОСПРОИЗВОДЯ клиентский алгоритм ProbeJob (D2: shortcut → лестница early-stop → childTerms).
//    В ПРОДЕ джобы идут реальному клиенту (WssJobChannel); этот алгоритм живёт в репо client.

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

  /** DEV-воспроизведение клиентского алгоритма ProbeJob (D2). Возвращает ТОЛЬКО реально
   *  «фетченные» префиксы (в проде этот код живёт в репо client). */
  private execProbe(job: ProbeJob): ProbeResult {
    const K = normalizeKeyword(job.keyword);
    const fetched: Record<string, RawHints> = {};
    const take = (prefix: string): RawHints => {
      if (job.prefill[prefix]) return job.prefill[prefix]; // из кэша D3 — без «сети»
      if (fetched[prefix]) return fetched[prefix];
      const terms = mockHints(prefix); // «сеть» (mock)
      fetched[prefix] = terms;
      return terms;
    };

    // 1. Полный префикс K — детект unsuggested за один запрос (shortcut D2).
    const full = take(K);
    if (!full.some((t) => normalizeKeyword(t) === K)) {
      return { job_id: job.job_id, kind: "probe", fetched, childTerms: null, unsuggested: true };
    }
    // 2. Восходящая лестница, ранняя остановка на минимальном L (порядок обязателен).
    for (const prefix of job.prefixLadder) {
      const terms = take(prefix);
      if (terms.some((t) => normalizeKeyword(t) === K)) break;
    }
    // 3. childTerms для childCount: из childPrefill (кэш D3, reconcile v2) или «фетч».
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
