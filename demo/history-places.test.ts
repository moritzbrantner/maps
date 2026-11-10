import { describe, expect, test } from "vitest";

import {
  getHistoricalMapFeatureDateOptions,
  isHistoricalMapFeatureApplicable,
  resolveHistoricalMapFeatureName,
} from "@moritzbrantner/maps";

import {
  demoHistoricalPlaceAttribution,
  demoHistoricalPlaceLocales,
  demoHistoricalPlaceRecords,
  demoHistoricalPlaces,
  getDemoHistoricalPlacesAt,
  isDemoHistoricalPlaceId,
} from "./data/history-places";
import {
  demoHistoricalPolityScenarios,
  getDemoHistoricalPolityBoundaryStatus,
  getDemoHistoricalPolityRecords,
  getDemoHistoricalPolityScenario,
  getDemoHistoricalPolitySceneForYear,
} from "./data/history-polities";

const placeIdsAt = (year: number) =>
  getDemoHistoricalPlacesAt(year).map((place) => place.record.id);
const record = (id: string) => demoHistoricalPlaceRecords.find((candidate) => candidate.id === id)!;

describe("illustrative History place pins (#231 phase A)", () => {
  test("every place and name is attributed as an illustrative fixture", () => {
    expect(demoHistoricalPlaceAttribution).toMatch(/illustrative/i);
    expect(demoHistoricalPlaceAttribution).toMatch(/not historical evidence/i);

    for (const place of demoHistoricalPlaces) {
      expect(place.record.id).toMatch(/^illustrative-place-/);
      expect(place.record.attribution).toBe(demoHistoricalPlaceAttribution);
      expect(place.record.modernName).toMatch(/illustrative/i);
      expect(
        place.record.names!.every((name) => name.attribution === demoHistoricalPlaceAttribution),
      ).toBe(true);
    }
  });

  test("the applicable places follow the map year over direct and out-of-order seeks", () => {
    const expected: Record<number, string[]> = {
      1816: ["illustrative-place-ford", "illustrative-place-beacon"],
      1885: ["illustrative-place-ford", "illustrative-place-beacon"],
      1886: ["illustrative-place-ford", "illustrative-place-market"],
      1944: ["illustrative-place-ford", "illustrative-place-market"],
      1945: ["illustrative-place-market"],
      1988: ["illustrative-place-market"],
      1989: ["illustrative-place-market", "illustrative-place-beacon"],
      2019: ["illustrative-place-market", "illustrative-place-beacon"],
    };

    // The answer depends only on the year sought, never on the order of the seeks.
    for (const year of [1945, 1816, 2019, 1886, 1885, 1989, 1944, 1988, 1816, 1945]) {
      expect(placeIdsAt(year), `year ${year}`).toEqual(expected[year]);
    }
  });

  test("a place keeps one stable Map Feature ID through its supported rename", () => {
    const ford = record("illustrative-place-ford");

    expect(resolveHistoricalMapFeatureName(ford, 1913, "en")?.text).toBe("Sample Ford");
    expect(resolveHistoricalMapFeatureName(ford, 1914, "en")?.text).toBe("Sample Bridge");
    expect(resolveHistoricalMapFeatureName(ford, 1886, "en")?.text).toBe("Sample Ford");
    expect(isHistoricalMapFeatureApplicable(ford, 1913)).toBe(true);
    expect(isHistoricalMapFeatureApplicable(ford, 1914)).toBe(true);
    expect(placeIdsAt(1913)).toContain(ford.id);
    expect(placeIdsAt(1914)).toContain(ford.id);
    // Out of period no name applies: the modern name is never shown as a historical one.
    expect(resolveHistoricalMapFeatureName(ford, 1945, "en")).toBeNull();
  });

  test("names follow the viewer language and flag the source-form fallback", () => {
    const ford = record("illustrative-place-ford");

    expect(demoHistoricalPlaceLocales).toEqual(["en", "de", "es"]);
    expect(resolveHistoricalMapFeatureName(ford, 1816, "de")).toMatchObject({
      language: "de",
      original: { language: "la", text: "Vadum Exempli" },
      sourceFormFallback: false,
      text: "Beispielfurt",
    });
    expect(resolveHistoricalMapFeatureName(ford, 1816, "es")?.text).toBe("Vado de Ejemplo");
    // The renamed period has no Spanish form: the original form is shown and flagged.
    expect(resolveHistoricalMapFeatureName(ford, 1939, "es")).toMatchObject({
      language: "de",
      sourceFormFallback: true,
      text: "Beispielbrücke",
    });
  });

  test("every mini-timeline date of a place is a year at which it applies", () => {
    for (const place of demoHistoricalPlaces) {
      const options = getHistoricalMapFeatureDateOptions(
        place.record,
        { end: 2019, start: 1816 },
        1,
      );

      expect(options.length).toBeGreaterThan(0);
      expect(options.every((option) => option.available)).toBe(true);
      expect(options.every((option) => placeIdsAt(option.time).includes(place.record.id))).toBe(
        true,
      );
    }
  });

  test("place IDs never collide with polity IDs", () => {
    for (const scenario of demoHistoricalPolityScenarios) {
      for (const polity of getDemoHistoricalPolityRecords(scenario.id)) {
        expect(isDemoHistoricalPlaceId(polity.id)).toBe(false);
      }
    }
  });
});

