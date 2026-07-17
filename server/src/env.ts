// @aso/server — центральная работа с окружением: DEV-флаг и обязательные секреты в проде.
// Правило (BUILD-PLAN §6/§9): mock Store/LLM/Stripe/Apple-loopback и dev-хелперы работают
// ТОЛЬКО при DEV=1. В проде (DEV не задан) отсутствие обязательного секрета — жёсткий отказ,
// а не тихий мок. Значения секретов сюда не логируются — только факт наличия.

export const IS_DEV = process.env.DEV === "1";

export class ProdConfigError extends Error {
  constructor(public varName: string, hint = "") {
    super(
      `[config] переменная окружения ${varName} обязательна в прод-режиме и не задана. ` +
        `Задайте её (см. .env.example)${hint ? ` — ${hint}` : ""}, либо запустите с DEV=1 для мок-фолбэков.`,
    );
    this.name = "ProdConfigError";
  }
}

/** Обязательный в проде секрет. В DEV возвращает "" (включает мок-ветку у вызывающего). */
export function requireEnv(name: string, hint = ""): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  if (IS_DEV) return "";
  throw new ProdConfigError(name, hint);
}

/** Опциональная переменная (без прод-требования). */
export function optionalEnv(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Наличие переменной (для выбора живой/мок ветки при DEV). */
export function hasEnv(name: string): boolean {
  const v = process.env[name];
  return !!(v && v.trim());
}
