// Aswath Damodaran's public valuation datasets (NYU Stern), reduced at build
// time to the figures we serve (scripts/damodaran-parse.ts). We serve figures
// with attribution and a link to his page; we don't mirror his files.
// Terms: docs/DATA_SOURCES.md §8.

import { ToolError } from "./errors";

export type IndustryRegion = "US" | "Europe" | "Global";

export interface IndustryRow {
  industry: string;
  firms: number | null;
  beta: number | null;
  de_ratio: number | null;
  effective_tax_rate: number | null;
  unlevered_beta: number | null;
  cash_to_firm_value: number | null;
  unlevered_beta_cash_corrected: number | null;
  cost_of_equity: number | null;
  equity_weight: number | null;
  cost_of_debt_pretax: number | null;
  after_tax_cost_of_debt: number | null;
  debt_weight: number | null;
  cost_of_capital: number | null;
}

export interface CountryRow {
  country: string;
  region: string | null;
  moodys_rating: string | null;
  default_spread: number | null;
  equity_risk_premium: number | null;
  country_risk_premium: number | null;
  /** What the premium is based on: a Moody's rating, or (frontier markets) a PRS risk score. */
  basis?: string;
}

export interface DatasetMeta {
  url: string;
  page: string;
  updated: string | null; // the date in the workbook, else the file's Last-Modified
}

export interface DamodaranData {
  schema: 1;
  fetched_at: string;
  mature_market_erp: number | null;
  us_erp: number | null;
  /** Assumptions embedded in his US$ cost-of-capital tables. */
  wacc_assumptions: Record<IndustryRegion, { riskfree: number | null; erp: number | null; marginal_tax: number | null }>;
  industries: Record<IndustryRegion, IndustryRow[]>;
  countries: CountryRow[];
  datasets: Record<string, DatasetMeta>;
}

export const DAMODARAN_PAGE = "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datacurrent.html";
const LICENSE =
  "Aswath Damodaran, NYU Stern, public datasets (pages.stern.nyu.edu/~adamodar), shared freely; acknowledge the source.";

/** Lowercase words with punctuation dropped: "R.E.I.T." -> "reit", "Banks (Regional)" -> "banks regional". */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Common names that are not Damodaran's spelling (and must never fall through to a substring match). */
const COUNTRY_ALIASES: Record<string, string> = {
  uk: "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  england: "united kingdom",
  us: "united states",
  usa: "united states",
  "united states of america": "united states",
  america: "united states",
  uae: "united arab emirates",
  "south korea": "korea",
  "republic of korea": "korea",
  "north korea": "korea dpr",
  czechia: "czech republic",
  turkiye: "turkey",
  "north macedonia": "macedonia",
  holland: "netherlands",
  "the netherlands": "netherlands",
  "viet nam": "vietnam",
  drc: "congo democratic republic of",
};
const INDUSTRY_ALIASES: Record<string, string> = { reits: "reit", "real estate investment trust": "reit" };

const singular = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

export type MatchKind = "exact" | "partial";

/**
 * Exact name (or alias) first. Otherwise every query word must appear as a whole
 * word in the name (plural-insensitive). Never a raw substring: "UK" must not
 * match "Ukraine". Partial matches are labeled so the model confirms the entity.
 */
function find<T>(rows: T[], key: (r: T) => string, q: string, aliases: Record<string, string>): Array<T & { match: MatchKind }> {
  const n0 = norm(q);
  const n = aliases[n0] ?? n0;
  const exact = rows.filter((r) => norm(key(r)) === n);
  if (exact.length) return exact.map((r) => ({ ...r, match: "exact" as const }));
  const words = n.split(" ").filter(Boolean).map(singular);
  if (!words.length) return [];
  return rows
    .filter((r) => {
      const have = new Set(norm(key(r)).split(" ").map(singular));
      return words.every((w) => have.has(w));
    })
    .map((r) => ({ ...r, match: "partial" as const }));
}

function source(d: DamodaranData, dataset: string, id: string) {
  const meta = d.datasets[dataset];
  return {
    name: `Aswath Damodaran, ${dataset}`,
    url: meta?.url ?? DAMODARAN_PAGE,
    accession_or_id: id,
    period: meta?.updated ?? "",
    as_of: meta?.updated ?? "",
    license_note: LICENSE,
  };
}

export function countryPremium(d: DamodaranData, country: string) {
  const hits = find(d.countries, (c) => c.country, country, COUNTRY_ALIASES);
  if (!hits.length) {
    throw new ToolError(
      `No country matches ${JSON.stringify(country)} in Damodaran's country risk premiums. ` +
        "Use the English country name, e.g. 'France', 'United States', 'Germany'.",
    );
  }
  if (hits.length > 5) {
    throw new ToolError(`${hits.length} countries match ${JSON.stringify(country)}; be more specific (e.g. ${hits.slice(0, 3).map((h) => h.country).join(", ")}).`);
  }
  return hits.map((c) => ({
    ...c,
    mature_market_erp: d.mature_market_erp,
    source: source(d, "Country Default Spreads and Risk Premiums", `ctryprem/${c.country}`),
  }));
}

export function industryInputs(d: DamodaranData, region: IndustryRegion, industry: string) {
  const rows = d.industries[region] ?? [];
  const hits = find(rows, (r) => r.industry, industry, INDUSTRY_ALIASES);
  if (!hits.length) {
    throw new ToolError(
      `No ${region} industry matches ${JSON.stringify(industry)}. Call valuation_inputs with no industry ` +
        "to list Damodaran's industry names, then retry with one of them.",
    );
  }
  if (hits.length > 8) {
    throw new ToolError(`${hits.length} industries match; be more specific (e.g. ${hits.slice(0, 4).map((h) => h.industry).join(", ")}).`);
  }
  const a = d.wacc_assumptions[region];
  return hits.map((r) => ({
    region,
    ...r,
    sources: [
      source(d, `Betas by Sector (${region})`, `betas/${region}/${r.industry}`),
      source(d, `Cost of Capital by Industry (${region})`, `wacc/${region}/${r.industry}`),
    ],
    note:
      "cost_of_equity and cost_of_capital are Damodaran's US$ estimates using his own risk-free rate " +
      `(${a?.riskfree ?? "n/a"}) and ERP (${a?.erp ?? "n/a"}) at the update date. For a current WACC, prefer ` +
      "unlevered_beta_cash_corrected, relevered at the company's D/E, with today's risk_free_rate.",
  }));
}

export function industryNames(d: DamodaranData, region: IndustryRegion): string[] {
  return (d.industries[region] ?? []).map((r) => r.industry);
}
