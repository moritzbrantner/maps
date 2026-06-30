import { describe, expect, test } from "vitest";

import {
  demoHistoricalPolityScenes,
  formatDemoHistoricalPolityYear,
  getDemoHistoricalPolityFrame,
  getDemoHistoricalPolityPlaybackFrame,
  getDemoHistoricalPolityRenderFeatureId,
  isDemoHistoricalPolityVisibleFeature,
  validateDemoHistoricalPolityScenes,
} from "./data/history-polities";

describe("History demo polities", () => {
  test("publishes CShapes-Europe Historical Polity Scene snapshots for supported milestone years", () => {
    expect(demoHistoricalPolityScenes.map((scene) => scene.year)).toEqual([
      1816, 1886, 1914, 1939, 1945, 1989, 2019,
    ]);

    for (const scene of demoHistoricalPolityScenes) {
      expect(scene.collection.features.length).toBeGreaterThan(0);

      for (const feature of scene.collection.features) {
        expect(feature.properties).toMatchObject({
          kind: "historical-polity",
          sceneYear: scene.year,
          source: "CShapes-Europe",
          sourceId: expect.any(Number),
          sourceFrom: expect.any(Number),
          sourceTo: expect.any(Number),
          sourceStatus: "independent",
        });
      }
    }
  });

  test("returns exact and snapped Historical Polity frames with AD labels", () => {
    const exactFrame = getDemoHistoricalPolityFrame(1816);

    expect(exactFrame).toBe(demoHistoricalPolityScenes[0]?.collection);
    expect(exactFrame.features[0]?.properties?.sceneYear).toBe(1816);

    const snappedFrame = getDemoHistoricalPolityFrame(1900);

    expect(snappedFrame).toBe(demoHistoricalPolityScenes[1]?.collection);
    expect(snappedFrame.features.length).toBeGreaterThan(0);
    expect(
      snappedFrame.features.every(
        (feature) =>
          feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon",
      ),
    ).toBe(true);

    expect(getDemoHistoricalPolityFrame(1800)).toBe(demoHistoricalPolityScenes[0]?.collection);
    expect(getDemoHistoricalPolityFrame(2100)).toBe(demoHistoricalPolityScenes.at(-1)?.collection);
    expect(formatDemoHistoricalPolityYear(1816)).toBe("1816 AD");
    expect(formatDemoHistoricalPolityYear(2019)).toBe("2019 AD");
  });

  test("snaps playback to previous CShapes-Europe milestone without fade metadata", () => {
    const playbackFrame = getDemoHistoricalPolityPlaybackFrame(1900);

    expect(playbackFrame).toBe(demoHistoricalPolityScenes[1]?.collection);
    expect(playbackFrame.features.length).toBeGreaterThan(0);
    expect(countVisiblePolities(playbackFrame)).toBe(playbackFrame.features.length);
    expect(
      playbackFrame.features.every(
        (feature) =>
          !("displayOpacity" in feature.properties!) &&
          !("sourceIds" in feature.properties!) &&
          !("targetIds" in feature.properties!) &&
          !("transitionKind" in feature.properties!),
      ),
    ).toBe(true);
  });

  test("uses detailed source polygon rings rather than simple bounding boxes", () => {
    const ringLengths = demoHistoricalPolityScenes.flatMap((scene) =>
      scene.collection.features.flatMap((feature) => {
        if (feature.geometry?.type === "Polygon") {
          return feature.geometry.coordinates.map((ring) => ring.length);
        }

        if (feature.geometry?.type === "MultiPolygon") {
          return feature.geometry.coordinates.flatMap((polygon) =>
            polygon.map((ring) => ring.length),
          );
        }

        return [];
      }),
    );

    expect(Math.max(...ringLengths)).toBeGreaterThan(100);
  });

  test("validates Historical Polity Scene polygon quality", () => {
    expect(validateDemoHistoricalPolityScenes(demoHistoricalPolityScenes)).toEqual([]);
    expect(
      validateDemoHistoricalPolityScenes([
        {
          collection: {
            features: [
              {
                geometry: {
                  coordinates: [
                    [
                      [0, 0],
                      [1, 0],
                      [0, 1],
                    ],
                  ],
                  type: "Polygon",
                },
                id: "bad-polity",
                properties: {
                  kind: "historical-polity",
                  label: "Bad polity",
                  polityId: "bad-polity",
                  precision: "source-derived",
                  region: "central",
                  sceneYear: 900,
                },
                type: "Feature",
              },
            ],
            type: "FeatureCollection",
          },
          label: "900 AD",
          year: 900,
        },
      ]),
    ).toEqual([
      {
        code: "missing-source",
        message: "Historical Polity Scenes must include CShapes-Europe source metadata.",
        polityId: "bad-polity",
        sceneYear: 900,
      },
      {
        code: "unclosed-ring",
        message: "Historical Polity polygon rings must be closed.",
        polityId: "bad-polity",
        sceneYear: 900,
      },
    ]);
  });

  test("reports overlapping Historical Polities in the same scene", () => {
    expect(
      validateDemoHistoricalPolityScenes([
        {
          collection: {
            features: [
              squareFeature("left-polity", "Left polity", 0, 0, 2, 2),
              squareFeature("right-polity", "Right polity", 1, 1, 3, 3),
            ],
            type: "FeatureCollection",
          },
          label: "1900 AD",
          year: 1900,
        },
      ]),
    ).toEqual([
      {
        code: "overlapping-polities",
        message: "Historical Polity Scene features must not overlap each other.",
        polityId: "left-polity / right-polity",
        sceneYear: 1900,
      },
    ]);
  });

  test("keeps render feature ids stable inside a snapped milestone segment", () => {
    const beforeIds = new Set(
      getDemoHistoricalPolityPlaybackFrame(1900).features.map((feature) =>
        getDemoHistoricalPolityRenderFeatureId(feature, 1900),
      ),
    );
    const afterIds = new Set(
      getDemoHistoricalPolityPlaybackFrame(1910).features.map((feature) =>
        getDemoHistoricalPolityRenderFeatureId(feature, 1910),
      ),
    );

    expect(afterIds).toEqual(beforeIds);
  });

  test("keeps render feature ids stable between adjacent dragged years", () => {
    for (let year = 1886; year < 1913; year += 1) {
      const currentIds = getPlaybackRenderFeatureIds(year);
      const nextIds = getPlaybackRenderFeatureIds(year + 1);

      expect(nextIds).toEqual(currentIds);
    }
  });

  test("reuses prepared playback frames for integer timeline years", () => {
    expect(getDemoHistoricalPolityPlaybackFrame(1900)).toBe(
      getDemoHistoricalPolityPlaybackFrame(1900),
    );
    expect(getDemoHistoricalPolityPlaybackFrame(1914)).toBe(
      getDemoHistoricalPolityPlaybackFrame(1914),
    );
  });
});

function getPlaybackRenderFeatureIds(year: number) {
  return getDemoHistoricalPolityPlaybackFrame(year)
    .features.map((feature) => getDemoHistoricalPolityRenderFeatureId(feature, year))
    .sort();
}

function countVisiblePolities(frame: ReturnType<typeof getDemoHistoricalPolityPlaybackFrame>) {
  return frame.features.filter(isDemoHistoricalPolityVisibleFeature).length;
}

function squareFeature(
  polityId: string,
  label: string,
  west: number,
  south: number,
  east: number,
  north: number,
) {
  return {
    geometry: {
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
      type: "Polygon" as const,
    },
    id: polityId,
    properties: {
      kind: "historical-polity" as const,
      label,
      polityId,
      precision: "source-derived" as const,
      region: "central" as const,
      sceneYear: 1900,
      source: "CShapes-Europe" as const,
      sourceFrom: 1900,
      sourceId: Number(polityId.length),
      sourceStatus: "independent" as const,
      sourceTo: 1900,
    },
    type: "Feature" as const,
  };
}
