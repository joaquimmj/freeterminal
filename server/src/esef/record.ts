// One European issuer's precomputed record (built by scripts/build-esef.ts,
// served from static assets under /v1/eu/).

import { SNAPSHOT_SCHEMA, SNAPSHOT_YEARS } from "../config";
import { NoAnnualFacts, standardize, type Standardized } from "../sec/xbrl";
import { toCompanyFacts, type EsefFilingMeta, type ExtractedFiling } from "./extract";

export const FILINGS_XBRL_ORG = "https://filings.xbrl.org";

export interface EuIssuer {
  lei: string;
  name: string;
  country: string;
  /** Bank or insurer: EBITDA/EV-style metrics don't apply (ESEF carries no industry code). */
  financial?: boolean;
}

export interface EuFilingRef extends EsefFilingMeta {
  kind: ExtractedFiling["kind"];
  report_end: string | null;
}

export interface EuRecord {
  schema: number;
  kind: "esef";
  lei: string;
  name: string;
  country: string;
  financial: boolean;
  financials: Standardized | null;
  financials_error: string | null;
  /** fxo_id -> repository metadata, for citations. */
  filings: Record<string, EuFilingRef>;
  built_at: string;
  origin: "snapshot";
}

/** The human-readable report on filings.xbrl.org (the iXBRL viewer), else the repository's filing page. */
export function citationUrl(meta: EsefFilingMeta): string {
  const path = meta.viewer_url ?? meta.report_url;
  return path ? `${FILINGS_XBRL_ORG}${path}` : `${FILINGS_XBRL_ORG}/filing/${encodeURIComponent(meta.fxo_id)}`;
}

export function buildEuRecord(issuer: EuIssuer, filings: Array<{ meta: EsefFilingMeta; data: ExtractedFiling }>): EuRecord {
  const usable = filings.filter((f) => f.data.kind !== "unknown");
  const byId = new Map(usable.map((f) => [f.meta.fxo_id, f.meta]));
  let financials: Standardized | null = null;
  let error: string | null = null;
  try {
    financials = standardize(toCompanyFacts(issuer.name, usable), SNAPSHOT_YEARS, true, {
      source: "esef",
      filingUrl: (a) => {
        const m = byId.get(a);
        return m ? citationUrl(m) : `${FILINGS_XBRL_ORG}/`;
      },
    });
  } catch (e) {
    if (!(e instanceof NoAnnualFacts)) throw e;
    error = "no annual IFRS facts in the issuer's ESEF reports";
  }
  const refs: Record<string, EuFilingRef> = {};
  for (const f of usable) refs[f.meta.fxo_id] = { ...f.meta, kind: f.data.kind, report_end: f.data.report_end };
  return {
    schema: SNAPSHOT_SCHEMA,
    kind: "esef",
    lei: issuer.lei,
    name: issuer.name,
    country: issuer.country,
    financial: issuer.financial ?? false,
    financials,
    financials_error: error,
    filings: refs,
    built_at: "",
    origin: "snapshot",
  };
}
