// Data access for the tools: snapshot (static assets) first, live SEC as the fallback.
//
// Portions adapted from open-finance-mcp (c) 2026 Nathanael Johnson, MIT License
// (ticker/CIK resolution and EDGAR entity search, src/open_finance_mcp/server.py @ 8bcf3af0).
// See THIRD_PARTY_NOTICES.md.

import { SNAPSHOT_PREFIX } from "./config";
import { ToolError, UpstreamError } from "./errors";
import { entitySearchUrl, factsUrl, pad, SecClient, submissionsUrl, TICKERS_URL } from "./sec/edgar";
import type { Submissions } from "./sec/filings";
import { buildCompanyRecord, type CompanyRecord } from "./sec/record";
import type { CompanyFacts } from "./sec/xbrl";
import type { DamodaranData } from "./damodaran";

/** One row of the company index. */
export interface CompanyRow {
  cik: number;
  ticker: string | null;
  name: string;
  exchange: string | null;
  /** From the snapshot build; null when unknown (live ticker list). */
  standard: string | null;
  currency: string | null;
  fiscal_year_end: string | null;
}

export interface Manifest {
  schema: number;
  built_at: string;
  companies: number;
  records: number;
  source: string;
}

/** Index file format: compact rows, fields named once. */
export interface CompanyIndexFile {
  fields: string[];
  data: unknown[][];
}

export interface AssetsLike {
  fetch(input: Request | string): Promise<Response>;
}

const TTL_TICKERS = 7 * 86_400;
const TTL_FACTS = 86_400;
const TTL_SUBMISSIONS = 6 * 3600;

// Parsed snapshot data lives for the isolate's lifetime (snapshot changes only on deploy).
let indexMemo: { key: AssetsLike | null; rows: Promise<CompanyRow[]> } | null = null;
let manifestMemo: { key: AssetsLike | null; value: Promise<Manifest | null> } | null = null;
let damodaranMemo: { key: AssetsLike | null; value: Promise<DamodaranData | null> } | null = null;

export function resetMemos(): void {
  indexMemo = null;
  manifestMemo = null;
  damodaranMemo = null;
}

export class Repo {
  constructor(
    private readonly sec: SecClient,
    private readonly assets: AssetsLike | null,
  ) {}

  private async asset<T>(path: string): Promise<T | null> {
    if (!this.assets) return null;
    const res = await this.assets.fetch(new Request(`https://assets.invalid${SNAPSHOT_PREFIX}${path}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new UpstreamError(`snapshot asset ${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  manifest(): Promise<Manifest | null> {
    if (!manifestMemo || manifestMemo.key !== this.assets) {
      manifestMemo = { key: this.assets, value: this.asset<Manifest>("/manifest.json").catch(() => null) };
    }
    return manifestMemo.value;
  }

  /** Damodaran's valuation datasets (built into the snapshot), or null when not deployed. */
  damodaran(): Promise<DamodaranData | null> {
    if (!damodaranMemo || damodaranMemo.key !== this.assets) {
      damodaranMemo = { key: this.assets, value: this.asset<DamodaranData>("/damodaran.json").catch(() => null) };
    }
    return damodaranMemo.value;
  }

  /** Every SEC registrant with a ticker (snapshot index, else SEC's live ticker list). */
  companies(): Promise<CompanyRow[]> {
    if (!indexMemo || indexMemo.key !== this.assets) {
      const rows = this.loadIndex();
      indexMemo = { key: this.assets, rows };
      rows.catch(() => {
        indexMemo = null; // don't cache a failure
      });
    }
    return indexMemo.rows;
  }

  private async loadIndex(): Promise<CompanyRow[]> {
    const snap = await this.asset<CompanyIndexFile>("/companies.json");
    const file = snap ?? (await this.sec.json<CompanyIndexFile>(TICKERS_URL, TTL_TICKERS));
    const f = file.fields;
    const at = (name: string) => f.indexOf(name);
    const [iCik, iTicker, iName, iExch, iStd, iCur, iFye] = [
      at("cik"),
      at("ticker"),
      at("name"),
      at("exchange"),
      at("standard"),
      at("currency"),
      at("fiscal_year_end"),
    ];
    const get = (row: unknown[], i: number) => (i >= 0 ? ((row[i] as string | null) ?? null) : null);
    return file.data.map((row) => ({
      cik: Number(row[iCik]),
      ticker: get(row, iTicker),
      name: String(row[iName] ?? ""),
      exchange: get(row, iExch),
      standard: get(row, iStd),
      currency: get(row, iCur),
      fiscal_year_end: get(row, iFye),
    }));
  }

  /**
   * A ticker, or a CIK ("CIK0000034088" or "34088") for registrants without one.
   * SEC's ticker list only covers current tickers, so a predecessor company
   * (Exxon Mobil Corp after its ticker moved to a new holding company) is
   * reachable only by CIK.
   */
  async resolve(query: string): Promise<{ cik: number; ticker: string | null; name: string | null }> {
    const raw = query.trim().toUpperCase();
    const m = /^(?:CIK)?0*(\d{1,10})$/.exec(raw);
    if (m) {
      const cik = Number(m[1]);
      const row = (await this.companies()).find((c) => c.cik === cik);
      return { cik, ticker: row?.ticker ?? null, name: row?.name ?? null };
    }
    const want = raw.replaceAll(".", "-");
    const hit = (await this.companies()).find((c) => (c.ticker ?? "").toUpperCase() === want);
    if (hit) return { cik: hit.cik, ticker: hit.ticker, name: hit.name };
    throw new ToolError(
      `Unknown ticker ${JSON.stringify(query)}. Use company_lookup to search by name, ` +
        "or pass a CIK such as 'CIK0000320193'.",
    );
  }

  /** EDGAR entities matching `query`, including ones with no current ticker. Best effort. */
  async entitySearch(query: string): Promise<Array<{ cik: number; name: string; ticker: string | null }>> {
    interface Hit {
      _id: string;
      _source?: { entity?: string; tickers?: string };
    }
    const payload = await this.sec.json<{ hits?: { hits?: Hit[] } }>(entitySearchUrl(query), TTL_TICKERS);
    return (payload.hits?.hits ?? []).map((h) => {
      const tickers = String(h._source?.tickers ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      // "ExxonMobil Holdings Corp (XOM)" -> "ExxonMobil Holdings Corp"
      const name = String(h._source?.entity ?? "").replace(/\s*\([A-Z0-9., -]+\)$/, "");
      return { cik: Number(h._id), name, ticker: tickers[0] ?? null };
    });
  }

  /** The company's record: from the snapshot, else built live from SEC (slower, costs CPU). */
  async record(cik: number): Promise<CompanyRecord> {
    const snap = await this.asset<CompanyRecord>(`/co/${pad(cik)}.json`);
    if (snap) {
      if (!snap.built_at) snap.built_at = (await this.manifest())?.built_at ?? "";
      return snap;
    }
    const sub = await this.sec.json<Submissions>(submissionsUrl(cik), TTL_SUBMISSIONS).catch((e) => {
      if (e instanceof UpstreamError && e.status === 404) {
        throw new ToolError(`No SEC registrant with CIK ${cik}. Use company_lookup to find the right one.`);
      }
      throw e;
    });
    const facts = await this.sec.json<CompanyFacts>(factsUrl(cik), TTL_FACTS).catch((e) => {
      if (e instanceof UpstreamError && e.status === 404) return null; // registrant with no XBRL facts
      throw e;
    });
    return buildCompanyRecord(facts, sub, cik, new Date().toISOString(), "live");
  }
}
