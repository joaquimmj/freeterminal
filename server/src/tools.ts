// MCP tool definitions. Tool descriptions are the product's UX inside Claude:
// they name the data (not a vendor) and use the vocabulary of finance workflows
// (10-K, LTM, EBITDA, WACC inputs) so /comps and /dcf style skills pick them up.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DISCLAIMER, PRODUCT_NAME, SELF_HOST_URL, SNAPSHOT_YEARS, VERSION } from "./config";
import { ConfigError, ToolError, UpstreamError } from "./errors";
import { keyMetrics } from "./metrics";
import { companyBlock, financialStatements, reportingStandard, slice, sourcesFor } from "./present";
import type { Rates } from "./rates";
import type { Repo } from "./repo";
import { isFinancial } from "./sec/filings";

export interface Deps {
  repo: Repo;
  rates: Rates;
}

export const INSTRUCTIONS = `\
${PRODUCT_NAME}: free financial data with citations, from official sources.
Today: US companies from SEC EDGAR XBRL filings (10-K, 10-Q, 20-F), computed ratios, and risk-free \
rates (US Treasury, ECB euro area). Europe (ESEF/IFRS) and valuation inputs are coming.
- Start with company_lookup to resolve a name to a ticker/CIK, then call financial_statements or key_metrics.
- For a DCF or WACC, take the risk-free rate from risk_free_rate with a tenor matching the forecast \
horizon (usually 10Y), in the currency of the cash flows.
- Every number carries its XBRL concept and filing accession; each response has a \`sources\` array. \
Cite the filing when you use a number, and never fill a missing (null) value from memory: say it is \
not reported, or ask the user.
- EBITDA, free cash flow, total debt and net debt are computed and show their formula.
- Banks and insurers are flagged \`financial_company\`: EBITDA/EV multiples and a standard FCF DCF \
don't apply.
- This server has no share prices. For market cap, use shares outstanding from financial_statements \
with a price the user gives or one you find and cite.
${DISCLAIMER}`;

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function buildServer(deps: Deps, refuse?: string): McpServer {
  /** Turn anticipated failures into messages that tell the model what to do next. */
  const guarded = (run: () => Promise<ToolResult>) => (refuse ? Promise.resolve(fail(refuse)) : guardedRun(run));
  return registerTools(deps, guarded);
}

async function guardedRun(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message);
    if (e instanceof ConfigError) return fail(`Server configuration error: ${e.message}`);
    if (e instanceof UpstreamError) return fail(`Upstream data source failed: ${e.message}`);
    console.error("tool error", e);
    return fail(`Unexpected error: ${(e as Error).message}. This is a bug in ${PRODUCT_NAME}; please report it.`);
  }
}

