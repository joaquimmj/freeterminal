import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompanyFacts, RawFact } from "../src/sec/xbrl";

const FIX = join(import.meta.dirname, "fixtures", "sec");

export function load<T = unknown>(name: string): T {
  const text = readFileSync(join(FIX, name), "utf8");
  return (name.endsWith(".json") ? JSON.parse(text) : text) as T;
}

export const facts = (ticker: string) => load<CompanyFacts>(`facts_${ticker}.json`);
export const submissions = (ticker: string) => load<Record<string, unknown>>(`submissions_${ticker}.json`);

export function fact(
  val: number,
  start: string | null,
  end: string,
  accn: string,
  filed: string,
  form = "10-K",
  fy: number | null = null,
): RawFact {
  const r: RawFact = { val, end, accn, filed, form, fy, fp: "FY" };
  if (start) r.start = start;
  return r;
}

export function companyfacts(gaap: Record<string, RawFact[]>, dei?: CompanyFacts["facts"][string]): CompanyFacts {
  const ns: CompanyFacts["facts"][string] = {};
  for (const [k, v] of Object.entries(gaap)) ns[k] = { units: { USD: v } };
  const f: CompanyFacts["facts"] = { "us-gaap": ns };
  if (dei) f.dei = dei;
  return { cik: 1, entityName: "Test Co", facts: f };
}

/** Fixture tickers -> CIK, from the trimmed SEC ticker list. */
export function tickerToCik(): Map<string, number> {
  const t = load<{ fields: string[]; data: unknown[][] }>("company_tickers_exchange.json");
  const iC = t.fields.indexOf("cik");
  const iT = t.fields.indexOf("ticker");
  return new Map(t.data.map((r) => [String(r[iT]), Number(r[iC])]));
}

/** Rate fixture for a Treasury/ECB URL (latest observations as of 2026-11-08). */
function rateFixture(url: string): string | null {
  if (url.includes("daily-treasury-rates.csv/") && !url.includes("/2025/")) return "treasury_2026.csv";
  if (url.includes("daily-treasury-rates.csv/2025/")) return "treasury_2025.csv";
  if (url.includes("data-api.ecb.europa.eu") && url.includes("PY_10Y?lastNObservations=1")) return "ecb_PY_10Y_latest.csv";
  return null;
}

/** A fetch stub serving SEC fixture files, like open-finance-mcp's respx router. */
export function secFetch(calls: string[] = []) {
  const byCik = new Map([...tickerToCik()].map(([t, c]) => [c, t]));
  return async (input: Request | string): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url === "https://www.sec.gov/files/company_tickers_exchange.json") {
      return Response.json(load("company_tickers_exchange.json"));
    }
    const m = /(companyfacts|submissions)\/CIK(\d{10})\.json$/.exec(url);
    if (m) {
      const t = byCik.get(Number(m[2]));
      const name = `${m[1] === "companyfacts" ? "facts" : "submissions"}_${t}.json`;
      try {
        return Response.json(load(name));
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    if (url.startsWith("https://efts.sec.gov/LATEST/search-index?keysTyped=exxon%20mobil")) {
      return Response.json(load("efts_exxon_mobil.json"));
    }
    if (url.startsWith("https://efts.sec.gov/")) return Response.json({ hits: { hits: [] } });
    const rate = rateFixture(url);
    if (rate) return new Response(readFileSync(join(import.meta.dirname, "fixtures", "rates", rate), "utf8"));
    return new Response("unexpected", { status: 500 });
  };
}
