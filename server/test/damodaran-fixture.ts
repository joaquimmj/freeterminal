// Synthetic workbooks laid out like Damodaran's (header rows, notes above the
// tables, the mislabeled region column), so the parser is tested without
// redistributing his files. Numbers are illustrative.

import * as XLSX from "xlsx";
import type { DamodaranData, IndustryRegion } from "../src/damodaran";
import { mergeIndustries, parseBetas, parseCountries, parseWacc } from "../scripts/damodaran-parse";

const book = (sheet: string, aoa: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Explanations"]]), "Explanations & FAQ");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xls" }));
};

const INDUSTRIES = [
  "Advertising",
  "Bank (Money Center)",
  "Banks (Regional)",
  "R.E.I.T.",
  "Retail (General)",
  "Retail (REITs)",
  "Software (System & Application)",
  "Utility (General)",
];
const many = (n: number) => Array.from({ length: n }, (_, i) => `Industry ${i + 1}`);

export function betasBook(names = [...INDUSTRIES, ...many(60)]) {
  return book("Industry Averages", [
    ["Date updated:", 46027, null, null, null, null, null, "Notes"],
    ["Created by:", "Aswath Damodaran"],
    ["If marginal tax rate, enter the marginal tax rate to use", null, null, null, null, 0.25],
    ["Industry Name", "Number of firms", "Beta ", "D/E Ratio", "Effective Tax rate", "Unlevered beta", "Cash/Firm value", "Unlevered beta corrected for cash", "HiLo Risk"],
    ...names.map((n, i) => [n, 10 + i, 1.2, 0.2, 0.15, 1.0 + i / 1000, 0.05, 1.05 + i / 1000, 0.5]),
    ["Total Market", 5994, 0.91, 0.35, 0.08, 0.72, 0.045, 0.7557, 0.48],
  ]);
}

export function waccBook(names = [...INDUSTRIES, ...many(60)]) {
  return book("Industry Averages", [
    ["Date updated:", 46027],
    ["Long Term Treasury bond rate =", null, null, 0.0395],
    ["Risk Premium to Use for Equity =", null, null, 0.0446],
    ["If yes, enter the marginal tax rate to use", null, null, null, null, 0.25],
    ["Industry Name", "Number of Firms", "Beta", "Cost of Equity", "E/(D+E)", "Std Dev in Stock", "Cost of Debt", "Tax Rate", "After-tax Cost of Debt", "D/(D+E)", "Cost of Capital", "Cost of Capital (Local Currency)"],
    ...names.map((n) => [n, 20, 1.2, 0.09, 0.8, 0.4, 0.05, 0.15, 0.0375, 0.2, 0.0795, 0.0795]),
  ]);
}

export function countriesBook(extra = 120, header = ["Country", "Africa", "Moody's rating", "Rating-based Default Spread", "Total Equity Risk Premium", "Country Risk Premium", "CDS"]) {
  const wb = XLSX.utils.book_new();
  const rows: unknown[][] = [
    ["Country and Equity Risk Premiums"],
    ["Date of update:", 44561],
    ["Enter the current risk premium for a mature equity market", null, null, null, 0.0423],
    ["Enter the current risk premium for the US =", null, null, null, 0.0446],
    header,
    ["France", "Western Europe", "Aa3", 0.0051, 0.0501, 0.0078, 0.005],
    ["Germany", "Western Europe", "Aaa", 0, 0.0423, 0, 0.002],
    ["United States", "North America", "Aa1", 0.0023, 0.0446, 0.0023, 0.003],
    ["United Kingdom", "Western Europe", "Aa3", 0.0051, 0.0501, 0.0078, 0.004],
    ["Ukraine", "Eastern Europe & Russia", "Ca", 0.1, 0.1423, 0.1, "NA"],
    ["Korea", "Asia", "Aa2", 0.0042, 0.0487, 0.0064, 0.004],
    // ERP = mature ERP (0.0423) + CRP, as in Damodaran's sheet.
    ...Array.from({ length: extra }, (_, i) => [`Country ${i + 1}`, "Elsewhere", "Baa1", 0.01, 0.0623, 0.02, "NA"]),
    // A second section with its own layout, which must not be read with the first table's columns.
    ["Frontier Markets (no sovereign ratings)"],
    ["Country", "PRS Composite Risk Score", "ERP", "CRP", "Default Spread"],
    ["Russia", 70.25, 0.0813, 0.039, 0.0256],
    [null, "NR", "NA"],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "ERPs by country");
  return XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

/** A full DamodaranData built through the real parser from the synthetic books. */
export function syntheticDamodaran(): DamodaranData {
  const regions: IndustryRegion[] = ["US", "Europe", "Global"];
  const d: DamodaranData = {
    schema: 1,
    fetched_at: "2026-11-08T03:00:00Z",
    mature_market_erp: null,
    us_erp: null,
    wacc_assumptions: {} as DamodaranData["wacc_assumptions"],
    industries: {} as DamodaranData["industries"],
    countries: [],
    datasets: {},
  };
  for (const r of regions) {
    const b = parseBetas(betasBook());
    const w = parseWacc(waccBook());
    d.industries[r] = mergeIndustries(b.rows, w.rows);
    d.wacc_assumptions[r] = w.assumptions;
    d.datasets[`Betas by Sector (${r})`] = { url: "https://example.test/betas.xls", page: "https://example.test", updated: b.updated };
    d.datasets[`Cost of Capital by Industry (${r})`] = { url: "https://example.test/wacc.xls", page: "https://example.test", updated: w.updated };
  }
  const c = parseCountries(countriesBook());
  d.countries = c.countries;
  d.mature_market_erp = c.mature;
  d.us_erp = c.us;
  d.datasets["Country Default Spreads and Risk Premiums"] = { url: "https://example.test/ctryprem.xlsx", page: "https://example.test", updated: "2026-02-16" };
  return d;
}
