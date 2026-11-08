// FX from the ECB euro foreign exchange reference rates (EXR), no key needed.
// ECB quotes every currency per 1 EUR, so any pair is a cross through EUR.
// Reuse: "Source: ECB statistics." (docs/DATA_SOURCES.md §5).

import { PRODUCT_NAME } from "./config";
import { daysBetween, pastDate, shiftDays, staleness, todayIso, ttlFor } from "./dates";
import { ToolError } from "./errors";
import { isEcbCsv, parseEcbCsv, type FetchText } from "./rates";

/**
 * Currencies with an ECB daily reference rate (as of 2026). BGN is gone:
 * Bulgaria adopted the euro on 2026-01-01 and its last ECB fixing is 2025-12-31.
 */
export const ECB_CURRENCIES = [
  "USD", "JPY", "CZK", "DKK", "GBP", "HUF", "PLN", "RON", "SEK", "CHF", "ISK", "NOK", "TRY", "AUD",
  "BRL", "CAD", "CNY", "HKD", "IDR", "ILS", "INR", "KRW", "MXN", "MYR", "NZD", "PHP", "SGD", "THB", "ZAR",
];

export function exrUrl(cur: string, start: string, end: string): string {
  return `https://data-api.ecb.europa.eu/service/data/EXR/D.${cur}.EUR.SP00.A?startPeriod=${start}&endPeriod=${end}&format=csvdata&detail=dataonly`;
}

function code(c: string): string {
  const s = c.trim().toUpperCase();
  if (s === "BGN") throw new ToolError("BGN was replaced by the euro on 2026-01-01 (fixed at 1.95583 BGN per EUR); use EUR.");
  if (s !== "EUR" && !ECB_CURRENCIES.includes(s)) {
    throw new ToolError(`currency ${JSON.stringify(c)} has no ECB reference rate; supported: EUR, ${ECB_CURRENCIES.join(", ")}`);
  }
  return s;
}

type Obs = Map<string, number>; // date -> units of currency per 1 EUR

/** Days of history fetched for a "latest" or dated rate, so both legs of a cross share a fixing date. */
const LOOKBACK_DAYS = 14;
/**
 * Longest averaging window: about 1,300 daily fixings per leg. 27 years measured 8-12 ms of CPU,
 * over the Workers Free 10 ms limit; 5 years stays around 2 ms.
 */
const MAX_AVERAGE_DAYS = 5 * 366;

export class Fx {
  constructor(
    private readonly fetchText: FetchText,
    private readonly today: () => string = todayIso,
  ) {}

  private async series(cur: string, start: string, end: string): Promise<Obs> {
    if (cur === "EUR") return new Map();
    const text = await this.fetchText(exrUrl(cur, start, end), ttlFor(end, this.today()), isEcbCsv);
    return new Map(parseEcbCsv(text).map((o) => [o.date, o.value]));
  }

  /** Units of `to` per 1 unit of `from`, on each date both series have. */
  private static cross(from: string, to: string, a: Obs, b: Obs): Array<[string, number]> {
    const dates = from === "EUR" ? [...b.keys()] : [...a.keys()].filter((d) => to === "EUR" || b.has(d));
    return dates.sort().map((d) => {
      const fromPerEur = from === "EUR" ? 1 : a.get(d)!;
      const toPerEur = to === "EUR" ? 1 : b.get(d)!;
      return [d, toPerEur / fromPerEur];
    });
  }

  async rate(fromIn: string, toIn: string, opts: { on?: string; averageFrom?: string; averageTo?: string } = {}) {
    const from = code(fromIn);
    const to = code(toIn);
    if (from === to) throw new ToolError("from and to are the same currency");
    const today = this.today();
    const series = [from, to].filter((c) => c !== "EUR").map((c) => `EXR.D.${c}.EUR.SP00.A`);
    // ECB terms: any modification (averages, cross rates) must be stated explicitly.
    const derivation =
      from !== "EUR" && to !== "EUR"
        ? `; cross rate computed by ${PRODUCT_NAME} from the ECB EUR rates of both currencies`
        : to === "EUR"
          ? `; inverse of the ECB EUR rate, computed by ${PRODUCT_NAME}`
          : "";
    const source = {
      name: "European Central Bank, euro foreign exchange reference rates",
      url: "https://data.ecb.europa.eu/data/datasets/EXR",
      accession_or_id: series.join(" / "),
      period: "",
      as_of: "",
      license_note: "Source: ECB statistics. Reference rates are for information purposes only.",
    };

    if (opts.averageFrom || opts.averageTo) {
      if (opts.on) throw new ToolError("pass either `on` or `average_from`/`average_to`, not both");
      if (!opts.averageFrom || !opts.averageTo) throw new ToolError("pass both average_from and average_to");
      const s = pastDate(opts.averageFrom, "average_from", today);
      const e = pastDate(opts.averageTo, "average_to", today);
      if (s > e) throw new ToolError("average_from must be on or before average_to");
      if (daysBetween(s, e) > MAX_AVERAGE_DAYS) {
        throw new ToolError("averaging window is longer than 5 years; split it into fiscal years and average those instead");
      }
      const [a, b] = await Promise.all([this.series(from, s, e), this.series(to, s, e)]);
      const pts = Fx.cross(from, to, a, b).filter(([d]) => d >= s && d <= e);
      if (!pts.length) throw new ToolError(`No ECB reference rates between ${s} and ${e}.`);
      const mean = pts.reduce((x, [, v]) => x + v, 0) / pts.length;
      const first = pts[0]![0];
      const last = pts.at(-1)![0];
      const warnings: string[] = [];
      if (daysBetween(last, e) > 7) warnings.push(`No fixings after ${last}: the average covers ${first} to ${last}, not the full period to ${e}.`);
      return {
        from,
        to,
        rate: mean,
        basis:
          `average of ${pts.length} daily ECB reference rates, ${first} to ${last} (the rate IFRS uses for ` +
          `income-statement items); average computed by ${PRODUCT_NAME}${derivation}`,
        warnings,
        sources: [{ ...source, period: `${first}/${last}`, as_of: last }],
      };
    }

    // Latest, or the last fixing on or before `on`. A two-week window per leg (not just the last
    // observation), so the newest date BOTH legs have is used even if one was cached before today's fixing.
    const day = opts.on ? pastDate(opts.on, "on", today) : today;
    const start = shiftDays(day, -LOOKBACK_DAYS);
    const [a, b] = await Promise.all([this.series(from, start, day), this.series(to, start, day)]);
    const last = Fx.cross(from, to, a, b)
      .filter(([d]) => d <= day)
      .at(-1);
    if (!last) throw new ToolError(`No ECB reference rate in the two weeks up to ${day}.`);
    const stale = opts.on ? null : staleness(last[0], today, `ECB ${series.join("/")}`);
    return {
      from,
      to,
      rate: last[1],
      basis:
        `ECB reference rate on ${last[0]}` +
        (opts.on && last[0] !== day ? ` (last fixing on or before ${day})` : "") +
        derivation +
        "; use the period-end rate for balance-sheet items",
      warnings: stale ? [stale] : [],
      sources: [{ ...source, period: last[0], as_of: last[0] }],
    };
  }
}
