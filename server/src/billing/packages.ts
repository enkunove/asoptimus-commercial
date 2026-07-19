// @aso/server/billing — top-up package catalog (D4 v4: 1 credit = $1, top-up only).
// Lives in billing, NOT in the payment-provider module: the catalog is a business decision;
// the provider only needs the per-package price id. Overridden by env TOPUP_PACKAGES_JSON.

import type { TopupPackage } from "@aso/shared";
import { IS_DEV, ProdConfigError, optionalEnv } from "../env.ts";
import { log } from "../log.ts";

/** Internal package config shape: what the user pays, how many credits to grant, and the
 *  Paddle price id the checkout charges (prod-required per package; DEV mock ignores it). */
export interface PackageConfig {
  chargeUsd: number;
  credits: number;
  label: string;
  paddlePriceId?: string;
}

// Top-up packages (1 credit = $1; larger ones carry a bonus). Overridden by TOPUP_PACKAGES_JSON —
// in prod each entry must carry its paddlePriceId (pri_…) from the Paddle catalog.
const DEFAULT_PACKAGES: Record<string, PackageConfig> = {
  p10: { chargeUsd: 10, credits: 10, label: "10 credits" },
  p25: { chargeUsd: 25, credits: 26, label: "25 credits (+1 bonus)" },
  p50: { chargeUsd: 50, credits: 53, label: "50 credits (+3 bonus)" },
  p100: { chargeUsd: 100, credits: 110, label: "100 credits (+10 bonus)" },
};

let packagesCache: Record<string, PackageConfig> | null = null;
export function packages(): Record<string, PackageConfig> {
  if (packagesCache) return packagesCache;
  const raw = optionalEnv("TOPUP_PACKAGES_JSON");
  let result: Record<string, PackageConfig> = DEFAULT_PACKAGES;
  if (raw) {
    try { result = { ...DEFAULT_PACKAGES, ...JSON.parse(raw) }; }
    catch {
      // Fail CLOSED in prod: a typo must stop the boot, not silently sell price-id-less
      // defaults that 500 on every checkout.
      if (!IS_DEV) throw new ProdConfigError("TOPUP_PACKAGES_JSON", "malformed JSON — fix it or unset");
      log.warn("TOPUP_PACKAGES_JSON failed to parse — using default (DEV)");
    }
  }
  // Per-entry shape check: a partial override ({"p25":{"paddlePriceId":"pri_x"}}) shallow-
  // replaces the whole entry and would reach grant() with credits=undefined.
  for (const [id, p] of Object.entries(result)) {
    const valid = p && Number.isFinite(p.chargeUsd) && p.chargeUsd > 0 &&
      Number.isFinite(p.credits) && p.credits > 0 && typeof p.label === "string";
    if (!valid) {
      if (!IS_DEV) throw new ProdConfigError("TOPUP_PACKAGES_JSON", `package "${id}" is malformed (chargeUsd/credits must be positive numbers, label a string)`);
      log.warn(`TOPUP_PACKAGES_JSON: dropping malformed package "${id}" (DEV)`);
      delete result[id];
    }
  }
  packagesCache = result;
  return result;
}

/** Top-up catalog in the @aso/shared::TopupPackage contract shape (query kind="packages"). */
export function topupCatalog(): TopupPackage[] {
  return Object.entries(packages()).map(([id, p]) => ({
    id,
    credits: p.credits,
    priceUsd: p.chargeUsd,
    label: p.label,
    bonusPct: p.chargeUsd > 0 ? Math.round(((p.credits - p.chargeUsd) / p.chargeUsd) * 100) : 0,
  }));
}
