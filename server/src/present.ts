// Shape internal records into tool output: grouped statements, explicit units,
// and a `sources` array where every cited filing is one entry (brief §4/§5).

import { DISCLAIMER } from "./config";
import { isFinancial, stalenessWarning } from "./sec/filings";
import type { CompanyRecord } from "./sec/record";
import type { Cell, Column, Derived, Standardized } from "./sec/xbrl";

export interface Source {
  name: string;
  url: string;
  accession_or_id: string;
  form: string | null;
  period: string | null;
  as_of: string | null;
  license_note: string;
}

const SEC_LICENSE = "SEC EDGAR filing data: U.S. government work, public domain. Cite the filing.";

const INCOME = ["revenue", "gross_profit", "operating_income", "interest_expense", "pretax_income", "net_income", "diluted_shares", "diluted_eps"];
const CASH_FLOW = ["operating_cash_flow", "capex", "d_and_a"];

function pickKeys(src: Record<string, Cell | null>, keys: string[]): Record<string, Cell | null> {
  const out: Record<string, Cell | null> = {};
  for (const k of keys) if (k in src) out[k] = src[k] ?? null;
  return out;
}

export interface StatementPeriod {
  label: string;
  type: "annual" | "ltm";
  start: string | null;
  end: string;
  ytd?: Column["ytd"];
  income_statement: Record<string, Cell | null>;
  cash_flow: Record<string, Cell | null>;
  balance_sheet: Record<string, Cell | null>;
  derived: Record<string, Derived | null>;
}

function shapeColumn(c: Column): StatementPeriod {
  return {
    label: c.label,
    type: c.type,
    start: c.start,
    end: c.end,
    ...(c.ytd ? { ytd: c.ytd } : {}),
    income_statement: pickKeys(c.values, INCOME),
    cash_flow: pickKeys(c.values, CASH_FLOW),
    balance_sheet: c.balance_sheet,
    derived: c.derived,
  };
}

/** The last `years` annual columns (+ the LTM column if asked) and the accessions they cite. */
export function slice(std: Standardized, years: number, includeLtm: boolean): { columns: Column[]; cited: Set<string> } {
  const annual = std.periods.filter((p) => p.type === "annual").slice(-years);
  const ltm = includeLtm ? std.periods.filter((p) => p.type === "ltm") : [];
  const columns = [...annual, ...ltm];
  const cited = new Set<string>();
  for (const col of columns) {
    for (const group of [col.values, col.balance_sheet]) {
      for (const c of Object.values(group)) {
        if (!c) continue;
        for (const a of c.accessions ?? [c.accession!]) cited.add(a);
      }
    }
  }
  return { columns, cited };
}

export function reportingStandard(taxonomy: string | null | undefined): string | null {
  if (taxonomy === "us-gaap") return "US-GAAP";
  if (taxonomy === "ifrs-full") return "IFRS";
  return null;
}

function fmt(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "n/a";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B ${currency}`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M ${currency}`;
  return `${v} ${currency}`;
}

/** One `sources` entry per cited SEC filing. */
export function sourcesFor(rec: CompanyRecord, cited: Set<string>): Source[] {
  const std = rec.financials!;
  return [...cited].sort().map((a) => ({
    name: "SEC EDGAR",
    url: std.filings[a]?.url ?? "",
    accession_or_id: a,
    form: std.filings[a]?.form ?? null,
    period: rec.report_dates[a] ?? null,
    as_of: std.filings[a]?.filed ?? null,
    license_note: SEC_LICENSE,
  }));
}

/** The company block shared by the statement and metrics tools. */
export function companyBlock(rec: CompanyRecord) {
  const std = rec.financials!;
  return {
    name: std.entity_name ?? rec.name,
    ticker: rec.tickers[0] ?? null,
    cik: rec.cik,
    exchange: rec.exchanges[0] || null,
    region: "US",
    reporting_standard: reportingStandard(std.taxonomy),
    currency: std.currency,
    fiscal_year_end: rec.fiscal_year_end,
    sic: rec.sic,
    sic_description: rec.sic_description,
    financial_company: isFinancial(rec.sic),
    foreign_private_issuer: rec.foreign_private_issuer,
  };
}

/** Warnings every tool built on a company record must carry (stale XBRL data, live-built record). */
export function recordWarnings(rec: CompanyRecord, cited: Set<string>): string[] {
  const warnings: string[] = [];
  const stale = stalenessWarning(rec.latest_periodic, cited);
  if (stale) warnings.push(stale);
  if (rec.origin === "live") {
    warnings.push("Built live from SEC (not in the nightly snapshot); figures follow the same rules.");
  }
  return warnings;
}

export function financialStatements(rec: CompanyRecord, years: number, includeLtm: boolean) {
  const std = rec.financials!;
  const { columns, cited } = slice(std, years, includeLtm);
  const warnings = recordWarnings(rec, cited);
  const financial = isFinancial(rec.sic);
  if (financial) {
    warnings.push(
      `financial_company (SIC ${rec.sic} ${rec.sic_description ?? ""}): EBITDA, net debt and EV multiples ` +
        "are not meaningful; use P/E and P/B, and don't run a standard FCF-based DCF.",
    );
  }
  const sources = sourcesFor(rec, cited);
  const ticker = rec.tickers[0] ?? null;
  const cur = std.currency;
  const last = columns.filter((c) => c.type === "annual").at(-1);
  const summary =
    `${std.entity_name ?? rec.name} (${ticker ?? `CIK ${rec.cik}`}), ${reportingStandard(std.taxonomy)}, ${cur}. ` +
    (last
      ? `${last.label} (ended ${last.end}): revenue ${fmt(last.values.revenue?.value, cur)}, ` +
        `net income ${fmt(last.values.net_income?.value, cur)}. `
      : "") +
    `${columns.length} period(s), ${sources.length} cited filing(s). Every value cites its XBRL concept and accession; ` +
    "cite the matching `sources` entry when you use a number.";

  return {
    summary,
    company: companyBlock(rec),
    units:
      `Monetary values in ${cur}, absolute (not thousands or millions). diluted_shares in shares; ` +
      `diluted_eps in ${cur} per share.`,
    periods: columns.map(shapeColumn),
    warnings,
    notes: std.notes,
    sources,
    data_as_of: rec.built_at,
    disclaimer: DISCLAIMER,
  };
}
