// Risk-free rates from official sources, no key needed (docs/DATA_SOURCES.md §4-5):
// - US: Treasury daily par yield curve (home.treasury.gov CSV download)
// - Euro area: ECB Data Portal yield curves (YC), Svensson par yields; AAA issuers by default

import { ToolError, UpstreamError } from "./errors";
import type { FetchLike } from "./sec/edgar";

export interface Rate {
  region: "US" | "EUR";
  tenor: string;
  rate_pct: number;
  date: string;
  basis: string;
  series: string;
  source: { name: string; url: string; accession_or_id: string; period: string; as_of: string; license_note: string };
}

/** Treasury CSV column for each tenor. */
const TREASURY_COLUMNS: Record<string, string> = {
  "1M": "1 Mo",
  "2M": "2 Mo",
  "3M": "3 Mo",
  "4M": "4 Mo",
  "6M": "6 Mo",
  "1Y": "1 Yr",
  "2Y": "2 Yr",
  "3Y": "3 Yr",
  "5Y": "5 Yr",
  "7Y": "7 Yr",
  "10Y": "10 Yr",
  "20Y": "20 Yr",
  "30Y": "30 Yr",
};

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
  const m = /^(\d{1,2})(Y|YR|YEAR|YEARS|M|MO|MONTH|MONTHS)$/.exec(s);
  if (!m) throw new ToolError(`tenor ${JSON.stringify(t)} not understood; use e.g. "10Y" or "3M"`);
  return `${Number(m[1])}${m[2]!.startsWith("Y") ? "Y" : "M"}`;
}

function splitCsvLine(line: string): string[] {
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

/** Treasury CSV -> [{date ISO, values by column}], newest first as published. */
export function parseTreasuryCsv(text: string): Array<{ date: string; row: Record<string, string> }> {
  const lines = text.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const [mm, dd, yyyy] = cells[0]!.split("/");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return { date: `${yyyy}-${mm}-${dd}`, row };
  });
}

/** ECB csvdata -> [{date, value}] oldest first. */
export function parseEcbCsv(text: string): Array<{ date: string; value: number }> {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  const iD = header.indexOf("TIME_PERIOD");
  const iV = header.indexOf("OBS_VALUE");
  return lines
    .slice(1)
    .map((l) => splitCsvLine(l))
    .filter((c) => c[iV] !== "" && c[iV] !== undefined)
    .map((c) => ({ date: c[iD]!, value: Number(c[iV]) }));
}

function isoDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new ToolError(`date ${JSON.stringify(s)} must be YYYY-MM-DD`);
  }
  return s;
}

function daysBefore(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

export class Rates {
  constructor(
    private readonly fetchText: (url: string, ttlSeconds: number) => Promise<string>,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  async us(tenorIn: string, on?: string): Promise<Rate> {
    const tenor = normalizeTenor(tenorIn);
    const col = TREASURY_COLUMNS[tenor];
    if (!col) throw new ToolError(`US Treasury tenors: ${US_TENORS.join(", ")}`);
    const want = on ? isoDate(on) : this.today();
    const year = Number(want.slice(0, 4));
    // Look in the target year, then the year before (for early-January dates).
    for (const y of [year, year - 1]) {
      const url = treasuryUrl(y);
      const historical = y < Number(this.today().slice(0, 4));
      const rows = parseTreasuryCsv(await this.fetchText(url, historical ? 30 * 86_400 : 6 * 3600));
      const hit = rows
        .filter((r) => r.date <= want && r.row[col] !== undefined && r.row[col] !== "")
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (hit) {
        return {
          region: "US",
          tenor,
          rate_pct: Number(hit.row[col]),
          date: hit.date,
          basis:
            `US Treasury par yield, ${tenor}, bond-equivalent basis (percent)` +
            (on && hit.date !== want ? `; last business day on or before ${want}` : ""),
          series: `daily_treasury_yield_curve "${col}"`,
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
    }
    throw new ToolError(`No Treasury ${tenor} yield on or before ${want}.`);
  }

  async eur(tenorIn: string, on?: string, curve: "aaa" | "all" = "aaa"): Promise<Rate> {
    const tenor = normalizeTenor(tenorIn);
    if (!ECB_TENORS.has(tenor)) throw new ToolError("ECB par-yield tenors: 3M, 6M, 1Y to 30Y");
    const want = on ? isoDate(on) : undefined;
    const url = want ? ecbUrl(tenor, curve, daysBefore(want, 14), want) : ecbUrl(tenor, curve);
    const obs = parseEcbCsv(await this.fetchText(url, want ? 30 * 86_400 : 6 * 3600));
    const hit = obs.filter((o) => !want || o.date <= want).at(-1);
    if (!hit) throw new ToolError(`No ECB ${tenor} par yield on or before ${want ?? "today"}.`);
    const curveName = curve === "aaa" ? "AAA-rated euro area central government bonds" : "all euro area central government bonds";
    return {
      region: "EUR",
      tenor,
      rate_pct: hit.value,
      date: hit.date,
      basis:
        `ECB euro area par yield, ${tenor}, ${curveName}, Svensson model, continuous compounding (percent)` +
        (want && hit.date !== want ? `; last business day on or before ${want}` : ""),
      series: `YC.B.U2.EUR.4F.G_N_${curve === "aaa" ? "A" : "C"}.SV_C_YM.PY_${tenor}`,
      source: {
        name: "European Central Bank, Data Portal, euro area yield curves",
        url: `https://data.ecb.europa.eu/data/datasets/YC/YC.B.U2.EUR.4F.G_N_${curve === "aaa" ? "A" : "C"}.SV_C_YM.PY_${tenor}`,
        accession_or_id: `YC.B.U2.EUR.4F.G_N_${curve === "aaa" ? "A" : "C"}.SV_C_YM.PY_${tenor}/${hit.date}`,
        period: hit.date,
        as_of: hit.date,
        license_note: "Source: ECB statistics. Reuse allowed with attribution; figures unmodified.",
      },
    };
  }
}

/** Plain GET with the Cache API when available (rates are small and public). */
export function cachedFetchText(fetchImpl: FetchLike, cache?: Cache) {
  return async (url: string, ttlSeconds: number): Promise<string> => {
    const key = new Request(url);
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return hit.text();
    const res = await fetchImpl(url, { headers: { Accept: "text/csv,*/*" } });
    if (!res.ok) throw new UpstreamError(`${new URL(url).host} returned HTTP ${res.status}`, res.status);
    const body = await res.text();
    if (cache) {
      await cache
        .put(key, new Response(body, { headers: { "Cache-Control": `public, max-age=${ttlSeconds}` } }))
        .catch(() => undefined);
    }
    return body;
  };
}
