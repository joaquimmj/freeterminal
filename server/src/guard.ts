// Cost guardrails for the shared free service (brief §3):
// - per-IP rate limit (Workers Rate Limiting binding if configured, else a per-isolate window)
// - global daily request cap (D1 counter if configured) with a friendly "self-host" message
// Cloudflare Free also hard-stops at 100k requests/day (error 1027), so even with
// no D1 there is no billing risk; the cap exists to fail gracefully before that.

import { DEFAULT_DAILY_CAP, DEFAULT_PER_IP_PER_MINUTE, PRODUCT_NAME, SELF_HOST_URL, type Env } from "./config";

export const CAPACITY_MESSAGE =
  `${PRODUCT_NAME}'s free daily capacity is used up (it resets at 00:00 UTC). ` +
  `Anyone can deploy their own free copy in a few minutes: ${SELF_HOST_URL}`;

export const RATE_MESSAGE =
  `Too many requests from your network to ${PRODUCT_NAME} in the last minute. Wait a minute and retry, ` +
  `or deploy your own copy for heavy use: ${SELF_HOST_URL}`;

// ---- per-IP window (fallback when no Rate Limiting binding) --------------------

const windows = new Map<string, { start: number; count: number }>();

function isolateLimit(ip: string, perMinute: number, now: number): boolean {
  const w = windows.get(ip);
  if (!w || now - w.start >= 60_000) {
    if (windows.size > 10_000) windows.clear(); // bound memory
    windows.set(ip, { start: now, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= perMinute;
}

export async function allowIp(env: Env, ip: string, now = Date.now()): Promise<boolean> {
  if (env.IP_LIMITER) {
    try {
      return (await env.IP_LIMITER.limit({ key: ip })).success;
    } catch {
      // fall through to the isolate window
    }
  }
  const perMinute = Number(env.PER_IP_PER_MINUTE) || DEFAULT_PER_IP_PER_MINUTE;
  return isolateLimit(ip, perMinute, now);
}

// ---- daily cap (batched D1 counter) ---------------------------------------------

const FLUSH_EVERY = 20; // requests
const FLUSH_MS = 30_000;

const counter = { day: "", pending: 0, total: 0, lastFlush: 0 };

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Test isolation: clears the daily counter and the per-IP windows. */
export function resetCounter(): void {
  Object.assign(counter, { day: "", pending: 0, total: 0, lastFlush: 0 });
  windows.clear();
}

async function flush(db: D1Database, day: string, n: number): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        "INSERT INTO usage (day, n) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET n = n + excluded.n RETURNING n",
      )
      .bind(day, n)
      .first<{ n: number }>();
    return row?.n ?? null;
  } catch (e) {
    console.error("usage flush failed", e);
    return null;
  }
}

/**
 * Count one request; returns false once the day's total reaches the cap.
 * Writes to D1 at most once per FLUSH_EVERY requests or FLUSH_MS per isolate,
 * so the counter costs ~5% of D1's free daily writes at the cap.
 */
export async function allowDaily(env: Env, waitUntil: (p: Promise<unknown>) => void, now = Date.now()): Promise<boolean> {
  if (!env.USAGE) return true;
  const cap = Number(env.DAILY_CAP) || DEFAULT_DAILY_CAP;
  const day = utcDay(now);
  if (counter.day !== day) Object.assign(counter, { day, pending: 0, total: 0, lastFlush: 0 });
  if (counter.total + counter.pending >= cap) return false;
  counter.pending += 1;
  if (counter.pending >= FLUSH_EVERY || now - counter.lastFlush >= FLUSH_MS) {
    const n = counter.pending;
    counter.pending = 0;
    counter.lastFlush = now;
    const db = env.USAGE;
    waitUntil(
      flush(db, day, n).then((total) => {
        if (total !== null && counter.day === day) counter.total = Math.max(counter.total, total);
      }),
    );
  }
  return true;
}
