import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Fx } from "../src/fx";

const FIX = join(import.meta.dirname, "fixtures", "rates");
const read = (n: string) => readFileSync(join(FIX, n), "utf8");

/** Latest -> *_latest.csv; any 2025 window -> the 2025 file (the code filters by date). */
export function fxFetchText(urls: string[] = []) {
  return async (url: string): Promise<string> => {
    urls.push(url);
    const cur = /EXR\/D\.([A-Z]{3})\.EUR/.exec(url)?.[1];
    if (!cur) throw new Error(`unexpected ${url}`);
    if (url.includes("lastNObservations=1")) return read(`ecb_EXR_${cur}_latest.csv`);
    if (url.includes("startPeriod=2025-") || url.includes("startPeriod=2024-12")) return read(`ecb_EXR_${cur}_2025.csv`);
    throw new Error(`no fixture for ${url}`);
  };
}

const lastValue = (name: string) => Number(read(name).trim().split("\n").at(-1)!.split(",").at(-1));

describe("fx_rate", () => {
  it("EUR->USD latest is the ECB USD reference rate", async () => {
    const r = await new Fx(fxFetchText()).rate("eur", "usd");
    expect(r.rate).toBe(1.1165);
    expect(r.sources[0]!.as_of).toBe("2026-11-06");
    expect(r.sources[0]!.license_note).toMatch(/Source: ECB statistics/);
  });

  it("USD->EUR is the inverse, and JPY->USD crosses through EUR", async () => {
    const fx = new Fx(fxFetchText());
    expect((await fx.rate("USD", "EUR")).rate).toBeCloseTo(1 / 1.1165, 12);
    const jpy = lastValue("ecb_EXR_JPY_latest.csv");
    expect((await fx.rate("JPY", "USD")).rate).toBeCloseTo(1.1165 / jpy, 12);
  });

  it("period average uses every common fixing in the window", async () => {
    const r = await new Fx(fxFetchText()).rate("EUR", "USD", { averageFrom: "2025-01-01", averageTo: "2025-12-31" });
    const vals = read("ecb_EXR_USD_2025.csv").trim().split("\n").slice(1).map((l) => Number(l.split(",").at(-1)));
    expect(r.rate).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 12);
    expect(r.basis).toMatch(new RegExp(`average of ${vals.length} daily`));
  });

  it("a holiday date takes the last fixing before it", async () => {
    const r = await new Fx(fxFetchText()).rate("EUR", "USD", { on: "2025-12-25" });
    expect(r.sources[0]!.as_of < "2025-12-25").toBe(true);
    expect(r.basis).toMatch(/on or before 2025-12-25/);
  });

  it("rejects unsupported or identical currencies and half-open periods", async () => {
    const fx = new Fx(fxFetchText());
    await expect(fx.rate("EUR", "XYZ")).rejects.toThrow(/no ECB reference rate/);
    await expect(fx.rate("USD", "usd")).rejects.toThrow(/same currency/);
    await expect(fx.rate("EUR", "USD", { averageFrom: "2025-01-01" })).rejects.toThrow(/both/);
  });
});
