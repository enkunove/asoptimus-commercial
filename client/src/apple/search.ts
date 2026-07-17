// Официальный iTunes Search API (spec 02.2). Возвращает СЫРОЙ JSON нужных полей (RawSerp).
// Difficulty (D) считает сервер над этим сырьём — клиент никаких метрик не трогает.

import type { AppleHttp } from "./http";
import type { RawSerp, RawSerpApp } from "@aso/shared";

/** Один запрос выдачи. `country` — двухбуквенный код (см. storefront.ts), `lang` — язык. */
export async function searchApps(
  http: AppleHttp,
  query: string,
  country: string,
  lang: string,
  limit = 25,
): Promise<RawSerp> {
  const url =
    "https://itunes.apple.com/search" +
    `?media=software&entity=software&term=${encodeURIComponent(query)}` +
    `&country=${encodeURIComponent(country)}&lang=${encodeURIComponent(lang)}&limit=${limit}`;
  const body = await http.get(url);
  const data = JSON.parse(body);
  // Сырой passthrough нужных полей: тип RawSerpApp допускает [k]: unknown, поэтому
  // прокидываем объекты как есть, лишь гарантируя обязательные trackId/trackName.
  const results: RawSerpApp[] = (Array.isArray(data.results) ? data.results : []).map((r: any) => ({
    ...r,
    trackId: Number(r.trackId ?? 0),
    trackName: String(r.trackName ?? ""),
  }));
  return { resultCount: Number(data.resultCount ?? results.length), results };
}
