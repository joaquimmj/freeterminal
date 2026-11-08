// Parse Damodaran's workbooks into DamodaranData. Build-time only (SheetJS is a
// dev dependency and never ships in the Worker).

import * as XLSX from "xlsx";
import type { CountryRow, DamodaranData, IndustryRegion, IndustryRow } from "../src/damodaran";

export const DAMODARAN_BASE = "https://pages.stern.nyu.edu/~adamodar/pc/datasets";
export const FILES = {
  betas: { US: "betas.xls", Europe: "betaEurope.xls", Global: "betaGlobal.xls" },
  wacc: { US: "wacc.xls", Europe: "waccEurope.xls", Global: "waccGlobal.xls" },
  ctryprem: "ctryprem.xlsx",
} as const;

type Row = unknown[];

function rows(wb: XLSX.WorkBook, sheet: string): Row[] {
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`sheet ${JSON.stringify(sheet)} not found (have: ${wb.SheetNames.join(", ")})`);
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, blankrows: false, defval: null });
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const label = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Excel serial date -> ISO date. */
export function excelDate(v: unknown): string | null {
  const n = num(v);
  if (n === null || n < 30_000 || n > 80_000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000).toISOString().slice(0, 10);
}

function cellAfter(rs: Row[], startsWith: string): unknown[] | null {
  const r = rs.find((x) => label(x[0]).startsWith(startsWith.toLowerCase()));
  return r ?? null;
}

function firstNumber(r: Row | null, from = 1): number | null {
  if (!r) return null;
  for (let i = from; i < r.length; i++) if (num(r[i]) !== null) return num(r[i]);
  return null;
}

/** Rows under the "Industry Name" header, as {header label: value}. */
function industryTable(rs: Row[]): Array<Record<string, unknown>> {
  const h = rs.findIndex((r) => label(r[0]) === "industry name");
  if (h < 0) throw new Error("no 'Industry Name' header row");
  const header = rs[h]!.map(label);
  const out: Array<Record<string, unknown>> = [];
  for (const r of rs.slice(h + 1)) {
    const name = str(r[0]);
    if (!name) break;
    const rec: Record<string, unknown> = {};
    header.forEach((k, i) => k && !(k in rec) && (rec[k] = r[i]));
    out.push(rec);
  }
  return out;
}

const pick = (rec: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (num(rec[k]) !== null) return num(rec[k]);
  return null;
};

export function parseBetas(wb: XLSX.WorkBook) {
  const rs = rows(wb, "Industry Averages");
  return {
    updated: excelDate(cellAfter(rs, "date updated")?.[1]),
    rows: industryTable(rs).map((r) => ({
      industry: String(r["industry name"]).trim(),
      firms: pick(r, "number of firms"),
      beta: pick(r, "beta"),
      de_ratio: pick(r, "d/e ratio"),
      effective_tax_rate: pick(r, "effective tax rate"),
      unlevered_beta: pick(r, "unlevered beta"),
      cash_to_firm_value: pick(r, "cash/firm value"),
      unlevered_beta_cash_corrected: pick(r, "unlevered beta corrected for cash"),
    })),
  };
}

export function parseWacc(wb: XLSX.WorkBook) {
  const rs = rows(wb, "Industry Averages");
  return {
    updated: excelDate(cellAfter(rs, "date updated")?.[1]),
    assumptions: {
      riskfree: firstNumber(cellAfter(rs, "long term treasury bond rate")),
      erp: firstNumber(cellAfter(rs, "risk premium to use for equity")),
      marginal_tax: firstNumber(cellAfter(rs, "if yes, enter the marginal tax rate")),
    },
    rows: industryTable(rs).map((r) => ({
      industry: String(r["industry name"]).trim(),
      cost_of_equity: pick(r, "cost of equity"),
      equity_weight: pick(r, "e/(d+e)"),
      cost_of_debt_pretax: pick(r, "cost of debt"),
      after_tax_cost_of_debt: pick(r, "after-tax cost of debt"),
      debt_weight: pick(r, "d/(d+e)"),
      cost_of_capital: pick(r, "cost of capital"),
    })),
  };
}

export function parseCountries(wb: XLSX.WorkBook) {
  const rs = rows(wb, "ERPs by country");
  const h = rs.findIndex((r) => label(r[0]) === "country");
  if (h < 0) throw new Error("no 'Country' header row in ERPs by country");
  const header = rs[h]!.map(label);
  const col = (name: string, fallback: number) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const [iRating, iSpread, iErp, iCrp] = [
    col("moody's rating", 2),
    col("rating-based default spread", 3),
    col("total equity risk premium", 4),
    col("country risk premium", 5),
  ];
  const countries: CountryRow[] = [];
  for (const r of rs.slice(h + 1)) {
    const name = str(r[0]);
    if (!name) break;
    countries.push({
      country: name,
      region: str(r[1]), // the header cell above this column is mislabeled in the source workbook
      moodys_rating: str(r[iRating]),
      default_spread: num(r[iSpread]),
      equity_risk_premium: num(r[iErp]),
      country_risk_premium: num(r[iCrp]),
    });
  }
  return {
    mature: firstNumber(cellAfter(rs, "enter the current risk premium for a mature equity market")),
    us: firstNumber(cellAfter(rs, "enter the current risk premium for the us")),
    countries,
  };
}

/** Merge per-region beta and WACC tables by industry name. */
export function mergeIndustries(
  betas: ReturnType<typeof parseBetas>["rows"],
  wacc: ReturnType<typeof parseWacc>["rows"],
): IndustryRow[] {
  const w = new Map(wacc.map((r) => [r.industry.toLowerCase(), r]));
  return betas.map((b) => {
    const x = w.get(b.industry.toLowerCase());
    return {
      ...b,
      cost_of_equity: x?.cost_of_equity ?? null,
      equity_weight: x?.equity_weight ?? null,
      cost_of_debt_pretax: x?.cost_of_debt_pretax ?? null,
      after_tax_cost_of_debt: x?.after_tax_cost_of_debt ?? null,
      debt_weight: x?.debt_weight ?? null,
      cost_of_capital: x?.cost_of_capital ?? null,
    };
  });
}

/** Sanity checks: fail the build rather than ship a broken parse. */
export function validate(d: DamodaranData): void {
  for (const region of ["US", "Europe", "Global"] as IndustryRegion[]) {
    const rs = d.industries[region];
    if (rs.length < 50) throw new Error(`${region}: only ${rs.length} industries parsed`);
    const withBeta = rs.filter((r) => r.unlevered_beta_cash_corrected !== null && r.unlevered_beta_cash_corrected > 0 && r.unlevered_beta_cash_corrected < 5);
    if (withBeta.length < rs.length * 0.9) throw new Error(`${region}: unlevered betas look wrong`);
  }
  if (d.countries.length < 100) throw new Error(`only ${d.countries.length} countries parsed`);
  const us = d.countries.find((c) => c.country === "United States");
  if (!us || us.equity_risk_premium === null || us.equity_risk_premium < 0.02 || us.equity_risk_premium > 0.12) {
    throw new Error("US equity risk premium missing or implausible");
  }
}
