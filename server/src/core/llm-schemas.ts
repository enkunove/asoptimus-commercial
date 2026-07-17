// @aso/core — JSON-схемы выходов всех LLM-задач (spec 06.3). ПРОПРИЕТАРНО.
// Порт 1:1 из aso-util/src/llm/schemas.ts. Ограничения structured outputs: везде
// additionalProperties:false, все поля в required, без numeric/string constraints
// (количества/длины валидируются кодом после парсинга).

export const contextSchema = {
  type: "object",
  properties: {
    productSummary: { type: "string" },
    category: { type: "string" },
    jobsToBeDone: { type: "array", items: { type: "string" } },
    audience: { type: "string" },
    featureVocabulary: { type: "array", items: { type: "string" } },
    competitors: { type: "array", items: { type: "string" } },
    antiSemantics: { type: "string" },
    targetLanguage: { type: "string" },
  },
  required: [
    "productSummary", "category", "jobsToBeDone", "audience",
    "featureVocabulary", "competitors", "antiSemantics", "targetLanguage",
  ],
  additionalProperties: false,
} as const;

const keywordItem = {
  type: "object",
  properties: {
    keyword: { type: "string" },
    type: { type: "string", enum: ["functional", "problem", "audience", "adjacent", "category"] },
  },
  required: ["keyword", "type"],
  additionalProperties: false,
} as const;

export const seedsSchema = {
  type: "object",
  properties: { keywords: { type: "array", items: keywordItem } },
  required: ["keywords"],
  additionalProperties: false,
} as const;

export const hypothesizeSchema = {
  type: "object",
  properties: {
    roots: { type: "array", items: { type: "string" } },
    keywords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          type: { type: "string", enum: ["functional", "problem", "audience", "adjacent", "category"] },
          strategy: { type: "string", enum: ["exploit", "explore"] },
        },
        required: ["keyword", "type", "strategy"],
        additionalProperties: false,
      },
    },
  },
  required: ["roots", "keywords"],
  additionalProperties: false,
} as const;

export const rateSchema = {
  type: "object",
  properties: {
    ratings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          r: { type: "integer", enum: [0, 1, 2, 3] },
          reason: { type: "string" },
        },
        required: ["keyword", "r", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["ratings"],
  additionalProperties: false,
} as const;

export const phraseSchema = {
  type: "object",
  properties: {
    titleSlogan: { type: "string" },
    subtitle: { type: "string" },
  },
  required: ["titleSlogan", "subtitle"],
  additionalProperties: false,
} as const;

export const schemas: Record<string, object> = {
  context: contextSchema,
  seeds: seedsSchema,
  rate: rateSchema,
  hypothesize: hypothesizeSchema,
  phrase: phraseSchema,
};

/** Минимальная структурная валидация ответа по схеме (код не доверяет провайдеру, spec 06.1). */
export function validateAgainstSchema(data: unknown, schema: any, path = "$"): string[] {
  const errors: string[] = [];
  const check = (value: any, sch: any, p: string) => {
    if (sch.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${p}: ожидался объект`);
        return;
      }
      for (const req of sch.required ?? []) {
        if (!(req in value)) errors.push(`${p}.${req}: обязательное поле отсутствует`);
      }
      if (sch.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in (sch.properties ?? {}))) errors.push(`${p}.${k}: лишнее поле`);
        }
      }
      for (const [k, sub] of Object.entries(sch.properties ?? {})) {
        if (k in value) check(value[k], sub, `${p}.${k}`);
      }
    } else if (sch.type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${p}: ожидался массив`);
        return;
      }
      value.forEach((item, i) => check(item, sch.items, `${p}[${i}]`));
    } else if (sch.type === "string") {
      if (typeof value !== "string") errors.push(`${p}: ожидалась строка`);
      else if (sch.enum && !sch.enum.includes(value)) errors.push(`${p}: значение "${value}" не из ${JSON.stringify(sch.enum)}`);
    } else if (sch.type === "integer") {
      if (!Number.isInteger(value)) errors.push(`${p}: ожидалось целое число`);
      else if (sch.enum && !sch.enum.includes(value)) errors.push(`${p}: значение ${value} не из ${JSON.stringify(sch.enum)}`);
    } else if (sch.type === "number") {
      if (typeof value !== "number") errors.push(`${p}: ожидалось число`);
    } else if (sch.type === "boolean") {
      if (typeof value !== "boolean") errors.push(`${p}: ожидался boolean`);
    }
  };
  check(data, schema, path);
  return errors;
}
