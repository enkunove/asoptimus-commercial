// @aso/server/llm-proxy — детерминированный МОК LLM (ТОЛЬКО DEV=1, без ANTHROPIC_API_KEY).
// Не модель: генерирует правдоподобный валидный-по-схеме JSON, чтобы happy-path прогонялся
// офлайн (activation → run → orchestrate → assemble). Usage — синтетический ненулевой, чтобы
// внутренний COGS-учёт был виден. В ПРОДЕ на этот путь не выходим (см. createLlmClient).

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
    // Синтетический ненулевой usage — биллинг спишет реальные кредиты (демонстрируемо).
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
          productSummary: "Приложение помогает пользователю отслеживать привычки и прогресс.",
          category: "Health & Fitness",
          jobsToBeDone: ["track daily habits", "build a routine", "stay motivated", "log progress"],
          audience: "люди, которые хотят выработать полезные привычки",
          featureVocabulary: ["habit tracker", "daily planner", "streak", "reminder", "routine builder", "goal tracker"],
          competitors: [],
          antiSemantics: "не игра, не социальная сеть, не мессенджер; нерелевантны запросы про игры и знакомства",
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
          reason: "релевантно ядру продукта (mock-оценка)",
        }));
        return JSON.stringify({ ratings });
      }
      case "phrase": {
        const phrases = extract(/"phrase"\s*:\s*"([^"]+)"/g, req.prompt);
        const slogan = phrases[0] ?? "habit tracker";
        // Подобрать subtitle-фразу без пересечения слов со слоганом (иначе валидатор отклонит —
        // тогда сработает детерминированный фолбэк оркестратора).
        const sWords = new Set(slogan.split(" "));
        const sub = phrases.slice(1).find((p) => p.split(" ").every((w) => !sWords.has(w))) ?? "";
        return JSON.stringify({ titleSlogan: slogan, subtitle: sub });
      }
      default:
        return "{}";
    }
  }
}
