// Build the SEC snapshot served as Worker static assets (snapshot/v1/...).
//
// Why: parsing a large companyfacts JSON live costs 17-35 ms of CPU, over the
// Workers Free 10 ms limit (docs/research/cloudflare_competitors.md §2.2). So
// we run the same standardizer here, nightly, and the Worker only reads small
// precomputed records.
//
// Usage (needs SEC_USER_AGENT="<app name> <contact email>"):
//   tsx scripts/build-snapshot.ts --bulk            # all ticker companies, from SEC bulk zips (CI)
//   tsx scripts/build-snapshot.ts --tickers AAPL,MSFT   # a few companies via the per-company API (dev)
// Options: --out <dir> (default ./snapshot), --work <dir> (bulk download dir, default ./.snapshot-work)

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { SNAPSHOT_SCHEMA } from "../src/config";
import { factsUrl, pad, SecClient, submissionsUrl, TICKERS_URL } from "../src/sec/edgar";
import { PERIODIC_FORMS, recentFilings, type Submissions } from "../src/sec/filings";
import { buildCompanyRecord, type CompanyRecord } from "../src/sec/record";
import type { CompanyFacts } from "../src/sec/xbrl";

const BULK_FACTS = "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip";
const BULK_SUBMISSIONS = "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip";

interface TickerFile {
  fields: string[];
  data: unknown[][];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** --fixtures <dir>: build offline from facts_<T>.json / submissions_<T>.json test fixtures. */
const FIXTURES = arg("fixtures");
const UA = process.env.SEC_USER_AGENT ?? "";
if (!FIXTURES && !UA.includes("@")) {
  console.error('Set SEC_USER_AGENT to "<app name> <contact email>" (SEC fair-access policy).');
  process.exit(2);
}

const OUT = resolve(arg("out") ?? "snapshot");
const WORK = resolve(arg("work") ?? ".snapshot-work");
const sec = new SecClient({ userAgent: UA });

async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest) && Date.now() - statSync(dest).mtimeMs < 12 * 3600_000) {
    console.log(`using cached ${dest}`);
    return;
  }
  console.log(`downloading ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/** Stream every `CIK##########.json` entry of a zip whose CIK is wanted. */
async function eachEntry(zipPath: string, want: Set<number>, onJson: (cik: number, json: unknown) => void): Promise<void> {
  const z = await yauzl.openPromise(zipPath, { lazyEntries: true });
  await new Promise<void>((done, fail) => {
    z.on("error", fail);
    z.on("end", () => done());
    z.on("entry", (entry: yauzl.Entry) => {
      const m = /^CIK(\d{10})\.json$/.exec(entry.fileName);
      if (!m || !want.has(Number(m[1]))) return z.readEntry();
      z.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(err);
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", fail);
        stream.on("end", () => {
          try {
            onJson(Number(m[1]), JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            console.warn(`skip ${entry.fileName}: ${(e as Error).message}`);
          }
          z.readEntry();
        });
      });
    });
    z.readEntry();
  });
}

/**
 * Keep only what records need from a submissions file (bulk mode holds ~10k in
 * memory): the periodic reports, which are all that staleness, FPI detection
 * (20-F/40-F vs 10-K) and citation report dates look at.
 */
