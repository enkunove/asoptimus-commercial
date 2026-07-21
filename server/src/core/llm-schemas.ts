// @aso/core — JSON schemas for all LLM task outputs (spec 06.3). PROPRIETARY.
// 1:1 port from aso-util/src/llm/schemas.ts. Structured-outputs constraints:
// additionalProperties:false everywhere, all fields in required, no numeric/string
// constraints (counts/lengths are validated by code after parsing).

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
          brand: { type: "boolean" },
        },
        required: ["keyword", "r", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["ratings"],
  additionalProperties: false,
} as const;

export const classifySchema = {
  type: "object",
  properties: {
    apps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trackId: { type: "integer" },
          match: { type: "number", enum: [0, 0.5, 1] },
          reason: { type: "string" },
        },
        required: ["trackId", "match", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["apps"],
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
  compose: phraseSchema,
  classify: classifySchema,
};

/** Minimal structural validation of a response against a schema (code does not trust the provider, spec 06.1). */
export function validateAgainstSchema(data: unknown, schema: any, path = "$"): string[] {
  const errors: string[] = [];
  const check = (value: any, sch: any, p: string) => {
    if (sch.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${p}: expected an object`);
        return;
      }
      for (const req of sch.required ?? []) {
        if (!(req in value)) errors.push(`${p}.${req}: required field missing`);
      }
      if (sch.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in (sch.properties ?? {}))) errors.push(`${p}.${k}: unexpected field`);
        }
      }
      for (const [k, sub] of Object.entries(sch.properties ?? {})) {
        if (k in value) check(value[k], sub, `${p}.${k}`);
      }
    } else if (sch.type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${p}: expected an array`);
        return;
      }
      value.forEach((item, i) => check(item, sch.items, `${p}[${i}]`));
    } else if (sch.type === "string") {
      if (typeof value !== "string") errors.push(`${p}: expected a string`);
      else if (sch.enum && !sch.enum.includes(value)) errors.push(`${p}: value "${value}" not in ${JSON.stringify(sch.enum)}`);
    } else if (sch.type === "integer") {
      if (!Number.isInteger(value)) errors.push(`${p}: expected an integer`);
      else if (sch.enum && !sch.enum.includes(value)) errors.push(`${p}: value ${value} not in ${JSON.stringify(sch.enum)}`);
    } else if (sch.type === "number") {
      if (typeof value !== "number") errors.push(`${p}: expected a number`);
    } else if (sch.type === "boolean") {
      if (typeof value !== "boolean") errors.push(`${p}: expected a boolean`);
    }
  };
  check(data, schema, path);
  return errors;
}
