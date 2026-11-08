// MCP tool definitions. Tool descriptions are the product's UX inside Claude:
// they name the data (not a vendor) and use the vocabulary of finance workflows
// (10-K, LTM, EBITDA, WACC inputs) so /comps and /dcf style skills pick them up.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DISCLAIMER, PRODUCT_NAME, SELF_HOST_URL, SNAPSHOT_YEARS, VERSION } from "./config";
import { ConfigError, ToolError, UpstreamError } from "./errors";
import { countryPremium, DAMODARAN_PAGE, industryInputs, industryNames } from "./damodaran";
import type { Fx } from "./fx";
import { keyMetrics } from "./metrics";
import {
  companyBlock,
  euCompanyBlock,
  euFinancialStatements,
  euSourcesFor,
  financialStatements,
  recordWarnings,
  reportingStandard,
  slice,
  sourcesFor,
} from "./present";
import type { Rates } from "./rates";
import { LEI_RE, type CompanyRow, type EuRow, type Repo } from "./repo";
import { isFinancial } from "./sec/filings";

export interface Deps {
  repo: Repo;
  rates: Rates;
  fx: Fx;
}

export const INSTRUCTIONS = `\
${PRODUCT_NAME}: free financial data with citations, from official sources.
Today: US companies from SEC EDGAR XBRL filings (10-K, 10-Q, 20-F), large European issuers from their \
ESEF annual reports (IFRS; pass the LEI from company_lookup), computed ratios, risk-free rates (US \
Treasury, ECB euro area), ECB exchange rates, and Damodaran's valuation inputs (ERP by country, industry \
betas and costs of capital).
- Start with company_lookup to resolve a name to a ticker/CIK, then call financial_statements or key_metrics.
- For a DCF or WACC, take the risk-free rate from risk_free_rate with a tenor matching the forecast \
horizon (usually 10Y), in the currency of the cash flows; the equity risk premium and an industry \
unlevered beta from valuation_inputs; relever the beta at the company's D/E. Show every input with its source.
- Units: risk_free_rate gives rate_pct (percent) AND rate_decimal; valuation_inputs and key_metrics give \
decimals (0.05 = 5%). Use decimals everywhere before combining (e.g. CAPM = rate_decimal + beta × ERP).
- IFRS filers report in their own currency: convert with fx_rate (period average for income statement, \
period-end for balance sheet) before comparing with US companies.
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

function registerTools({ repo, rates, fx }: Deps, guarded: (run: () => Promise<ToolResult>) => Promise<ToolResult>): McpServer {
  const server = new McpServer({ name: PRODUCT_NAME, version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "company_lookup",
    {
      title: "Find a company",
      description:
        "Find a company by ticker, name, SEC CIK or LEI. Returns the canonical record: name, ticker or LEI, " +
        "region (US or EU), reporting standard (US-GAAP or IFRS), currency and fiscal year end. Covers SEC " +
        "registrants (US-listed companies, including foreign filers on 20-F) and large European issuers from their " +
        "ESEF annual reports. Example: query 'apple', 'AAPL', 'LVMH' or 'CIK0000320193'.",
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe("Ticker, company name, CIK or LEI, e.g. 'MSFT', 'caterpillar', 'TotalEnergies'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) =>
      guarded(async () => {
        const q = query.trim().toUpperCase();
        if (!q) throw new ToolError("query is empty");
        const n = limit ?? 10;
        const [rows, eu] = await Promise.all([repo.companies(), repo.euCompanies()]);
        const cikMatch = /^(?:CIK)?0*(\d{1,10})$/.exec(q);
        const byCik = cikMatch ? rows.filter((c) => c.cik === Number(cikMatch[1])) : [];
        const exact = rows.filter((c) => (c.ticker ?? "").toUpperCase() === q.replaceAll(".", "-"));
        const seen = new Set([...byCik, ...exact]);
        const byName = rows.filter((c) => !seen.has(c) && c.name.toUpperCase().includes(q));
        const us = (c: CompanyRow) => ({
          name: c.name,
          ticker: c.ticker,
          cik: c.cik,
          exchange: c.exchange,
          region: "US",
          reporting_standard: reportingStandard(c.standard),
          currency: c.currency,
          fiscal_year_end: c.fiscal_year_end,
          source: "SEC company tickers list",
        });
        const euOut = (c: EuRow) => ({
          name: c.name,
          ticker: null,
          lei: c.lei,
          country: c.country,
          region: "EU",
          reporting_standard: "IFRS",
          currency: c.currency,
          fiscal_year_end: c.fiscal_year_end,
          source: "ESEF annual reports (filings.xbrl.org)",
        });
        const euHits = LEI_RE.test(q) ? eu.filter((c) => c.lei === q) : eu.filter((c) => c.name.toUpperCase().includes(q));
        const results: Array<Record<string, unknown>> = [
          ...[...byCik, ...exact].map(us),
          ...euHits.map(euOut),
          ...byName.map(us),
        ].slice(0, n);
        if (results.length < n && !cikMatch && !LEI_RE.test(q)) {
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
            `No company matches ${JSON.stringify(query)}. Try a shorter name, the ticker, or the LEI. European ` +
              `coverage is ${eu.length} large issuers so far (no German issuers: their reports are not in the public ESEF repository).`,
          );
        }
        return ok({
          results,
          note:
            "Pass `ticker` (or `CIK##########` when ticker is null) to financial_statements; for EU issuers pass " +
            "the `lei` as `ticker`. A company listed in both regions (e.g. a 20-F filer) can differ: US filings may " +
            "use US GAAP or a different presentation than its EU IFRS report.",
        });
      }),
  );

  /** Resolve a ticker/CIK (SEC) or an LEI (EU) to the record the statement tools use. */
  async function resolveRecord(ticker: string) {
    const t = ticker.trim().toUpperCase();
    if (LEI_RE.test(t)) {
      const rec = await repo.euRecord(t);
      if (!rec.financials) {
        throw new ToolError(`${rec.name} (LEI ${rec.lei}) has ${rec.financials_error}; do not substitute figures from memory.`);
      }
      return { kind: "eu" as const, rec };
    }
    const co = await repo.resolve(ticker);
    const rec = await repo.record(co.cik);
    if (!rec.financials) {
      throw new ToolError(
        `${rec.name ?? co.name ?? `CIK ${co.cik}`} (CIK ${co.cik}) has no usable annual XBRL financials: ` +
          `${rec.financials_error}. If you know a predecessor registrant's CIK, call again with it as ` +
          "the ticker (e.g. 'CIK0000034088'); otherwise do not substitute figures from memory.",
      );
    }
    return { kind: "sec" as const, rec };
  }

  server.registerTool(
    "financial_statements",
    {
      title: "Financial statements (SEC XBRL, EU ESEF)",
      description:
        "Standardized income statement, cash flow and balance sheet from official filings: SEC EDGAR XBRL " +
        "(10-K / 10-Q, or 20-F for IFRS foreign filers) for US-listed companies, and ESEF annual reports (IFRS) " +
        "for European issuers (pass their LEI). Annual fiscal years plus, for SEC filers, an LTM (last twelve " +
        "months) column built as FY + YTD - prior YTD. Includes revenue, gross profit, operating income (EBIT), " +
        "pretax and net income, interest expense, D&A, operating cash flow, capex, diluted shares and EPS, " +
        "cash, short-term investments, total assets, equity and debt components, plus computed EBITDA, " +
        "free cash flow, total debt and net debt with formulas. SEC filers also get cover-page shares outstanding. " +
        "Every value cites its concept and filing; `sources` lists each filing with its URL.",
      inputSchema: z.object({
        ticker: z
          .string()
          .min(1)
          .max(24)
          .describe("Ticker (e.g. 'AAPL', 'BRK.B'), CIK (e.g. 'CIK0000034088'), or LEI for EU issuers (from company_lookup)"),
        years: z
          .number()
          .int()
          .min(1)
          .max(SNAPSHOT_YEARS)
          .optional()
          .describe(`Number of fiscal years, newest last (default 5, max ${SNAPSHOT_YEARS})`),
        include_ltm: z.boolean().optional().describe("Add the LTM column when an interim report follows the last annual one (default true)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, years, include_ltm }) =>
      guarded(async () => {
        const r = await resolveRecord(ticker);
        if (r.kind === "eu") return ok(euFinancialStatements(r.rec, years ?? 5, include_ltm ?? true));
        const out = financialStatements(r.rec, years ?? 5, include_ltm ?? true);
        return ok({ ...out, shares_outstanding: r.rec.shares_outstanding });
      }),
  );

  server.registerTool(
    "key_metrics",
    {
      title: "Key metrics (computed)",
      description:
        "Ratios computed from the standardized financial statements (SEC XBRL or EU ESEF), each with its formula: " +
        "revenue and net income growth, revenue CAGR, gross / operating / EBITDA / net / FCF margins, capex to " +
        "revenue, FCF conversion, ROE, ROA, ROIC, net debt to EBITDA, interest coverage. Annual fiscal years plus " +
        "LTM where available. Ratios are decimals (0.25 = 25%). Null when an input is not reported. Banks and " +
        "insurers get no EBITDA-based ratios or ROIC.",
      inputSchema: z.object({
        ticker: z.string().min(1).max(24).describe("Ticker (e.g. 'AAPL'), CIK, or LEI for EU issuers"),
        years: z.number().int().min(1).max(SNAPSHOT_YEARS - 1).optional().describe("Number of fiscal years (default 5)"),
        include_ltm: z.boolean().optional().describe("Add LTM ratios when available (default true)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, years, include_ltm }) =>
      guarded(async () => {
        const r = await resolveRecord(ticker);
        const std = r.rec.financials!;
        const n = years ?? 5;
        const ltm = include_ltm ?? true;
        const financial = r.kind === "eu" ? r.rec.financial : isFinancial(r.rec.sic);
        const { periods, revenue_cagr } = keyMetrics(std, n, ltm, financial);
        const { cited } = slice(std, n + 1, ltm);
        const company = r.kind === "eu" ? euCompanyBlock(r.rec) : companyBlock(r.rec);
        const warnings = r.kind === "eu" ? [] : recordWarnings(r.rec, cited);
        if (financial) {
          warnings.push("financial_company: EBITDA-based ratios and ROIC are not meaningful for banks and insurers (null).");
        }
        const id = r.kind === "eu" ? `LEI ${r.rec.lei}` : (company.ticker ?? `CIK ${r.rec.cik}`);
        return ok({
          summary:
            `${company.name} (${id}): ${periods.length} period(s) of ratios computed by ` +
            `${PRODUCT_NAME} from reported figures. Each shows its formula; inputs are in financial_statements.`,
          company,
          units: "Ratios are decimals (0.25 = 25%). net_debt_to_ebitda and interest_coverage are multiples (x).",
          computed: true,
          revenue_cagr,
          periods,
          warnings,
          sources: r.kind === "eu" ? euSourcesFor(r.rec, cited) : sourcesFor(r.rec, cited),
          data_as_of: r.rec.built_at,
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
          summary:
            `${r.region} ${r.tenor} government yield: ${r.rate_pct.toFixed(3)}% (decimal ${r.rate_decimal.toFixed(5)}) ` +
            `on ${r.date} (${r.source.name}).`,
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
    "fx_rate",
    {
      title: "Exchange rate (ECB reference rates)",
      description:
        "Exchange rate between two currencies from the ECB euro foreign exchange reference rates (30+ currencies, " +
        "crossed through EUR). Latest, on a date (period-end rate for balance-sheet items), or the average over a " +
        "period (for income-statement items under IFRS). Returns units of `to` per 1 unit of `from`. " +
        "Example: from 'EUR', to 'USD', average_from '2025-01-01', average_to '2025-12-31'.",
      inputSchema: z.object({
        from: z.string().length(3).describe("ISO currency code, e.g. 'EUR', 'JPY'"),
        to: z.string().length(3).describe("ISO currency code, e.g. 'USD'"),
        on: z.string().optional().describe("YYYY-MM-DD: rate on that date (last fixing on or before it)"),
        average_from: z.string().optional().describe("YYYY-MM-DD: start of an averaging period"),
        average_to: z.string().optional().describe("YYYY-MM-DD: end of an averaging period"),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, on, average_from, average_to }) =>
      guarded(async () => {
        const r = await fx.rate(from, to, { on, averageFrom: average_from, averageTo: average_to });
        return ok({
          summary: `1 ${r.from} = ${r.rate.toPrecision(6)} ${r.to} (${r.basis}).`,
          ...r,
          disclaimer: DISCLAIMER,
        });
      }),
  );

  server.registerTool(
    "valuation_inputs",
    {
      title: "Valuation inputs (Damodaran)",
      description:
        "Aswath Damodaran's public valuation data (NYU Stern), with the dataset date. " +
        "Pass `country` for its equity risk premium (ERP), country risk premium, Moody's rating and default spread. " +
        "Pass `industry` (with `region` US, Europe or Global) for industry beta, unlevered beta (cash-corrected), " +
        "D/E, effective tax rate, cost of equity, cost of debt and cost of capital. With neither, lists the industry " +
        "names and the mature-market ERP. Rates are decimals (0.05 = 5%).",
      inputSchema: z.object({
        country: z.string().max(80).optional().describe("English country name, e.g. 'United States', 'France'"),
        industry: z.string().max(80).optional().describe("Damodaran industry name or part of it, e.g. 'Software', 'Retail (General)'"),
        region: z.enum(["US", "Europe", "Global"]).optional().describe("Industry dataset region (default US)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ country, industry, region }) =>
      guarded(async () => {
        const d = await repo.damodaran();
        if (!d) {
          throw new ToolError(
            "Damodaran datasets are not loaded on this server (they ship with the snapshot). " +
              `They are published at ${DAMODARAN_PAGE}.`,
          );
        }
        const reg = region ?? "US";
        const out: Record<string, unknown> = {};
        if (country) out.country = countryPremium(d, country);
        if (industry) out.industry = industryInputs(d, reg, industry);
        if (!country && !industry) {
          out.mature_market_erp = d.mature_market_erp;
          out.us_erp = d.us_erp;
          out.industries = industryNames(d, reg);
          out.region = reg;
        }
        const dates = [...new Set(Object.values(d.datasets).map((x) => x.updated))].filter(Boolean);
        const partial = [...((out.country as Array<{ match: string }>) ?? []), ...((out.industry as Array<{ match: string }>) ?? [])].some(
          (x) => x.match === "partial",
        );
        const warnings = partial
          ? ["Partial name match: confirm the country/industry shown is the one the user means before using its figures."]
          : [];
        return ok({
          summary:
            (country ? `Country risk data for ${JSON.stringify(country)}. ` : "") +
            (industry ? `${reg} industry data for ${JSON.stringify(industry)}. ` : "") +
            (!country && !industry ? `${(out.industries as string[]).length} ${reg} industries; pass one as \`industry\`. ` : "") +
            `Damodaran datasets updated ${dates.join(", ")}.`,
          ...out,
          units: "Decimals (0.05 = 5%). Betas and D/E are plain numbers.",
          warnings,
          attribution: "Data: Aswath Damodaran, NYU Stern (pages.stern.nyu.edu/~adamodar). Cite him when you use these inputs.",
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
            europe_esef:
              "Large EU issuers (FR, NL, ES, FI, IT, BE) from their ESEF annual reports via filings.xbrl.org; annual only " +
              "(half-year reports are rarely in ESEF). No German issuers yet: their reports are not in the public repository.",
            ratios: "key_metrics: computed from the SEC statements, each with its formula",
            risk_free_rates: "US Treasury par yield curve; ECB euro area par yields (AAA or all issuers)",
            fx: "fx_rate: ECB euro reference rates, any pair crossed through EUR",
            valuation_inputs: "Damodaran: ERP and country risk premium by country; betas and cost of capital by industry (US, Europe, Global)",
            macro: "planned (ECB, Eurostat)",
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
