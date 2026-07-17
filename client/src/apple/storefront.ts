// X-Apple-Store-Front заголовок из storefront id (для hints, spec 02.1/02.3).
//
// reconcile v2: реверс-мап «storefront id → country» УДАЛЁН. iTunes Search теперь получает
// `country` напрямую из SerpJob.country (сервер кладёт его из конфига). Никаких весов/extraLocale
// здесь нет и быть не может (они server-only, D5).

/** X-Apple-Store-Front заголовок из id (формат `<id>-1,29`, spec 02.1/02.3). */
export function storefrontHeader(storefrontId: number): string {
  return `${storefrontId}-1,29`;
}
