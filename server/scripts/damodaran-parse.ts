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
/**
 * Names come from remote workbooks and are returned to the model: keep printable
 * text only, capped, so a tampered cell can't smuggle long instructions.
 */
const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return s || null;
};
/** Header labels: lowercased, single-spaced, curly apostrophes straightened. */
const label = (v: unknown) => String(v ?? "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();

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

/** The first numeric cell after the label in column A. */
function firstNumber(r: Row | null): number | null {
  return r?.slice(1).map(num).find((v) => v !== null) ?? null;
}

/** Rows under the "Industry Name" header, as {header label: value}. Throws if an expected column is missing. */
function industryTable(rs: Row[], required: string[]): Array<Record<string, unknown>> {
  const h = rs.findIndex((r) => label(r[0]) === "industry name");
  if (h < 0) throw new Error("no 'Industry Name' header row");
  const header = rs[h]!.map(label);
  const missing = required.filter((k) => !header.includes(k));
  if (missing.length) throw new Error(`layout changed: missing column(s) ${missing.join(", ")}`);
  const out: Array<Record<string, unknown>> = [];
  for (const r of rs.slice(h + 1)) {
    const name = str(r[0]);
    if (!name) break;
    const rec: Record<string, unknown> = {};
    header.forEach((k, i) => k && !(k in rec) && (rec[k] = r[i]));
    rec["industry name"] = name;
    out.push(rec);
  }
  return out;
}

const pick = (rec: Record<string, unknown>, key: string) => num(rec[key]);

const BETA_COLUMNS = ["number of firms", "beta", "d/e ratio", "effective tax rate", "unlevered beta", "cash/firm value", "unlevered beta corrected for cash"];
const WACC_COLUMNS = ["cost of equity", "e/(d+e)", "cost of debt", "after-tax cost of debt", "d/(d+e)", "cost of capital"];

export function parseBetas(wb: XLSX.WorkBook) {
  const rs = rows(wb, "Industry Averages");
  return {
    updated: excelDate(cellAfter(rs, "date updated")?.[1]),
    rows: industryTable(rs, BETA_COLUMNS).map((r) => ({
      industry: String(r["industry name"]),
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
    rows: industryTable(rs, WACC_COLUMNS).map((r) => ({
      industry: String(r["industry name"]),
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
  // No positional fallbacks: an inserted or renamed column must fail the build, not shift every value.
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`ERPs by country: layout changed, no "${name}" column`);
    return i;
  };
  const [iRating, iSpread, iErp, iCrp] = [
    col("moody's rating"),
    col("rating-based default spread"),
    col("total equity risk premium"),
    col("country risk premium"),
  ];
  const countries: CountryRow[] = [];
  let i = h + 1;
  // Main table: rated countries. It ends at the "Frontier Markets" section, which has its own layout.
  for (; i < rs.length; i++) {
    const r = rs[i]!;
    const name = str(r[0]);
    if (!name || label(name).startsWith("frontier markets")) break;
    countries.push({
      country: name,
      region: str(r[1]), // the header cell above this column is mislabeled in the source workbook
      moodys_rating: str(r[iRating]),
      default_spread: num(r[iSpread]),
      equity_risk_premium: num(r[iErp]),
      country_risk_premium: num(r[iCrp]),
      basis: "Moody's sovereign rating",
    });
  }
  // Frontier markets (no sovereign rating): Country, PRS Composite Risk Score, ERP, CRP, Default Spread.
  const fh = rs.findIndex((r, j) => j >= i && label(r[0]) === "country" && label(r[1]).startsWith("prs"));
  if (fh >= 0) {
    const fheader = rs[fh]!.map(label);
    const fcol = (name: string) => {
      const k = fheader.indexOf(name);
      if (k < 0) throw new Error(`Frontier markets: layout changed, no "${name}" column`);
      return k;
    };
    const [fPrs, fErp, fCrp, fSpread] = [fcol("prs composite risk score"), fcol("erp"), fcol("crp"), fcol("default spread")];
    for (const r of rs.slice(fh + 1)) {
      const name = str(r[0]);
      if (!name || num(r[fErp]) === null) break;
      countries.push({
        country: name,
        region: null,
        moodys_rating: null,
        default_spread: num(r[fSpread]),
        equity_risk_premium: num(r[fErp]),
        country_risk_premium: num(r[fCrp]),
        basis: `no sovereign rating; PRS composite risk score ${num(r[fPrs]) ?? "n/a"}`,
      });
    }
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

const inRange = (v: number | null, lo: number, hi: number) => v !== null && v >= lo && v <= hi;

/** Share of rows whose value passes `ok`; throws below `min`. */
function coverage<T>(rows: T[], ok: (r: T) => boolean, min: number, what: string): void {
  const share = rows.filter(ok).length / Math.max(rows.length, 1);
  if (share < min) throw new Error(`${what}: only ${(share * 100).toFixed(0)}% of rows plausible (need ${min * 100}%)`);
}

/** Sanity checks on every figure we serve: fail the build rather than ship a broken parse. */
export function validate(d: DamodaranData): void {
  for (const region of ["US", "Europe", "Global"] as IndustryRegion[]) {
    const rs = d.industries[region];
    if (rs.length < 50) throw new Error(`${region}: only ${rs.length} industries parsed`);
    coverage(rs, (r) => inRange(r.unlevered_beta_cash_corrected, 0.01, 5), 0.9, `${region} unlevered betas`);
    coverage(rs, (r) => inRange(r.beta, 0.01, 5), 0.9, `${region} betas`);
    coverage(rs, (r) => inRange(r.cost_of_capital, 0.01, 0.3), 0.9, `${region} cost of capital (betas/wacc join or layout)`);
    coverage(rs, (r) => inRange(r.cost_of_equity, 0.01, 0.4), 0.9, `${region} cost of equity`);
    coverage(rs, (r) => inRange(r.de_ratio, 0, 20), 0.9, `${region} D/E`);
    const a = d.wacc_assumptions[region];
    if (!inRange(a?.riskfree ?? null, 0, 0.15) || !inRange(a?.erp ?? null, 0.02, 0.15)) {
      throw new Error(`${region}: WACC assumptions (risk-free rate, ERP) missing or implausible`);
    }
  }
  if (d.countries.length < 100) throw new Error(`only ${d.countries.length} countries parsed`);
  if (!inRange(d.mature_market_erp, 0.02, 0.12)) throw new Error("mature market ERP missing or implausible");
  coverage(d.countries, (c) => inRange(c.country_risk_premium, 0, 0.3) && inRange(c.default_spread, 0, 0.25), 0.9, "country risk premiums / default spreads");
  // Damodaran's identity: total ERP = mature-market ERP + country risk premium. Checks that columns didn't shift.
  coverage(
    d.countries,
    (c) => c.equity_risk_premium !== null && c.country_risk_premium !== null && Math.abs(c.equity_risk_premium - d.mature_market_erp! - c.country_risk_premium) < 0.002,
    0.9,
    "ERP = mature ERP + CRP identity",
  );
  const us = d.countries.find((c) => c.country === "United States");
  if (!us || !inRange(us.equity_risk_premium, 0.02, 0.12)) throw new Error("US equity risk premium missing or implausible");
}
