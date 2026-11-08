/** The one place the product name lives (CLAUDE.md: don't hardcode it elsewhere). */
export const PRODUCT_NAME = "freeterminal";
export const VERSION = "0.1.0";
export const REPO_URL = "https://github.com/joaquimmj/freeterminal";
export const SELF_HOST_URL = `${REPO_URL}/blob/main/docs/SELF_HOSTING.md`;

export const DISCLAIMER =
  "Independent open-source project. Not affiliated with or endorsed by Anthropic. " +
  "Data may be incomplete or delayed; verify against the cited filing before use. Not investment advice.";

/** Snapshot layout under the Worker's static assets (built by scripts/build-snapshot.ts). */
export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_PREFIX = "/v1";
/** Years kept per company in the snapshot; also the max a caller can ask for. */
export const SNAPSHOT_YEARS = 15;

/** Defaults for the cost guardrails; each can be overridden by a Worker var. */
export const DEFAULT_DAILY_CAP = 90_000; // Cloudflare Free hard-stops at 100k requests/day
export const DEFAULT_PER_IP_PER_MINUTE = 60;

export interface Env {
  /** Static assets binding (the snapshot). Absent in some tests and local runs. */
  ASSETS?: { fetch(input: Request | string): Promise<Response> };
  /** Optional D1 database for the global daily request counter. */
  USAGE?: D1Database;
  /** Optional Workers Rate Limiting binding (per IP). */
  IP_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** Required for live SEC requests: "<name> <contact email>" per SEC fair-access policy. */
  SEC_USER_AGENT?: string;
  DAILY_CAP?: string;
  PER_IP_PER_MINUTE?: string;
  /** Comma-separated extra Origin hostnames allowed (besides Claude's and localhost). */
  ALLOWED_ORIGINS?: string;
}
