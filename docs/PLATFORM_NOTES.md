# M0 platform verification

Research date: 2026-11-08. Sources are current official docs (support.claude.com, claude.com/docs, code.claude.com, modelcontextprotocol.io, developers.cloudflare.com, npm, GitHub). Quotes are kept short. Anything not confirmed in an official source is marked **UNVERIFIED**.

Note: Anthropic's developer docs for connectors and plugins now live under `claude.com/docs/...`. The Help Center article `11503834` on building custom connectors returns 404 (support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers, read 2026-11-08).

---

## 1. Custom connectors in the Claude app

**Availability and plan limits**
- Custom remote-MCP connectors work in Claude (web), Cowork and Claude Desktop on Free, Pro, Max, Ultra, Team and Enterprise. (https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp, read 2026-11-08)
- **Free plan: limited to one custom connector.** The docs say "On the Free plan, you can add one custom connector." (https://claude.com/docs/connectors/custom/add-unlisted.md, read 2026-11-08; same statement in https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities, read 2026-11-08)
- No other numeric per-plan connector limit is documented. (same sources, read 2026-11-08)

**How a user adds one**
- Free / Pro / Max / Ultra: go to **Customize > Connectors**, click **Add custom connector**, enter the server URL, optionally set auth, then **Add**. (https://claude.com/docs/connectors/custom/add-unlisted.md, read 2026-11-08)
- Team / Enterprise: an Owner (or an Enterprise custom role that manages libraries) adds it under **Organization settings > Connectors > Add > Custom > Web**. Members then click **Connect** under Customize > Connectors. Members cannot add custom connectors themselves. (same, read 2026-11-08)
- Connectors are toggled per conversation with **+ > Connectors**. Auth settings can't be edited later; you remove the connector and add it again. (same, read 2026-11-08)

**Authless servers**
- Authless is supported. The docs list "`none` | No authentication (authless server) | Supported by default". (https://claude.com/docs/connectors/building/authentication.md, read 2026-11-08)
- The add dialog has an Authentication choice of **Sign in now**, **Sign in when needed**, or **No sign-in**. (https://claude.com/docs/connectors/custom/add-unlisted.md, read 2026-11-08)
- "Lazy authentication" lets public tools run before sign-in and asks for OAuth only when a protected tool is called. (https://claude.com/docs/connectors/building/lazy-authentication.md listed in https://claude.com/docs/llms.txt, read 2026-11-08; page itself not read)

**Transports**
- Use Streamable HTTP. Claude also supports legacy HTTP+SSE, "which is being deprecated". (https://claude.com/docs/connectors/building/index.md, read 2026-11-08)
- A URL ending in `/sse` selects SSE. **Advanced > Transport** should be changed only if the server's docs say so. (https://claude.com/docs/connectors/custom/add-unlisted.md, read 2026-11-08)

**Custom request headers / API keys (for an optional user-supplied price-data key)**
- A **Request headers** section exists, but it is "in beta and available to a limited set of organizations". (https://claude.com/docs/connectors/custom/add-unlisted.md, read 2026-11-08)
- Header rules (same source, read 2026-11-08):
  - At most 4 headers.
  - `authorization`, `x-api-key` and `x-auth-token` are pre-approved.
  - Any other header name needs Anthropic approval, otherwise the save is rejected.
  - The value is sent verbatim, with no `Bearer ` prefix added for you.
  - Each header can be marked Required or optional; an optional header with no value is omitted.
- Authentication docs say the `static_headers` type is the organization's credential, "not a person's". It is entered by an Owner on Team/Enterprise, and the docs say "Never accept it in the URL" (no `?apiKey=`). (https://claude.com/docs/connectors/building/authentication.md, read 2026-11-08)
- **UNVERIFIED:** whether a Free/Pro individual user has the Request headers section today. The beta gate is per organization, and individual accounts were not confirmed either way.

**Mobile**
- Connectors added on web or desktop show up on iOS/Android "the next time you log in". (https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities, read 2026-11-08)
- Installing connectors on mobile "is currently in beta". Desktop and web "remain the primary path for custom connectors". (same, read 2026-11-08)
- The same connector infrastructure backs claude.ai, Desktop, mobile, Cowork and Claude Code. (https://claude.com/docs/connectors/building/index.md, read 2026-11-08)

**Server requirements**
- Connections come from Anthropic's cloud, not the user's device, on every client including mobile. The server must be reachable on the public internet. (https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp, read 2026-11-08)
- Outbound traffic comes from `160.79.104.0/21`; this matters only if we put a firewall or WAF in front. (https://claude.com/docs/connectors/building/authentication.md, read 2026-11-08)
- The OAuth callback is `https://claude.ai/api/mcp/auth_callback`, plus a port-agnostic loopback for Claude Code. None of this applies if we stay authless. (same, read 2026-11-08)
- Limits on claude.ai and Desktop: tool results up to about 150,000 characters, and a 240 s timeout per tool call. Claude Code allows 25,000 tokens by default, configurable with `MAX_MCP_OUTPUT_TOKENS`. (https://claude.com/docs/connectors/building/index.md, read 2026-11-08)
- Supported: tools, prompts, resources, and text/image results. Not supported: resource subscriptions, sampling, "advanced or draft capabilities". (same, read 2026-11-08)
- CORS: no CORS requirement is documented for Claude. Calls are server-to-server from Anthropic's cloud, so CORS matters only for browser tools such as MCP Inspector. **UNVERIFIED** that Claude ignores CORS headers entirely.
- Claude's OAuth client follows the 2025-03-26, 2025-06-18 and 2025-11-25 authorization specs. The 2026-07-28 revision is not named. (same, read 2026-11-08)

## 2. Plugins and marketplaces

**Format**
- The manifest is optional and lives at `.claude-plugin/plugin.json`. `name` (kebab-case) is the only required field. (https://code.claude.com/docs/en/plugins-reference, read 2026-11-08)
- Default layout: `skills/<name>/SKILL.md`, `commands/*.md` ("Prefer `skills/` for new plugins"), `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, plus `.lsp.json`, `output-styles/`, `bin/` and others. (same, read 2026-11-08)
- Reserved names: plugin names starting with `claude-` or `anthropic-` are a validation error. (same, read 2026-11-08)
- `userConfig` declares prompted values, including `sensitive` ones stored in the keychain. They are referenced as `${user_config.KEY}` in MCP `url`/`headers`. (same, read 2026-11-08)
- A marketplace is `.claude-plugin/marketplace.json` with required `name`, `owner` and `plugins[]`. Each entry needs `name` and `source`. Sources can be a relative path, `github`, `git-subdir`, `url`, `archive`, `npm` or `command`. (https://code.claude.com/docs/en/plugin-marketplaces, read 2026-11-08)
- Official marketplace names such as `claude-plugins-official` are refused. (same, read 2026-11-08)
- Versions: if you set `version`, users stay pinned until you bump it. If you omit it, users track commits. (https://code.claude.com/docs/en/plugins/host-marketplace.md, read 2026-11-08)

**Plan availability: major constraint for students**
- Plugins are on paid plans only: Pro, Max, Ultra, Team and Enterprise. (https://support.claude.com/en/articles/13837440-use-plugins-in-cowork, read 2026-11-08)
- Skills, by contrast, work on Free and above, and Free users can upload their own skill as a ZIP under Customize > Skills. Skills need code execution enabled. (https://support.claude.com/en/articles/12512180-use-skills-in-claude, read 2026-11-08)
- **UNVERIFIED:** whether Cowork is usable on Free. A secondary FAQ says it is not; no official source was found.

**Adding a marketplace from GitHub: app vs Claude Code**
- In the app (claude.ai or Desktop): **Customize > Plugins > Add > Add marketplace**, then enter `https://github.com/owner/repo` or `owner/repo`. GitHub and GitHub Enterprise work, as do public GitLab and Bitbucket repos. (https://claude.com/docs/plugins/overview.md, read 2026-11-08)
- Other app options: **Add > Upload plugin** takes a zip or `.plugin` file. **Check for updates** pulls changes, and **Sync automatically** is available for github.com. (same, read 2026-11-08)
- Private repos in the app: connect your GitHub account and give the Claude GitHub App access to the repo. (same, read 2026-11-08)
- Account limits: up to 25 user-added marketplaces, and 5,000 files / 200 MB per plugin. (https://claude.com/docs/plugins/platform-support.md, read 2026-11-08)
- Org-synced marketplaces have stricter rules: the repo must be private or internal. (https://code.claude.com/docs/en/plugins/host-marketplace.md, read 2026-11-08)
- In Claude Code: `/plugin marketplace add owner/repo`, or `claude plugin marketplace add ...`. It accepts any git URL, a hosted `marketplace.json` URL, or a local path. (same, read 2026-11-08)
- Private repos in Claude Code use the user's own git credentials (SSH key, or a credential helper via `gh auth setup-git`). A `GITHUB_TOKEN` env var alone isn't enough. Auto-update is off by default for third-party marketplaces. (same, read 2026-11-08)
- Sync between surfaces:
  - A plugin installed on the claude.ai account syncs to Claude Code at the next signed-in session.
  - A plugin installed from the CLI stays on that machine.
  - (https://claude.com/docs/plugins/platform-support.md, read 2026-11-08)

**Which parts work where** (https://claude.com/docs/plugins/platform-support.md, read 2026-11-08)

| Component | Chat (web/desktop/mobile) | Cowork | Claude Code |
|---|---|---|---|
| Skills | Loads | Loads | Loads |
| Commands | "Loads as a skill"; Claude applies it when it fits | `/plugin-name:command` | Loads |
| Agents | Ignored | Loads | Loads |
| Hooks | Ignored | Loads | Loads |
| Remote MCP (`http`/`sse`, fixed URL) | Listed on the plugin's Connectors tab; works once the user adds or connects it | Same | Loads |
| Local/stdio MCP, `.mcpb` | Ignored | Loads if the session runs locally | Loads |
| MCP server using `${user_config.*}` | Ignored if the URL contains it | Ignored if no default; Cowork doesn't prompt | Prompts for the value |
| Top-level `bin/` | Plugin can't be installed | Plugin can't be installed | Loads |

- In chat, the `/` menu lists skills along with their plugin name. Commands appear in the same menu. (https://claude.com/docs/plugins/overview.md, read 2026-11-08)

**How a plugin references a remote MCP server, and whether it auto-installs**
- Declare it in `.mcp.json` at the plugin root: `{"mcpServers":{"<name>":{"type":"http","url":"https://.../mcp"}}}`. Don't put secrets in this file. (https://claude.com/docs/plugins/build.md, read 2026-11-08)
- It does **not** auto-install in the app. The docs say "Installing doesn't add or sign you in to any connector". (https://claude.com/docs/cowork/guide/plugins.md, read 2026-11-08)
- The plugin's Connectors tab shows Connected, Not connected or **Not added**, and the user adds it from there. On Team/Enterprise an Owner must add it. (https://claude.com/docs/plugins/overview.md, read 2026-11-08)
- If a server is already in the directory, a plugin should use the same URL so the user sees one set of tools rather than two. (https://claude.com/docs/plugins/build.md, read 2026-11-08)
- **UNVERIFIED:** whether a connector added from a plugin's Connectors tab counts against the Free plan's one-custom-connector limit. This is mostly moot, since plugins need a paid plan.
- In Claude Code, plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`. A remote server's `url`/`headers` expand `${VAR}`, `${VAR:-default}` and `${user_config.KEY}`. (https://code.claude.com/docs/en/mcp.md, read 2026-11-08; https://code.claude.com/docs/en/plugins-reference, read 2026-11-08)

## 3. MCP spec and building on Cloudflare Workers

**Spec: Streamable HTTP in the current revision**
- The current revision is **2026-07-28**. (https://modelcontextprotocol.io/specification/versioning, read 2026-11-08)
- This revision removes the `initialize` handshake. Each request carries `_meta.io.modelcontextprotocol/protocolVersion`. Servers MUST implement `server/discover`. (same, read 2026-11-08)
- Streamable HTTP (2026-07-28): a single endpoint that accepts POST. 2026-07-28 removed "the GET stream endpoint" and "protocol-level sessions". (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md, read 2026-11-08)
- Request and response rules (same source, read 2026-11-08):
  - The client sends `Accept: application/json, text/event-stream`.
  - The server replies with JSON or a request-scoped SSE stream.
  - A notification gets `202`.
  - Closing the stream means cancel.
  - Resumable `Last-Event-ID` streams are not supported.
- Required headers on every POST: `MCP-Protocol-Version` (must match the body `_meta`), `Mcp-Method`, and `Mcp-Name` for `tools/call`, `resources/read` and `prompts/get`. (same, read 2026-11-08)
- Errors for header problems (same, read 2026-11-08):
  - A mismatch returns `400` with `HeaderMismatch` (-32020).
  - An unknown version returns `400` with `UnsupportedProtocolVersionError` (-32022).
  - A request without `MCP-Protocol-Version` MAY be treated as `2025-03-26` if the server supports old clients.
- Servers MUST validate `Origin` and return 403 when it is invalid. (same, read 2026-11-08)
- Old-client traffic: a modern-only server SHOULD answer GET/DELETE with 405, and should ignore `Mcp-Session-Id` and `Last-Event-ID`. (same, read 2026-11-08)
- Era compatibility (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md, read 2026-11-08):
  - Legacy client against a modern-only server: "Fails".
  - Legacy client against a dual-era server: "Works".
  - A dual-era server MAY serve both eras on one endpoint.
- HTTP+SSE (2024-11-05) is Deprecated, and new implementations SHOULD NOT adopt it. (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md, read 2026-11-08)
- Tool parameters can be mirrored into `Mcp-Param-*` headers via `x-mcp-header`. Clients MUST support this. (same, read 2026-11-08)

**Official TypeScript SDK**
- v2 is the stable line implementing 2026-07-28. Its packages are `@modelcontextprotocol/server` and `@modelcontextprotocol/client`. (https://github.com/modelcontextprotocol/typescript-sdk README via `gh api`, read 2026-11-08)
- v1 (`@modelcontextprotocol/sdk`) gets fixes for at least six months after v2's release on 2026-07-27. (same, read 2026-11-08)
- Current npm versions: `@modelcontextprotocol/server` **2.4.0**, `@modelcontextprotocol/sdk` **1.32.2**. (`npm view`, read 2026-11-08)
- `createMcpHandler(factory)` returns `{ fetch }`, the shape a Cloudflare Workers default export expects. The factory runs once per request. (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md, read 2026-11-08)
- The handler does no Host/Origin validation itself. You add `hostHeaderValidationResponse` and `originValidationResponse` in front. (same, read 2026-11-08)
- Legacy option: the default `legacy: 'stateless'` answers 2025-era `initialize` from a fresh instance with no sessions. Legacy GET/DELETE get `405`. `legacy: 'reject'` makes the server modern-only. (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md, read 2026-11-08)

**Cloudflare `agents` package**
- `createMcpHandler` from `agents/mcp/server` serves an SDK v2 server. The page says you "do not need a Durable Object, protocol session, or WebSocket". (https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/, read 2026-11-08; page updated 2026-10-27)
- Options: `route` (default `/mcp`), `corsOptions` (wildcard CORS by default), `authContext`, `allowedHostnames`, `allowedOriginHostnames`, `legacy`, `responseMode`. SDK v1 options such as `sessionIdGenerator` are rejected. (same, read 2026-11-08)
- Cloudflare docs say `McpAgent` is deprecated and `createMcpHandler` "serves Streamable HTTP only". (https://developers.cloudflare.com/agents/model-context-protocol/transport/, read 2026-11-08; page updated 2026-10-27)
- The Cloudflare page installs `@modelcontextprotocol/server` 2.3.1; npm now has 2.4.0. (same, read 2026-11-08)
- Current npm versions: `agents` **0.33.0**, `@cloudflare/workers-oauth-provider` **1.2.4**, `wrangler` **4.158.0**. (`npm view`, read 2026-11-08)
- Workers Free plan limits (https://developers.cloudflare.com/workers/platform/limits/, read 2026-11-08):
  - 100,000 requests/day
  - **10 ms CPU** per request
  - 50 subrequests per request
  - 128 MB memory
- Conclusion: a Durable Object is not required, and a stateless Worker on the Free plan is a documented path. The 10 ms CPU limit is the real constraint. Network wait doesn't count toward it, but parsing large XBRL/JSON does (**UNVERIFIED** how much CPU our parsing will use; measure it in M1).
- **UNVERIFIED:** the default value of `legacy` in Cloudflare's wrapper. The SDK's own default is `'stateless'`.

## 4. Compatibility with `anthropics/financial-services`

Static analysis of commit `6056506` (2026-10-28), read via `gh api` and a `--depth 1` clone in /private/tmp (deleted afterwards). None of the repo's code was run. (https://github.com/anthropics/financial-services, read 2026-11-08)

- **License: Apache-2.0.** GitHub reports `apache-2.0`, and `LICENSE` is the Apache License 2.0 text. Partner plugin `partner-built/spglobal` ships its own `LICENSE` files, which were not reviewed. (same, read 2026-11-08)
- The marketplace name is **`claude-for-financial-services`**, defined in `.claude-plugin/marketplace.json`. (same, read 2026-11-08)
- Plugins (same, read 2026-11-08):
  - Verticals: `financial-analysis` (core), `investment-banking`, `equity-research`, `private-equity`, `fund-admin`, `operations`.
  - Agents: `pitch-agent`, `market-researcher`, `earnings-reviewer`, `meeting-prep-agent`, `model-builder`, `gl-reconciler`, `kyc-screener`, `valuation-reviewer`, `month-end-closer`, `statement-auditor`.
  - Partner and tooling: `lseg`, `sp-global`, `claude-for-msft-365-install`.
- `financial-analysis/.mcp.json` hard-wires 12 remote `http` servers: `daloopa`, `morningstar`, `sp-global` (Kensho), `factset`, `moodys`, `mtnewswire`, `aiera`, `lseg`, `pitchbook`, `chronograph`, `egnyte`, `box`. The README notes "MCP access may require a subscription or API key". (same, read 2026-11-08)
- `/comps` (`commands/comps.md`) has no `allowed-tools` restriction. It says "Gather data (prioritize MCP sources if available)". (same, read 2026-11-08)
- `/dcf` (`commands/dcf.md`) has no tool restriction. It loads the `comps-analysis` and `dcf-model` skills. (same, read 2026-11-08)
- `skills/comps-analysis/SKILL.md` has a "Data Source Priority" section that names vendors (same, read 2026-11-08):
  - It says "If S&P Kensho MCP, FactSet MCP, or Daloopa MCP are available, use them exclusively".
  - Otherwise it says "Bloomberg Terminal, SEC EDGAR filings, or other institutional sources".
  - It also says "NEVER use web search as a primary data source".
- `skills/dcf-model/SKILL.md` is generic about data (same, read 2026-11-08):
  - It says "Default to using all of the information provided by the user and MCP servers available".
  - Its priority order is MCP servers ("providers like Daloopa"), then user data, then web search.
  - Its description says it "Retrieves financial data from SEC filings".
- **Agent plugins are hard-wired by server name.** Their `agents/*.md` frontmatter sets `tools:` allowlists (same, read 2026-11-08):
  - `pitch-agent.md` has "tools: Read, Write, Edit, mcp__capiq__*".
  - `model-builder.md` has `mcp__capiq__*, mcp__daloopa__*`.
  - `market-researcher.md` has `mcp__capiq__*, mcp__factset__*`.
  - `earnings-reviewer.md` has `mcp__factset__*, mcp__daloopa__*`.
- No `bin/` directory exists under `plugins/`, so `financial-analysis` installs in chat and Cowork. `financial-analysis/hooks/hooks.json` is empty. (same, read 2026-11-08)

**Conclusion (static analysis only; a live test comes after deploy)**
- `/comps` and `/dcf` from `financial-analysis` will **likely use our tools** when the user has our connector and none of the named vendor connectors connected:
  - Neither command restricts tools.
  - The DCF skill says to use whatever MCP servers are available.
  - The comps skill's fallback explicitly allows "SEC EDGAR filings", which is our core data.
  - Users without paid FactSet/Kensho/Daloopa subscriptions can't connect those servers anyway. In chat they show as "Not added" on the plugin's Connectors tab.
- Risk: the comps skill tells Claude to use the named MCPs "exclusively" if they are available. If a student has, say, S&P connected, Claude will prefer it, which is expected and fine.
- **Agent plugins will NOT see our tools** in Cowork or Claude Code, because of their `mcp__capiq__*`-style allowlists. They also don't run in chat at all. Making them work would require the user to edit the agent or fork it; we shouldn't target them.
- Claude Code namespaces plugin tools as `mcp__plugin_<plugin>_<server>__*`, so even same-named servers wouldn't match those agent globs. **UNVERIFIED:** how the allowlist treats account/connector tools.
- How to maximize pickup:
  1. Name tools after the data, not the vendor. Examples: `get_financial_statements`, `get_company_filings`, `get_market_multiples` / `get_peer_comparables`, `get_risk_free_rate`, `get_equity_risk_premium`, `get_beta`, `search_company`.
  2. Start tool descriptions with the words the skills use: "SEC EDGAR filings (10-K/10-Q)", "historical financials", "Revenue, EBITDA, margins", "market cap / enterprise value", "WACC inputs: risk-free rate, ERP, beta".
  3. Return a citation (filing URL, accession number, period, retrieved-at) with every number. Both skills require a source comment on every hard-coded cell.
  4. Set a server `instructions` string saying this is a free source of SEC/ESEF/rates/Damodaran data for comps and DCF inputs.
  5. Never name our server or tools after FactSet, Capital IQ, Daloopa, S&P or any other vendor; that would be impersonation, and their agents' globs wouldn't match plugin servers anyway.
  6. Our own plugin's commands should not shadow theirs; they are already namespaced (`/openanalyst:comps` vs `/financial-analysis:comps`). Verify how chat shows two skills both called "comps" in M2.

---

## Design implications for us

1. **Free-plan students get exactly one custom connector and no plugins.** Our main Free-tier path is "add one connector URL", plus optional skills uploaded as ZIPs (Free users can upload skills). Plugins and the marketplace are a Pro+ bonus. Docs and onboarding must say this up front.
2. **Ship authless.** It is "Supported by default" and needs no OAuth endpoints, callback URL or DCR. Rate-limit by IP or Cloudflare features instead. Optionally adopt lazy auth later.
3. **Don't build the user-API-key feature on Claude's request headers.** They are beta, limited to some orgs, and treated as an org-wide credential. Rule out query-string keys (`?apiKey=`), which Anthropic explicitly prohibits. Options:
   - Defer the feature.
   - Accept a key as a tool argument (it would sit in the transcript; weak).
   - Use a per-user OAuth-protected tier later.
   - Use `x-api-key` so it works wherever headers are available.
4. **Use the `x-api-key` header name** if we support header keys. It is pre-approved; custom names need Anthropic approval.
5. **Serve Streamable HTTP only, dual-era.** Use SDK v2 `createMcpHandler` with `legacy: 'stateless'` and no `legacy: 'reject'`. The docs we found don't say whether Claude's client speaks 2026-07-28; its documented OAuth spec versions stop at 2025-11-25. Don't implement deprecated SSE.
6. **Stateless Worker on the Free plan; no Durable Object.** Choose between Cloudflare `agents` 0.33.0 `createMcpHandler` (adds CORS and route handling) and the raw SDK `createMcpHandler`. Either way, add Host and Origin validation. Cache upstream data (SEC/ECB/FRED) in KV or the Cache API to keep within 10 ms CPU and 50 subrequests.
7. **Keep tool results under about 150k characters** on claude.ai and 25k tokens in Claude Code, and keep each call under 240 s. Paginate statements and offer `fields`/`periods` filters.
8. **Plugin layout:**
   - `skills/` holds the real logic, because commands load as skills in chat.
   - `.mcp.json` points at our URL with `type: http`.
   - No `bin/`, no secrets, no `${user_config}` in the URL.
   - Agents and hooks are Cowork/Code-only extras.
   - Use a plugin name that doesn't start with `claude-` or `anthropic-`.
   - Public github.com repo, `owner/repo` shorthand, and omit `version` so users track commits (or bump it on each release).
9. **Use the same URL** in our plugin's `.mcp.json` and in the connector instructions, and in any future directory listing, so users never see two tool sets.
10. **Tool naming and descriptions** should follow the list in section 4, to be picked up by `anthropics/financial-services` `/comps` and `/dcf`. Every value should carry a citation.

## Open questions / unverified

- Does Claude's connector client (claude.ai/Desktop/Cowork) speak MCP 2026-07-28, or only 2025-era `initialize`? No official statement was found. Test live against both eras.
- Do Free/Pro individual accounts get the **Request headers** section? It is beta and per org, and wasn't confirmed for individuals.
- Does adding a plugin's bundled connector count against the Free one-custom-connector limit? Mostly moot, since plugins are paid-only.
- Is Cowork available on the Free plan? Only a secondary source says no.
- Can custom connectors be added (not just used) from the iOS/Android apps? Docs say mobile install is beta and point to web/desktop as the primary path.
- The default `legacy` posture of Cloudflare `agents` `createMcpHandler` (SDK default: `'stateless'`).
- Do CORS headers matter at all for Claude's server-side client? Assumed not.
- Real CPU cost of our parsing against the 10 ms Workers Free limit. Measure it in M1.
- How claude.ai chat disambiguates two installed plugins that both have a "comps" skill or command.
- Whether claude.ai chat defers or "tool-searches" connector tools when many connectors are enabled, which would affect tool discovery. Not found in the docs read.
- The `partner-built/spglobal` sub-licenses in `anthropics/financial-services` were not reviewed. We only plan to interoperate with, not copy, that repo; if we ever copy skill text, Apache-2.0 attribution and NOTICE rules apply.

---

## Cloudflare free-tier limits and caching design

### Cloudflare free-tier limits

| Product | Free-plan limit | Source |
|---|---|---|
| Workers requests | 100,000/day **per account**, resets 00:00 UTC. Paid: no limit | [CF-LIM] |
| Over the request limit | Error **1027**. Fail open bypasses the Worker on routes; fail closed returns the 1027 page | [CF-LIM] |
| CPU time | **10 ms per HTTP request** (Paid: 30 s default, 5 min max). Waiting on fetch, KV or DB does not count. Exceeding it gives Error 1102 "Worker exceeded resource limits". There is "some built-in flexibility" for rare overruns | [CF-LIM] |
| Memory | 128 MB per isolate (both plans). Exceeding it gives 1102 / `exceededMemory` | [CF-LIM] |
| Subrequests | 50 per request (Paid 10,000). 1,000 to internal services. 6 connections at once waiting for headers | [CF-LIM] |
| Worker size | 64 MiB uncompressed. No compressed limit. Startup under 1 s | [CF-LIM] |
| Workers / env vars / crons | 100 Workers per account, 64 env vars per Worker (5 KB each), 5 Cron Triggers per account (10 ms CPU each) | [CF-LIM] |
| Static assets | 20,000 files per version, 25 MiB per file. "Requests to static assets are free and unlimited" | [CF-LIM], [CF-SA] |
| Cache API | Max object 512 MB, 50 cache calls per request. Per data center, no replication. Not compatible with tiered cache. No `stale-while-revalidate` | [CF-LIM], [CF-CACHEAPI], [CF-HOWCACHE] |
| Workers Cache (new) | Caches the Worker's own **GET/HEAD** responses in front of it. Works on workers.dev and behind service bindings, on any plan. Hits count as requests but use no CPU. Size limit 512 MB at launch | [CF-WCACHE], [CF-WCACHE-LIM], [CF-BLOG-WC] |
| Workers KV | 100,000 reads/day. **1,000 writes/day** (to different keys). 1,000 deletes and 1,000 lists per day. 1 write/s to the same key. 1 GB storage. 25 MiB per value. 1,000 operations per invocation | [CF-KV], [CF-PRICE] |
| R2 | 10 GB-month, 1M Class A and 10M Class B ops per month, free egress (Standard storage only). **You must add an R2 subscription at checkout, and usage over the free tier is billed monthly** | [CF-R2P], [CF-R2GS] |
| D1 | 10 databases, 500 MB per DB, 5 GB total. **5M rows read/day, 100k rows written/day**. 50 queries per invocation. 2 MB per row. Over the daily limit, queries error until 00:00 UTC | [CF-D1L], [CF-D1P] |
| Durable Objects | On Free, **SQLite backend only**: 100k requests/day, 13,000 GB-s/day, 5M rows read/day, 100k rows written/day, 5 GB stored. "Further operations of that type will fail with an error" | [CF-DO] |
| Rate Limiting binding | Counts per Cloudflare location, approximate and eventually consistent. Periods are 10 or 60 s. Needs Wrangler 4.36+. **Free-plan availability and billing: UNVERIFIED** (docs silent) | [CF-RL] |
| Analytics Engine | Free: 100k data points written/day, 10k read queries/day. "Currently, you will not be billed" | [CF-AE] |
| Workers Logs | 200k events/day, 3-day retention. 256 KB of log data per request | [CF-PRICE], [CF-LIM] |
| Usage alerts | **None for Workers on Free.** The "Usage Based Billing" notification is Professional+ and Pay-as-you-go only | [CF-NOTIF] |

**Notes**

- **No surprise billing on Workers, KV, D1 or DO.** Hitting a free limit produces errors, not overage charges [CF-PRICE], [CF-D1P], [CF-DO]. The docs never say "the Free plan is never billed" outright, so treat that wording as UNVERIFIED.
- **R2 is the exception.** It needs a checkout and bills usage above the free tier [CF-R2GS]. Secondary guides say a payment method is required (UNVERIFIED officially). That breaks the hard $0 rule unless something enforces a spend cap, and I found none. **Recommendation: do not use R2.**
- **Cache API on workers.dev is UNVERIFIED.**
  - The docs say Workers "deployed to custom domains have access to functional cache operations", and they list dashboard and Playground previews as having "no impact" [CF-CACHEAPI].
  - workers.dev is not on either list. Its only mention is that its cache key includes the query string. Older doc copies (seen only in search snippets) listed `*.workers.dev` as having no impact.
  - **Test this in M1 before relying on it.**
- **Workers Cache does not help MCP calls.** It does work on workers.dev [CF-BLOG-WC], but it caches GET/HEAD only [CF-WCACHE-LIM], and MCP Streamable HTTP tool calls are POSTs. Hits also count as requests [CF-PRICE].
  - It *can* cache GET responses of a second "data" Worker reached over a service binding ("the callee's cache is consulted") [CF-WCACHE].
  - Whether service-binding calls count toward the Free 100k/day cap is **UNVERIFIED**. The docs only say they "do not incur additional request fees" [CF-PRICE].
- **workers.dev is "treated as a Free website ... intended for personal or hobby projects that aren't business-critical".** Cloudflare recommends a custom domain for production [CF-WDEV].
  - Browser Integrity Check cannot be turned off on workers.dev. Some default-library User-Agents get **error 1010** before the Worker runs [CF-WDEV].
  - Whether Claude's connector backend passes this check is **UNVERIFIED**. Other MCP servers on workers.dev suggest it does. Test in M1.
  - A custom domain would fix both issues, but a domain costs money and breaks $0.
- **Cloudflare's remote MCP pattern.**
  - The current getting-started guide uses `createMcpHandler`. `McpAgent` is marked **deprecated**, with a "Migrate to MCP SDK v2" guide [CF-MCP-GS], [CF-MCP-TR].
  - The stateless handler "needs no Durable Object or session". It serves Streamable HTTP only [CF-MCP-GS], [CF-MCP-TR].
  - The authless template is `npm create cloudflare@latest -- remote-mcp-server-authless --template=cloudflare/ai/demos/remote-mcp-authless` [CF-MCP-GS].
  - **This fits the Free plan without DOs.** The free-plan fit is my inference; the docs don't mention pricing. If we ever need DOs (for example a strict global rate limiter), the SQLite backend is available on Free [CF-DO].

### Capacity estimate and caching design

### 2.1 Load model (assumptions are labelled)

| Item | Value |
|---|---|
| Tool calls | 2,000 DAU × 25 = **50,000 POST requests/day** |
| MCP protocol overhead (initialize, initialized notification, tools/list, possible GET/DELETE probes, all counted as requests) | Assumed +30% to +100% → **65k–100k requests/day** (UNVERIFIED: measure in M1 with Analytics Engine) |
| Free cap | 100,000/day per account [CF-LIM] |
| Uncached upstream fetches | 50k × 1–3 = 50k–150k/day. Subrequests are unbilled [CF-PRICE], but SEC allows **10 req/s** [SEC-FAIR] |
| Peak burst (assumed) | 10 tool calls/s (US market-open spikes) |

**Finding: the request cap binds, not caching.** Cache hits still count as Worker requests, and POSTs can't be served by any cache in front of the Worker. At 25 calls per user the free account tops out at about **2,000–3,000 DAU**, depending on protocol overhead. At 2,000 DAU we use 65–100% of the cap.

Levers on request volume:

1. **Fewer, richer tools.** For example, `get_comps([tickers])` instead of N per-ticker calls, and statements returned together. Target ≤15 calls per user per day.
2. **Per-IP/session caps** with the Rate Limiting binding (once its free availability is confirmed), so one abuser cannot burn the daily budget.
3. **Keep no other Workers on this account.** The cap is per account.
4. **Serve docs, landing page and JSON downloads as static assets**, which are free and unlimited [CF-SA].
5. **Watch usage ourselves.** Write one Analytics Engine point per call (50k/day < 100k free) [CF-AE]. A GitHub Actions cron alerts at 70% of the cap, since Free has no Cloudflare usage alerts [CF-NOTIF].

### 2.2 CPU risk (high)

Raw sizes and `JSON.parse` best-of-5 times on the dev laptop [MEAS]. Workers CPU is probably not faster than this.

| Payload | Raw | gzip | Parse |
|---|---|---|---|
| SEC companyfacts, Apple (CIK 320193) | **3.86 MB** | 277 KB | **17.4 ms** |
| SEC companyfacts, Microsoft | 4.94 MB | 340 KB | 22.6 ms |
| SEC companyfacts, JPMorgan | **8.13 MB** | 555 KB | **34.9 ms** |
| SEC frames (AccountsPayableCurrent, CY2024Q4I) | 493 KB | 106 KB | 1.9 ms |
| SEC submissions, Apple | 165 KB | 28 KB | 0.5 ms |
| SEC companyconcept, Apple RevenueFromContract… | 18.8 KB | 2 KB | ~0.1 ms |
| ESEF xBRL-JSON, small FR half-year report | 4.98 MB | 359 KB | 9.2 ms |
| ESEF xBRL-JSON, **TotalEnergies FY2025** | **21.6 MB** | 880 KB | **35.7 ms** |
| Trimmed Apple payload (30 core concepts, 10-K/10-Q, FY≥2015) | 344 KB | 25 KB | 1.5 ms |

- Apple's companyfacts is **~3.9 MB, not 5–15 MB**. JPMorgan's is 8 MB.
- Parsing any companyfacts or large-cap ESEF report in a request is **certain to exceed 10 ms**. Gunzip and object-walk come on top of the parse. Large ESEF reports also risk the 128 MB memory limit.

**Rule: never fetch companyfacts or a full ESEF report inside a request.**

Mitigations, in order:

1. **Precompute offline.** A nightly GitHub Actions job (free for public repos):
   - Downloads SEC `companyfacts.zip` and `submissions.zip`, which are rebuilt "nightly at approximately 3:00 a.m. ET" [SEC-API].
   - For a curated ESEF universe, fetches xBRL-JSON once per filing. Filings never change, so each is fetched once.
   - Trims each company to exactly what the tools return (normalized lines, period, value, accession, concept, URL).
   - Deduplicates repeated facts. The trim above still contains duplicates, so true size is under 25 KB gz.
2. **Live fallbacks use small endpoints only:**
   - `companyconcept` (2–20 KB) for one concept.
   - `submissions` to check for filings newer than the snapshot. The XBRL APIs update in under a minute [SEC-API].
   - `frames` only for screens, cached 24 h.
3. **Streaming parse is a last resort.** A streaming JSON parser still spends CPU on every byte. It avoids memory blowups, not the 10 ms limit, so it is not a fix for companyfacts.
4. **Shape tool outputs at build time** so the Worker only does lookup, merge and serialize, under 2 ms typical. The docs cite about 2.2 ms for a typical Worker [CF-LIM].

### 2.3 Storage tiers (all $0, no R2)

| Tier | What goes there | Why / limit |
|---|---|---|
| **L0 static assets** (deployed by Actions via `wrangler deploy`) | Per-company SEC fundamentals JSON (~6–8k filers with tickers). Curated ESEF issuers, for example STOXX 600, pre-extracted to IFRS lines. Ticker↔CIK↔LEI maps, concept maps. Damodaran datasets as JSON. One manifest with `as_of` | Free and unlimited. 20,000 files, 25 MiB each [CF-LIM]. Shard into fewer files if it nears 20k. Whether `env.ASSETS.fetch()` from Worker code counts as a request is **UNVERIFIED** (test). Fallback host: GitHub Pages (outside Cloudflare) |
| **L1 isolate memory** (`globalThis` LRU, ~20 MB) | Hot parsed snapshots, rate series | Free, per isolate, within 128 MB |
| **L2 Cache API** | Live upstream responses: companyconcept, submissions, frames, Treasury, ECB, FRED | Per colo. **Works on workers.dev? UNVERIFIED.** Use opportunistically |
| **L3 D1 `cache` table** (key, body ≤2 MB, expires) | Global runtime cache for live-fetch misses and the ESEF long tail (trim results, never raw reports) | 100k rows written/day, 5M read/day, 5 GB [CF-D1P]. Hits ≈1 row read |
| **KV** | Only tiny cron-updated values (latest yield curve, ECB/€STR, FRED snapshot) | **1,000 writes/day** rules out runtime write-through [CF-KV] |
| ~~R2~~ | Not used | Checkout plus metered overage [CF-R2GS] |
| Durable Objects | Not needed (stateless handler) | Keep as an option for a strict global SEC token bucket [CF-RL], [CF-DO] |

**TTLs**

| Data | TTL |
|---|---|
| SEC snapshot (L0) | Rebuilt nightly after 03:00 ET. Responses carry `as_of` and the accession |
| companyconcept / submissions | 6 h (L2), 24 h (D1), revalidated when submissions shows a new 10-K/10-Q |
| frames | 24 h |
| Treasury par yields | Until the next business-day publish (about 6 h) |
| ECB | 6 h |
| FRED | 6–24 h by series frequency. FRED needs an API key, kept as a Worker secret (UNVERIFIED this pass) |
| ESEF index | 24 h |
| ESEF per-filing facts | Immutable, cache forever |
| Damodaran | Rebuilt monthly. The source updates mainly in January (UNVERIFIED) |

### 2.4 Required hit rate

- **SEC fair access.** Budget live SEC traffic at ≤4 req/s, 40% of 10 req/s, because Workers egress IPs are shared (UNVERIFIED how SEC counts them).
  - At a 10 calls/s peak with 2 fetches per miss, the miss rate must be ≤20%. **Hit rate ≥80% at peak.**
  - Also add a global SEC limiter, for example a D1 or DO token bucket.
- **KV as runtime cache.** Misses would have to stay ≤1,000/day, which means ≥98% hits. Infeasible, which is why D1 is the runtime cache.
- **CPU.** Hit rate does not matter if misses only touch small endpoints. It matters a lot if a miss ever falls back to companyfacts (≈0% tolerance).
- **Target: ≥90% of tool calls answered from L0/L1 with no upstream fetch.** That is realistic, since most comps and DCF calls hit the snapshot universe.


Sources (read 2026-11-08):
- [CF-LIM] https://developers.cloudflare.com/workers/platform/limits/
- [CF-PRICE] https://developers.cloudflare.com/workers/platform/pricing/
- [CF-CACHEAPI] https://developers.cloudflare.com/workers/runtime-apis/cache/ (and `/index.md`)
- [CF-HOWCACHE] https://developers.cloudflare.com/workers/reference/how-the-cache-works/
- [CF-WCACHE] https://developers.cloudflare.com/workers/cache/ (last updated 2026-10-30)
- [CF-WCACHE-LIM] https://developers.cloudflare.com/workers/cache/limitations/
- [CF-BLOG-WC] https://blog.cloudflare.com/workers-cache/ (published 2026-07-06)
- [CF-WDEV] https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- [CF-SA] https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- [CF-KV] https://developers.cloudflare.com/kv/platform/limits/
- [CF-R2P] https://developers.cloudflare.com/r2/pricing/
- [CF-R2GS] https://developers.cloudflare.com/r2/get-started/
- [CF-D1L] https://developers.cloudflare.com/d1/platform/limits/
- [CF-D1P] https://developers.cloudflare.com/d1/platform/pricing/
- [CF-DO] https://developers.cloudflare.com/durable-objects/platform/pricing/
- [CF-RL] https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- [CF-AE] https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- [CF-NOTIF] https://developers.cloudflare.com/notifications/notification-available/
- [CF-MCP-GS] https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- [CF-MCP-TR] https://developers.cloudflare.com/agents/model-context-protocol/transport/
