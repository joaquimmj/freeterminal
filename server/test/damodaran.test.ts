import { describe, expect, it } from "vitest";
import { countryPremium, industryInputs, industryNames } from "../src/damodaran";
import { excelDate, parseBetas, parseCountries, parseWacc, validate } from "../scripts/damodaran-parse";
import { betasBook, countriesBook, syntheticDamodaran, waccBook } from "./damodaran-fixture";

describe("Damodaran parser", () => {
  it("reads the betas table under its header row, with the update date", () => {
    const b = parseBetas(betasBook());
    expect(b.updated).toBe(excelDate(46027));
    expect(excelDate(46027)).toBe("2026-01-05");
    const sw = b.rows.find((r) => r.industry === "Software (System & Application)")!;
    expect(sw).toMatchObject({ beta: 1.2, de_ratio: 0.2, effective_tax_rate: 0.15, cash_to_firm_value: 0.05 });
    expect(sw.unlevered_beta_cash_corrected).toBeGreaterThan(sw.unlevered_beta!); // distinct columns, not mixed up
    expect(b.rows.at(-1)!.industry).toBe("Total Market");
  });

  it("reads WACC tables and the assumptions embedded above them", () => {
    const w = parseWacc(waccBook());
    expect(w.assumptions).toEqual({ riskfree: 0.0395, erp: 0.0446, marginal_tax: 0.25 });
    expect(w.rows[0]).toMatchObject({ cost_of_equity: 0.09, cost_of_debt_pretax: 0.05, cost_of_capital: 0.0795, debt_weight: 0.2 });
  });

  it("reads country ERPs despite the mislabeled region header", () => {
    const c = parseCountries(countriesBook());
    expect([c.mature, c.us]).toEqual([0.0423, 0.0446]);
    expect(c.countries.find((x) => x.country === "France")).toEqual({
      country: "France",
      region: "Western Europe",
      moodys_rating: "Aa3",
      default_spread: 0.0051,
      equity_risk_premium: 0.0501,
      country_risk_premium: 0.0078,
    });
  });

  it("validate() rejects a broken parse instead of shipping it", () => {
    const d = syntheticDamodaran();
    expect(() => validate(d)).not.toThrow();
    expect(() => validate({ ...d, countries: d.countries.slice(0, 10) })).toThrow(/countries/);
    const noUs = { ...d, countries: d.countries.filter((c) => c.country !== "United States") };
    expect(() => validate(noUs)).toThrow(/US equity risk premium/);
  });
});

describe("Damodaran lookups", () => {
  const d = syntheticDamodaran();

  it("country lookup is case-insensitive and cited", () => {
    const [fr] = countryPremium(d, "france");
    expect(fr!.equity_risk_premium).toBe(0.0501);
    expect(fr!.mature_market_erp).toBe(0.0423);
    expect(fr!.source.license_note).toMatch(/Damodaran/);
    expect(() => countryPremium(d, "Atlantis")).toThrow(/English country name/);
    expect(() => countryPremium(d, "Country")).toThrow(/be more specific/);
  });

  it("industry lookup prefers an exact name and explains its US$ assumptions", () => {
    const [r] = industryInputs(d, "Europe", "retail (general)");
    expect(r!.industry).toBe("Retail (General)");
    expect(r!.sources).toHaveLength(2);
    expect(r!.note).toMatch(/0.0395/);
    expect(() => industryInputs(d, "US", "Spaceships")).toThrow(/list Damodaran's industry names/);
    expect(industryNames(d, "US")).toContain("Advertising");
  });
});
