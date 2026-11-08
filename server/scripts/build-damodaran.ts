// Build snapshot/v1/damodaran.json from Damodaran's public workbooks.
// Usage: tsx scripts/build-damodaran.ts [--from <dir with the downloaded files>] [--out snapshot]
// Without --from it downloads the 7 files (about 1.5 MB) from pages.stern.nyu.edu.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as XLSX from "xlsx";
import { PRODUCT_NAME, REPO_URL } from "../src/config";
import { DAMODARAN_PAGE, type DamodaranData, type IndustryRegion } from "../src/damodaran";
import { DAMODARAN_BASE, FILES, mergeIndustries, parseBetas, parseCountries, parseWacc, validate } from "./damodaran-parse";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FROM = arg("from");
const OUT = resolve(arg("out") ?? "snapshot");
const UA = `${PRODUCT_NAME} snapshot build (+${REPO_URL})`;

async function load(file: string): Promise<{ wb: XLSX.WorkBook; lastModified: string | null }> {
  if (FROM) {
    const p = join(FROM, file);
    // A local copy's mtime is the download date, not Damodaran's update date: report it as unknown.
    return { wb: XLSX.read(readFileSync(p)), lastModified: null };
  }
  const res = await fetch(`${DAMODARAN_BASE}/${file}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const lm = res.headers.get("last-modified");
  return {
    wb: XLSX.read(new Uint8Array(await res.arrayBuffer())),
    lastModified: lm ? new Date(lm).toISOString().slice(0, 10) : null,
  };
}

const regions: IndustryRegion[] = ["US", "Europe", "Global"];
const data: DamodaranData = {
  schema: 1,
  fetched_at: new Date().toISOString(),
  mature_market_erp: null,
  us_erp: null,
  wacc_assumptions: {} as DamodaranData["wacc_assumptions"],
  industries: {} as DamodaranData["industries"],
  countries: [],
  datasets: {},
};

for (const region of regions) {
  const b = await load(FILES.betas[region]);
  const w = await load(FILES.wacc[region]);
  const betas = parseBetas(b.wb);
  const wacc = parseWacc(w.wb);
  data.industries[region] = mergeIndustries(betas.rows, wacc.rows);
  data.wacc_assumptions[region] = wacc.assumptions;
  data.datasets[`Betas by Sector (${region})`] = {
    url: `${DAMODARAN_BASE}/${FILES.betas[region]}`,
    page: DAMODARAN_PAGE,
    updated: betas.updated ?? b.lastModified,
  };
  data.datasets[`Cost of Capital by Industry (${region})`] = {
    url: `${DAMODARAN_BASE}/${FILES.wacc[region]}`,
    page: DAMODARAN_PAGE,
    updated: wacc.updated ?? w.lastModified,
  };
}

const c = await load(FILES.ctryprem);
const countries = parseCountries(c.wb);
data.countries = countries.countries;
data.mature_market_erp = countries.mature;
data.us_erp = countries.us;
// The date cell in this workbook is stale; the file's Last-Modified is the reliable update date.
data.datasets["Country Default Spreads and Risk Premiums"] = {
  url: `${DAMODARAN_BASE}/${FILES.ctryprem}`,
  page: DAMODARAN_PAGE,
  updated: c.lastModified,
};

validate(data);
mkdirSync(join(OUT, "v1"), { recursive: true });
writeFileSync(join(OUT, "v1", "damodaran.json"), JSON.stringify(data));
console.log(
  `damodaran.json: ${regions.map((r) => `${r} ${data.industries[r].length}`).join(", ")} industries, ` +
    `${data.countries.length} countries, US ERP ${data.us_erp}, mature ERP ${data.mature_market_erp}`,
);
