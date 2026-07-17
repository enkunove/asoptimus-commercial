// @aso/shared — ТОЛЬКО публичные константы. Zero-secret.
// NB: placement-веса (05.2) и extraLocale-таблица (05.9) — НЕ здесь. Они moat и живут
// в приватном репо server (server/src/core/locales.ts). Сюда класть их нельзя.

/** Дефолтные стоп-слова (spec 01.3). Пользователь может переопределить в конфиге. */
export const DEFAULT_STOPWORDS: string[] = [
  "app", "apps", "free", "best", "top", "new",
  "a", "an", "the", "and", "or", "for", "of", "with", "your", "my", "&",
];

/** Символьные лимиты полей App Store (spec 00/05). */
export const FIELD_LIMITS = { title: 30, subtitle: 30, keywords: 100 } as const;

/** Дефолты HTTP-слоя клиента (spec 02.4). */
export const HTTP_DEFAULTS = {
  requestsPerMinute: 18,
  cacheTtlDays: 7,
  timeoutMs: 10000,
  retries: 3,
} as const;

import storefronts from "./storefronts.public.json" with { type: "json" };
/** country → { id, primaryLanguage }. ТОЛЬКО это нужно клиенту для построения URL.
 *  extraLocale (кросс-локализация 05.9) — server-only, здесь его нет. */
export const STOREFRONTS = storefronts as Record<string, { id: number; primaryLanguage: string }>;
