// X-Apple-Store-Front header from a storefront id (for hints, spec 02.1/02.3).
//
// reconcile v2: the "storefront id → country" reverse map is REMOVED. iTunes Search now gets
// `country` directly from SerpJob.country (the server sets it from the config). No weights/extraLocale
// live here, nor may they (they are server-only, D5).

/** X-Apple-Store-Front header from an id (format `<id>-1,29`, spec 02.1/02.3). */
export function storefrontHeader(storefrontId: number): string {
  return `${storefrontId}-1,29`;
}
