// Единый HTTP-слой для запросов к Apple (spec 02.4): token bucket ПЕР-IP (эта машина),
// файловый кэш (D3, локальная нога), экспоненциальные ретраи, счётчики.
// Портирован ~1:1 из aso-util/src/http.ts. ВСЕ запросы к Apple идут только через него.
// В клиенте НЕТ метрик — этот слой лишь достаёт сырьё.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cacheDir } from "../paths";
import type { HttpStats } from "@aso/shared";

export interface HttpOptions {
  requestsPerMinute: number;
  cacheTtlDays: number;
  timeoutMs: number;
  retries: number;
  freshData?: boolean;
  onStats?: (stats: HttpStats) => void;
}

interface CacheEntry {
  fetchedAt: string;
  url: string;
  status: number;
  body: string;
}

const BACKOFFS_MS = [5_000, 20_000, 60_000];

export class HttpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

/** Троттлинг — сигнал серверу для back-pressure (job.error{throttle}). */
export function isThrottle(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 429 || e.status === 403);
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  queue: Promise<void>;
}

export class AppleHttp {
  // Бакет на хост: у search.itunes.apple.com (подсказки) и itunes.apple.com (выдача)
  // раздельные лимиты — общий бакет заставлял бы их простаивать друг под друга.
  private buckets = new Map<string, Bucket>();
  readonly stats: HttpStats = { requestsMade: 0, cacheHits: 0, throttleWaitMs: 0 };

  constructor(private opts: HttpOptions) {}

  private bucket(host: string): Bucket {
    let b = this.buckets.get(host);
    if (!b) {
      b = { tokens: this.opts.requestsPerMinute, lastRefill: Date.now(), queue: Promise.resolve() };
      this.buckets.set(host, b);
    }
    return b;
  }

  private cachePath(key: string): string {
    return join(cacheDir(), `${key}.json`);
  }

  private cacheKey(url: string, storefront: string): string {
    return createHash("sha1").update(`GET ${url} ${storefront}`).digest("hex");
  }

  private readCache(key: string): CacheEntry | null {
    const p = this.cachePath(key);
    if (!existsSync(p)) return null;
    try {
      const entry: CacheEntry = JSON.parse(readFileSync(p, "utf8"));
      if (this.opts.freshData) return null;
      const ageMs = Date.now() - Date.parse(entry.fetchedAt);
      if (ageMs > this.opts.cacheTtlDays * 24 * 3600 * 1000) return null;
      return entry;
    } catch {
      return null;
    }
  }

  private refill(b: Bucket) {
    const now = Date.now();
    const perTokenMs = 60_000 / this.opts.requestsPerMinute;
    const gained = Math.floor((now - b.lastRefill) / perTokenMs);
    if (gained > 0) {
      b.tokens = Math.min(this.opts.requestsPerMinute, b.tokens + gained);
      b.lastRefill += gained * perTokenMs;
    }
  }

  private async takeToken(host: string): Promise<void> {
    const b = this.bucket(host);
    // FIFO в рамках хоста: сериализуем ожидание через цепочку промисов.
    const prev = b.queue;
    let release!: () => void;
    b.queue = new Promise((r) => (release = r));
    await prev;
    try {
      const start = Date.now();
      for (;;) {
        this.refill(b);
        if (b.tokens >= 1) {
          b.tokens -= 1;
          break;
        }
        await sleep(250);
      }
      // Джиттер 300–900 мс между фактическими отправками (spec 02.4).
      // При rpm > 60 (тесты/моки) вежливость не нужна — пропускаем.
      if (this.opts.requestsPerMinute <= 60) await sleep(300 + Math.random() * 600);
      this.stats.throttleWaitMs += Date.now() - start;
    } finally {
      release();
    }
  }

  /** GET с кэшем; storefront участвует в ключе кэша. Возвращает тело ответа (строку). */
  async get(url: string, headers: Record<string, string> = {}, storefront = ""): Promise<string> {
    const key = this.cacheKey(url, storefront);
    const cached = this.readCache(key);
    if (cached && cached.status === 200) {
      this.stats.cacheHits += 1;
      this.opts.onStats?.(this.stats);
      return cached.body;
    }

    let lastError: Error | null = null;
    const attempts = Math.max(1, this.opts.retries);
    const host = new URL(url).host;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.takeToken(host);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
        let res: Response;
        try {
          res = await fetch(url, { headers, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        this.stats.requestsMade += 1;
        this.opts.onStats?.(this.stats);
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          lastError = new HttpError(`HTTP ${res.status} от ${new URL(url).host}`, res.status);
        } else {
          const body = await res.text();
          writeFileSync(this.cachePath(key), JSON.stringify({
            fetchedAt: new Date().toISOString(),
            url,
            status: res.status,
            body,
          } satisfies CacheEntry));
          if (res.status !== 200) throw new HttpError(`HTTP ${res.status} от ${new URL(url).host}`, res.status);
          return body;
        }
      } catch (e: any) {
        if (e instanceof HttpError && e.status && e.status < 500 && e.status !== 429 && e.status !== 403) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
      }
      if (attempt < attempts - 1) {
        await sleep(BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)]);
      }
    }
    throw lastError ?? new HttpError("неизвестная ошибка HTTP");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
