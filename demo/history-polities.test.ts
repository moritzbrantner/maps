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
  test("returns exact and interpolated Historical Polity frames with AD labels", () => {
    const exactFrame = getDemoHistoricalPolityFrame(800);

    expect(exactFrame).toBe(demoHistoricalPolityScenes[0]?.collection);
    expect(exactFrame.features[0]?.properties?.sceneYear).toBe(800);

    const interpolatedFrame = getDemoHistoricalPolityFrame(900);

    expect(interpolatedFrame).not.toBe(exactFrame);
    expect(interpolatedFrame.features.length).toBeGreaterThan(0);
    expect(
      interpolatedFrame.features.every(
        (feature) =>
          feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon",
      ),
    ).toBe(true);

    expect(getDemoHistoricalPolityFrame(700)).toBe(demoHistoricalPolityScenes[0]?.collection);
    expect(getDemoHistoricalPolityFrame(2100)).toBe(demoHistoricalPolityScenes.at(-1)?.collection);
    expect(formatDemoHistoricalPolityYear(800)).toBe("800 AD");
    expect(formatDemoHistoricalPolityYear(2000)).toBe("2000 AD");
  });

  test("returns continuity frames for playback at internal epoch milestones", () => {
    const playbackFrame = getDemoHistoricalPolityPlaybackFrame(1000);

    expect(playbackFrame).not.toBe(demoHistoricalPolityScenes[1]?.collection);
    expect(playbackFrame.features.length).toBeGreaterThan(0);
    expect(countVisiblePolities(playbackFrame)).toBeLessThanOrEqual(18);
    expect(playbackFrame.features.every((feature) => !feature.properties?.transitionKind)).toBe(
      true,
    );
  });

  test("keeps the 1198 AD playback frame free of topology residual slivers", () => {
    const playbackFrame = getDemoHistoricalPolityPlaybackFrame(1198);

    expect(countVisiblePolities(playbackFrame)).toBeLessThanOrEqual(18);
    expect(playbackFrame.features.every((feature) => !feature.properties?.transitionKind)).toBe(
      true,
    );
  });

  test("uses more detailed polygon rings than simple bounding boxes", () => {
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

    expect(Math.min(...ringLengths)).toBeGreaterThanOrEqual(24);
  });

  test("publishes conditioned Historical Polity Scenes with explicit lineage metadata", () => {
    for (const scene of demoHistoricalPolityScenes) {
      for (const feature of scene.collection.features) {
        expect(feature.properties?.lineage).toEqual({
          entersFrom: expect.any(Array),
          exitsTo: expect.any(Array),
          morphGroup: expect.any(String),
        });
        expect(feature.properties?.conditioned).toBe(true);
      }
    }
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
                  precision: "approximate",
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
        code: "undetailed-ring",
        message: "Historical Polity polygon rings must use at least 24 coordinates.",
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

  test("keeps render feature ids stable while passing 1200 AD", () => {
    const beforeIds = new Set(
      getDemoHistoricalPolityPlaybackFrame(1199.9).features.map((feature) =>
        getDemoHistoricalPolityRenderFeatureId(feature, 1199.9),
      ),
    );
    const afterIds = new Set(
      getDemoHistoricalPolityPlaybackFrame(1200.1).features.map((feature) =>
        getDemoHistoricalPolityRenderFeatureId(feature, 1200.1),
      ),
    );
    const sharedIds = [...beforeIds].filter((id) => afterIds.has(id));

    expect(sharedIds.length).toBeGreaterThanOrEqual(10);
  });

  test("keeps render feature ids stable between adjacent dragged years", () => {
    for (let year = 1000; year < 1200; year += 1) {
      const currentIds = getPlaybackRenderFeatureIds(year);
      const nextIds = getPlaybackRenderFeatureIds(year + 1);

      expect(nextIds).toEqual(currentIds);
    }
  });

  test("reuses prepared playback frames for integer timeline years", () => {
    expect(getDemoHistoricalPolityPlaybackFrame(1198)).toBe(
      getDemoHistoricalPolityPlaybackFrame(1198),
    );
    expect(getDemoHistoricalPolityPlaybackFrame(1200)).toBe(
      getDemoHistoricalPolityPlaybackFrame(1200),
    );
  });

  test("uses lineage metadata to seed entering Historical Polity geometry", () => {
    const frame = getDemoHistoricalPolityPlaybackFrame(900);
    const france = frame.features.find((feature) => feature.properties?.polityId === "france");
    const sceneFrance = demoHistoricalPolityScenes[1]?.collection.features.find(
      (feature) => feature.properties?.polityId === "france",
    );

    expect(france?.properties?.displayOpacity).toBeCloseTo(0.5);
    expect(france?.geometry).not.toEqual(sceneFrance?.geometry);
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
