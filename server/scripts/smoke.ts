// Smoke test a running server: tsx scripts/smoke.ts [url]  (default http://127.0.0.1:8787/mcp)
// Connects as both a modern (2026-07-28) and a legacy (2025) client, lists tools,
// and calls each tool once.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");

for (const mode of ["auto", "legacy"] as const) {
  const client = new Client({ name: "smoke", version: "1" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(url));
  const { tools } = await client.listTools();
  console.log(`[${mode}] tools: ${tools.map((t) => t.name).join(", ")}`);
  for (const [name, args] of [
    ["company_lookup", { query: "apple" }],
    ["financial_statements", { ticker: "AAPL", years: 2 }],
    ["key_metrics", { ticker: "AAPL", years: 3 }],
    ["risk_free_rate", { region: "US", tenor: "10Y" }],
    ["risk_free_rate", { region: "EUR", tenor: "10Y" }],
    ["fx_rate", { from: "EUR", to: "USD" }],
    ["fx_rate", { from: "JPY", to: "USD", average_from: "2025-04-01", average_to: "2026-03-31" }],
    ["valuation_inputs", { country: "UK", industry: "REIT", region: "US" }],
    ["fx_rate", { from: "EUR", to: "USD", average_from: "1999-01-04", average_to: "2026-11-06" }],
    ["company_lookup", { query: "TotalEnergies" }],
    ["financial_statements", { ticker: "529900S21EQ1BO4ESM68", years: 3 }],
    ["key_metrics", { ticker: "724500Y6DUVHQD6OXN27", years: 2 }],
    ["data_status", {}],
  ] as const) {
    const t0 = Date.now();
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    const preview = r.isError ? text : (JSON.parse(text).summary ?? text.slice(0, 160));
    console.log(`[${mode}] ${name} ${r.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms ${text.length}B: ${preview}`);
  }
  await client.close();
}
