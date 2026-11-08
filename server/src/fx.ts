// FX from the ECB euro foreign exchange reference rates (EXR), no key needed.
// ECB quotes every currency per 1 EUR, so any pair is a cross through EUR.
// Reuse: "Source: ECB statistics." (docs/DATA_SOURCES.md §5).

import { PRODUCT_NAME } from "./config";
import { ToolError } from "./errors";
import { parseEcbCsv } from "./rates";

/** Currencies with an ECB daily reference rate (as of 2026). */
export const ECB_CURRENCIES = [
  "USD", "JPY", "BGN", "CZK", "DKK", "GBP", "HUF", "PLN", "RON", "SEK", "CHF", "ISK", "NOK", "TRY", "AUD",
  "BRL", "CAD", "CNY", "HKD", "IDR", "ILS", "INR", "KRW", "MXN", "MYR", "NZD", "PHP", "SGD", "THB", "ZAR",
];

export function exrUrl(cur: string, start?: string, end?: string): string {
  const range = start && end ? `startPeriod=${start}&endPeriod=${end}` : "lastNObservations=1";
  return `https://data-api.ecb.europa.eu/service/data/EXR/D.${cur}.EUR.SP00.A?${range}&format=csvdata&detail=dataonly`;
}

function code(c: string): string {
  const s = c.trim().toUpperCase();
  if (s !== "EUR" && !ECB_CURRENCIES.includes(s)) {
    throw new ToolError(`currency ${JSON.stringify(c)} has no ECB reference rate; supported: EUR, ${ECB_CURRENCIES.join(", ")}`);
  }
  return s;
}

function isoDate(s: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new ToolError(`${name} must be YYYY-MM-DD`);
  return s;
}

function shift(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type Obs = Map<string, number>; // date -> units of currency per 1 EUR

export class Fx {
  constructor(private readonly fetchText: (url: string, ttlSeconds: number) => Promise<string>) {}

  private async series(cur: string, start?: string, end?: string): Promise<Obs> {
    if (cur === "EUR") return new Map();
    const text = await this.fetchText(exrUrl(cur, start, end), start ? 30 * 86_400 : 6 * 3600);
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
      if (!opts.averageFrom || !opts.averageTo) throw new ToolError("pass both average_from and average_to");
      const s = isoDate(opts.averageFrom, "average_from");
      const e = isoDate(opts.averageTo, "average_to");
      if (s > e) throw new ToolError("average_from must be on or before average_to");
      const [a, b] = await Promise.all([this.series(from, s, e), this.series(to, s, e)]);
      const pts = Fx.cross(from, to, a, b);
      if (!pts.length) throw new ToolError(`No ECB reference rates between ${s} and ${e}.`);
      const mean = pts.reduce((x, [, v]) => x + v, 0) / pts.length;
      return {
        from,
        to,
        rate: mean,
        basis: `average of ${pts.length} daily ECB reference rates, ${pts[0]![0]} to ${pts.at(-1)![0]} (the rate IFRS uses for income-statement items); average computed by ${PRODUCT_NAME}${derivation}`,
        sources: [{ ...source, period: `${s}/${e}`, as_of: pts.at(-1)![0] }],
      };
    }

    // Latest, or the last ECB fixing on or before `on` (looking back up to 10 days for holidays).
    const day = opts.on ? isoDate(opts.on, "on") : undefined;
    const [a, b] = await Promise.all([
      this.series(from, day && shift(day, -10), day),
      this.series(to, day && shift(day, -10), day),
    ]);
    const pts = Fx.cross(from, to, a, b).filter(([d]) => !day || d <= day);
    const last = pts.at(-1);
    if (!last) throw new ToolError(`No ECB reference rate on or before ${day ?? "today"}.`);
    return {
      from,
      to,
      rate: last[1],
      basis:
        `ECB reference rate on ${last[0]}` +
        (day && last[0] !== day ? ` (last fixing on or before ${day})` : "") +
        derivation +
        "; use the period-end rate for balance-sheet items",
      sources: [{ ...source, period: last[0], as_of: last[0] }],
    };
  }
}
