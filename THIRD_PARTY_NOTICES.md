# Third-party notices

freeterminal is MIT-licensed (see `LICENSE`). It includes work adapted from the projects below, under their own licenses.

## open-finance-mcp

- Source: https://github.com/nathanaelhub/open-finance-mcp, commit `8bcf3af022ba4dc28150172900bd8350a4ff6731` (fetched 2026-11-08)
- License: MIT. Copyright (c) 2026 Nathanael Johnson. Full text: [`third_party/open-finance-mcp/LICENSE`](third_party/open-finance-mcp/LICENSE)
- What we adapted (ported from Python to TypeScript), each file marked with a header:
  - `server/src/sec/xbrl.ts`: concept maps (US-GAAP and IFRS), per-period concept resolution, restatement handling, fiscal-year labels, LTM, total debt, derived metrics, shares outstanding (from `xbrl.py`)
  - `server/src/sec/filings.ts`: staleness warning, foreign private issuer detection, financial-company flag (from `server.py`)
  - `server/src/repo.ts`: ticker/CIK resolution and EDGAR entity search (from `server.py`)
  - `server/test/xbrl.test.ts`, `server/test/server.test.ts`: tests and expected values (from `tests/test_xbrl.py`, `tests/test_server.py`)
- Changes from the original: LTM diluted EPS is computed as FY + YTD − prior YTD (trailing), not the year-to-date figure; tool names, output shape and error messages differ; the Yahoo Finance price path is not ported.
- Test fixtures in `server/test/fixtures/sec/` were selected and trimmed by open-finance-mcp. Their content is SEC EDGAR data (a U.S. government work, public domain). Its Yahoo chart fixtures are not included.
