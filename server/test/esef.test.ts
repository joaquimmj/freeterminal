import { describe, expect, it } from "vitest";
import { extractFiling, fiscalYear, oimUnit } from "../src/esef/extract";
import { buildEuRecord } from "../src/esef/record";
import { esefFixture, ITX, meta, tteRecord } from "./esef-fixture";

/** A minimal OIM xBRL-JSON document. */
function doc(facts: Array<{ concept: string; period: string; unit?: string; value: string; extra?: Record<string, string> }>) {
  return {
    documentInfo: { documentType: "https://xbrl.org/2021/xbrl-json" },
    facts: Object.fromEntries(
      facts.map((f, i) => [
        `f${i}`,
        { value: f.value, dimensions: { concept: f.concept, entity: "scheme:X", period: f.period, unit: f.unit ?? "iso4217:EUR", ...f.extra } },
      ]),
    ),
  };
}

describe("ESEF extraction (xBRL-JSON)", () => {
  it("converts OIM periods: an end at midnight belongs to the previous day", () => {
    const x = extractFiling(
      doc([
        { concept: "ifrs-full:Revenue", period: "2025-01-01T00:00:00/2026-01-01T00:00:00", value: "100.0" },
        { concept: "ifrs-full:Assets", period: "2026-01-01T00:00:00", value: "500.0" },
      ]),
      "X-2025",
    );
    expect(x.rows).toEqual([
      { c: "Revenue", u: "EUR", s: "2025-01-01", e: "2025-12-31", v: 100 },
      { c: "Assets", u: "EUR", s: null, e: "2025-12-31", v: 500 },
    ]);
    expect([x.kind, x.report_end]).toEqual(["annual", "2025-12-31"]);
  });

  it("keeps only undimensioned numeric ifrs-full facts, deduplicated; counts extensions", () => {
    const p = "2025-01-01T00:00:00/2026-01-01T00:00:00";
    const x = extractFiling(
      doc([
        { concept: "ifrs-full:Revenue", period: p, value: "100.0" },
        { concept: "ifrs-full:Revenue", period: p, value: "100.0" }, // the same fact tagged twice
        { concept: "ifrs-full:Revenue", period: p, value: "40.0", extra: { "ifrs-full:SegmentsAxis": "x:Retail" } },
        { concept: "tot:Excisetax", period: p, value: "18.0" },
        { concept: "ifrs-full:DescriptionOfAccountingPolicies", period: p, value: "We apply IFRS..." },
      ]),
      "X",
    );
    expect(x.rows).toHaveLength(1);
    expect(x.extension_facts).toBe(1);
  });

  it("classifies half-year and unknown reports from the facts, not the repository metadata", () => {
    const hy = extractFiling(doc([{ concept: "ifrs-full:ProfitLoss", period: "2026-01-01T00:00:00/2026-07-01T00:00:00", value: "5" }]), "H");
    expect([hy.kind, hy.report_end]).toEqual(["half-year", "2026-06-30"]);
    const odd = extractFiling(doc([{ concept: "ifrs-full:Assets", period: "2026-01-01T00:00:00", value: "5" }]), "U");
    expect(odd.kind).toBe("unknown");
  });

  it("maps OIM units", () => {
    expect([oimUnit("iso4217:EUR"), oimUnit("iso4217:EUR/xbrli:shares"), oimUnit("xbrli:shares"), oimUnit("xbrli:pure")]).toEqual([
      "EUR",
      "EUR/shares",
      "shares",
      null,
    ]);
  });

  it("labels fiscal years that end in January/February by the year they mostly cover", () => {
    expect([fiscalYear("2025-12-31"), fiscalYear("2026-01-31"), fiscalYear("2023-01-01"), fiscalYear("2025-06-30")]).toEqual([2025, 2025, 2022, 2025]);
  });
});

describe("ESEF records (real reports)", () => {
  it("TotalEnergies: figures match the published annual reports, in USD, cited to the report", () => {
    const rec = tteRecord();
    const s = rec.financials!;
    expect([s.taxonomy, s.currency]).toEqual(["ifrs-full", "USD"]);
    const fy = (l: string) => s.periods.find((p) => p.label === l)!;
    expect(fy("FY2025").values.revenue).toMatchObject({ value: 201_196_000_000, concept: "ifrs-full:RevenueFromContractsWithCustomers" });
    expect(fy("FY2024").values.net_income).toMatchObject({ value: 15_758_000_000, concept: "ifrs-full:ProfitLossAttributableToOwnersOfParent" });
    expect(fy("FY2025").derived.total_debt).toEqual({ value: 61_033_000_000, formula: "borrowings_noncurrent + borrowings_current" });
    // A year present in both reports comes from the later one (restatements win).
    expect(fy("FY2024").values.revenue!.accession).toBe("529900S21EQ1BO4ESM68-2025-12-31-ESEF-FR-0");
    // Company-specific tags are not guessed: TotalEnergies tags capex with its own concept.
    expect(fy("FY2025").values.capex).toBeNull();
    expect(s.periods.every((p) => p.type === "annual")).toBe(true);
    expect(s.notes.some((n) => /No LTM column/.test(n))).toBe(true);
    expect(s.filings["529900S21EQ1BO4ESM68-2025-12-31-ESEF-FR-0"]!.url).toBe(
      "https://filings.xbrl.org/529900S21EQ1BO4ESM68-2025-12-31-ESEF-FR-0/reports/ixbrlviewer.html",
    );
  });

  it("Inditex: a year ending 2026-01-31 is fiscal 2025", () => {
    const rec = buildEuRecord(ITX, [
      { meta: meta("549300TTCXZOGZM2EY83-2025-01-31-ESEF-ES-0", "2025-03-12"), data: esefFixture("549300TTCXZOGZM2EY83-2025-01-31-ESEF-ES-0") },
      { meta: meta("549300TTCXZOGZM2EY83-2026-01-31-ESEF-ES-0", "2026-03-11"), data: esefFixture("549300TTCXZOGZM2EY83-2026-01-31-ESEF-ES-0") },
    ]);
    const last = rec.financials!.periods.at(-1)!;
    expect([last.label, last.start, last.end]).toEqual(["FY2025", "2025-02-01", "2026-01-31"]);
  });
});
