// @aso/core — system prompt loading (PROPRIETARY, moat, D9: never leaves the server).
// Prompts are baked into the binary via Bun text imports (as in aso-util). 1:1 port.

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

/** Substitutes {{PLACEHOLDER}} values. Result is stable within a run (prompt cache). */
export function renderPrompt(task: string, vars: Record<string, string | number>): string {
  let text = templates[task];
  if (!text) throw new Error(`No prompt for task ${task}`);
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, String(v));
  }
  return text;
}
