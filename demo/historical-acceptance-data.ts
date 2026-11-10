import type { HistoricalMapFeatureRecord } from "../src/historical-map-features";

/**
 * Explicitly synthetic, illustrative records for the historical selection acceptance (#170
 * phase D). The places, names and dates are invented test data, not historical evidence, and
 * are not part of the History tab's CShapes-Europe snapshots (ADR 0005).
 */
export const HISTORICAL_ACCEPTANCE_RECORDS: HistoricalMapFeatureRecord[] = [
  {
    attribution: "Synthetic fixture (illustrative, not a source)",
    id: "synthetic-harbour",
    modernName: "Modern Harbourtown (synthetic)",
    names: [
      {
        end: 1850,
        localized: { de: "Althafen", en: "Old Harbour" },
        original: { language: "la", text: "Portus Vetus" },
        start: 1800,
      },
      {
        end: 1900,
        localized: { en: "New Harbour" },
        original: { language: "de", text: "Neuhafen" },
        start: 1850,
      },
    ],
    periods: [{ end: 1900, label: "1800–1899", start: 1800 }],
    supportedDates: [
      { label: "1820", time: 1820 },
      { label: "1860", time: 1860 },
    ],
  },
  {
    attribution: "Synthetic fixture (illustrative, not a source)",
    id: "synthetic-mill",
    names: [{ localized: { de: "Mühle", en: "Mill" }, original: { text: "Mill" }, start: 1880 }],
    periods: [{ start: 1880 }],
  },
];

/** The point each synthetic place is drawn and picked at. */
export const HISTORICAL_ACCEPTANCE_POSITIONS: Record<string, [number, number]> = {
  "synthetic-harbour": [12.4, 52.2],
  "synthetic-mill": [13.6, 51.8],
};
