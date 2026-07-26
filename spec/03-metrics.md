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

The semantic half is assigned by the built-in LLM via the batch call `rate` (contract in `06-llm-adapters.md`) at PRESCREEN time — before any measurement, gating the measurement budget. The rubric (v3) rates **searcher intent** — *who types this query into the App Store search bar, and what are they hoping to install?* — embedded in the prompt verbatim:

| R | Criterion |
|---|---|
| 3 | The dominant search intent IS the job our app does — the searcher is looking for exactly our kind of app (generic wording is fine; intent, not word overlap) |
| 2 | A large share of searchers would be satisfied by our app: an adjacent job we genuinely cover, or a mixed-intent query where our reading is strong |
| 1 | Small minority intent — most searchers want something else |
| 0 | Wrong traffic: the dominant intent is something we are not — including the OPPOSITE need (wanting to gamble when we help quit) and anti-semantics matches → excluded |

`reason` is mandatory (non-empty), stored in state, shown in the UI next to the score; the entire LLM call itself (prompt + response) is available in the LLM call log. This makes the LLM's judgment human-verifiable. Topic match is NOT intent match: a query can name our topic and still be 0, and can share zero words with the product and still be 3.

### 3.3v3 Intent leads, the store disambiguates (supersedes v2's fit-dominant blend)

**What v2 got right:** R is computed, not asked — no per-keyword final LLM call, `classify` verdicts cached per app per run (`state.appNiche`), full traceability. All of that stays.

**What v2 got wrong (falsified on live runs):** SERP composition is *competition* information, not relevance. For counter-positioned products the SERP of the most core queries is dominated by the industry the user is escaping — "block betting apps" (a quit-gambling blocker's literal core) scored R=0.3 and was **excluded**, while generic-tool queries ("days until", "counter") scored ~2 off coincidental niche labels. Against a 3-lens judge panel over a full production run, v2's ranking correlated at ρ=0.04 (noise), with 55% pairwise inversions and 65% of truth-good keywords excluded. Folding SERP strength into R also double-counts competition, which already lives in D.

**The fix has two halves:**

1. **The prescreen rubric asks about SEARCHER INTENT, not topical overlap** (`prompts/rate.md`): *"who types this into the App Store search bar, and what are they hoping to install?"* Under the old topical rubric the LLM rated "gambling" 3 (topically core; the searcher wants a casino) and "gambling ban" 1 (intent = wants gambling banned — exactly us). Under the intent rubric, on panel-labeled data, **intent=3 predicted truth≥2 in 100% of cases** (39/43 exactly 3) — the intent rating is the ground-truth-grade signal, measured store fit is not.
2. **`classify` judges the app's own advertised purpose** (with genre + description snippet as evidence, not name alone): purpose-built for our core job = 1; a generic tool that could be repurposed = 0.5 at most. This kills the "Counter+ directly matches bet-free streak tracking" label inflation.

Final R is intent-led; the measured evidence `E` modulates only the uncertain middle bands:

```
serpFit = Σ_i  posWeight(i) · match(app_i)        // as in v2; posWeight mirrors D
conf    = min(1, observed / serpTop)
E       = conf · serpFit + (1 − conf) · (sem/3)   // thin evidence falls back to the prior

R = 0                     sem = 0    // anti-semantics / opposite-need veto, non-negotiable
    0.4 + 0.8·E           sem = 1    // 0.4–1.2: crosses include (R≥1) only on store confirmation
    1.4 + 1.0·E           sem = 2    // 1.4–2.4: store evidence disambiguates mixed intent
    3.0                   sem = 3    // core intent is not negotiable by SERP composition
```

A core phrase now scores a full 3 — differences *among* cores are demand and competition, i.e. P's and D's channels, not R's. Offline validation against judge-panel ground truth (289 measured keywords of a production run): objective 0.29 (v3) vs 2.0 (best exponent blend) vs 7.07 (v2.2); core recall (truth-3 → R≥2.8) **100%**, junk suppression 99%, false exclusions 0, rank inversions 0.

**Brand traps (v3, replaces the exact-name "dead brand" detector).** Two detectors in union, finalized at rating time and guarded by intent: `brandQuery = (sem < 3) ∧ (prescreen brand flag ∨ isBrandNameQuery)`. The prescreen flag catches famous and coined brands the LLM recognizes blind; `isBrandNameQuery` catches suggest-seeded phantoms the LLM can't know: the query matches a NAME SEGMENT (split on `:|–-·`) of a weak (<300 ratings) top-3 app and no app with ≥1000 ratings owns the phrase in full ("cbt thought record" → "TellMe: CBT Thought Record", 3 ratings, phantom P=78). The sem<3 guard exists because young niches consist entirely of weak apps — without it the signature false-flags real cores ("quit gambling"). Judge-labeled traps: recall 0.83, zero flags on truth≥2 keywords; flagged keywords keep their R but Score=0.

R is continuous. Keywords with `R ≥ 1` are included (charged, enter the sample and assembly); below 1 they are excluded (not charged). The `reason` stays code-generated: `"R 3 = intent 3/3. <prescreen reason>"` / `"R 1.9 = intent 2/3 · store-fit 55%. …"`. Implementation: `core/metrics/relevance.ts`, `core/metrics/difficulty.ts` (`isBrandNameQuery`), `prompts/rate.md`, `prompts/classify.md`.

## 3.4 Opportunity Score, 0–100 — final strength

```
Score = round(100 × (P/100)^0.6 × ((100 − D)/100)^0.4 × (R/3))
```

The power form: both factors must be non-zero (a popular but impenetrable query ≈ useless; an empty but easy one — likewise), and the exponents 0.6/0.4 prioritize demand. R is a linear multiplier: adjacent queries (R=2) lose a third of their strength. (With R now continuous per 3.3v2, `R/3` is evaluated directly — e.g. R=2.8 → ×0.933.)

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
