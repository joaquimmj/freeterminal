# Self-hosting freeterminal

Deploy your own copy on a free Cloudflare account, so you don't share the public service's daily capacity.
You need Node.js 24+ and a free Cloudflare account.

```bash
git clone https://github.com/joaquimmj/freeterminal && cd freeterminal/server
npm ci
npx wrangler login
```

1. **Set your SEC contact.** SEC's fair-access policy requires a User-Agent naming you. In `wrangler.jsonc`, set
   `"SEC_USER_AGENT": "<your app name> <your email>"`.
2. **Build the snapshot.** This is optional but recommended: without it, every request fetches SEC live, which is slower and can hit the free plan's CPU limit on large filers.
   - A few companies: `SEC_USER_AGENT="..." npm run snapshot -- --tickers AAPL,MSFT,NVDA`
   - All of them: `SEC_USER_AGENT="..." npm run snapshot -- --bulk` (downloads 2–3 GB)
3. **Deploy:** `npm run deploy`. Wrangler prints your URL, `https://freeterminal.<you>.workers.dev`.
4. **Connect it in Claude:** Settings → Connectors → Add custom connector. Paste `https://freeterminal.<you>.workers.dev/mcp`, with no sign-in.

**Optional global daily cap.** Create the counter database:

```bash
npx wrangler d1 create freeterminal-usage
npx wrangler d1 execute freeterminal-usage --remote --file migrations/0001_usage.sql
```

Then add the `d1_databases` block shown in `wrangler.jsonc`. Without it, Cloudflare's Free plan still hard-stops at 100k requests/day, with no charges.

**Nightly refresh.** Fork the repo and set the Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `SEC_USER_AGENT`. `.github/workflows/snapshot-deploy.yml` then rebuilds and deploys daily.