function registerTools({ repo, rates }: Deps, guarded: (run: () => Promise<ToolResult>) => Promise<ToolResult>): McpServer {
  const server = new McpServer({ name: PRODUCT_NAME, version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "company_lookup",
    {
      title: "Find a company",
      description:
        "Find a company by ticker, name or SEC CIK. Returns the canonical record: name, ticker, CIK, " +
        "exchange, region, reporting standard (US-GAAP or IFRS), currency and fiscal year end. " +
        "Covers SEC registrants (US-listed companies, including foreign filers on 20-F). " +
        "Example: query 'apple' or 'AAPL' or 'CIK0000320193'.",
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe("Ticker, company name or CIK, e.g. 'MSFT', 'caterpillar', 'CIK0000034088'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) =>
      guarded(async () => {
        const q = query.trim().toUpperCase();
        if (!q) throw new ToolError("query is empty");
        const n = limit ?? 10;
        const rows = await repo.companies();
        const cikMatch = /^(?:CIK)?0*(\d{1,10})$/.exec(q);
        const byCik = cikMatch ? rows.filter((c) => c.cik === Number(cikMatch[1])) : [];
        const exact = rows.filter((c) => (c.ticker ?? "").toUpperCase() === q.replaceAll(".", "-"));
        const seen = new Set([...byCik, ...exact]);
        const byName = rows.filter((c) => !seen.has(c) && c.name.toUpperCase().includes(q));
        const results: Array<Record<string, unknown>> = [...byCik, ...exact, ...byName].slice(0, n).map((c) => ({
          name: c.name,
          ticker: c.ticker,
          cik: c.cik,
          exchange: c.exchange,
          region: "US",
          reporting_standard: reportingStandard(c.standard),
          currency: c.currency,
          fiscal_year_end: c.fiscal_year_end,
          source: "SEC company tickers list",
        }));
        if (results.length < n && !cikMatch) {
          // EDGAR's company index also has registrants with no current ticker
          // (a predecessor company, a financing subsidiary). Best effort.
          const have = new Set(results.map((r) => r.cik));
          const hits = await repo.entitySearch(query.trim()).catch(() => []);
          for (const h of hits) {
            if (have.has(h.cik) || results.length >= n) continue;
            have.add(h.cik);
            results.push({
              name: h.name,
              ticker: h.ticker,
              cik: h.cik,
              exchange: null,
              region: "US",
              reporting_standard: null,
              currency: null,
              fiscal_year_end: null,
              source: "EDGAR company search",
            });
          }
        }
        if (!results.length) {
          throw new ToolError(
            `No SEC registrant matches ${JSON.stringify(query)}. Try a shorter name or the ticker. ` +
              "European issuers without a US listing are not covered yet.",
          );
        }
        return ok({
          results,
          note: "Pass `ticker` (or `CIK##########` when ticker is null) to financial_statements.",
        });
      }),
  );

  server.registerTool(
    "financial_statements",
    {
      title: "Financial statements (SEC XBRL)",
      description:
        "Standardized income statement, cash flow and balance sheet from SEC EDGAR XBRL filings " +
        "(10-K / 10-Q, or 20-F for IFRS foreign filers): annual fiscal years plus an LTM (last twelve months) " +
        "column built as FY + YTD - prior YTD. Includes revenue, gross profit, operating income (EBIT), " +
        "pretax and net income, interest expense, D&A, operating cash flow, capex, diluted shares and EPS, " +
        "cash, short-term investments, total assets, equity and debt components, plus computed EBITDA, " +
        "free cash flow, total debt and net debt with formulas. Also returns shares outstanding from the cover page. " +
        "Every value cites its XBRL concept and filing accession; `sources` lists each filing with its URL.",
      inputSchema: z.object({
        ticker: z.string().min(1).max(20).describe("Ticker (e.g. 'AAPL', 'BRK.B') or CIK (e.g. 'CIK0000034088')"),
        years: z
          .number()
          .int()
          .min(1)
          .max(SNAPSHOT_YEARS)
          .optional()
          .describe(`Number of fiscal years, newest last (default 5, max ${SNAPSHOT_YEARS})`),
        include_ltm: z.boolean().optional().describe("Add the LTM column when a 10-Q follows the last 10-K (default true)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, years, include_ltm }) =>
      guarded(async () => {
        const co = await repo.resolve(ticker);
        const rec = await repo.record(co.cik);
        if (!rec.financials) {
          throw new ToolError(
            `${rec.name ?? co.name ?? `CIK ${co.cik}`} (CIK ${co.cik}) has no usable annual XBRL financials: ` +
              `${rec.financials_error}. If you know a predecessor registrant's CIK, call again with it as ` +
              "the ticker (e.g. 'CIK0000034088'); otherwise do not substitute figures from memory.",
          );
        }
        const out = financialStatements(rec, years ?? 5, include_ltm ?? true);
        return ok({ ...out, shares_outstanding: rec.shares_outstanding });
      }),
  );

  server.registerTool(
    "key_metrics",
    {
      title: "Key metrics (computed)",
      description:
        "Ratios computed from SEC XBRL financial statements, each with its formula: revenue and net income growth, " +
        "revenue CAGR, gross / operating / EBITDA / net / FCF margins, capex to revenue, FCF conversion, ROE, ROA, " +
        "ROIC, net debt to EBITDA, interest coverage. Annual fiscal years plus LTM. Ratios are decimals " +
        "(0.25 = 25%). Null when an input is not reported. Banks and insurers get no EBITDA-based ratios or ROIC.",
      inputSchema: z.object({
        ticker: z.string().min(1).max(20).describe("Ticker (e.g. 'AAPL') or CIK (e.g. 'CIK0000320193')"),
        years: z.number().int().min(1).max(SNAPSHOT_YEARS - 1).optional().describe("Number of fiscal years (default 5)"),
        include_ltm: z.boolean().optional().describe("Add LTM ratios when a 10-Q follows the last 10-K (default true)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, years, include_ltm }) =>
      guarded(async () => {
        const co = await repo.resolve(ticker);
        const rec = await repo.record(co.cik);
        if (!rec.financials) {
          throw new ToolError(
            `${rec.name ?? co.name ?? `CIK ${co.cik}`} has no usable annual XBRL financials (${rec.financials_error}), ` +
              "so no ratios can be computed. Do not estimate them from memory.",
          );
        }
        const n = years ?? 5;
        const ltm = include_ltm ?? true;
        const financial = isFinancial(rec.sic);
        const { periods, revenue_cagr } = keyMetrics(rec.financials, n, ltm, financial);
        const { cited } = slice(rec.financials, n + 1, ltm);
        const company = companyBlock(rec);
        return ok({
          summary:
            `${company.name} (${company.ticker ?? `CIK ${rec.cik}`}): ${periods.length} period(s) of ratios computed by ` +
            `${PRODUCT_NAME} from reported figures. Each shows its formula; inputs are in financial_statements.`,
          company,
          units: "Ratios are decimals (0.25 = 25%). net_debt_to_ebitda and interest_coverage are multiples (x).",
          computed: true,
          revenue_cagr,
          periods,
          warnings: financial
            ? ["financial_company: EBITDA-based ratios and ROIC are not meaningful for banks and insurers (null)."]
            : [],
          sources: sourcesFor(rec, cited),
          data_as_of: rec.built_at,
          disclaimer: DISCLAIMER,
        });
      }),
  );

  server.registerTool(
    "risk_free_rate",
    {
      title: "Risk-free rate (government yield)",
      description:
        "Tenor-matched government bond yield for a DCF / WACC risk-free rate, date-stamped and cited. " +
        "US: U.S. Treasury daily par yield curve (1M-30Y). Euro area: ECB yield curve par yields (3M, 6M, 1Y-30Y), " +
        "AAA-rated sovereigns by default or all euro area sovereigns. Latest by default, or on a given date " +
        "(last business day on or before it). Example: region 'US', tenor '10Y'.",
      inputSchema: z.object({
        region: z.enum(["US", "EUR"]).describe("'US' (USD cash flows) or 'EUR' (euro cash flows)"),
        tenor: z.string().min(2).max(10).optional().describe("Maturity, e.g. '10Y' (default), '5Y', '3M'"),
        date: z.string().optional().describe("YYYY-MM-DD; omit for the latest"),
        eur_curve: z.enum(["aaa", "all"]).optional().describe("Euro area only: 'aaa' (default) or 'all' issuers"),
      }),
      annotations: READ_ONLY,
    },
    async ({ region, tenor, date, eur_curve }) =>
      guarded(async () => {
        const r = region === "US" ? await rates.us(tenor ?? "10Y", date) : await rates.eur(tenor ?? "10Y", date, eur_curve ?? "aaa");
        return ok({
          summary: `${r.region} ${r.tenor} government yield: ${r.rate_pct.toFixed(3)}% on ${r.date} (${r.source.name}).`,
          ...r,
          sources: [r.source],
          note:
            "Percent per year. In a WACC, use the yield in the currency of the cash flows, with a tenor matching " +
            "the forecast horizon. Cite the source and date.",
          disclaimer: DISCLAIMER,
        });
      }),
  );

  server.registerTool(
    "data_status",
    {
      title: "Data coverage and status",
      description:
        `What ${PRODUCT_NAME} covers, how fresh the data is, usage limits, how to self-host, and the disclaimer. ` +
        "Call it when the user asks what data is available or when a tool says capacity is reached.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      guarded(async () => {
        const m = await repo.manifest();
        return ok({
          name: PRODUCT_NAME,
          version: VERSION,
          coverage: {
            us_sec: "SEC registrants with XBRL financials (10-K/10-Q; 20-F IFRS filers without LTM).",
            europe_esef: "planned",
            ratios: "key_metrics: computed from the SEC statements, each with its formula",
            risk_free_rates: "US Treasury par yield curve; ECB euro area par yields (AAA or all issuers)",
            fx_macro: "planned (ECB, Eurostat)",
            prices: "not provided: use a price the user gives or one you find and cite",
          },
          snapshot: m
            ? { built_at: m.built_at, companies: m.companies, records: m.records, source: m.source }
            : { built_at: null, note: "no snapshot deployed; every request is fetched live from SEC" },
          limits:
            "Free shared service with a daily capacity and a per-IP rate limit. Heavy users can deploy their own copy.",
          self_host: SELF_HOST_URL,
          disclaimer: DISCLAIMER,
        });
      }),
  );

  return server;
}
