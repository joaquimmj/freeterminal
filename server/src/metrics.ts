// Ratios computed from the standardized statements. Each value is labeled with
// its formula; if any input is missing (null), the ratio is null, never 0.

import { slice } from "./present";
import type { Column, Standardized } from "./sec/xbrl";

export interface Metric {
  value: number;
  formula: string;
  note?: string;
}

export interface MetricsPeriod {
  label: string;
  type: Column["type"];
  end: string;
  metrics: Record<string, Metric | null>;
}

type Get = (k: string) => number | null;

function getter(col: Column): Get {
  return (k) =>
    col.values[k]?.value ?? col.balance_sheet[k]?.value ?? col.derived[k]?.value ?? null;
}

function ratio(num: number | null, den: number | null, formula: string, note?: string): Metric | null {
  if (num === null || den === null || den === 0) return null;
  return note ? { value: num / den, formula, note } : { value: num / den, formula };
}

function avg(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : (a + b) / 2;
}

/** Effective tax rate approximated from pretax and net income (no tax-expense concept in the map). */
function taxRate(g: Get): number | null {
  const pre = g("pretax_income");
  const ni = g("net_income");
  if (pre === null || ni === null || pre <= 0) return null;
  const t = (pre - ni) / pre;
  return t >= 0 && t <= 0.5 ? t : null; // outside 0-50% the proxy is meaningless
}

export function metricsFor(col: Column, prev: Column | null, financial: boolean): Record<string, Metric | null> {
  const g = getter(col);
  const p = prev ? getter(prev) : null;
  const rev = g("revenue");
  const m: Record<string, Metric | null> = {};

  m.revenue_growth =
    p && rev !== null && p("revenue") !== null && p("revenue")! > 0
      ? { value: rev / p("revenue")! - 1, formula: `revenue / revenue(${prev!.label}) - 1` }
      : null;
  m.net_income_growth =
    p && g("net_income") !== null && p("net_income") !== null && p("net_income")! > 0
      ? { value: g("net_income")! / p("net_income")! - 1, formula: `net_income / net_income(${prev!.label}) - 1` }
      : null;

  m.gross_margin = ratio(g("gross_profit"), rev, "gross_profit / revenue");
  m.operating_margin = ratio(g("operating_income"), rev, "operating_income / revenue");
  m.net_margin = ratio(g("net_income"), rev, "net_income / revenue");
  m.fcf_margin = ratio(g("free_cash_flow"), rev, "free_cash_flow / revenue");
  m.capex_to_revenue = ratio(g("capex"), rev, "capex / revenue");
  m.fcf_conversion = ratio(g("free_cash_flow"), g("net_income"), "free_cash_flow / net_income");

  const eqAvg = p ? avg(g("total_equity"), p("total_equity")) : null;
  const assetsAvg = p ? avg(g("total_assets"), p("total_assets")) : null;
  m.roe =
    eqAvg !== null && eqAvg > 0 ? ratio(g("net_income"), eqAvg, "net_income / average(total_equity, prior year)") : null;
  m.roa = ratio(g("net_income"), assetsAvg, "net_income / average(total_assets, prior year)");

  if (financial) {
    // EBITDA, EV-style leverage and ROIC are not meaningful for banks and insurers.
    for (const k of ["ebitda_margin", "net_debt_to_ebitda", "interest_coverage", "roic", "effective_tax_rate_proxy"]) m[k] = null;
    return m;
  }

  m.ebitda_margin = ratio(g("ebitda"), rev, "ebitda / revenue");
  const ebitda = g("ebitda");
  m.net_debt_to_ebitda = ebitda !== null && ebitda > 0 ? ratio(g("net_debt"), ebitda, "net_debt / ebitda") : null;
  m.interest_coverage = ratio(g("operating_income"), g("interest_expense"), "operating_income / interest_expense");

  const t = taxRate(g);
  m.effective_tax_rate_proxy =
    t === null
      ? null
      : {
          value: t,
          formula: "(pretax_income - net_income) / pretax_income",
          note: "approximation: also absorbs minority interests and discontinued operations",
        };
  const oi = g("operating_income");
  const debt = g("total_debt");
  const eq = g("total_equity");
  const cash = g("cash");
  if (t !== null && oi !== null && debt !== null && eq !== null && cash !== null) {
    const sti = g("short_term_investments") ?? 0;
    const ic = debt + eq - cash - sti;
    m.roic =
      ic > 0
        ? {
            value: (oi * (1 - t)) / ic,
            formula: "operating_income × (1 - effective_tax_rate_proxy) / (total_debt + total_equity - cash - short_term_investments)",
            note: "period-end invested capital; tax rate is the proxy above",
          }
        : null;
  } else {
    m.roic = null;
  }
  return m;
}

/** Compound annual growth of revenue across the annual columns returned. */
export function revenueCagr(columns: Column[]): Metric | null {
  const annual = columns.filter((c) => c.type === "annual");
  if (annual.length < 2) return null;
  const first = annual[0]!;
  const last = annual[annual.length - 1]!;
  const a = first.values.revenue?.value ?? null;
  const b = last.values.revenue?.value ?? null;
  const n = annual.length - 1;
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return { value: (b / a) ** (1 / n) - 1, formula: `(revenue(${last.label}) / revenue(${first.label}))^(1/${n}) - 1` };
}

export function keyMetrics(std: Standardized, years: number, includeLtm: boolean, financial: boolean) {
  // One extra year so the oldest returned year still has growth and averages.
  const { columns } = slice(std, years + 1, includeLtm);
  const annual = columns.filter((c) => c.type === "annual");
  const out: MetricsPeriod[] = [];
  annual.forEach((col, i) => {
    out.push({ label: col.label, type: col.type, end: col.end, metrics: metricsFor(col, annual[i - 1] ?? null, financial) });
  });
  const ltm = columns.find((c) => c.type === "ltm");
  if (ltm) {
    // LTM vs the last fiscal year: balance-sheet averages use the fiscal year end; growth is not
    // like-for-like (overlapping windows), so it is left null.
    const m = metricsFor(ltm, annual.at(-1) ?? null, financial);
    m.revenue_growth = null;
    m.net_income_growth = null;
    out.push({ label: ltm.label, type: "ltm", end: ltm.end, metrics: m });
  }
  const shown = out.filter((p) => p.type === "ltm" || annual.slice(-years).some((a) => a.label === p.label));
  return { periods: shown, revenue_cagr: revenueCagr(annual.slice(-years)) };
}
