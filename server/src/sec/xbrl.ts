// Portions adapted from open-finance-mcp (c) 2026 Nathanael Johnson, MIT License.
// https://github.com/nathanaelhub/open-finance-mcp @ 8bcf3af0 (src/open_finance_mcp/xbrl.py).
// See THIRD_PARTY_NOTICES.md.
//
// Standardize SEC XBRL "company facts" into citable annual + LTM financials.
//
// Everything here is pure: it takes the parsed JSON from
// data.sec.gov/api/xbrl/companyfacts/CIK##########.json and returns plain
// objects, so it runs the same in the Worker, in the snapshot build, and in tests.
//
// Two facts about the data drive the design:
// - Companies tag the same line item differently and change tags over time
//   (Caterpillar's NetIncomeLoss stops in 2010 and continues as
//   NetIncomeLossAvailableToCommonStockholdersBasic). Each metric has a priority
//   list of concepts, resolved per period: the first concept with a value for
//   that period wins, and the concept actually used is reported.
// - A 10-K carries prior years as comparatives and later filings can restate
//   them. For each period we take the value from the most recently filed
//   report, and cite that filing.
//
// Foreign private issuers that report under IFRS (20-F/40-F) are read from
// ifrs-full with their own concept map, in their reporting currency. A filer
// with both taxonomies (Sony) is read from whichever has the latest fiscal year.

export const DURATION_CONCEPTS: Record<string, string[]> = {
  revenue: [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "RevenuesNetOfInterestExpense",
  ],
  gross_profit: ["GrossProfit"],
  operating_income: ["OperatingIncomeLoss"],
  pretax_income: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  net_income: ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"],
  interest_expense: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
  d_and_a: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
    "DepreciationAmortizationAndOther",
    "Depreciation",
  ],
  operating_cash_flow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  diluted_shares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  diluted_eps: ["EarningsPerShareDiluted"],
};

export const INSTANT_CONCEPTS: Record<string, string[]> = {
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  short_term_investments: [
    "MarketableSecuritiesCurrent",
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
    "ShortTermInvestments",
  ],
  total_assets: ["Assets"],
  total_equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  // Debt components; combined by totalDebt below.
  ltd_noncurrent: [
    "LongTermDebtNoncurrent",
    "LongTermDebtAndCapitalLeaseObligations",
    "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
  ],
  ltd_total: ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities"],
  debt_current: ["DebtCurrent"],
  ltd_current: ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"],
  commercial_paper: ["CommercialPaper"],
  short_term_borrowings: ["ShortTermBorrowings"],
};

export const IFRS_DURATION_CONCEPTS: Record<string, string[]> = {
  revenue: ["Revenue", "RevenueFromContractsWithCustomers", "RevenueFromSaleOfGoods"],
  gross_profit: ["GrossProfit"],
  operating_income: ["ProfitLossFromOperatingActivities"],
  pretax_income: ["ProfitLossBeforeTax"],
  net_income: ["ProfitLossAttributableToOwnersOfParent", "ProfitLoss"],
  interest_expense: ["InterestExpense", "FinanceCosts"],
  // Impairment-inclusive D&A concepts are left out so EBITDA means the same thing across filers.
  d_and_a: ["DepreciationAndAmortisationExpense", "AdjustmentsForDepreciationAndAmortisationExpense"],
  operating_cash_flow: ["CashFlowsFromUsedInOperatingActivities"],
  capex: [
    "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
    "PurchaseOfPropertyPlantAndEquipment",
    // Broader (includes intangibles); the concept name is reported with the value.
    "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
  ],
  diluted_shares: ["AdjustedWeightedAverageShares"],
  diluted_eps: ["DilutedEarningsLossPerShare"],
};

export const IFRS_INSTANT_CONCEPTS: Record<string, string[]> = {
  cash: ["CashAndCashEquivalents"],
  short_term_investments: [], // no standard IFRS concept
  total_assets: ["Assets"],
  total_equity: ["EquityAttributableToOwnersOfParent", "Equity"],
  // IFRS Borrowings is current + non-current; the pieces are the fallback.
  borrowings: ["Borrowings"],
  borrowings_noncurrent: ["LongtermBorrowings", "NoncurrentPortionOfNoncurrentLoansReceived"],
  borrowings_current: [
    "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings",
    "CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived",
  ],
  // The two components of current borrowings, used only when the total above is not tagged.
  short_term_borrowings: ["ShorttermBorrowings"],
  current_portion_of_longterm_borrowings: ["CurrentPortionOfLongtermBorrowings"],
};

