import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolError, UpstreamError } from "../src/errors";
import { cachedFetchText, isTreasuryCsv, normalizeTenor, Rates, treasuryUrl } from "../src/rates";
import { ecbFixture } from "./helpers";

const FIX = join(import.meta.dirname, "fixtures", "rates");
const read = (n: string) => readFileSync(join(FIX, n), "utf8");

export function ratesFetchText(urls: string[] = [], override?: (url: string) => string | null) {
  return async (url: string): Promise<string> => {
    urls.push(url);
    const o = override?.(url);
    if (o !== undefined && o !== null) return o;
    if (url === treasuryUrl(2026)) return read("treasury_2026.csv");
    if (url === treasuryUrl(2025)) return read("treasury_2025.csv");
    const ecb = ecbFixture(url);
    if (ecb !== null) return ecb;
    throw new Error(`unexpected ${url}`);
  };
}

const rates = (urls?: string[], today = "2026-11-08", override?: (url: string) => string | null) =>
  new Rates(ratesFetchText(urls, override), () => today);

describe("risk-free rates", () => {
  it("US 10Y latest is the newest Treasury par yield, in percent and decimal", async () => {
    const r = await rates().us("10Y");
    expect([r.date, r.rate_pct, r.rate_decimal, r.tenor]).toEqual(["2026-11-06", 4.86, 0.0486, "10Y"]);
    expect(r.source.accession_or_id).toBe("daily_treasury_yield_curve/2026-11-06/10 Yr");
    expect(r.warnings).toEqual([]);
  });

  it("a weekend date takes the prior business day", async () => {
    const r = await rates().us("30Y", "2026-11-07");
    expect(r.date).toBe("2026-11-06");
    expect(r.basis).toMatch(/on or before 2026-11-07/);
  });

  it("early January falls back to the prior year's file", async () => {
    const urls: string[] = [];
    const r = await rates(urls).us("10Y", "2026-01-01");
    expect([r.date, r.rate_pct]).toEqual(["2025-12-31", 4.18]);
    expect(urls).toEqual([treasuryUrl(2026), treasuryUrl(2025)]);
  });

  it("a latest rate older than a week is flagged as possibly stale", async () => {
    const r = await rates(undefined, "2026-11-30").us("10Y");
    expect(r.date).toBe("2026-11-06");
    expect(r.warnings[0]).toMatch(/24 days ago/);
  });

  it("EUR 10Y latest is the ECB AAA par yield", async () => {
    const r = await rates().eur("10Y");
    expect([r.date, r.rate_pct]).toEqual(["2026-11-05", 3.2663886346]);
    expect(r.series).toBe("YC.B.U2.EUR.4F.G_N_A.SV_C_YM.PY_10Y");
    expect(r.source.license_note).toMatch(/Source: ECB statistics/);
  });

  it("EUR on a date returns that date's fixing, and a weekend takes the prior one", async () => {
    const r = await rates().eur("10Y", "2026-11-03");
    expect([r.date, r.rate_pct]).toEqual(["2026-11-03", 3.3174124288]);
    const w = await rates().eur("10Y", "2026-11-01");
    expect([w.date, w.rate_pct]).toEqual(["2026-10-30", 3.3363663906]);
    expect(w.basis).toMatch(/on or before 2026-11-01/);
  });

  it("tenors are normalized and validated; dates must be real and not in the future", async () => {
    expect(normalizeTenor("10 yr")).toBe("10Y");
    expect(normalizeTenor("3 months")).toBe("3M");
    expect(normalizeTenor("12M")).toBe("1Y");
    expect(() => normalizeTenor("ten years")).toThrow(ToolError);
    await expect(rates().us("15Y")).rejects.toThrow(/Treasury tenors/);
    await expect(rates().eur("1M")).rejects.toThrow(/ECB par-yield tenors/);
    await expect(rates().us("10Y", "11/06/2026")).rejects.toThrow(/YYYY-MM-DD/);
    await expect(rates().us("10Y", "2026-02-30")).rejects.toThrow(/real date/);
    await expect(rates().us("10Y", "2026-13-01")).rejects.toThrow(/real date/);
    await expect(rates().us("10Y", "2027-01-04")).rejects.toThrow(/in the future/);
  });

  it("a Treasury page that is not the CSV is an upstream error, not a silent 'no data'", async () => {
    await expect(rates(undefined, "2026-11-08", () => "<html>Access denied</html>").us("10Y")).rejects.toThrow(UpstreamError);
  });
});

describe("cachedFetchText", () => {
  const url = "https://home.treasury.gov/x.csv";

  it("maps a non-OK upstream to UpstreamError", async () => {
    const f = cachedFetchText(async () => new Response("down", { status: 503 }));
    await expect(f(url, 60)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("never caches a body the validator rejects", async () => {
    let n = 0;
    const f = cachedFetchText(async () => new Response(n++ === 0 ? "<html>maintenance</html>" : "Date,10 Yr\n11/06/2026,4.86\n"));
    await expect(f(url, 60, isTreasuryCsv)).rejects.toThrow(/unexpected page/);
    expect(await f(url, 60, isTreasuryCsv)).toMatch(/^Date,/);
  });

  it("serves repeat requests from the isolate memo without refetching", async () => {
    let n = 0;
    const f = cachedFetchText(async () => {
      n++;
      return new Response("Date,10 Yr\n");
    });
    await f(url, 60);
    await f(url, 60);
    expect(n).toBe(1);
  });
});