describe("History polity selection records (#231 phase A)", () => {
  test("a polity applies exactly while a held milestone snapshot contains it", () => {
    for (const scenario of demoHistoricalPolityScenarios) {
      const records = getDemoHistoricalPolityRecords(scenario.id);
      const first = scenario.scenes[0]!.year;
      const last = scenario.scenes.at(-1)!.year;
      const probes = scenario.scenes.flatMap((scene, index) => {
        const next = scenario.scenes[index + 1]?.year ?? scene.year;
        return [scene.year, (scene.year + next) / 2];
      });

      // Probed out of order on purpose.
      for (const time of [...probes].reverse().concat(first, last)) {
        const scene = getDemoHistoricalPolitySceneForYear(time, scenario.id);
        const drawn = scene.collection.features
          .map((feature) => feature.properties!.polityId)
          .sort();
        const applicable = records
          .filter((polity) => isHistoricalMapFeatureApplicable(polity, time))
          .map((polity) => polity.id)
          .sort();

        expect(applicable, `${scenario.id} at ${time}`).toEqual(drawn);
      }
    }
  });

  test("supported dates are only milestone years whose snapshot contains the polity", () => {
    const scenario = getDemoHistoricalPolityScenario("european-states");
    const records = getDemoHistoricalPolityRecords("european-states");
    const austriaHungary = records.find((polity) => polity.id === "300-austria-hungary")!;

    expect(austriaHungary.supportedDates?.map((date) => date.time)).toEqual([1816, 1886, 1914]);
    expect(austriaHungary.periods).toEqual([
      { end: 1939, label: "snapshot held 1816 AD until 1939 AD", start: 1816 },
    ]);
    expect(isHistoricalMapFeatureApplicable(austriaHungary, 1938)).toBe(true);
    expect(isHistoricalMapFeatureApplicable(austriaHungary, 1939)).toBe(false);

    for (const polity of records) {
      for (const date of polity.supportedDates ?? []) {
        expect(scenario.scenes.some((scene) => scene.year === date.time)).toBe(true);
        expect(isHistoricalMapFeatureApplicable(polity, date.time)).toBe(true);
      }
    }
  });

  test("a polity absent from intermediate snapshots gets separate periods, not a bridge", () => {
    const iceland = getDemoHistoricalPolityRecords("european-states").find(
      (polity) => polity.id === "395-iceland",
    )!;

    expect(iceland.periods.map(({ end, start }) => [start, end])).toEqual([
      [1816, 1886],
      [1945, undefined],
    ]);
    expect(isHistoricalMapFeatureApplicable(iceland, 1914)).toBe(false);
  });

  test("polities with different dataset IDs are never linked, however similar their names", () => {
    const records = getDemoHistoricalPolityRecords("european-states");
    const germany1816 = records.find((polity) => polity.id === "255-germany")!;
    const germanyPrussia = records.find((polity) => polity.id === "255-germany-prussia")!;

    expect(isHistoricalMapFeatureApplicable(germany1816, 1886)).toBe(false);
    expect(isHistoricalMapFeatureApplicable(germanyPrussia, 1816)).toBe(false);
    expect(germany1816.supportedDates?.map((date) => date.time)).toEqual([1816]);
  });

  test("polity names come from the dataset and are flagged as a fallback in other languages", () => {
    const france = getDemoHistoricalPolityRecords("european-states").find(
      (polity) => polity.id === "220-france",
    )!;

    expect(resolveHistoricalMapFeatureName(france, 1900, "en")).toMatchObject({
      sourceFormFallback: false,
      text: "France",
    });
    expect(resolveHistoricalMapFeatureName(france, 1900, "de")).toMatchObject({
      sourceFormFallback: true,
      text: "France",
    });
    expect(france.modernName).toBeUndefined();
  });

  test("boundary status separates source-derived snapshots from illustrative control areas", () => {
    expect(
      getDemoHistoricalPolityBoundaryStatus(
        { sourceFrom: 1886, sourceTo: 1918 },
        "european-states",
      ),
    ).toMatchObject({
      kind: "source-derived",
      source: "CShapes-Europe record 1886–1918",
    });
    expect(
      getDemoHistoricalPolityBoundaryStatus({ sourceFrom: 1886, sourceTo: 1918 }, "european-states")
        .limitation,
    ).toMatch(/not an authoritative historical boundary source/);
    expect(
      getDemoHistoricalPolityBoundaryStatus({ sourceFrom: 1938, sourceTo: 1944 }, "wwii-control"),
    ).toMatchObject({ kind: "illustrative", label: "Illustrative boundary" });
  });
});
