# 05 — Assembling metadata for maximum coverage

## 5.1 Apple's indexing model (the basis of all rules)

1. What gets indexed is the **union of words** from title + subtitle + keyword field (+ brand, + category name — duplicating their words is pointless).
2. A search query matches if all of its words are present in the union. **Words from different fields combine** — the phrase `sleep tracker` is covered by `sleep` in the subtitle and `tracker` in the keyword field.
3. Field weight in ranking: **title > subtitle > keyword field**. A word's position within a field does not matter.
4. Repeating a word in two fields does NOT boost anything — it only burns characters. Hence the golden rule: **no word repeats across title, subtitle, and keyword field** (and none duplicates the brand's words).
5. For English, Apple matches singular/plural — store only one form (folding rule below). For other languages, do not fold forms (conservative).

## 5.2 The optimization problem (formally)

Given: the set of phrases Φ = all keywords with R ≥ 1 and Score > 0; the vocabulary W = all words of the phrases in Φ minus stopwords minus brand words.
Find: a subset of words S ⊆ W and its partition into (title slogan, subtitle, keyword field) that maximizes

```
Σ over phrases p covered by S:  Score(p) × PlacementWeight(p)
```

subject to the budgets: slogan ≤ `limits.title − len(brand) − 3` (the ` - ` separator), subtitle ≤ 30, keywords ≤ 100.

`PlacementWeight(p)` = the weight of the weakest field holding p's words: all words in title → 1.0; worst word in subtitle → 0.85; worst in keyword field → 0.7. (Positional weight constants: title 1.0 / subtitle 0.85 / kwfield 0.7 — hardcoded, not exposed in config.)

A phrase p is **covered** if each of its words (after folding) ∈ S ∪ brand words. Stopwords in phrases are ignored when checking coverage (`habit tracker for adhd` is covered by the words habit, tracker, adhd).

## 5.3 Form folding (word deduplication rule)

Only for `semanticLanguage` = `en*`. The folding key is computed by rules applied STRICTLY in this order (the first that fires is final):

1. Word length < 4 OR the word is in `EXCEPTIONS` → key = the word as is.
2. Ends in `ss` → as is (`chess`, `class`, `press`, `business`, `access` — not plurals).
3. Ends in `us` or `is` → as is (`focus`, `status`, `bonus`, `virus`, `analysis`, `basis`; rare missed merges like `menus/menu` are an acceptable price).
4. Ends in `ies` and length ≥ 5 → `ies`→`y` (`stories→story`, `categories→category`).
5. Ends in `ches`/`shes`/`xes`/`zes`/`ses`/`oes` → drop `es` (`boxes→box`, `watches→watch`, `heroes→hero`).
6. Ends in `s` → drop `s` (`games→game`, `notes→note`, `planes→plane`, `habits→habit`).

`EXCEPTIONS` — only genuine traps where rules 2–6 would produce a false merge with another real word or mangle an invariable word: `news` (would otherwise merge with `new`), `lens`, `ios`, `css`, `gps`, `sms`, `canvas`, `atlas`. The list is a constant next to the code, with the comment "add here ONLY on a proven false merge, not for tidiness".

**Error asymmetry (design rationale):** a missed merge (`menus` and `menu` both kept) costs a few budget characters; a false merge (`planes` collapsed into `plan`) silently throws a working keyword out of the index. Hence the rules are conservative: when in doubt — don't trim. Among words sharing one key, S keeps the form with the maximum sum of Scores of the phrases it appears in. For non-en languages folding is fully disabled (every form is a separate word).

## 5.4 Word selection algorithm (deterministic greedy)

```
S = ∅; budgetTotal = slogan + 30 + 100 (character budgets of the three fields)
repeat:
  for each word w ∈ W \ S:
    gain(w)  = Σ Score(p) over phrases p that become covered with S ∪ {w}
             + 0.2 × Σ Score(p)/rem(p) over uncovered p where w shrinks the remainder (rem = how many words of p are not yet in S)
    cost(w)  = len(w) + 1                    // +1 — separator (comma or space)
  pick w* = argmax gain(w)/cost(w); tie-breaks: higher gain → shorter word → alphabetical
  if gain(w*) = 0 → exit the loop
  if cost(w*) does not fit in the total remaining budgets → skip w (mark it), continue
  S += w*
```

The 0.2 term is an "advance" for partial progress on multi-word phrases; without it the greedy would never start assembling three-word queries. The algorithm must be a pure function `selectWords(phrases, config) → orderedWords` and covered by unit tests on fixtures.

## 5.5 Placement across fields

1. Sort S by contribution: `contribution(w) = Σ Score(p)` over covered phrases containing w.
2. Fill in order: first the title slogan (while it fits), then the subtitle, the remainder — the keyword field.
3. **Cohesion:** if the top word by contribution belongs to a top phrase together with another word, try to place them in the same field (reshuffling within the budget is allowed as long as it doesn't change the set S) — a phrase entirely in the title ranks stronger than one torn across fields (PlacementWeight accounts for this: recompute the variants and pick the higher total weight; there are few variants, a full permutation search over the top 6 words is acceptable).
4. The result of `assemble()` (saved to state, shown in the UI):
```json
{
  "titleWords": ["habit", "tracker"],
  "subtitleWords": ["streak", "routine", "daily"],
  "keywordFieldDraft": "adhd,planner,reminder,focus,goal,builder,motivation,discipline",
  "budgets": { "titleSloganMax": 19, "subtitleMax": 30, "keywordsMax": 100 },
  "coverage": { "phrasesCovered": 61, "scoreCovered": 2140, "scoreTotal": 2610, "coveredShare": 0.82 },
  "topUncovered": [ { "keyword": "...", "score": 38, "missingWords": ["..."] } ]
}
```

## 5.6 The LLM's role after word selection (the `phrase` call, contract in 06)

The code picks the WORDS; the LLM turns them into human text:
- **Title:** `"<Brand> - <slogan>"` — the slogan must contain all `titleWords` exactly in the given forms; word order and adding stopwords are at the LLM's discretion (stopwords are not indexed but eat budget — add only for readability). Example: words `habit, tracker` → `Habits - Habit Tracker` is FORBIDDEN (repetition), correct: `Brandname - Habit Tracker`.
- **Subtitle:** a phrase built from all `subtitleWords`, readable and selling (people see the subtitle on the product page — it's conversion too, not just index).
- **Keyword field:** the code's draft is accepted as is; the LLM does not touch it (replacements happen only via the user's manual keyword exclusion and reassembly).

The `phrase` response is validated by code (rules 5.7); violations are fed back into the retry prompt (up to 3 attempts, see `04.2`).

## 5.7 Validation (the `validate()` function) — hard rules, each with a code

| Code | Rule |
|---|---|
| T1 | len(title) ≤ 30; starts with `brand` + ` - ` |
| T2 | title contains all titleWords (by folding keys) |
| S1 | len(subtitle) ≤ 30; contains all subtitleWords |
| K1 | len(keywords) ≤ 100; format: comma-separated words, no spaces, no empty elements |
| X1 | no repeated folding keys across title, subtitle, keywords, and brand words |
| X2 | no stopwords in the keyword field |
| X3 | no third-party brand names (checked against the competitor list from aso-context.md) |
| W1 | warning: keyword field shorter than 92 characters — budget underused |

The result is a list of violations (empty = green) + a coverage report (which top phrases are covered by which field); everything is saved to state and displayed on the "Assembly" tab (`07`).

## 5.8 Speculative top-up of the keyword field

If after placing S the keyword field budget is underused (W1): top it up with words from `unsuggested` keywords with R = 3 (demand unconfirmed by suggestions, but relevance is maximal — a free lottery ticket), ordered by descending R, then by ascending length. Mark such words in state as `speculative: true` (the UI shows them in a distinct color).

## 5.9 Cross-localization — the second bucket (included in v1)

Apple indexes more than one localization per storefront: for example, for US both en-US **and es-MX** are indexed, for RU — ru **and en-GB**, and so on. This is a second full 30+30+100-character set that almost everyone is too lazy to fill. We fill it automatically.

**Algorithm — a second pass of the same greedy selection (5.4):**
1. Universe of pass 2: phrases with Score > 0 NOT covered by the pass-1 words ∪ brand words.
2. Vocabulary of pass 2: the words of those phrases minus stopwords, minus brand words, **minus all words selected in pass 1** (a word already in the index — duplicating it in the second localization is pointless; this is rule 5.1-4 extended to both buckets).
3. The same greedy `selectWords`, the same budgets (slogan = 30 − len(brand) − 3, subtitle 30, keywords 100), the same placement (5.5).
4. The `phrase` LLM call for the second bucket is separate, tagged with the locale (the text should be readable in the extra localization's language where possible; with English semantics an English slogan in es-MX is acceptable — that is standard practice for the cross-localization hack).

**The extra-localization table** lives next to the storefront codes (`src/apple/storefronts.json`, field `extraLocale`): us→es-MX, gb→en-AU(→verify during the build), ru→en-GB, de→en-GB, fr→en-GB, etc.; if the extra locale for a country is unknown — pass 2 is skipped with an event in the log. Run config: `"extraLocale": true` (default; can be disabled in advanced settings).

**Validation:** the T/S/K/X/W rules apply to each bucket separately, plus the new rule **X4: no folding key repeats across buckets** (including the brand). The coverage report is computed over the union of both buckets; `topUncovered` — what didn't fit even into the second one (remains as a hint in the UI).
