// Real ESEF reports (extracted facts) and builders shared by the ESEF and server tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EsefFilingMeta, ExtractedFiling } from "../src/esef/extract";
import { buildEuRecord, type EuIssuer } from "../src/esef/record";

const FIX = join(import.meta.dirname, "fixtures", "esef");
export const esefFixture = (id: string) => JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8")) as ExtractedFiling;

export const meta = (id: string, published: string): EsefFilingMeta => ({
  fxo_id: id,
  processed: published,
  published,
  country: id.split("-ESEF-")[1]!.split("-")[0]!,
  viewer_url: `/${id}/reports/ixbrlviewer.html`,
  report_url: null,
  package_url: null,
});

export const TTE: EuIssuer = { lei: "529900S21EQ1BO4ESM68", name: "TotalEnergies SE", country: "FR" };
export const ITX: EuIssuer = { lei: "549300TTCXZOGZM2EY83", name: "INDUSTRIA DE DISEÑO TEXTIL, S.A.", country: "ES" };

export const tteRecord = () =>
  buildEuRecord(TTE, [
    { meta: meta("529900S21EQ1BO4ESM68-2024-12-31-ESEF-FR-0", "2025-03-19"), data: esefFixture("529900S21EQ1BO4ESM68-2024-12-31-ESEF-FR-0") },
    { meta: meta("529900S21EQ1BO4ESM68-2025-12-31-ESEF-FR-0", "2026-03-18"), data: esefFixture("529900S21EQ1BO4ESM68-2025-12-31-ESEF-FR-0") },
  ]);

