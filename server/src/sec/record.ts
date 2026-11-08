// One company's precomputed record. The nightly snapshot build and the live
// fallback both produce it with buildCompanyRecord, so the Worker serves the
// same shape whether the data came from static assets or from SEC directly.

import { SNAPSHOT_SCHEMA, SNAPSHOT_YEARS } from "../config";
import {
  isForeignPrivateIssuer,
  latestPeriodic,
  recentFilings,
  type RecentFiling,
  type Submissions,
} from "./filings";
import { NoAnnualFacts, sharesOutstanding, standardize, type CompanyFacts, type SharesOutstanding, type Standardized } from "./xbrl";

export interface CompanyRecord {
  schema: number;
  cik: number;
  name: string | null;
  tickers: string[];
  exchanges: string[];
  sic: string | null;
  sic_description: string | null;
  fiscal_year_end: string | null; // "MMDD"
  foreign_private_issuer: boolean;
  /** The newest 10-K/10-Q/20-F/40-F EDGAR lists, for the staleness check. */
  latest_periodic: Pick<RecentFiling, "form" | "filingDate" | "reportDate" | "accessionNumber"> | null;
  /** accession -> report period end, for citations (only accessions the financials cite). */
  report_dates: Record<string, string>;
  financials: Standardized | null;
  /** Why financials is null (no annual XBRL history, ...). */
  financials_error: string | null;
  shares_outstanding: SharesOutstanding | null;
  /**
   * When this record was built, ISO-8601 UTC. Empty in snapshot files (so a
   * file only changes when the company files something, keeping nightly
   * deploys small); the Worker fills it from the snapshot manifest.
   */
  built_at: string;
  origin: "snapshot" | "live";
}

export function buildCompanyRecord(
  facts: CompanyFacts | null,
  sub: Submissions,
  cik: number,
  builtAt: string,
  origin: CompanyRecord["origin"],
): CompanyRecord {
  const filings = recentFilings(sub);
  let financials: Standardized | null = null;
  let error: string | null = null;
  if (facts) {
    try {
      financials = standardize(facts, SNAPSHOT_YEARS, true);
    } catch (e) {
      if (!(e instanceof NoAnnualFacts)) throw e;
      error = e.message;
    }
  } else {
    error = "no XBRL company facts published for this registrant";
  }
  const reportDates: Record<string, string> = {};
  if (financials) {
    const byAccn = new Map(filings.map((f) => [f.accessionNumber, f.reportDate]));
    for (const a of Object.keys(financials.filings)) {
      const d = byAccn.get(a);
      if (d) reportDates[a] = d;
    }
  }
  const newest = latestPeriodic(filings);
  return {
    schema: SNAPSHOT_SCHEMA,
    cik,
    name: sub.name ?? facts?.entityName ?? null,
    tickers: sub.tickers ?? [],
    exchanges: (sub.exchanges ?? []).map((e) => e ?? ""),
    sic: sub.sic || null,
    sic_description: sub.sicDescription || null,
    fiscal_year_end: sub.fiscalYearEnd || null,
    foreign_private_issuer: isForeignPrivateIssuer(filings),
    latest_periodic: newest
      ? { form: newest.form, filingDate: newest.filingDate, reportDate: newest.reportDate, accessionNumber: newest.accessionNumber }
      : null,
    report_dates: reportDates,
    financials,
    financials_error: error,
    shares_outstanding: facts ? sharesOutstanding(facts) : null,
    built_at: builtAt,
    origin,
  };
}
