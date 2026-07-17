// @aso/core — загрузка системных промптов (ПРОПРИЕТАРНО, moat, D9: наружу не уходят).
// Промпты вшиваются в бинарь через Bun text-импорты (как в aso-util). Порт 1:1.

// @ts-expect-error — Bun text import
import contextMd from "./prompts/context.md" with { type: "text" };
// @ts-expect-error — Bun text import
import seedsMd from "./prompts/seeds.md" with { type: "text" };
// @ts-expect-error — Bun text import
import rateMd from "./prompts/rate.md" with { type: "text" };
// @ts-expect-error — Bun text import
import hypothesizeMd from "./prompts/hypothesize.md" with { type: "text" };
// @ts-expect-error — Bun text import
import phraseMd from "./prompts/phrase.md" with { type: "text" };

const templates: Record<string, string> = {
  context: contextMd,
  seeds: seedsMd,
  rate: rateMd,
  hypothesize: hypothesizeMd,
  phrase: phraseMd,
};

/** Подстановка {{PLACEHOLDER}}-значений. Результат стабилен в рамках прогона (кэш промптов). */
export function renderPrompt(task: string, vars: Record<string, string | number>): string {
  let text = templates[task];
  if (!text) throw new Error(`Нет промпта для задачи ${task}`);
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, String(v));
  }
  return text;
}
