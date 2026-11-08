// Portions adapted from open-finance-mcp (c) 2026 Nathanael Johnson, MIT License.
// https://github.com/nathanaelhub/open-finance-mcp @ 8bcf3af0 (src/open_finance_mcp/server.py).
// See THIRD_PARTY_NOTICES.md.

/** The parts of data.sec.gov/submissions/CIK##########.json we use. */
export interface Submissions {
  cik?: string | number;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  fiscalYearEnd?: string;
  filings?: { recent?: Record<string, unknown[]> };
}

export interface RecentFiling {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  primaryDocDescription: string;
}

const RECENT_KEYS = ["form", "filingDate", "reportDate", "accessionNumber", "primaryDocument", "primaryDocDescription"] as const;

export function recentFilings(sub: Submissions): RecentFiling[] {
  const r = sub.filings?.recent ?? {};
  const cols = RECENT_KEYS.map((k) => (r[k] as string[] | undefined) ?? []);
  const n = Math.min(...cols.map((c) => c.length));
  const out: RecentFiling[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      form: cols[0]![i]!,
      filingDate: cols[1]![i]!,
      reportDate: cols[2]![i]!,
      accessionNumber: cols[3]![i]!,
      primaryDocument: cols[4]![i]!,
      primaryDocDescription: cols[5]![i]!,
    });
  }
  return out;
}

export const PERIODIC_FORMS = new Set(["10-K", "10-Q", "10-K/A", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"]);
export const FOREIGN_ANNUAL_FORMS = new Set(["20-F", "20-F/A", "40-F", "40-F/A"]);

/** Files annual reports on 20-F/40-F (and interims on 6-K) rather than 10-K. */
export function isForeignPrivateIssuer(filings: RecentFiling[]): boolean {
  const forms = filings.map((f) => f.form);
  return forms.some((f) => FOREIGN_ANNUAL_FORMS.has(f)) && !forms.includes("10-K");
}

/** The newest periodic report EDGAR lists (first max by filing date, like Python max()). */
export function latestPeriodic(filings: RecentFiling[]): RecentFiling | null {
  let best: RecentFiling | null = null;
  for (const f of filings) {
    if (!PERIODIC_FORMS.has(f.form)) continue;
    if (best === null || f.filingDate > best.filingDate) best = f;
  }
  return best;
}

/** Warn when EDGAR lists a newer annual/quarterly report than the XBRL API has processed. */
export function stalenessWarning(
  newest: Pick<RecentFiling, "form" | "filingDate" | "reportDate" | "accessionNumber"> | null,
  cited: Set<string>,
): string | null {
  if (!newest || cited.has(newest.accessionNumber)) return null;
  const foreign = FOREIGN_ANNUAL_FORMS.has(newest.form);
  return (
    `EDGAR lists a ${newest.form} filed ${newest.filingDate} (period ${newest.reportDate}) ` +
    "that the XBRL company-facts data does not include yet; figures stop at the prior filing. " +
    (foreign
      ? "Open it from the SEC filing index before relying on these figures."
      : "Read that filing (or the company's earnings press release) for the newest quarter.")
  );
}

/** SIC 6000-6399 (banks, credit, brokers, insurers) and 6700-6799 (holding/investment offices). */
export function isFinancial(sic: string | null | undefined): boolean {
  const code = Number.parseInt(sic ?? "0", 10);
  if (Number.isNaN(code)) return false;
  return (code >= 6000 && code <= 6399) || (code >= 6700 && code <= 6799);
}
