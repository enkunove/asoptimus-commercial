# 02 — Apple data sources

Two endpoints. Both require no authorization. Both go through a single HTTP layer with throttling and caching (below).

## 2.1 Search autocomplete suggestions (undocumented)

```
GET https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term={prefix}
Headers:
  X-Apple-Store-Front: {storefrontId}-1,29
  User-Agent: AppStore/3.0 iOS/17.0 model/iPhone14,2
```

- `{prefix}` — URL-encoded query string (what the "user is typing").
- The response is an XML plist OR JSON (Apple has changed the format before). The parser must support both:
  - plist: an array of dictionaries with a `term` key (the suggestion string); array order = rank;
  - JSON: `{ "hints": [ { "term": "..." }, ... ] }`.
- From the response we take the ordered list of strings `hints[]` (usually ≤10). Suggestion rank = index + 1.
- If the response contains a numeric `priority` — store it raw in the cache (may come in handy), but do NOT use it in v1 formulas (undocumented, unknown scale).

**Mandatory smoke test during the build** (the only place in the spec where exploratory behavior is allowed): hit the endpoint with `term=photo` and the US storefront; if the response format differs from both described — adapt the parser to the actual response and record a sample response in `test/fixtures/hints-response.example`.

**Fallback:** if the endpoint consistently returns non-200 (Apple changed/closed it), the pipeline does not crash: Popularity is marked `unavailable`, the run state gets `hintsEndpointDown: true` (the UI shows a yellow banner with an explanation). In this mode Score is computed with P=50 for everyone (neutralizing the factor) and a `degraded` flag on every keyword.

## 2.2 Search results (official iTunes Search API)

```
GET https://itunes.apple.com/search?media=software&entity=software&term={query}&country={cc}&lang={lang}&limit=25
```

The response is JSON `{ resultCount, results: [...] }`. Fields used from each result:

| Field | Why |
|---|---|
| `trackId`, `trackName` | identification; finding keyword occurrences in the name |
| `averageUserRating`, `userRatingCount` | competitor strength |
| `currentVersionReleaseDate` | competitor freshness |
| `primaryGenreName`, `genres` | niche context (for UI and report) |
| `artworkUrl100` | icon in the UI |
| `sellerName` | display in the UI |

Documented limit: ~20 requests/min per IP. Our budget is lower (see 2.4).

## 2.3 Storefront code table

Stored in the sources as `src/storefronts.json`. Header: `X-Apple-Store-Front: <id>-1,29`.

| country | id | | country | id |
|---|---|---|---|---|
| us | 143441 | | jp | 143462 |
| gb | 143444 | | kr | 143466 |
| de | 143443 | | cn | 143465 |
| fr | 143442 | | br | 143503 |
| it | 143450 | | mx | 143468 |
| es | 143454 | | au | 143460 |
| ca | 143455 | | in | 143467 |
| ru | 143469 | | tr | 143480 |
| nl | 143452 | | ua | 143492 |
| se | 143456 | | pl | 143478 |

During the build, verify the codes at least for us/gb/de/ru with a smoke test (suggestions in the country's local language = the code is correct). An unknown country in the config → exit code 2 with the list of supported countries.

## 2.4 HTTP layer: throttling, cache, retries (single layer for both endpoints)

This is the heart of "politeness". Implemented ONCE; all requests go only through it.

- **Token bucket:** capacity = `http.requestsPerMinute` (default 18), refill of 1 token every `60/rpm` seconds. No token — the request waits in a FIFO queue. Additionally, 300–900 ms of jitter between actual sends.
- **Cache:** file-based, shared across all runs: `<dataDir>/cache/<sha1(method+url+storefront)>.json`, contents `{ fetchedAt, url, status, body }`. TTL = `http.cacheTtlDays`. A cache hit does NOT spend tokens. The run option "fresh data" ignores TTL on read (but the result is still written to the cache).
- **Retries:** on 429/403/5xx/timeout — exponential backoff 5s → 20s → 60s (max `http.retries`). Once exhausted — the keyword is marked `status: "error"` with the reason text, and the pipeline continues (one error does not kill the run).
- **Counters:** the HTTP layer tracks `requestsMade`, `cacheHits`, `throttleWaitMs` in state — the UI shows them live.

## 2.5 Apple Search Ads (v1.1, interface only)

In `src/apple/`, provide the interface `PopularityProvider { getPopularity(keyword): number | null }` with the single v1 implementation `SuggestPopularityProvider` (formula from `03-metrics.md`). v1.1 will add `AsaPopularityProvider` (official popularity on a 5-point scale via an Apple Search Ads account). The Score assembly code must not know where the popularity came from.
