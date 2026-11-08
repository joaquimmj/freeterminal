// Risk-free rates from official sources, no key needed (docs/DATA_SOURCES.md §4-5):
// - US: Treasury daily par yield curve (home.treasury.gov CSV download)
// - Euro area: ECB Data Portal yield curves (YC), Svensson par yields; AAA issuers by default

import { PRODUCT_NAME, REPO_URL } from "./config";
import { pastDate, shiftDays, staleness, todayIso, ttlFor } from "./dates";
import { ToolError, UpstreamError } from "./errors";
import type { FetchLike } from "./sec/edgar";

export interface Rate {
  region: "US" | "EUR";
  tenor: string;
  rate_pct: number;
  /** Same rate as a decimal (0.0486 = 4.86%), the unit valuation_inputs and key_metrics use. */
  rate_decimal: number;
  date: string;
  basis: string;
  series: string;
  warnings: string[];
  source: { name: string; url: string; accession_or_id: string; period: string; as_of: string; license_note: string };
}

/** Treasury CSV column for each tenor: "3M" -> "3 Mo", "10Y" -> "10 Yr". */
const TREASURY_COLUMNS: Record<string, string> = Object.fromEntries(
  ["1M", "2M", "3M", "4M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"].map((t) => [
    t,
    t.replace(/M$/, " Mo").replace(/Y$/, " Yr"),
  ]),
);

/** ECB par-yield tenors (the YC dataset publishes 3M, 6M and 1Y-30Y). */
const ECB_TENORS = new Set(["3M", "6M", ...Array.from({ length: 30 }, (_, i) => `${i + 1}Y`)]);

export const US_TENORS = Object.keys(TREASURY_COLUMNS);

export function treasuryUrl(year: number): string {
  return (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/" +
    `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`
  );
}

export function ecbUrl(tenor: string, curve: "aaa" | "all", start?: string, end?: string): string {
  const key = `B.U2.EUR.4F.G_N_${curve === "aaa" ? "A" : "C"}.SV_C_YM.PY_${tenor}`;
  const range = start && end ? `startPeriod=${start}&endPeriod=${end}` : "lastNObservations=1";
  return `https://data-api.ecb.europa.eu/service/data/YC/${key}?${range}&format=csvdata&detail=dataonly`;
}

export function normalizeTenor(t: string): string {
  const s = t.trim().toUpperCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(Y|YR|YRS|YEAR|YEARS|M|MO|MOS|MONTH|MONTHS)$/.exec(s);
  if (!m) throw new ToolError(`tenor ${JSON.stringify(t)} not understood; use e.g. "10Y" or "3M"`);
  const n = Number(m[1]);
  const unit = m[2]!.startsWith("Y") ? "Y" : "M";
  // "12M", "24M" are whole years.
  return unit === "M" && n >= 12 && n % 12 === 0 ? `${n / 12}Y` : `${n}${unit}`;
}

/** Split one CSV line (the Treasury header quotes its column names). */
function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Treasury CSV -> [{date ISO, values by column}], in published order. Throws on a body that isn't the CSV. */
export function parseTreasuryCsv(text: string): Array<{ date: string; row: Record<string, string> }> {
  const body = text.trim();
  if (!body) return []; // a year with no fixings yet
  const lines = body.split(/\r?\n/);
  const header = splitCsvLine(lines[0]!);
  if (header[0] !== "Date") throw new UpstreamError("Treasury returned something other than its yield-curve CSV");
  return lines.slice(1).flatMap((l) => {
    const cells = splitCsvLine(l);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[0] ?? "");
    if (!m) return [];
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return [{ date: `${m[3]}-${m[1]}-${m[2]}`, row }];
  });
}

/** ECB csvdata -> [{date, value}] oldest first, finite values only. Throws on a body that isn't ECB csvdata. */
export function parseEcbCsv(text: string): Array<{ date: string; value: number }> {
  const body = text.trim();
  if (!body) return []; // the ECB answers an empty window with an empty 200
  const lines = body.split(/\r?\n/);
  const header = splitCsvLine(lines[0]!);
  const iD = header.indexOf("TIME_PERIOD");
  const iV = header.indexOf("OBS_VALUE");
  if (iD < 0 || iV < 0) throw new UpstreamError("ECB returned something other than its csvdata format");
  return lines.slice(1).flatMap((l) => {
    const c = splitCsvLine(l);
    const v = Number(c[iV]);
    return c[iV] !== "" && Number.isFinite(v) && /^\d{4}-\d{2}-\d{2}$/.test(c[iD] ?? "") ? [{ date: c[iD]!, value: v }] : [];
  });
}

/** Body checks run before anything is cached: a 200 maintenance page must never be stored as data. */
export const isTreasuryCsv = (t: string) => !t.trim() || t.trimStart().startsWith("Date,");
export const isEcbCsv = (t: string) => !t.trim() || /^KEY,.*TIME_PERIOD.*OBS_VALUE/.test(t.trimStart().split(/\r?\n/, 1)[0]!);

export type FetchText = (url: string, ttlSeconds: number, valid?: (body: string) => boolean) => Promise<string>;

export class Rates {
  constructor(
    private readonly fetchText: FetchText,
    private readonly today: () => string = todayIso,
  ) {}

