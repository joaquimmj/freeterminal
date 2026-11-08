// Parity tests for the XBRL port. Portions adapted from open-finance-mcp
// (c) 2026 Nathanael Johnson, MIT License (tests/test_xbrl.py @ 8bcf3af0).
// Same fixtures, same expected values; deliberate changes are marked "CHANGE".

import { describe, expect, it } from "vitest";
import { ifrsTotalDebt, NoAnnualFacts, sharesOutstanding, standardize, totalDebt, type RawFact } from "../src/sec/xbrl";
import { companyfacts, fact, facts } from "./helpers";

const col = (r: ReturnType<typeof standardize>, label: string) => {
  const c = r.periods.find((p) => p.label === label);
  if (!c) throw new Error(`no column ${label}`);
  return c;
};
const rows = (cf: ReturnType<typeof facts>, concept: string, unit = "USD"): RawFact[] =>
  cf.facts["us-gaap"]![concept]!.units![unit]!;

describe("real filings", () => {
  it("Apple FY2024 matches the 10-K", () => {
    const r = standardize(facts("AAPL"), 5);
    const fy24 = col(r, "FY2024");
    expect([fy24.start, fy24.end]).toEqual(["2023-10-01", "2024-09-28"]);
    expect(fy24.values.revenue!.value).toBe(391_035_000_000);
    expect(fy24.values.revenue!.concept).toBe("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax");
    expect(fy24.values.net_income!.value).toBe(93_736_000_000);
    // Commercial paper 9.967B + term debt 10.912B current + 85.750B noncurrent.
    expect(fy24.derived.total_debt).toEqual({
      value: 106_629_000_000,
      formula: "ltd_noncurrent + ltd_current + commercial_paper",
    });
  });

  it("every cited accession has a filing URL", () => {
    const r = standardize(facts("AAPL"), 3);
    for (const p of r.periods) {
      for (const group of [p.values, p.balance_sheet]) {
        for (const c of Object.values(group)) {
          if (!c) continue;
          for (const a of c.accessions ?? [c.accession!]) expect(r.filings[a]!.url.endsWith(`${a}-index.htm`)).toBe(true);
        }
      }
    }
  });

  it("Apple LTM is FY + YTD - prior YTD", () => {
    const cf = facts("AAPL");
    const r = standardize(cf, 1);
    const ltm = r.periods.at(-1)!;
    expect(ltm.type).toBe("ltm");
    const fy = col(r, "FY2025");
    const rev = rows(cf, "RevenueFromContractWithCustomerExcludingAssessedTax");
    const ytdStart = "2025-09-28";
    const byFiled = (a: RawFact, b: RawFact) => ((a.filed ?? "") < (b.filed ?? "") ? b : a);
    const cur = rev.filter((x) => x.start === ytdStart && x.end === ltm.end).reduce(byFiled);
    const prior = rev
      .filter((x) => x.start === fy.start && x.form === "10-Q" && x.end < fy.end && x.end >= "2025-06-01")
      .reduce(byFiled);
    expect(ltm.values.revenue!.value).toBe(fy.values.revenue!.value + cur.val - prior.val);
    expect(ltm.label).toBe(`LTM to ${ltm.end}`);
    expect(ltm.ytd).toEqual({ start: ytdStart, end: ltm.end, days: 273 }); // 39 weeks
  });

  it("CHANGE: LTM diluted EPS is trailing (FY + YTD - prior YTD), not the YTD figure", () => {
    const cf = facts("AAPL");
    const r = standardize(cf, 1);
    const ltm = r.periods.at(-1)!;
    const fy = col(r, "FY2025");
    const eps = ltm.values.diluted_eps!;
    expect(eps.formula).toBe("FY + YTD - prior YTD");
    expect(eps.accessions!.length).toBeGreaterThanOrEqual(2);
    const ytdOnly = cf.facts["us-gaap"]!.EarningsPerShareDiluted!.units!["USD/shares"]!.filter(
      (x) => x.start === ltm.ytd!.start && x.end === ltm.end,
    );
    // Trailing EPS is close to the fiscal-year EPS, and far above 9-month YTD EPS.
    expect(Math.abs(eps.value - fy.values.diluted_eps!.value)).toBeLessThan(0.3 * fy.values.diluted_eps!.value);
    expect(eps.value).toBeGreaterThan(ytdOnly[0]!.val * 1.2);
  });

  it("fiscal years follow the company calendar", () => {
    const labels = standardize(facts("MSFT"), 2, false).periods.map((p) => [p.label, p.end]);
    expect(labels).toEqual([
      ["FY2025", "2025-06-30"],
      ["FY2026", "2026-06-30"],
    ]);
  });

  it("bank uses long-term debt including current; no EBITDA", () => {
    const r = standardize(facts("JPM"), 1);
    expect(r.periods[0]!.derived.total_debt!.formula.startsWith("ltd_total")).toBe(true);
    expect(r.periods[0]!.derived.ebitda).toBeNull();
  });

  it("segment-only debt is null, not zero", () => {
    const ltm = standardize(facts("CAT"), 1).periods.at(-1)!;
    expect(ltm.type).toBe("ltm");
    expect(ltm.derived.total_debt).toBeNull();
    expect(ltm.derived.net_debt).toBeNull();
  });

  it("new registrant without history raises", () => {
    expect(() => standardize(facts("XOM"))).toThrow(NoAnnualFacts);
    expect(() => standardize(facts("XOM"))).toThrow(/predecessor/);
  });

  it("shares from the cover page", () => {
    const s = sharesOutstanding(facts("AAPL"))!;
    expect(s.concept).toBe("dei:EntityCommonStockSharesOutstanding");
    expect(s.classes_summed).toBe(1);
    expect(s.value).toBeGreaterThan(1e10);
  });

  it("shares fall back to the balance sheet for per-class cover pages", () => {
    const s = sharesOutstanding(facts("GOOGL"))!;
    expect(s.concept).toBe("us-gaap:CommonStockSharesOutstanding");
    expect(s.classes_summed).toBeNull();
    expect(s.value).toBeGreaterThan(1e10);
  });

  it("IFRS filer is read in its own currency", () => {
    const r = standardize(facts("SAP"), 3);
    expect([r.taxonomy, r.currency]).toEqual(["ifrs-full", "EUR"]);
    const fy = r.periods.at(-1)!;
    expect(fy.values.revenue).toEqual({
      value: 36_800_000_000,
      concept: "ifrs-full:Revenue",
      accession: fy.values.revenue!.accession,
    });
    expect(fy.values.net_income!.concept).toBe("ifrs-full:ProfitLossAttributableToOwnersOfParent");
    expect(fy.derived.total_debt!.formula).toBe("borrowings");
    expect(r.periods.every((p) => p.type === "annual")).toBe(true); // 6-K interims carry no XBRL
    expect(r.notes.some((n) => n.includes("IFRS filer"))).toBe(true);
  });

  it("Toyota IFRS with no standard capex concept", () => {
    const r = standardize(facts("TM"), 1);
    const fy = r.periods[0]!;
    expect([r.taxonomy, r.currency, fy.end]).toEqual(["ifrs-full", "JPY", "2025-03-31"]);
    expect(fy.values.revenue!.value).toBe(48_036_704_000_000);
    expect(fy.values.capex).toBeNull();
    expect(fy.derived.free_cash_flow).toBeNull();
    expect(fy.derived.ebitda!.value).toBe(4_795_586_000_000 + 2_251_233_000_000);
  });
});

