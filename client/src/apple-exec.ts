// Маршрутизатор джоб: сервер решает ЧТО фетчить (Probe/Serp/Hints), клиент — КАК.
// Каждая джоба → соответствующая apple/-функция → JobResult (всегда СЫРЬЁ, без метрик, D2).

import type { AppleHttp } from "./apple/http";
import type { Job, JobResult } from "@aso/shared";
import { executeProbe } from "./apple/probe";
import { searchApps } from "./apple/search";
import { fetchHints } from "./apple/hints";

/** Исполнить одну джобу против Apple. Бросает при ошибке — вызывающий шлёт job.error. */
export async function executeJob(http: AppleHttp, job: Job): Promise<JobResult> {
  switch (job.kind) {
    case "probe":
      return await executeProbe(http, job);
    case "serp": {
      // reconcile v2: country кладёт сервер (SerpJob.country) — клиент НЕ реверс-мапит storefront id.
      const raw = await searchApps(http, job.query, job.country, job.lang);
      return { job_id: job.job_id, kind: "serp", raw };
    }
    case "hints": {
      const raw = await fetchHints(http, job.term, job.storefront);
      return { job_id: job.job_id, kind: "hints", raw };
    }
    default: {
      // Исчерпывающая проверка: новый JobKind в контракте потребует ветки здесь.
      const _exhaustive: never = job;
      throw new Error(`неизвестный тип джобы: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
