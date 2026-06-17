import { describe, expect, test } from "vitest";

import {
  demoHistoricalPolityScenes,
  formatDemoHistoricalPolityYear,
  getDemoHistoricalPolityFrame,
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
});
