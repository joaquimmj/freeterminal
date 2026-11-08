// Date handling shared by the rate and FX tools (all dates are ISO YYYY-MM-DD, UTC).

import { ToolError } from "./errors";

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * A real calendar date, not in the future. V8 accepts "2026-02-31" (rolling over
 * to March 3), so the parsed date must round-trip to the input.
 */
export function pastDate(s: string, name: string, today: string): string {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN;
  const ok = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  if (!ok) throw new ToolError(`${name} must be a real date in YYYY-MM-DD form, e.g. "2025-12-31"`);
  if (s > today) throw new ToolError(`${name} ${s} is in the future; the latest available data is as of ${today} or earlier`);
  return s;
}

/** Cache lifetimes: a closed historical window never changes; anything touching today can. */
export const TTL_HISTORICAL = 30 * 86_400;
export const TTL_LATEST = 6 * 3600;

/** Cache a response for 30 days only when its window ended a few days ago; otherwise 6 hours. */
export function ttlFor(end: string | undefined, today: string): number {
  return end && end < shiftDays(today, -3) ? TTL_HISTORICAL : TTL_LATEST;
}

/** A warning when the newest observation is older than `maxDays` (a discontinued or lagging series). */
export function staleness(observed: string, today: string, what: string, maxDays = 7): string | null {
  const age = daysBetween(observed, today);
  return age > maxDays
    ? `${what}: the newest observation is from ${observed} (${age} days ago). The series may be discontinued or delayed; do not present it as current.`
    : null;
}