function slimSubmissions(s: Submissions): Submissions {
  const recent = recentFilings(s).filter((f) => PERIODIC_FORMS.has(f.form));
  const cols: Record<string, string[]> = {
    form: [],
    filingDate: [],
    reportDate: [],
    accessionNumber: [],
    primaryDocument: [],
    primaryDocDescription: [],
  };
  for (const f of recent) for (const k of Object.keys(cols)) cols[k]!.push((f as unknown as Record<string, string>)[k]!);
  return {
    name: s.name,
    tickers: s.tickers,
    exchanges: s.exchanges,
    sic: s.sic,
    sicDescription: s.sicDescription,
    fiscalYearEnd: s.fiscalYearEnd,
    filings: { recent: cols },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

async function main(): Promise<void> {
  const tickersArg = arg("tickers");
  const bulk = process.argv.includes("--bulk");
  if (!bulk && !tickersArg && !FIXTURES) {
    console.error("pass --bulk, --tickers AAPL,MSFT or --fixtures <dir>");
    process.exit(2);
  }
  const readFix = (name: string) => JSON.parse(readFileSync(join(FIXTURES!, name), "utf8"));

  const tickers: TickerFile = FIXTURES ? readFix("company_tickers_exchange.json") : await sec.json<TickerFile>(TICKERS_URL, 0);
  const iCik = tickers.fields.indexOf("cik");
  const iTicker = tickers.fields.indexOf("ticker");
  const iName = tickers.fields.indexOf("name");
  const iExch = tickers.fields.indexOf("exchange");

  let wanted: Set<number>;
  if (FIXTURES) {
    wanted = new Set(
      tickers.data
        .filter((r) => existsSync(join(FIXTURES, `submissions_${r[iTicker]}.json`)))
        .map((r) => Number(r[iCik])),
    );
  } else if (bulk) {
    wanted = new Set(tickers.data.map((r) => Number(r[iCik])));
  } else {
    const ts = new Set(tickersArg!.split(",").map((t) => t.trim().toUpperCase().replaceAll(".", "-")));
    wanted = new Set(tickers.data.filter((r) => ts.has(String(r[iTicker]).toUpperCase())).map((r) => Number(r[iCik])));
  }
  console.log(`${wanted.size} companies`);

  rmSync(join(OUT, "v1"), { recursive: true, force: true });
  mkdirSync(join(OUT, "v1", "co"), { recursive: true });

  // Write each record as soon as it is built; keep only what the index needs (bulk = ~10k companies).
  const records = new Map<number, { taxonomy: string | null; currency: string | null; fye: string | null }>();
  const put = (cik: number, rec: CompanyRecord) => {
    writeJson(join(OUT, "v1", "co", `${pad(cik)}.json`), rec);
    records.set(cik, { taxonomy: rec.financials?.taxonomy ?? null, currency: rec.financials?.currency ?? null, fye: rec.fiscal_year_end });
  };
  let failed = 0;

  if (FIXTURES) {
    for (const r of tickers.data) {
      const cik = Number(r[iCik]);
      if (!wanted.has(cik) || records.has(cik)) continue;
      const t = String(r[iTicker]);
      const facts = existsSync(join(FIXTURES, `facts_${t}.json`)) ? readFix(`facts_${t}.json`) : null;
      put(cik, buildCompanyRecord(facts, slimSubmissions(readFix(`submissions_${t}.json`)), cik, "", "snapshot"));
    }
  } else if (bulk) {
    mkdirSync(WORK, { recursive: true });
    const subsZip = join(WORK, "submissions.zip");
    const factsZip = join(WORK, "companyfacts.zip");
    await download(BULK_SUBMISSIONS, subsZip);
    await download(BULK_FACTS, factsZip);
    const subs = new Map<number, Submissions>();
    await eachEntry(subsZip, wanted, (cik, json) => subs.set(cik, slimSubmissions(json as Submissions)));
    console.log(`${subs.size} submissions`);
    const seen = new Set<number>();
    await eachEntry(factsZip, wanted, (cik, json) => {
      seen.add(cik);
      const sub = subs.get(cik);
      if (!sub) return;
      try {
        put(cik, buildCompanyRecord(json as CompanyFacts, sub, cik, "", "snapshot"));
      } catch (e) {
        failed++;
        console.warn(`CIK ${cik}: ${(e as Error).message}`);
      }
    });
    // Registrants with submissions but no XBRL facts still get a record (with the reason).
    for (const [cik, sub] of subs) if (!seen.has(cik)) put(cik, buildCompanyRecord(null, sub, cik, "", "snapshot"));
  } else {
    for (const cik of wanted) {
      try {
        const sub = await sec.json<Submissions>(submissionsUrl(cik), 0);
        const facts = await sec.json<CompanyFacts>(factsUrl(cik), 0).catch(() => null);
        put(cik, buildCompanyRecord(facts, slimSubmissions(sub), cik, "", "snapshot"));
        console.log(`CIK ${cik} ok`);
      } catch (e) {
        failed++;
        console.warn(`CIK ${cik}: ${(e as Error).message}`);
      }
    }
  }

  // Company index: SEC's ticker list, enriched with standard/currency/FYE where we have a record.
  const fields = ["cik", "ticker", "name", "exchange", "standard", "currency", "fiscal_year_end"];
  const data = tickers.data.map((r) => {
    const rec = records.get(Number(r[iCik]));
    return [
      Number(r[iCik]),
      r[iTicker] ?? null,
      r[iName] ?? "",
      r[iExch] ?? null,
      rec?.taxonomy ?? null,
      rec?.currency ?? null,
      rec?.fye ?? null,
    ];
  });
  writeJson(join(OUT, "v1", "companies.json"), { fields, data });
  const builtAt = new Date().toISOString();
  writeJson(join(OUT, "v1", "manifest.json"), {
    schema: SNAPSHOT_SCHEMA,
    built_at: builtAt,
    companies: data.length,
    records: records.size,
    source: FIXTURES
      ? "test fixtures (offline dev build)"
      : bulk
        ? "SEC EDGAR bulk companyfacts.zip + submissions.zip"
        : "SEC EDGAR per-company API (partial)",
  });
  console.log(`wrote ${records.size} records (${failed} failed) to ${OUT}/v1 at ${builtAt}`);
  if (records.size === 0) process.exit(1);
  // A bulk build that loses most companies is broken: fail the job instead of deploying it.
  if (bulk && failed > records.size * 0.05) process.exit(1);
}

await main();