  async us(tenorIn: string, on?: string): Promise<Rate> {
    const tenor = normalizeTenor(tenorIn);
    const col = TREASURY_COLUMNS[tenor];
    if (!col) throw new ToolError(`US Treasury tenors: ${US_TENORS.join(", ")}`);
    const today = this.today();
    const want = on ? pastDate(on, "date", today) : today;
    const year = Number(want.slice(0, 4));
    // Look in the target year, then the year before (for early-January dates).
    for (const y of [year, year - 1]) {
      const url = treasuryUrl(y);
      const yearEnd = `${y}-12-31`;
      const rows = parseTreasuryCsv(await this.fetchText(url, ttlFor(yearEnd, today), isTreasuryCsv));
      if (rows.length && !(col in rows[0]!.row)) {
        throw new UpstreamError(`Treasury's ${y} CSV has no "${col}" column; its format may have changed`);
      }
      const hit = rows
        .filter((r) => r.date <= want && r.row[col] !== "" && Number.isFinite(Number(r.row[col])))
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (!hit) continue;
      const pct = Number(hit.row[col]);
      const stale = on ? null : staleness(hit.date, today, `US Treasury ${tenor}`);
      return {
        region: "US",
        tenor,
        rate_pct: pct,
        rate_decimal: Number((pct / 100).toPrecision(12)),
        date: hit.date,
        basis:
          `US Treasury par yield, ${tenor}, bond-equivalent basis` +
          (on && hit.date !== want ? `; last business day on or before ${want}` : ""),
        series: `daily_treasury_yield_curve "${col}"`,
        warnings: stale ? [stale] : [],
        source: {
          name: "U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates",
          url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
          accession_or_id: `daily_treasury_yield_curve/${hit.date}/${col}`,
          period: hit.date,
          as_of: hit.date,
          license_note: "U.S. government data, free to reuse; cite U.S. Treasury.",
        },
      };
    }
    throw new ToolError(`No Treasury ${tenor} yield on or before ${want}.`);
  }

  async eur(tenorIn: string, on?: string, curve: "aaa" | "all" = "aaa"): Promise<Rate> {
    const tenor = normalizeTenor(tenorIn);
    if (!ECB_TENORS.has(tenor)) throw new ToolError("ECB par-yield tenors: 3M, 6M, 1Y to 30Y");
    const today = this.today();
    const want = on ? pastDate(on, "date", today) : undefined;
    // Latest: a short window instead of lastNObservations=1, so the staleness check sees the real newest date.
    const start = shiftDays(want ?? today, -14);
    const end = want ?? today;
    const url = ecbUrl(tenor, curve, start, end);
    const obs = parseEcbCsv(await this.fetchText(url, ttlFor(end, today), isEcbCsv));
    const hit = obs.filter((o) => o.date <= end).at(-1);
    if (!hit) throw new ToolError(`No ECB ${tenor} par yield in the two weeks up to ${end}.`);
    const curveName = curve === "aaa" ? "AAA-rated euro area central government bonds" : "all euro area central government bonds";
    const seriesKey = `YC.B.U2.EUR.4F.G_N_${curve === "aaa" ? "A" : "C"}.SV_C_YM.PY_${tenor}`;
    const stale = want ? null : staleness(hit.date, today, `ECB ${tenor} par yield`);
    return {
      region: "EUR",
      tenor,
      rate_pct: hit.value,
      rate_decimal: Number((hit.value / 100).toPrecision(12)),
      date: hit.date,
      basis:
        `ECB euro area par yield, ${tenor}, ${curveName} (ECB series title: Svensson model, continuous compounding)` +
        (want && hit.date !== want ? `; last business day on or before ${want}` : ""),
      series: seriesKey,
      warnings: stale ? [stale] : [],
      source: {
        name: "European Central Bank, Data Portal, euro area yield curves",
        url: `https://data.ecb.europa.eu/data/datasets/YC/${seriesKey}`,
        accession_or_id: `${seriesKey}/${hit.date}`,
        period: hit.date,
        as_of: hit.date,
        license_note: "Source: ECB statistics. Reuse allowed with attribution; figures unmodified.",
      },
    };
  }
}

const UPSTREAM_TIMEOUT_MS = 10_000;
const MEMO_MAX = 128;

/**
 * GET with two cache layers: a small per-isolate memo (works even where the
 * Cache API is a no-op, e.g. possibly *.workers.dev) and the Cache API. A body
 * is cached only if `valid(body)` accepts it, so an error page served with a
 * 200 is never stored as data.
 */
export function cachedFetchText(
  fetchImpl: FetchLike,
  cache?: Cache,
  waitUntil: (p: Promise<unknown>) => void = (p) => void p.catch(() => undefined),
): FetchText {
  const memo = new Map<string, { expires: number; body: string }>();
  return async (url, ttlSeconds, valid = () => true) => {
    const now = Date.now();
    const m = memo.get(url);
    if (m && m.expires > now) return m.body;
    const key = new Request(url);
    const hit = await cache?.match(key).catch(() => undefined);
    let body: string;
    if (hit) {
      body = await hit.text();
    } else {
      const res = await fetchImpl(url, {
        headers: { Accept: "text/csv,*/*", "User-Agent": `${PRODUCT_NAME} (+${REPO_URL})` },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }).catch((e) => {
        throw new UpstreamError(`${new URL(url).host} did not answer (${(e as Error).name})`);
      });
      if (!res.ok) throw new UpstreamError(`${new URL(url).host} returned HTTP ${res.status}`, res.status);
      body = await res.text();
      if (!valid(body)) throw new UpstreamError(`${new URL(url).host} returned an unexpected page instead of data`);
      if (cache) {
        const put = cache.put(key, new Response(body, { headers: { "Cache-Control": `public, max-age=${ttlSeconds}` } }));
        waitUntil(put.catch(() => undefined));
      }
    }
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
    memo.set(url, { expires: now + Math.min(ttlSeconds, 3600) * 1000, body });
    return body;
  };
}