// "ESEF" / "ESEF-HY": European annual and half-year reports (src/esef/extract.ts).
export const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "10-KT", "20-F", "20-F/A", "40-F", "40-F/A", "ESEF"]);
export const QUARTERLY_FORMS = new Set(["10-Q", "10-Q/A", "ESEF-HY"]); // 6-K interims carry no XBRL financials

/** The filer has no usable annual facts in either taxonomy (new registrant, fund...). */
export class NoAnnualFacts extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAnnualFacts";
  }
}

// ---- types -----------------------------------------------------------------

/** One row of companyfacts `units.<unit>[]`. */
export interface RawFact {
  val: number;
  start?: string;
  end: string;
  accn: string;
  filed?: string;
  form?: string;
  fy?: number | null;
  fp?: string | null;
  frame?: string;
}

/** `facts.<taxonomy>`: concept -> { units: { unit: rows } }. */
export type Namespace = Record<string, { label?: string; units?: Record<string, RawFact[]> }>;

export interface CompanyFacts {
  cik: number | string;
  entityName?: string;
  facts: Record<string, Namespace>;
}

export interface Fact {
  concept: string;
  value: number;
  start: string | null;
  end: string;
  form: string;
  accession: string;
  filed: string;
  fy: number | null;
}

export interface Cell {
  value: number;
  concept: string;
  accession?: string;
  accessions?: string[];
  formula?: string;
  note?: string;
}

export interface Derived {
  value: number;
  formula: string;
}

export interface Column {
  label: string;
  start: string | null;
  end: string;
  type: "annual" | "ltm";
  ytd?: { start: string; end: string; days: number };
  values: Record<string, Cell | null>;
  balance_sheet: Record<string, Cell | null>;
  derived: Record<string, Derived | null>;
}

export interface FilingRef {
  url: string;
  form: string | null;
  filed: string | null;
}

export interface Standardized {
  cik: number;
  entity_name: string | null;
  taxonomy: string;
  currency: string;
  notes: string[];
  periods: Column[];
  filings: Record<string, FilingRef>;
}

interface Taxonomy {
  prefix: "us-gaap" | "ifrs-full";
  duration: Record<string, string[]>;
  instant: Record<string, string[]>;
}

const US_GAAP: Taxonomy = { prefix: "us-gaap", duration: DURATION_CONCEPTS, instant: INSTANT_CONCEPTS };
const IFRS: Taxonomy = { prefix: "ifrs-full", duration: IFRS_DURATION_CONCEPTS, instant: IFRS_INSTANT_CONCEPTS };

interface Ctx {
  tx: Taxonomy;
  facts: Namespace;
  currency: string;
}

// ---- helpers ---------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function factDays(f: Fact): number | null {
  return f.start === null ? null : daysBetween(f.start, f.end) + 1;
}

