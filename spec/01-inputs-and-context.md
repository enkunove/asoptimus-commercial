# 01 — Input, business context, configuration, storage

## 1.1 The only input: the brief

The user uploads **a single `.md` or `.txt` file** (or pastes text into a textarea — saved as a file) via the dashboard when creating a run. Requirements:

- UTF-8 encoding, size 200 characters … 200 KB;
- fewer than 200 meaningful characters → the form refuses to create the run and explains what to add (see the hint under the field: "what the app does, who it's for, competitors, market");
- the brief can be in any language — the orchestrator handles any, but the semantics are generated in the target market's language from the run settings.

The file is copied into the run directory as `brief.md`. There are no other input methods (repository, URL, App Store ID) in v1.

## 1.2 Business context extraction

The first step of a run is the `context` LLM call (contract in `06-llm-adapters.md`): brief → structured context:

```json
{
  "productSummary": "in a single paragraph",
  "category": "Health & Fitness",
  "jobsToBeDone": ["..."],
  "audience": "who searches and what words they think in",
  "featureVocabulary": ["habit tracker", "streak", "..."],
  "competitors": ["Sleep Cycle", "..."],
  "antiSemantics": "what the app is NOT; which words it must NOT index for",
  "targetLanguage": "en"
}
```

The context is shown to the user on the run screen **before the loop starts** (the "Context" step with buttons "Looks right, go" / "Edit"). Editing happens right in the UI, field by field; the edited version is saved and used in all subsequent prompts. This is the only mandatory human confirmation point in the entire run.

## 1.3 Run configuration

Set in the "New run" form (sensible defaults, everything editable; read-only once the run starts). Stored as `config.json` in the run directory:

```json
{
  "brand": "Somna",               // required; goes into the title before " - "
  "country": "us",                // storefront from the table in 02
  "semanticLanguage": "en",       // language of hypothesis generation; default = the country's primary language, selected in the form
  "language": "en_us",            // lang for the search API; derived from country+semanticLanguage
  "sampleSize": 150,              // stopping point (form: slider 50–500)
  "batchSize": 20,
  "exploreRatio": 0.3,
  "improvementRounds": 2,
  "serpTop": 10,
  "model": "claude-opus-4-8",     // adapter model for this run (list in 06)
  "extraLocale": true,            // second cross-localization bucket (05.9)
  "weights": {
    "popularity":  { "depth": 0.7, "rank": 0.3 },
    "difficulty":  { "volume": 0.45, "quality": 0.15, "freshness": 0.15, "match": 0.25 },
    "opportunity": { "popularityExp": 0.6, "easeExp": 0.4 }
  },
  "limits": { "title": 30, "subtitle": 30, "keywords": 100 },
  "http": { "requestsPerMinute": 18, "cacheTtlDays": 7, "timeoutMs": 10000, "retries": 3 },
  "stopwords": ["app", "apps", "free", "best", "top", "new", "a", "an", "the", "and", "or", "for", "of", "with", "your", "my", "&"]
}
```

Validation (at run creation, errors shown next to the fields): `brand` non-empty and `len(brand)+3 <= limits.title`; `sampleSize` in [30, 500]; `batchSize` in [5, 50]; `exploreRatio` in [0,1]; popularity and difficulty weight sums = 1.0 (±0.001); `country` — from the storefront code table.

In the form, advanced fields (weights, http, stopwords) are hidden under "Advanced settings" — a regular user only needs brand / country / **semantic language** / sampleSize / model.

**Semantic language** is a select in the main part of the form; picking a country auto-fills its primary language (us→en, ru→ru, de→de, mx→es…; the table lives next to the storefront codes), but the user may choose any other: for example, Spanish semantics for the US store (a Spanish-speaking audience searches in Spanish right inside the American store). Validation still runs against the selected storefront's autocomplete suggestions — phrases in a language nobody searches in on that store will honestly get P=0 and be filtered out. All LLM tasks (`06.3`) receive `semanticLanguage` and generate/rate in it.

## 1.4 Application data storage

Everything lives in the **data directory** (overridable with the `--data-dir` flag):

- macOS/Linux: `~/.aso-util/`
- Windows: `%APPDATA%\aso-util\`

```
~/.aso-util/
├── auth.json                 # provider credentials (chmod 600; format in 06)
├── settings.json             # global settings: active provider, port
├── cache/                    # Apple HTTP cache — SHARED across all runs
│   └── <sha1>.json
└── runs/
    └── somna-us-2026-07-15/  # slug: brand-country-date(-N on collision)
        ├── brief.md
        ├── config.json
        ├── context.json      # result of the context call (+ user edits)
        ├── state.json        # all keywords, metrics, phase, final fields
        ├── llm-log.jsonl     # LLM call log: prompt, response, usage (07/06)
        └── events.jsonl      # pipeline event log for the UI feed
```

The Apple cache is shared: two apps in the same niche reuse suggestions and search results. `state.json` is written atomically (temp + rename); killing the process loses no data, and the run is resumable from where it stopped.

## 1.5 Multi-country

One run = one storefront. For a second country the user creates a new run with the same brief (the "New run" form offers "clone from existing" — copies the brief, context, and config with a different country).
