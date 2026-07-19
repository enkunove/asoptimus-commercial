// @aso/server/llm-proxy — deterministic LLM MOCK (DEV=1 ONLY, no ANTHROPIC_API_KEY).
// Not a model: generates plausible schema-valid JSON so the happy path runs offline
// (activation → run → orchestrate → assemble). Usage is synthetic and non-zero so the
// internal COGS accounting is visible. In PROD this path is never taken (see createLlmClient).

import type { CallOnceRequest, CallOnceResult, LlmClient } from "./client.ts";

const NOUNS = ["sleep", "habit", "focus", "water", "budget", "mood", "workout", "recipe",
  "language", "meditation", "reading", "study", "expense", "period", "fasting"];
const SUFFIX = ["tracker", "planner", "timer", "journal", "coach", "log", "reminder", "monitor"];

function extract(re: RegExp, s: string): string[] {
  return [...s.matchAll(re)].map((m) => m[1]);
}

function combos(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < NOUNS.length && out.length < n; i++) {
    for (let j = 0; j < SUFFIX.length && out.length < n; j++) {
      out.push(`${NOUNS[i]} ${SUFFIX[j]}`);
    }
  }
  return out;
}

export class MockLlmClient implements LlmClient {
  readonly kind = "mock" as const;

  async callOnce(req: CallOnceRequest): Promise<CallOnceResult> {
    const text = this.render(req);
    // Synthetic non-zero usage — billing debits real credits (demonstrable).
    const usage = {
      inputTokens: 1400 + (req.prompt.length % 800),
      outputTokens: 400 + (text.length % 400),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return { text, usage };
  }

  private render(req: CallOnceRequest): string {
    switch (req.task) {
      case "context":
        return JSON.stringify({
          productSummary: "The app helps the user track habits and progress.",
          category: "Health & Fitness",
          jobsToBeDone: ["track daily habits", "build a routine", "stay motivated", "log progress"],
          audience: "people who want to build healthy habits",
          featureVocabulary: ["habit tracker", "daily planner", "streak", "reminder", "routine builder", "goal tracker"],
          competitors: [],
          antiSemantics: "not a game, not a social network, not a messenger; queries about games and dating are irrelevant",
          targetLanguage: "en",
        });
      case "seeds": {
        const kws = combos(20).map((k, i) => ({
          keyword: k,
          type: (["functional", "problem", "audience", "adjacent", "category"] as const)[i % 5],
        }));
        return JSON.stringify({ keywords: kws });
      }
      case "hypothesize": {
        const kws = combos(30).slice(12, 24).map((k, i) => ({
          keyword: k,
          type: (["functional", "problem", "audience", "adjacent", "category"] as const)[i % 5],
          strategy: (i % 3 === 0 ? "explore" : "exploit") as "explore" | "exploit",
        }));
        return JSON.stringify({ roots: NOUNS.slice(0, 8), keywords: kws });
      }
      case "rate": {
        const keywords = extract(/"keyword"\s*:\s*"([^"]+)"/g, req.prompt);
        const ratings = keywords.map((keyword, i) => ({
          keyword,
          r: (i % 5 === 0 ? 2 : 3),
          reason: "relevant to the product core (mock rating)",
        }));
        return JSON.stringify({ ratings });
      }
      case "phrase": {
        const phrases = extract(/"phrase"\s*:\s*"([^"]+)"/g, req.prompt);
        const slogan = phrases[0] ?? "habit tracker";
        // Pick a subtitle phrase with no word overlap with the slogan (otherwise the validator
        // rejects it — then the orchestrator's deterministic fallback kicks in).
        const sWords = new Set(slogan.split(" "));
        const sub = phrases.slice(1).find((p) => p.split(" ").every((w) => !sWords.has(w))) ?? "";
        return JSON.stringify({ titleSlogan: slogan, subtitle: sub });
      }
      default:
        return "{}";
    }
  }
}