export function filingUrl(cik: number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Math.trunc(cik)}/${accession.replaceAll("-", "")}/${accession}-index.htm`;
}

function unitFor(ctx: Ctx, metric: string): string {
  if (metric === "diluted_shares") return "shares";
  if (metric === "diluted_eps") return `${ctx.currency}/shares`;
  return ctx.currency;
}

function getFacts(ns: Namespace, concept: string, unit: string): Fact[] {
  const rows = ns[concept]?.units?.[unit] ?? [];
  const out: Fact[] = [];
  for (const r of rows) {
    if (r.val === undefined || r.val === null || !r.accn || !r.end) continue;
    out.push({
      concept,
      value: Number(r.val),
      start: r.start ?? null,
      end: r.end,
      form: r.form ?? "",
      accession: r.accn,
      filed: r.filed ?? "",
      fy: r.fy ?? null,
    });
  }
  return out;
}

/** Python tuple comparison on (filed, accession). */
function cmpFiledAccn(a: Fact, b: Fact): number {
  if (a.filed !== b.filed) return a.filed < b.filed ? -1 : 1;
  if (a.accession !== b.accession) return a.accession < b.accession ? -1 : 1;
  return 0;
}

/** Latest filing wins; ties on the filing date go to the later accession. Mirrors Python max(). */
function latestFiled(facts: Fact[]): Fact {
  let best = facts[0]!;
  for (const f of facts.slice(1)) if (cmpFiledAccn(f, best) > 0) best = f;
  return best;
}

/** Earliest filing; mirrors Python min() (first minimal element wins ties). */
function earliestFiled(facts: Fact[]): Fact {
  let best = facts[0]!;
  for (const f of facts.slice(1)) if (cmpFiledAccn(f, best) < 0) best = f;
  return best;
}

function isAnnual(f: Fact): boolean {
  const d = factDays(f);
  return ANNUAL_FORMS.has(f.form) && d !== null && d >= 350 && d <= 380;
}

// ---- periods -----------------------------------------------------------------

interface Period {
  label: string;
  start: string;
  end: string;
}

/**
 * Fiscal-year periods, oldest first, keyed off the revenue/net-income facts.
 *
 * The fiscal-year label comes from the original 10-K for that period (the
 * earliest filing that reports it), because comparatives in later 10-Ks carry
 * the later filing's fy. Label-by-end-year would be wrong for retailers: Home
 * Depot's fiscal 2025 ends on 1 Feb 2026.
 */
function annualPeriods(ctx: Ctx): Period[] {
  const periods = new Map<string, Fact[]>(); // insertion-ordered like a Python dict
  for (const metric of ["revenue", "net_income"]) {
    for (const concept of ctx.tx.duration[metric]!) {
      for (const f of getFacts(ctx.facts, concept, ctx.currency)) {
        if (!isAnnual(f)) continue;
        const key = `${f.start}|${f.end}`;
        const list = periods.get(key);
        if (list) list.push(f);
        else periods.set(key, [f]);
      }
    }
  }
  if (periods.size === 0) throw new NoAnnualFacts("no annual revenue or net-income facts");

  const out: Period[] = [];
  for (const [key, facts] of periods) {
    const [start, end] = key.split("|") as [string, string];
    const first = earliestFiled(facts);
    // Only trust fy when the first filing is the period's own 10-K (filed within ~6 months).
    const gap = first.filed ? daysBetween(end, first.filed) : -1;
    const fy = first.fy && gap >= 0 && gap <= 190 ? first.fy : Number(end.slice(0, 4));
    out.push({ label: `FY${fy}`, start, end });
  }
  // Stable sort by end date, like Python's list.sort.
  out.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  // Overlapping periods (a restated year re-cut with new dates) keep the later one.
  const dedup: Period[] = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (last && p.start <= last.end) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup;
}

function pick(ctx: Ctx, metric: string, concepts: string[], match: (f: Fact) => boolean): Fact | null {
  for (const concept of concepts) {
    const hits = getFacts(ctx.facts, concept, unitFor(ctx, metric)).filter(match);
    if (hits.length) return latestFiled(hits);
  }
  return null;
}

function cell(ctx: Ctx, f: Fact | null): Cell | null {
  if (!f) return null;
  return { value: f.value, concept: `${ctx.tx.prefix}:${f.concept}`, accession: f.accession };
}

function durationValue(ctx: Ctx, metric: string, start: string, end: string, forms: Set<string>): Fact | null {
  return pick(ctx, metric, ctx.tx.duration[metric]!, (f) => f.start === start && f.end === end && forms.has(f.form));
}

function instantValue(ctx: Ctx, metric: string, end: string, forms: Set<string>): Fact | null {
  return pick(ctx, metric, ctx.tx.instant[metric]!, (f) => f.start === null && f.end === end && forms.has(f.form));
}

function sumCells(cells: Array<{ value: number } | null | undefined>): number | null {
  const vals = cells.filter((c): c is { value: number } => !!c).map((c) => c.value);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

type Inst = Record<string, { value: number } | null | undefined>;

/**
 * Combine debt components without double counting. Returns [value, formula].
 *
 * DebtCurrent already includes the current portion of long-term debt,
 * commercial paper and short-term borrowings, so those are only summed when it
 * is absent. LongTermDebt includes its current portion, so it is only used
 * (minus that portion) when no noncurrent concept exists. Operating-lease
 * liabilities are excluded by design.
 */
export function totalDebt(inst: Inst): [number | null, string] {
  let lt: number | null = null;
  let ltDesc: string | null = null;
  if (inst.ltd_noncurrent) {
    lt = inst.ltd_noncurrent.value;
    ltDesc = "ltd_noncurrent";
  } else if (inst.ltd_total) {
    lt = inst.ltd_total.value;
    ltDesc = "ltd_total";
    if (inst.ltd_current) {
      lt -= inst.ltd_current.value;
      ltDesc = "(ltd_total - ltd_current)";
    }
  }

  let cur: number | null = null;
  let curDesc: string | null = null;
  if (inst.debt_current) {
    cur = inst.debt_current.value;
    curDesc = "debt_current";
  } else {
    const parts = ["ltd_current", "commercial_paper", "short_term_borrowings"].filter((k) => inst[k]);
    cur = parts.length ? sumCells(parts.map((k) => inst[k])) : null;
    curDesc = parts.length ? parts.join(" + ") : null;
  }

  if (lt === null && cur === null) return [null, "no debt concepts reported"];
  let formula = [ltDesc, curDesc].filter(Boolean).join(" + ");
  if (lt === null) formula += " (no long-term debt concept reported: likely incomplete)";
  return [(lt ?? 0) + (cur ?? 0), formula];
}

/**
 * IFRS Borrowings (current + non-current), else its parts. Current borrowings come
 * from their total concept, else from its two components (short-term borrowings +
 * current portion of long-term borrowings), never both. Leases excluded.
 */
export function ifrsTotalDebt(inst: Inst): [number | null, string] {
  if (inst.borrowings) return [inst.borrowings.value, "borrowings"];
  let cur: number | null = null;
  let curDesc: string | null = null;
  if (inst.borrowings_current) {
    cur = inst.borrowings_current.value;
    curDesc = "borrowings_current";
  } else {
    const parts = ["short_term_borrowings", "current_portion_of_longterm_borrowings"].filter((k) => inst[k]);
    if (parts.length) {
      cur = sumCells(parts.map((k) => inst[k]));
      curDesc = parts.length > 1 ? `(${parts.join(" + ")})` : parts[0]!;
    }
  }
  const lt = inst.borrowings_noncurrent?.value ?? null;
  if (lt === null && cur === null) return [null, "no debt concepts reported"];
  let formula = [lt !== null ? "borrowings_noncurrent" : null, curDesc].filter(Boolean).join(" + ");
  if (lt === null) formula += " (no non-current borrowings concept reported: likely incomplete)";
  return [(lt ?? 0) + (cur ?? 0), formula];
}

function derive(row: Record<string, Cell | null>, inst: Record<string, Cell | null>, tx: Taxonomy): Record<string, Derived | null> {
  const v = (src: Record<string, Cell | null>, k: string): number | null => src[k]?.value ?? null;
  const out: Record<string, Derived | null> = {};
  const oi = v(row, "operating_income");
  const da = v(row, "d_and_a");
  out.ebitda = oi !== null && da !== null ? { value: oi + da, formula: "operating_income + d_and_a" } : null;
  const cfo = v(row, "operating_cash_flow");
  const capex = v(row, "capex");
  out.free_cash_flow =
    cfo !== null && capex !== null ? { value: cfo - capex, formula: "operating_cash_flow - capex" } : null;
  const [debt, formula] = (tx === IFRS ? ifrsTotalDebt : totalDebt)(inst);
  out.total_debt = debt === null ? null : { value: debt, formula };
  const cash = v(inst, "cash");
  if (debt !== null && cash !== null) {
    const sti = v(inst, "short_term_investments") ?? 0;
    out.net_debt = { value: debt - cash - sti, formula: "total_debt - cash - short_term_investments" };
  } else {
    out.net_debt = null;
  }
  return out;
}

// ---- LTM ---------------------------------------------------------------------

/**
 * (start, end) of the newest 10-Q year-to-date period after fyEnd. A YTD
 * period starts right after the fiscal year ends (within a week, for 52/53-week
 * calendars), so 3-month quarterly facts are excluded.
 */
function latestQuarterYtd(ctx: Ctx, fyEnd: string): [string, string] | null {
  let best: [string, string] | null = null;
  for (const concept of [...ctx.tx.duration.revenue!, ...ctx.tx.duration.net_income!]) {
    for (const f of getFacts(ctx.facts, concept, ctx.currency)) {
      if (!QUARTERLY_FORMS.has(f.form) || !f.start) continue;
      const gap = daysBetween(fyEnd, f.start);
      if (gap > 0 && gap <= 7 && (best === null || f.end > best[1])) best = [f.start, f.end];
    }
  }
  return best;
}

/** [FY, current YTD, prior-year YTD] facts for one concept, or null. */
function ltmParts(ctx: Ctx, metric: string, concept: string, lastFy: Period, ytd: [string, string]): [Fact, Fact, Fact] | null {
  const facts = getFacts(ctx.facts, concept, unitFor(ctx, metric));
  const length = daysBetween(ytd[0], ytd[1]);
  const one = (pred: (f: Fact) => boolean): Fact | null => {
    const hits = facts.filter(pred);
    return hits.length ? latestFiled(hits) : null;
  };
  const fy = one((f) => ANNUAL_FORMS.has(f.form) && f.start === lastFy.start && f.end === lastFy.end);
  const cur = one((f) => QUARTERLY_FORMS.has(f.form) && f.start === ytd[0] && f.end === ytd[1]);
  const prev = one(
    (f) =>
      QUARTERLY_FORMS.has(f.form) &&
      f.start === lastFy.start &&
      f.start !== null &&
      Math.abs(daysBetween(f.start, f.end) - length) <= 7,
  );
  return fy && cur && prev ? [fy, cur, prev] : null;
}

function ltmColumn(ctx: Ctx, lastFy: Period): Column | null {
  const ytd = latestQuarterYtd(ctx, lastFy.end);
  if (!ytd) return null;

  const row: Record<string, Cell | null> = {};
  for (const m of Object.keys(ctx.tx.duration)) {
    if (m === "diluted_shares") {
      // A weighted-average share count is not additive: report the latest YTD figure as-is.
      const f = durationValue(ctx, m, ytd[0], ytd[1], QUARTERLY_FORMS);
      const c = cell(ctx, f);
      row[m] = c ? { ...c, note: "weighted average for the year-to-date period, not trailing twelve months" } : null;
      continue;
    }
    row[m] = null;
    // FY + YTD - prior YTD is only valid when one concept covers all three.
    for (const concept of ctx.tx.duration[m]!) {
      const parts = ltmParts(ctx, m, concept, lastFy, ytd);
      if (!parts) continue;
      const [fy, cur, prev] = parts;
      row[m] = {
        value: fy.value + cur.value - prev.value,
        concept: `${ctx.tx.prefix}:${concept}`,
        formula: "FY + YTD - prior YTD",
        accessions: [...new Set([fy.accession, cur.accession, prev.accession])].sort(),
        // Change vs open-finance-mcp: it reported diluted EPS as the YTD figure
        // (e.g. 9 months) under an LTM label. Trailing EPS is the sum of the last
        // four quarters, i.e. FY + YTD - prior YTD, which is what we compute.
        ...(m === "diluted_eps"
          ? { note: "sum of the last four quarters' EPS; per-share amounts are approximately additive" }
          : {}),
      };
      break;
    }
  }
  const inst: Record<string, Cell | null> = {};
  for (const m of Object.keys(ctx.tx.instant)) inst[m] = cell(ctx, instantValue(ctx, m, ytd[1], QUARTERLY_FORMS));
  return {
    // Exact span, not "6M": 52/53-week filers (PepsiCo) have 12- and 16-week quarters.
    label: `LTM to ${ytd[1]}`,
    start: null,
    end: ytd[1],
    type: "ltm",
    ytd: { start: ytd[0], end: ytd[1], days: daysBetween(ytd[0], ytd[1]) + 1 },
    values: row,
    balance_sheet: inst,
    derived: derive(row, inst, ctx.tx),
  };
}

// ---- taxonomy choice + entry point ---------------------------------------------

/** The currency most annual revenue/net-income facts are reported in. */
export function reportingCurrency(ns: Namespace): string | null {
  const counts = new Map<string, number>();
  for (const concept of [
    "Revenues",
    "Revenue",
    "NetIncomeLoss",
    "ProfitLoss",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
  ]) {
    for (const [unit, rows] of Object.entries(ns[concept]?.units ?? {})) {
      if (unit.includes("/") || unit === "shares") continue;
      const n = rows.filter((r) => r.form !== undefined && ANNUAL_FORMS.has(r.form)).length;
      counts.set(unit, (counts.get(unit) ?? 0) + n);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [unit, n] of counts) {
    if (best === null || n > bestN) {
      best = unit;
      bestN = n;
    }
  }
  return best !== null && bestN > 0 ? best : null;
}

function choose(cf: CompanyFacts): [Ctx, Period[]] {
  let best: [Ctx, Period[]] | null = null;
  for (const tx of [US_GAAP, IFRS]) {
    const ns = cf.facts?.[tx.prefix];
    const currency = ns ? reportingCurrency(ns) : null;
    if (!ns || !currency) continue;
    const ctx: Ctx = { tx, facts: ns, currency };
    let periods: Period[];
    try {
      periods = annualPeriods(ctx);
    } catch (e) {
      if (e instanceof NoAnnualFacts) continue;
      throw e;
    }
    if (best === null || periods[periods.length - 1]!.end > best[1][best[1].length - 1]!.end) best = [ctx, periods];
  }
  if (!best) {
    throw new NoAnnualFacts(
      "no 10-K or 20-F history: possibly a newly formed registrant whose history sits under a predecessor CIK",
    );
  }
  return best;
}

/** Index of accession -> form/filed, from every fact in the chosen taxonomy (for citations). */
function filingIndex(ns: Namespace): Map<string, { form: string | null; filed: string | null }> {
  const idx = new Map<string, { form: string | null; filed: string | null }>();
  for (const concept of Object.values(ns)) {
    for (const rows of Object.values(concept.units ?? {})) {
      for (const r of rows) if (r.accn && !idx.has(r.accn)) idx.set(r.accn, { form: r.form ?? null, filed: r.filed ?? null });
    }
  }
  return idx;
}

export interface StandardizeOptions {
  /** Where the facts come from: SEC companyfacts (default) or ESEF reports. Changes notes and citation URLs. */
  source?: "sec" | "esef";
  /** Citation URL for an accession / filing id (default: the SEC EDGAR filing index). */
  filingUrl?: (accession: string) => string;
}

/** Standardized annual (+ optional LTM) financials with per-value citations. */
export function standardize(cf: CompanyFacts, years = 5, includeLtm = true, opts: StandardizeOptions = {}): Standardized {
  const cik = Math.trunc(Number(cf.cik));
  const urlFor = opts.filingUrl ?? ((a: string) => filingUrl(cik, a));
  const [ctx, allPeriods] = choose(cf);
  const periods = allPeriods.slice(-years);
  const columns: Column[] = [];

  for (const p of periods) {
    const row: Record<string, Cell | null> = {};
    for (const m of Object.keys(ctx.tx.duration)) row[m] = cell(ctx, durationValue(ctx, m, p.start, p.end, ANNUAL_FORMS));
    const inst: Record<string, Cell | null> = {};
    for (const m of Object.keys(ctx.tx.instant)) inst[m] = cell(ctx, instantValue(ctx, m, p.end, ANNUAL_FORMS));
    columns.push({ ...p, type: "annual", values: row, balance_sheet: inst, derived: derive(row, inst, ctx.tx) });
  }

  if (includeLtm && periods.length) {
    const ltm = ltmColumn(ctx, periods[periods.length - 1]!);
    if (ltm) columns.push(ltm);
  }

  const accessions = new Set<string>();
  for (const col of columns) {
    for (const group of [col.values, col.balance_sheet]) {
      for (const c of Object.values(group)) {
        if (!c) continue;
        for (const a of c.accessions ?? [c.accession!]) accessions.add(a);
      }
    }
  }

  const notes = [
    "Values are as most recently reported (restatements included); each cites its filing.",
    "Balance-sheet items are period-end instants. Share counts are weighted diluted.",
    "Derived metrics show their formula. EBITDA is null when operating income is not " +
      "reported (common for banks and insurers, where EBITDA is not meaningful).",
  ];
  if (opts.source === "esef") {
    notes.push(
      "ESEF report (IFRS as adopted in the EU), from the issuer's tagged consolidated statements. Lines the " +
        "issuer tagged only with its own (extension) concepts are not mapped and come back null.",
    );
    if (!columns.some((c) => c.type === "ltm")) {
      notes.push("No LTM column: the issuer's half-year report is not available in ESEF format.");
    }
  } else if (ctx.tx === IFRS) {
    notes.push(
      "IFRS filer (20-F/40-F): figures follow IFRS, not US GAAP. Interim results are furnished " +
        "on 6-K without XBRL, so there is no LTM column.",
    );
  }
  const idx = filingIndex(ctx.facts);
  const filings: Record<string, FilingRef> = {};
  for (const a of [...accessions].sort()) {
    const meta = idx.get(a);
    filings[a] = { url: urlFor(a), form: meta?.form ?? null, filed: meta?.filed ?? null };
  }
  return {
    cik,
    entity_name: cf.entityName ?? null,
    taxonomy: ctx.tx.prefix,
    currency: ctx.currency,
    notes,
    periods: columns,
    filings,
  };
}

export interface SharesOutstanding {
  value: number;
  as_of: string;
  classes_summed: number | null;
  concept: string;
  accession: string;
  url: string;
  note?: string;
}

/**
 * Latest share count for market cap. Prefers the cover-page
 * dei:EntityCommonStockSharesOutstanding, summed across share classes when a
 * filing reports several. Companies that tag the cover page only per class
 * (Alphabet) have no undimensioned dei fact in the API, so fall back to the
 * balance-sheet us-gaap:CommonStockSharesOutstanding, already a total.
 */
export function sharesOutstanding(cf: CompanyFacts): SharesOutstanding | null {
  const facts = cf.facts ?? {};
  const cik = Math.trunc(Number(cf.cik));
  const periodic = new Set([...ANNUAL_FORMS, ...QUARTERLY_FORMS]);

  const dei = (facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).filter(
    (r) => r.form !== undefined && periodic.has(r.form),
  );
  if (dei.length) {
    let latest = dei[0]!;
    for (const r of dei.slice(1)) {
      const a = [r.filed ?? "", r.end];
      const b = [latest.filed ?? "", latest.end];
      if (a[0]! > b[0]! || (a[0] === b[0] && a[1]! > b[1]!)) latest = r;
    }
    const same = dei.filter((r) => r.accn === latest.accn && r.end === latest.end);
    return {
      value: same.reduce((s, r) => s + Number(r.val), 0),
      as_of: latest.end,
      classes_summed: same.length,
      concept: "dei:EntityCommonStockSharesOutstanding",
      accession: latest.accn,
      url: filingUrl(cik, latest.accn),
    };
  }

  const rows = (facts["us-gaap"]?.CommonStockSharesOutstanding?.units?.shares ?? []).filter(
    (r) => r.form !== undefined && periodic.has(r.form) && r.start === undefined,
  );
  if (!rows.length) return null;
  let latest = rows[0]!;
  for (const r of rows.slice(1)) {
    if (r.end > latest.end || (r.end === latest.end && (r.filed ?? "") > (latest.filed ?? ""))) latest = r;
  }
  return {
    value: Number(latest.val),
    as_of: latest.end,
    classes_summed: null,
    concept: "us-gaap:CommonStockSharesOutstanding",
    note: "Cover-page count not available undimensioned; balance-sheet total across all classes.",
    accession: latest.accn,
    url: filingUrl(cik, latest.accn),
  };
}
