// Исполнитель ProbeJob (BUILD-PLAN D2) — САМОЕ важное в клиенте.
// Инкапсулирует ВСЮ процедуру probing'а одного кейворда в один облачный round-trip:
//   (1) полный префикс `keyword`: если keyword ∉ его подсказок → unsuggested за 1 запрос
//       (shortcut — НЕ идём по всей лестнице для unsuggested);
//   (2) иначе — лестница `prefixLadder` СТРОГО по возрастанию длины: для каждого префикса
//       берём контент из prefill (без сети) либо фетчим; останавливаемся на КРАТЧАЙШЕМ
//       префиксе, где keyword встретился. Нельзя пропускать более короткий cache-miss ради
//       более длинного cache-hit — L это минимум, порядок обязателен;
//   (3) фетчим/берём `keyword + " "` для childTerms;
//   (4) возвращаем ProbeResult с ТОЛЬКО реально фетченными префиксами (полные массивы) +
//       childTerms. НИКАКИХ метрик — P/L/rank/childCount/seenTerms считает сервер над
//       `prefill ∪ fetched` (D2/D3).
//
// Матч keyword ∈ подсказки — механический строковый (нормализация нужна лишь для сравнения,
// это публичный хелпер из @aso/shared, не moat).

import type { AppleHttp } from "./http";
import type { ProbeJob, ProbeResult, RawHints } from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";
import { fetchHints } from "./hints";

/** Выполнить ProbeJob против Apple. Возвращает СЫРЬЁ (fetched-префиксы + childTerms). */
export async function executeProbe(http: AppleHttp, job: ProbeJob): Promise<ProbeResult> {
  const K = normalizeKeyword(job.keyword);
  const prefill = job.prefill ?? {};

  // Кэш увиденного за эту джобу: prefill + уже фетченное. Ключ = префикс.
  const seen = new Map<string, RawHints>();
  // ТОЛЬКО реально фетченные (по сети) префиксы — их сервер ещё не имеет.
  const fetched: Record<string, RawHints> = {};

  // Взять подсказки префикса: prefill → без сети; иначе фетч (и запись в fetched).
  const getPrefix = async (prefix: string): Promise<RawHints> => {
    const cached = seen.get(prefix);
    if (cached) return cached;
    const pre = prefill[prefix];
    if (pre) {
      seen.set(prefix, pre);
      return pre;
    }
    const hints = await fetchHints(http, prefix, job.storefront);
    seen.set(prefix, hints);
    fetched[prefix] = hints;
    return hints;
  };

  const contains = (hints: RawHints): boolean => hints.some((t) => normalizeKeyword(t) === K);

  // (1) Полный префикс = сам keyword. Shortcut для unsuggested.
  const fullHints = await getPrefix(K);
  if (!contains(fullHints)) {
    return { job_id: job.job_id, kind: "probe", fetched, childTerms: null, unsuggested: true };
  }

  // (2) Лестница строго по возрастанию длины; ранняя остановка на кратчайшем совпадении.
  //     prefixLadder детерминирован сервером как ['k','ke',…,keyword] — идём по нему по порядку.
  for (const prefix of job.prefixLadder) {
    const hints = await getPrefix(prefix);
    if (contains(hints)) break; // кратчайший L найден
  }

  // (3) childTerms: подсказки на "keyword " (для childCount). Сервер посчитает число сам.
  //     reconcile v2: если сервер уже держит их в childPrefill (кэш D3) — НЕ фетчим (0 сети).
  const childKey = K + " ";
  let childTerms: RawHints | null = null;
  if (job.childPrefill) {
    childTerms = job.childPrefill;
  } else {
    try {
      // childKey может лежать в общем prefill, тогда без сети; иначе фетч.
      childTerms = prefill[childKey] ?? (await fetchHints(http, childKey, job.storefront));
    } catch {
      // Отдельная неудача childTerms не должна валить всю джобу — вернём null.
      childTerms = null;
    }
  }

  return { job_id: job.job_id, kind: "probe", fetched, childTerms, unsuggested: false };
}
