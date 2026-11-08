import { readdirSync, readFileSync } from "node:fs";
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

const RATES = join(import.meta.dirname, "fixtures", "rates");

/**
 * ECB Data Portal stand-in: merges every fixture file for the requested series
 * (e.g. ecb_EXR_USD_*.csv, ecb_PY_10Y_*.csv) and returns only the rows inside
 * startPeriod..endPeriod, like the real API (an empty window is an empty 200).
 */
export function ecbFixture(url: string): string | null {
  const u = new URL(url);
  if (u.host !== "data-api.ecb.europa.eu") return null;
  const exr = /\/EXR\/D\.([A-Z]{3})\.EUR\.SP00\.A$/.exec(u.pathname);
  const yc = /\/YC\/B\.U2\.EUR\.4F\.G_N_A\.SV_C_YM\.PY_(\w+)$/.exec(u.pathname);
  const prefix = exr ? `ecb_EXR_${exr[1]}_` : yc ? `ecb_PY_${yc[1]}_` : null;
  if (!prefix) return null;
  const files = readdirSync(RATES).filter((f) => f.startsWith(prefix));
  if (!files.length) return "";
  const start = u.searchParams.get("startPeriod") ?? "0000-00-00";
  const end = u.searchParams.get("endPeriod") ?? "9999-99-99";
  let header = "";
  const rows = new Map<string, string>();
  for (const f of files) {
    const lines = readFileSync(join(RATES, f), "utf8").trim().split("\n");
    header = lines[0]!;
    const iD = header.split(",").indexOf("TIME_PERIOD");
    for (const l of lines.slice(1)) rows.set(l.split(",")[iD]!, l);
  }
  const keep = [...rows.entries()].filter(([d]) => d >= start && d <= end).sort(([a], [b]) => (a < b ? -1 : 1));
  if (u.searchParams.get("lastNObservations") === "1") keep.splice(0, keep.length - 1);
  return keep.length ? [header, ...keep.map(([, l]) => l)].join("\n") + "\n" : "";
}

/** Rate fixture for a Treasury/ECB URL (data as of 2026-11-08). */
function rateFixture(url: string): string | null {
  if (url.includes("daily-treasury-rates.csv/2025/")) return readFileSync(join(RATES, "treasury_2025.csv"), "utf8");
  if (url.includes("daily-treasury-rates.csv/")) return readFileSync(join(RATES, "treasury_2026.csv"), "utf8");
  return ecbFixture(url);
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
    if (rate !== null) return new Response(rate);
    return new Response("unexpected", { status: 500 });
  };
}
