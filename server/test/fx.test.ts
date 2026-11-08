import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Fx } from "../src/fx";
import { ecbFixture } from "./helpers";

const FIX = join(import.meta.dirname, "fixtures", "rates");
const read = (n: string) => readFileSync(join(FIX, n), "utf8");
const TODAY = "2026-11-08";

/** fetchText stand-in over the window-aware ECB fixtures; records URLs and TTLs. */
function fetchText(calls: Array<{ url: string; ttl: number }> = [], override?: (url: string) => string | null) {
  return async (url: string, ttl: number): Promise<string> => {
    calls.push({ url, ttl });
    const body = override?.(url) ?? ecbFixture(url);
    if (body === null) throw new Error(`unexpected ${url}`);
    return body;
  };
}

const fx = (calls?: Array<{ url: string; ttl: number }>, override?: (url: string) => string | null) =>
  new Fx(fetchText(calls, override), () => TODAY);
const lastValue = (name: string) => Number(read(name).trim().split("\n").at(-1)!.split(",").at(-1));
const values2025 = (cur: string, from: string, to: string) =>
  read(`ecb_EXR_${cur}_2025.csv`)
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","))
    .filter((c) => c.at(-2)! >= from && c.at(-2)! <= to)
    .map((c) => Number(c.at(-1)));

describe("fx_rate", () => {
  it("EUR->USD latest is the newest ECB USD reference rate", async () => {
    const r = await fx().rate("eur", "usd");
    expect(r.rate).toBe(1.1165);
    expect(r.sources[0]!.as_of).toBe("2026-11-06");
    expect(r.sources[0]!.license_note).toMatch(/Source: ECB statistics/);
    expect(r.warnings).toEqual([]);
  });

  it("USD->EUR is the inverse, and JPY->USD crosses through EUR", async () => {
    expect((await fx().rate("USD", "EUR")).rate).toBeCloseTo(1 / 1.1165, 12);
    const jpy = lastValue("ecb_EXR_JPY_latest.csv");
    const r = await fx().rate("JPY", "USD");
    expect(r.rate).toBeCloseTo(1.1165 / jpy, 12);
    expect(r.basis).toMatch(/cross rate computed by/);
  });

  it("a latest cross still works when one leg was cached before today's fixing", async () => {
    // JPY's cached window lacks the newest fixing (2026-11-06): use the newest date BOTH legs have.
    const r = await fx(undefined, (url) => {
      if (!url.includes("D.JPY.")) return null;
      const body = ecbFixture(url)!;
      return body.split("\n").filter((l) => !l.includes("2026-11-06")).join("\n");
    }).rate("JPY", "USD");
    expect(r.sources[0]!.as_of < "2026-11-06").toBe(true);
  });

  it("period average uses only the fixings inside the window", async () => {
    const r = await fx().rate("EUR", "USD", { averageFrom: "2025-04-01", averageTo: "2025-06-30" });
    const vals = values2025("USD", "2025-04-01", "2025-06-30");
    expect(r.rate).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 12);
    expect(r.basis).toMatch(new RegExp(`average of ${vals.length} daily ECB reference rates, 2025-04-01 to 2025-06-30`));
    expect(r.sources[0]!.period).toBe("2025-04-01/2025-06-30");
    expect(r.warnings).toEqual([]);
  });

  it("a holiday date takes the last fixing before it", async () => {
    const r = await fx().rate("EUR", "USD", { on: "2025-12-25" });
    expect(r.sources[0]!.as_of).toBe("2025-12-24");
    expect(r.basis).toMatch(/last fixing on or before 2025-12-25/);
  });

  it("caches a window ending today for hours, a closed historical one for 30 days", async () => {
    const calls: Array<{ url: string; ttl: number }> = [];
    await fx(calls).rate("EUR", "USD", { on: TODAY });
    expect(Math.max(...calls.map((c) => c.ttl))).toBe(6 * 3600);
    calls.length = 0;
    await fx(calls).rate("EUR", "USD", { averageFrom: "2025-01-01", averageTo: "2025-12-31" });
    expect(calls.every((c) => c.ttl === 30 * 86_400)).toBe(true);
  });

  it("rejects averaging windows longer than 5 years before fetching (Workers CPU budget)", async () => {
    const calls: Array<{ url: string; ttl: number }> = [];
    await expect(fx(calls).rate("JPY", "USD", { averageFrom: "1999-01-04", averageTo: "2026-11-06" })).rejects.toThrow(/5 years/);
    expect(calls).toEqual([]);
  });

  it("rejects future, impossible, mixed and unsupported inputs before fetching", async () => {
    const calls: Array<{ url: string; ttl: number }> = [];
    const f = fx(calls);
    await expect(f.rate("EUR", "USD", { on: "2027-01-01" })).rejects.toThrow(/in the future/);
    await expect(f.rate("EUR", "USD", { on: "2026-02-31" })).rejects.toThrow(/real date/);
    await expect(f.rate("EUR", "USD", { on: "2025-01-02", averageFrom: "2025-01-01", averageTo: "2025-01-31" })).rejects.toThrow(/not both/);
    await expect(f.rate("EUR", "BGN")).rejects.toThrow(/replaced by the euro/);
    await expect(f.rate("EUR", "XYZ")).rejects.toThrow(/no ECB reference rate/);
    await expect(f.rate("USD", "usd")).rejects.toThrow(/same currency/);
    await expect(f.rate("EUR", "USD", { averageFrom: "2025-01-01" })).rejects.toThrow(/both/);
    expect(calls).toEqual([]);
  });
});
