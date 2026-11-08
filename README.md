# freeterminal

**Free, citable financial data for Claude. US + Europe. Paste one URL.**

A free, hosted, open-source data connector that lets Claude work like a junior analyst with official sources only: no paid terminal, no API key. Every number comes back with the filing it came from.

> Status: beta. US SEC financials, computed ratios and risk-free rates (US + euro area) work today. Europe (ESEF/IFRS) and valuation inputs are next.

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
| `company_lookup` | Name, ticker or CIK → canonical record: ticker, CIK, exchange, reporting standard, currency, fiscal year end |
| `financial_statements` | Standardized income statement, cash flow and balance sheet: annual years plus LTM, with computed EBITDA, FCF, total and net debt. Every value carries its XBRL concept and accession, and a `sources` list gives each filing's URL |
| `key_metrics` | Growth, CAGR, margins, FCF conversion, ROE, ROA, ROIC, net debt / EBITDA, interest coverage. Each value is computed and shows its formula |
| `risk_free_rate` | Tenor-matched government yield for a WACC: US Treasury par yield curve, ECB euro area par yields (AAA or all issuers), latest or on a date |
| `data_status` | Coverage, data freshness, limits, self-hosting link, disclaimer |

## How it stays free

- **Cloudflare Workers Free plan.** There's a global daily cap with a friendly message and a per-IP rate limit.
- **No live parsing of large filings.** A nightly GitHub Action builds a per-company snapshot from SEC bulk data and ships it as static assets, which are free.
- **Self-host in a few minutes** with your own free account: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Data sources

SEC EDGAR (public domain), U.S. Treasury, and the ECB Data Portal (Source: ECB statistics). Terms, limits and attribution for every source are in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Limitations

- No share prices. Market cap = SEC shares outstanding × a price you give.
- No consensus estimates.
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
