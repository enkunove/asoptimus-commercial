// @aso/shared — public constants ONLY. Zero-secret.
// NB: placement weights (05.2) and the extraLocale table (05.9) are NOT here. They are the moat and live
// in the private server repo (server/src/core/locales.ts). They must not be put here.

/** Default stopwords (spec 01.3). The user may override them in the config. */
export const DEFAULT_STOPWORDS: string[] = [
  "app", "apps", "free", "best", "top", "new",
  "a", "an", "the", "and", "or", "for", "of", "with", "your", "my", "&",
];

/** App Store field character limits (spec 00/05). */
export const FIELD_LIMITS = { title: 30, subtitle: 30, keywords: 100 } as const;

/** Client HTTP-layer defaults (spec 02.4). */
export const HTTP_DEFAULTS = {
  requestsPerMinute: 18,
  cacheTtlDays: 7,
  timeoutMs: 10000,
  retries: 3,
} as const;

import storefronts from "./storefronts.public.json" with { type: "json" };
/** country → { id, primaryLanguage }. This is ALL the client needs to build URLs.
 *  extraLocale (cross-localization 05.9) is server-only and not here. */
export const STOREFRONTS = storefronts as Record<string, { id: number; primaryLanguage: string }>;
