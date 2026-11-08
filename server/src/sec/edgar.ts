// SEC EDGAR access with the fair-access rules: a declared User-Agent with a
// contact, and well under 10 requests/second. See docs/DATA_SOURCES.md §1.
//
// Live SEC calls are the fallback path: most requests are answered from the
// nightly snapshot (static assets) with no upstream fetch at all.

import { ConfigError, UpstreamError } from "../errors";

export const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
export const factsUrl = (cik: number) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad(cik)}.json`;
export const submissionsUrl = (cik: number) => `https://data.sec.gov/submissions/CIK${pad(cik)}.json`;
/** The endpoint behind EDGAR's company-search box: undocumented, best effort only. */
export const entitySearchUrl = (q: string) => `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`;

export function pad(cik: number): string {
  return String(Math.trunc(cik)).padStart(10, "0");
}

/** Per-isolate spacing between SEC requests. Our global budget is ≤ 5 req/s (DATA_SOURCES.md). */
const SEC_MIN_INTERVAL_MS = 200;

export type FetchLike = (input: Request | string, init?: RequestInit) => Promise<Response>;

export interface SecClientOptions {
  userAgent?: string;
  fetch?: FetchLike;
  /** Cache API cache; omitted in tests and when unavailable. */
  cache?: Cache;
}

export class SecClient {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: SecClientOptions) {
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  /** GET a SEC JSON document, cached for `ttlSeconds` in the Cache API when available. */
  async json<T>(url: string, ttlSeconds: number): Promise<T> {
    const ua = this.opts.userAgent?.trim();
    if (!ua || !ua.includes("@")) {
      throw new ConfigError(
        "SEC_USER_AGENT is not set. SEC requires a User-Agent naming a contact, e.g. " +
          '"freeterminal-selfhost admin@example.com". Set it as a Worker var (see docs/SELF_HOSTING.md).',
      );
    }
    const cacheKey = new Request(url);
    const hit = await this.opts.cache?.match(cacheKey).catch(() => undefined);
    if (hit) return (await hit.json()) as T;

    const res = await this.throttled(() =>
      this.fetchImpl(url, { headers: { "User-Agent": ua, Accept: "application/json", "Accept-Encoding": "gzip" } }),
    );
    if (res.status === 404) throw new UpstreamError(`SEC returned 404 for ${url}`, 404);
    if (res.status === 403 || res.status === 429) {
      throw new UpstreamError(
        `SEC refused the request (HTTP ${res.status}); it rate-limits shared IPs. Try again in a minute.`,
        res.status,
      );
    }
    if (!res.ok) throw new UpstreamError(`SEC returned HTTP ${res.status} for ${url}`, res.status);
    const body = await res.text();
    if (this.opts.cache) {
      const toCache = new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttlSeconds}` },
      });
      await this.opts.cache.put(cacheKey, toCache).catch(() => undefined);
    }
    return JSON.parse(body) as T;
  }

  /** Serialize SEC calls within this isolate with a minimum spacing. */
  private throttled(run: () => Promise<Response>): Promise<Response> {
    const next = this.chain.then(async () => {
      const wait = this.last + SEC_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next.then(run);
  }
}
