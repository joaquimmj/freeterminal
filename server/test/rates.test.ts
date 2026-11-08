import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors";
import { ecbUrl, normalizeTenor, Rates, treasuryUrl } from "../src/rates";

const FIX = join(import.meta.dirname, "fixtures", "rates");
const read = (n: string) => readFileSync(join(FIX, n), "utf8");

export function ratesFetchText(urls: string[] = []) {
  return async (url: string): Promise<string> => {
    urls.push(url);
    if (url === treasuryUrl(2026)) return read("treasury_2026.csv");
    if (url === treasuryUrl(2025)) return read("treasury_2025.csv");
    if (url === ecbUrl("10Y", "aaa")) return read("ecb_PY_10Y_latest.csv");
    if (url === ecbUrl("10Y", "aaa", "2026-10-20", "2026-11-03")) return read("ecb_PY_10Y_2026-10-20_2026-11-03.csv");
    throw new Error(`unexpected ${url}`);
  };
}

const rates = (urls?: string[]) => new Rates(ratesFetchText(urls), () => "2026-11-08");

describe("risk-free rates", () => {
  it("US 10Y latest is the newest Treasury par yield", async () => {
    const r = await rates().us("10Y");
    expect([r.date, r.rate_pct, r.tenor]).toEqual(["2026-11-06", 4.86, "10Y"]);
    expect(r.source.accession_or_id).toBe('daily_treasury_yield_curve/2026-11-06/10 Yr');
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

  it("EUR 10Y latest is the ECB AAA par yield", async () => {
    const r = await rates().eur("10Y");
    expect([r.date, r.rate_pct]).toEqual(["2026-11-05", 3.2663886346]);
    expect(r.series).toBe("YC.B.U2.EUR.4F.G_N_A.SV_C_YM.PY_10Y");
    expect(r.source.license_note).toMatch(/Source: ECB statistics/);
  });

  it("EUR on a date uses the last observation on or before it", async () => {
    const r = await rates().eur("10Y", "2026-11-03");
    expect(r.date <= "2026-11-03").toBe(true);
  });

  it("tenors are normalized and validated", async () => {
    expect(normalizeTenor("10 yr")).toBe("10Y");
    expect(normalizeTenor("3 months")).toBe("3M");
    expect(() => normalizeTenor("ten years")).toThrow(ToolError);
    await expect(rates().us("15Y")).rejects.toThrow(/Treasury tenors/);
    await expect(rates().eur("1M")).rejects.toThrow(/ECB par-yield tenors/);
    await expect(rates().us("10Y", "11/06/2026")).rejects.toThrow(/YYYY-MM-DD/);
  });
});
