# freeterminal

**Free, citable financial data for Claude. US + Europe. Paste one URL.**

A free, hosted, open-source data connector that lets Claude work like a junior analyst with official sources only: no paid terminal, no API key. Every number comes back with the filing it came from.

> Status: beta. US SEC financials, **European issuers from their ESEF reports (IFRS)**, computed ratios, risk-free rates (US + euro area), ECB exchange rates and Damodaran valuation inputs work today.

## Built on the shoulders of open-finance-mcp

The hard part, turning messy SEC XBRL into correct, cited numbers, was first solved by
[open-finance-mcp](https://github.com/nathanaelhub/open-finance-mcp) by **Nathanael Johnson** (MIT).
freeterminal ports its rules to TypeScript for a hosted Cloudflare Worker and runs parity tests on its fixtures.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install in 30 seconds

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Paste the connector URL (beta: `https://freeterminal.<account>.workers.dev/mcp`), with no sign-in.
3. Ask: *"Pull Apple's last 5 years of financials with sources."*

## Tools

| Tool | What it returns |
|---|---|
| `company_lookup` | Name, ticker, CIK or LEI → canonical record: ticker or LEI, region (US/EU), reporting standard, currency, fiscal year end |
| `financial_statements` | Standardized income statement, cash flow and balance sheet from SEC XBRL (US) or ESEF annual reports (EU, by LEI): annual years plus LTM (SEC), with computed EBITDA, FCF, total and net debt. Every value carries its concept and filing, and a `sources` list gives each filing's URL |
| `key_metrics` | Growth, CAGR, margins, FCF conversion, ROE, ROA, ROIC, net debt / EBITDA, interest coverage. Each value is computed and shows its formula |
| `risk_free_rate` | Tenor-matched government yield for a WACC: US Treasury par yield curve, ECB euro area par yields (AAA or all issuers), latest or on a date |
| `fx_rate` | ECB reference rates for 30+ currencies: latest, on a date (balance sheet) or a period average (income statement) |
| `valuation_inputs` | Damodaran: equity risk premium and country risk premium by country; beta, unlevered beta, cost of equity, debt and capital by industry (US, Europe, Global) |
| `data_status` | Coverage, data freshness, limits, self-hosting link, disclaimer |

## How it stays free

- **Cloudflare Workers Free plan.** There's a global daily cap with a friendly message and a per-IP rate limit.
- **No live parsing of large filings.** A nightly GitHub Action builds a per-company snapshot from SEC bulk data and ships it as static assets, which are free.
- **Self-host in a few minutes** with your own free account: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Data sources

SEC EDGAR (public domain), ESEF annual reports via [filings.xbrl.org](https://filings.xbrl.org) (XBRL International), U.S. Treasury, the ECB Data Portal (Source: ECB statistics), and Aswath Damodaran's public datasets (NYU Stern), with attribution. Terms, limits and attribution for every source are in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Limitations

- No share prices. Market cap = SEC shares outstanding × a price you give.
- No consensus estimates.
- Europe: about 30 large issuers so far (France, Netherlands, Spain, Finland, Italy, Belgium), annual figures only. No German issuers: their reports aren't in the public ESEF repository. Lines an issuer tags only with its own concepts come back `null`.
- IFRS 20-F filers have no LTM, because SEC has no XBRL for 6-K interims.
- Banks and insurers are flagged; EBITDA and EV metrics don't apply to them.

## Development

```bash
cd server && npm ci
npm test
npx tsx scripts/build-snapshot.ts --fixtures test/fixtures/sec   # offline dev snapshot
npm run dev
npx tsx scripts/smoke.ts                                         # call every tool on the local server
```

---

Independent open-source project. Not affiliated with or endorsed by Anthropic.
Data may be incomplete or delayed; verify against the cited filing. Not investment advice.
