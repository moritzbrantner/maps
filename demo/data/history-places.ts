import {
  isHistoricalMapFeatureApplicable,
  type HistoricalMapFeatureRecord,
} from "@moritzbrantner/maps";

/**
 * Explicitly ILLUSTRATIVE dated place pins for the History tab (#231 phase A).
 *
 * Every place, name, translation, period and position here is invented to exercise time-valid
 * point selection, a date-controlled rename and viewer-language labels. None of it is
 * historical evidence, and it is not part of the CShapes-Europe snapshots (ADR 0005).
 */
export const demoHistoricalPlaceAttribution =
  "Illustrative fixture invented for this demo — not historical evidence";

export const demoHistoricalPlaceLocales = ["en", "de", "es"] as const;

export type DemoHistoricalPlaceLocale = (typeof demoHistoricalPlaceLocales)[number];

export type DemoHistoricalPlace = {
  coordinates: [longitude: number, latitude: number];
  record: HistoricalMapFeatureRecord;
};

export const demoHistoricalPlaces: DemoHistoricalPlace[] = [
  {
    coordinates: [4.2, 46.9],
    record: {
      attribution: demoHistoricalPlaceAttribution,
      id: "illustrative-place-ford",
      modernName: "Sample Bridge (illustrative modern name)",
      names: [
        {
          attribution: demoHistoricalPlaceAttribution,
          end: 1914,
          localized: { de: "Beispielfurt", en: "Sample Ford", es: "Vado de Ejemplo" },
          original: { language: "la", script: "Latin", text: "Vadum Exempli" },
          start: 1816,
        },
        {
          attribution: demoHistoricalPlaceAttribution,
          end: 1945,
          // No Spanish form on purpose: Spanish viewers get the flagged source-form fallback.
          localized: { de: "Beispielbrücke", en: "Sample Bridge" },
          original: { language: "de", text: "Beispielbrücke" },
          start: 1914,
        },
      ],
      periods: [{ end: 1945, label: "1816–1944", start: 1816 }],
      supportedDates: [
        { label: "1816", time: 1816 },
        { label: "1886", time: 1886 },
        { label: "1914", time: 1914 },
        { label: "1939", time: 1939 },
      ],
    },
  },
  {
    coordinates: [15.4, 50.6],
    record: {
      attribution: demoHistoricalPlaceAttribution,
      id: "illustrative-place-market",
      modernName: "Sample Market (illustrative modern name)",
      names: [
        {
          attribution: demoHistoricalPlaceAttribution,
          localized: { de: "Beispielmarkt", en: "Sample Market", es: "Mercado de Ejemplo" },
          original: { language: "en", text: "Sample Market" },
          start: 1886,
        },
      ],
      periods: [{ label: "since 1886", start: 1886 }],
      supportedDates: [
        { label: "1886", time: 1886 },
        { label: "1939", time: 1939 },
        { label: "2019", time: 2019 },
      ],
    },
  },
  {
    coordinates: [-3.6, 40.3],
    record: {
      attribution: demoHistoricalPlaceAttribution,
      id: "illustrative-place-beacon",
      modernName: "Sample Beacon (illustrative modern name)",
      names: [
        {
          attribution: demoHistoricalPlaceAttribution,
          localized: { de: "Beispielfeuer", en: "Sample Beacon", es: "Faro de Ejemplo" },
          original: { language: "en", text: "Sample Beacon" },
          start: 1816,
        },
      ],
      // Two separate periods: the pin is absent between them and nothing bridges the gap.
      periods: [
        { end: 1886, label: "1816–1885", start: 1816 },
        { label: "since 1989", start: 1989 },
      ],
      supportedDates: [
        { label: "1816", time: 1816 },
        { label: "1989", time: 1989 },
        { label: "2019", time: 2019 },
      ],
    },
  },
];

export const demoHistoricalPlaceRecords: HistoricalMapFeatureRecord[] = demoHistoricalPlaces.map(
  (place) => place.record,
);

/** The illustrative places that apply at `year`, in fixture order. */
export function getDemoHistoricalPlacesAt(year: number) {
  return demoHistoricalPlaces.filter((place) =>
    isHistoricalMapFeatureApplicable(place.record, year),
  );
}

export function isDemoHistoricalPlaceId(featureId: string) {
  return demoHistoricalPlaces.some((place) => place.record.id === featureId);
}
