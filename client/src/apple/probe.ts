// ProbeJob executor (BUILD-PLAN D2) — the MOST important thing in the client.
// Encapsulates the WHOLE procedure of probing one keyword in a single cloud round-trip:
//   (1) full prefix `keyword`: if keyword ∉ its hints → unsuggested in 1 request
//       (shortcut — do NOT walk the whole ladder for unsuggested);
//   (2) otherwise — the `prefixLadder` ladder STRICTLY in increasing length: for each prefix
//       take content from prefill (no network) or fetch; stop at the SHORTEST
//       prefix where the keyword appeared. You must not skip a shorter cache-miss for
//       a longer cache-hit — L is a minimum, order is mandatory;
//   (3) fetch/take `keyword + " "` for childTerms;
//   (4) return a ProbeResult with ONLY the actually fetched prefixes (full arrays) +
//       childTerms. NO metrics — P/L/rank/childCount/seenTerms are computed by the server over
//       `prefill ∪ fetched` (D2/D3).
//
// The keyword ∈ hints match is mechanical string comparison (normalization is only needed for
// comparison; it's a public helper from @aso/shared, not the moat).

import type { AppleHttp } from "./http";
import type { ProbeJob, ProbeResult, RawHints } from "@aso/shared";
import { normalizeKeyword } from "@aso/shared";
import { fetchHints } from "./hints";

/** Execute a ProbeJob against Apple. Returns RAW material (fetched prefixes + childTerms). */
export async function executeProbe(http: AppleHttp, job: ProbeJob): Promise<ProbeResult> {
  const K = normalizeKeyword(job.keyword);
  const prefill = job.prefill ?? {};

  // Cache of everything seen during this job: prefill + already fetched. Key = prefix.
  const seen = new Map<string, RawHints>();
  // ONLY prefixes actually fetched (over the network) — the server doesn't have these yet.
  const fetched: Record<string, RawHints> = {};

  // Get hints for a prefix: prefill → no network; otherwise fetch (and record into fetched).
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

  // (1) Full prefix = the keyword itself. Shortcut for unsuggested.
  const fullHints = await getPrefix(K);
  if (!contains(fullHints)) {
    return { job_id: job.job_id, kind: "probe", fetched, childTerms: null, unsuggested: true };
  }

  // (2) Ladder strictly in increasing length; early stop at the shortest match.
  //     prefixLadder is determined by the server as ['k','ke',…,keyword] — walk it in order.
  for (const prefix of job.prefixLadder) {
    const hints = await getPrefix(prefix);
    if (contains(hints)) break; // shortest L found
  }

  // (3) childTerms: hints for "keyword " (for childCount). The server computes the count itself.
  //     reconcile v2: if the server already holds them in childPrefill (D3 cache) — do NOT fetch (0 network).
  const childKey = K + " ";
  let childTerms: RawHints | null = null;
  if (job.childPrefill) {
    childTerms = job.childPrefill;
  } else {
    try {
      // childKey may sit in the shared prefill, then no network; otherwise fetch.
      childTerms = prefill[childKey] ?? (await fetchHints(http, childKey, job.storefront));
    } catch {
      // A standalone childTerms failure must not fail the whole job — return null.
      childTerms = null;
    }
  }

  return { job_id: job.job_id, kind: "probe", fetched, childTerms, unsuggested: false };
}
