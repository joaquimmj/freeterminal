import { describe, expect, it } from "vitest";
import { keyMetrics } from "../src/metrics";
import { SNAPSHOT_YEARS } from "../src/config";
import { standardize } from "../src/sec/xbrl";
import { facts } from "./helpers";

const std = (t: string) => standardize(facts(t), SNAPSHOT_YEARS, true);
const period = (r: ReturnType<typeof keyMetrics>, label: string) => r.periods.find((p) => p.label === label)!;

describe("key metrics", () => {
  it("Apple margins and growth follow from the reported figures", () => {
    const s = std("AAPL");
    const r = keyMetrics(s, 3, true, false);
    const fy24 = s.periods.find((p) => p.label === "FY2024")!;
    const fy23 = s.periods.find((p) => p.label === "FY2023")!;
    const m = period(r, "FY2024").metrics;
    expect(m.gross_margin).toEqual({ value: fy24.values.gross_profit!.value / fy24.values.revenue!.value, formula: "gross_profit / revenue" });
    expect(m.revenue_growth!.value).toBeCloseTo(fy24.values.revenue!.value / fy23.values.revenue!.value - 1, 12);
    expect(m.revenue_growth!.formula).toBe("revenue / revenue(FY2023) - 1");
    expect(m.roe!.value).toBeCloseTo(
      fy24.values.net_income!.value / ((fy24.balance_sheet.total_equity!.value + fy23.balance_sheet.total_equity!.value) / 2),
      12,
    );
  });

  it("ROIC uses NOPAT over invested capital, with the tax proxy shown", () => {
    const s = std("AAPL");
    const fy = s.periods.find((p) => p.label === "FY2024")!;
    const m = period(keyMetrics(s, 2, false, false), "FY2024").metrics;
    const v = (k: string) => fy.values[k]?.value ?? fy.balance_sheet[k]?.value ?? fy.derived[k]?.value ?? 0;
    const t = (v("pretax_income") - v("net_income")) / v("pretax_income");
    const ic = v("total_debt") + v("total_equity") - v("cash") - v("short_term_investments");
    expect(m.effective_tax_rate_proxy!.value).toBeCloseTo(t, 12);
    expect(m.roic!.value).toBeCloseTo((v("operating_income") * (1 - t)) / ic, 12);
  });

  it("returns the requested number of years plus LTM, and a CAGR", () => {
    const r = keyMetrics(std("AAPL"), 3, true, false);
    expect(r.periods.map((p) => p.type)).toEqual(["annual", "annual", "annual", "ltm"]);
    expect(r.periods[0]!.metrics.revenue_growth).not.toBeNull(); // the extra year feeds the oldest growth
    expect(r.periods.at(-1)!.metrics.revenue_growth).toBeNull(); // LTM growth is not like-for-like
    // Exponent = years elapsed between fiscal year ends: Apple's 52/53-week years span 728 days = 1.99 years.
    expect(r.revenue_cagr!.formula).toBe("(revenue(FY2025) / revenue(FY2023))^(1/1.99) - 1");
  });

  it("growth is null when the previous column is not one year earlier (missing fiscal year)", () => {
    const s = std("AAPL");
    const annual = s.periods.filter((p) => p.type === "annual");
    const gappy = { ...s, periods: annual.filter((_, i) => i !== annual.length - 2) }; // drop the middle year
    const r = keyMetrics(gappy, 2, false, false);
    expect(r.periods.at(-1)!.metrics.revenue_growth).toBeNull();
    expect(r.periods.at(-1)!.metrics.gross_margin).not.toBeNull();
  });

  it("LTM averages name the balance-sheet dates they use", () => {
    const ltm = keyMetrics(std("AAPL"), 1, true, false).periods.at(-1)!;
    expect(ltm.metrics.roe!.formula).toMatch(/total_equity at \d{4}-\d{2}-\d{2}, total_equity at \d{4}-\d{2}-\d{2}/);
  });

  it("banks get no EBITDA-based ratios or ROIC", () => {
    const m = keyMetrics(std("JPM"), 1, false, true).periods[0]!.metrics;
    for (const k of ["ebitda_margin", "net_debt_to_ebitda", "interest_coverage", "roic"]) expect(m[k]).toBeNull();
    expect(m.net_margin).not.toBeNull();
  });

  it("missing inputs give null, never zero", () => {
    // Caterpillar's LTM has no total debt (segment-only tagging).
    const ltm = keyMetrics(std("CAT"), 1, true, false).periods.at(-1)!;
    expect(ltm.type).toBe("ltm");
    expect(ltm.metrics.net_debt_to_ebitda).toBeNull();
    expect(ltm.metrics.roic).toBeNull();
  });
});
