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
