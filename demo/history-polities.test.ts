import { describe, expect, test } from "vitest";

import {
  demoHistoricalPolityScenes,
  formatDemoHistoricalPolityYear,
  getDemoHistoricalPolityFrame,
  getDemoHistoricalPolityPlaybackFrame,
  getDemoHistoricalPolityRenderFeatureId,
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
    expect(
      playbackFrame.features.some(
        (feature) => String(feature.properties?.transitionKind ?? "").length > 0,
      ),
    ).toBe(true);
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

    expect(Math.min(...ringLengths)).toBeGreaterThan(5);
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

    expect(sharedIds.length).toBeGreaterThanOrEqual(12);
  });
});
