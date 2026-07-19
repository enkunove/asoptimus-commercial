# 03 — Metrics: formulas and examples

All metrics are integers, computable from cached Apple responses. Recomputing from the cache always yields the same result. Weights come from `aso.config.json` (the formulas below use the defaults).

Keyword normalization before any computation: `lowercase → trim → collapse repeated spaces → NFC`. Duplicates after normalization — a single keyword.

## 3.1 Popularity (P), 0–100 — demand proxy from autocomplete suggestions

**Intuition:** the shorter the prefix at which Apple already suggests the phrase, and the higher it sits in the suggestion list — the more often it is searched. That is precisely the signal Apple ranks suggestions by.

**Probing procedure for keyword K of length N characters:**
1. Request suggestions for prefixes `K[0:i]`, i = 1, 2, 3, … N (each request is cached — prefixes are reused across keywords, so the real cost drops quickly).
2. **L** = the minimum prefix length at which K appears in the suggestions (exact match after normalization). **rank** = K's position in the list at that prefix (1..10).
3. Early stop: as soon as K is found — stop (prefixes longer than L are not needed).
4. If K never appeared at any prefix up to i = N → P = 0, flag `unsuggested: true`.

**Formula** (N ≥ 2; N = 1 cannot occur — single-letter keywords do not exist, the minimum word length in hypotheses is 3 characters):

```
DepthScore = (N − L) / (N − 1)          // L=1 → 1.0; L=N → 0.0
RankScore  = (11 − rank) / 10           // rank 1 → 1.0; rank 10 → 0.1
P = round(100 × (0.7 × DepthScore + 0.3 × RankScore))
```

**Example:** K = `habit tracker`, N = 13. The phrase appeared in the suggestions at prefix `habi` (L = 4) at position 2.
DepthScore = (13−4)/12 = 0.75; RankScore = (11−2)/10 = 0.9; P = round(100 × (0.7×0.75 + 0.3×0.9)) = round(79.5) = **80**.

**Additional signal (stored, not part of P):** `childCount` — how many suggestions for the query `K + " "` start with K (how many "children" the phrase spawns). An indicator of long-tail potential, shown in the UI, used by the pipeline to pick expansion directions (`04-pipeline.md`).

## 3.2 Difficulty (D), 0–100 — competition strength from search results

**Intuition:** search results are hard to beat when the top is occupied by apps with a large volume of ratings, high scores, fresh updates, and an exact keyword match in the name (i.e., they deliberately own this query).

For each app i at position i = 1..`serpTop` (default 10) of the search results for K:

```
V = min(1, log10(userRatingCount + 1) / 6)        // volume: 1M+ ratings → 1.0
Q = averageUserRating / 5                          // quality
F = max(0, 1 − daysSince(currentVersionReleaseDate) / 365)   // freshness
M = 1.0  if K is contained whole in trackName (substring, case-insensitive)
    0.5  if all words of K appear in trackName in any order
    0.0  otherwise
AppStrength_i = 100 × (0.45×V + 0.15×Q + 0.15×F + 0.25×M)
```

Positional weights (the top of the results matters more): `w_i = (serpTop + 1 − i) / Σ` (for serpTop=10: 10/55, 9/55, … 1/55).

```
D_raw = Σ w_i × AppStrength_i
n     = actual number of results (resultCount, capped at serpTop)
D     = round(D_raw × n / serpTop)     // few results = weak niche → D drops
```

Also stored: `resultCount` of the full query (limit=25) as `serpSize` — a niche saturation indicator for the UI.

**Example:** competitor #1 — 250,000 ratings, score 4.7, updated 30 days ago, K whole in the name:
V = log10(250001)/6 = 0.90; Q = 0.94; F = 1−30/365 = 0.92; M = 1.0
AppStrength = 100 × (0.45×0.90 + 0.15×0.94 + 0.15×0.92 + 0.25×1.0) = **93**.
If all ten look like this — D ≈ 93 (a bloodbath). If after the top 3 come dead apps with no ratings or updates — D drops to 40–50, and that is an honest "you can squeeze in here" signal.

## 3.3 Relevance (R), 0–3 — the only LLM metric, by rubric

Assigned by the built-in LLM via the batch call `rate` (contract in `06-llm-adapters.md`), which receives the business context and a batch of verified keywords. The rubric is strict and embedded in the prompt verbatim:

| R | Criterion |
|---|---|
| 3 | The query describes the CORE of the product: a user searching for this is looking for exactly this kind of app |
| 2 | An adjacent job: our app solves it, but it is not its main function |
| 1 | A tangential overlap: some of the searchers might be satisfied with our app |
| 0 | Irrelevant or matches the anti-semantics from aso-context.md → excluded |

`reason` is mandatory (non-empty), stored in state, shown in the UI next to the score; the entire LLM call itself (prompt + response) is available in the LLM call log. This makes the LLM's judgment human-verifiable. Keywords matching the anti-semantics from the context must receive R=0.

## 3.4 Opportunity Score, 0–100 — final strength

```
Score = round(100 × (P/100)^0.6 × ((100 − D)/100)^0.4 × (R/3))
```

The power form: both factors must be non-zero (a popular but impenetrable query ≈ useless; an empty but easy one — likewise), and the exponents 0.6/0.4 prioritize demand. R is a linear multiplier: adjacent queries (R=2) lose a third of their strength.

**Examples:**
- P=80, D=70, R=3 → 100 × 0.8^0.6 × 0.3^0.4 × 1 = 100 × 0.875 × 0.618 = **54**
- P=35, D=25, R=3 → 100 × 0.533 × 0.891 × 1 = **47** — modest demand with weak competition nearly catches up with a hyped query dominated by giants. This is the workhorse of indie ASO; the formula is deliberately built that way.
- P=80, D=70, R=1 → 54 × 1/3 = **18** — hype without relevance yields nothing: users who install via an irrelevant query don't convert and hurt the behavioral metrics.

Tie-breaks at equal Score (for sorting and selection): higher P → lower D → shorter K.

**Keywords with P=0** (`unsuggested`): Score = 0, they do not enter greedy selection, but are NOT deleted — they are a speculative reserve for topping up the keyword field (see `05-assembly.md`, the "speculative top-up" step).

## 3.5 What must be in state for each keyword

```json
{
  "keyword": "habit tracker",
  "status": "rated",
  "source": "seed | suggest | competitor | expansion",
  "addedAt": "...", "probedAt": "...",
  "metrics": {
    "P": 80, "L": 4, "rank": 2, "unsuggested": false, "childCount": 6,
    "D": 63, "serpSize": 25, "topApps": [ { "trackId": 1, "trackName": "...", "ratingCount": 250000, "rating": 4.7, "updatedDaysAgo": 30, "match": 1.0, "strength": 93 } ],
    "R": 3, "reason": "core of the product: ...",
    "score": 54
  },
  "degraded": false
}
```