describe("rules on synthetic facts", () => {
  it("concept priority is resolved per period (Caterpillar-style)", () => {
    const cf = companyfacts({
      Revenues: [
        fact(100, "2009-01-01", "2009-12-31", "a-09", "2010-02-20", "10-K", 2009),
        fact(110, "2010-01-01", "2010-12-31", "a-10", "2011-02-20", "10-K", 2010),
        fact(120, "2011-01-01", "2011-12-31", "a-11", "2012-02-20", "10-K", 2011),
      ],
      NetIncomeLoss: [
        fact(9, "2009-01-01", "2009-12-31", "a-09", "2010-02-20", "10-K", 2009),
        fact(10, "2010-01-01", "2010-12-31", "a-10", "2011-02-20", "10-K", 2010),
      ],
      ProfitLoss: [
        fact(11, "2010-01-01", "2010-12-31", "a-11", "2012-02-20", "10-K", 2011),
        fact(12, "2011-01-01", "2011-12-31", "a-11", "2012-02-20", "10-K", 2011),
      ],
    });
    const ni = standardize(cf, 5, false).periods.map((p) => [p.values.net_income!.concept, p.values.net_income!.value]);
    expect(ni).toEqual([
      ["us-gaap:NetIncomeLoss", 9],
      ["us-gaap:NetIncomeLoss", 10],
      ["us-gaap:ProfitLoss", 12],
    ]);
  });

  it("restated value comes from the latest filing; label from the original", () => {
    const cf = companyfacts({
      Revenues: [
        fact(100, "2024-02-05", "2025-02-02", "orig", "2025-03-15", "10-K", 2024),
        fact(97, "2024-02-05", "2025-02-02", "restated", "2026-03-14", "10-K", 2025),
      ],
    });
    const p = standardize(cf, 5, false).periods[0]!;
    expect(p.label).toBe("FY2024"); // a retailer year ending Feb 2025 is fiscal 2024
    expect([p.values.revenue!.value, p.values.revenue!.accession]).toEqual([97, "restated"]);
  });

  it("LTM needs one concept across FY and both YTDs", () => {
    const cf = companyfacts({
      Revenues: [
        fact(400, "2025-01-01", "2025-12-31", "k", "2026-02-10", "10-K", 2025),
        fact(90, "2025-01-01", "2025-03-31", "q-prior", "2025-05-01", "10-Q"),
      ],
      SalesRevenueNet: [fact(110, "2026-01-01", "2026-03-31", "q", "2026-05-01", "10-Q")],
    });
    let ltm = standardize(cf).periods.at(-1)!;
    expect(ltm.type).toBe("ltm");
    expect(ltm.values.revenue).toBeNull();

    cf.facts["us-gaap"]!.Revenues!.units!.USD!.push(fact(110, "2026-01-01", "2026-03-31", "q", "2026-05-01", "10-Q"));
    ltm = standardize(cf).periods.at(-1)!;
    expect(ltm.values.revenue!.value).toBe(400 + 110 - 90);
  });

  it.each([
    [{ debt_current: 30, ltd_current: 10, commercial_paper: 20, ltd_noncurrent: 100 }, 130, "ltd_noncurrent + debt_current"],
    [{ ltd_total: 110, ltd_current: 10 }, 110, "(ltd_total - ltd_current) + ltd_current"],
    [{ short_term_borrowings: 5 }, 5, "short_term_borrowings (no long-term debt concept reported: likely incomplete)"],
    [{}, null, "no debt concepts reported"],
  ])("total debt never double counts %#", (inst, value, formula) => {
    const cells = Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, { value: v }]));
    expect(totalDebt(cells)).toEqual([value, formula]);
  });

  it("multi-class cover page is summed", () => {
    const dei = {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            { val: 300, end: "2026-07-20", accn: "x", filed: "2026-07-25", form: "10-Q" },
            { val: 50, end: "2026-07-20", accn: "x", filed: "2026-07-25", form: "10-Q" },
            { val: 340, end: "2026-04-20", accn: "w", filed: "2026-04-25", form: "10-Q" },
          ],
        },
      },
    };
    const s = sharesOutstanding(companyfacts({}, dei))!;
    expect([s.value, s.classes_summed, s.accession]).toEqual([350, 2, "x"]);
  });

  it("newest taxonomy wins for a filer with both (Sony-style)", () => {
    const cf = companyfacts({
      Revenues: [fact(100, "2019-04-01", "2020-03-31", "old", "2020-06-20", "20-F", 2020)],
    });
    cf.facts["ifrs-full"] = {
      Revenue: { units: { JPY: [fact(9000, "2024-04-01", "2025-03-31", "new", "2025-06-20", "20-F", 2025)] } },
    };
    let r = standardize(cf, 5, false);
    expect([r.taxonomy, r.currency]).toEqual(["ifrs-full", "JPY"]);
    expect(r.periods.at(-1)!.values.revenue!.value).toBe(9000);

    cf.facts["us-gaap"]!.Revenues!.units!.USD!.push(
      fact(120, "2025-04-01", "2026-03-31", "newer", "2026-06-20", "20-F", 2026),
    );
    r = standardize(cf, 5, false);
    expect(r.taxonomy).toBe("us-gaap");
  });

  it.each([
    [{ borrowings: 30, borrowings_noncurrent: 20, borrowings_current: 10 }, 30, "borrowings"],
    [{ borrowings_noncurrent: 20, borrowings_current: 10 }, 30, "borrowings_noncurrent + borrowings_current"],
    [{ borrowings_current: 10 }, 10, "borrowings_current (no non-current borrowings concept reported: likely incomplete)"],
    // Current debt tagged as its two components (no total): summed, never added on top of a total.
    [{ borrowings_noncurrent: 20, short_term_borrowings: 3, current_portion_of_longterm_borrowings: 4 }, 27, "borrowings_noncurrent + (short_term_borrowings + current_portion_of_longterm_borrowings)"],
    [{ borrowings_noncurrent: 20, borrowings_current: 7, short_term_borrowings: 3 }, 27, "borrowings_noncurrent + borrowings_current"],
    [{}, null, "no debt concepts reported"],
  ])("IFRS debt never double counts %#", (inst, value, formula) => {
    const cells = Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, { value: v }]));
    expect(ifrsTotalDebt(cells)).toEqual([value, formula]);
  });
});
