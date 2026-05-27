import { describe, expect, test } from "vitest";

import {
  createHeatLayerMetricSurfaceSpatialIndex,
  createHeatLayerSurfaceSpatialIndex,
  getHeatLayerCellDensityBruteForce,
  getHeatLayerCellDensityFromIndex,
  getHeatLayerMetricCellDensityBruteForce,
  getHeatLayerMetricCellDensityFromIndex,
  prepareHeatLayerColorRamp,
  resolveHeatLayerColor,
  resolveHeatLayerInterpolatedColor,
  type HeatLayerSurfaceSource,
  type MetricHeatLayerSurfaceSource,
} from "./heat-surface";

describe("heat-surface internals", () => {
  test("matches brute-force density for indexed pixel-space sources", () => {
    const sources = createSurfaceSources(240);
    const index = createHeatLayerSurfaceSpatialIndex(sources);

    for (const sample of createSamplePoints(80, 960, 640)) {
      expect(getHeatLayerCellDensityFromIndex(index, sample.x, sample.y)).toBeCloseTo(
        getHeatLayerCellDensityBruteForce(sources, sample.x, sample.y),
        12,
      );
    }
  });

  test("matches brute-force density for indexed metric-space sources", () => {
    const sources = createSurfaceSources(240).map((source): MetricHeatLayerSurfaceSource => ({
      ...source,
      dataInfluenceRadius: 85_000 + (Number(source.coordinate[0]) % 9) * 7_500,
      metricPoint: {
        x: source.point.x * 1_200 - 300_000,
        y: source.point.y * 1_100 + 150_000,
      },
    }));
    const index = createHeatLayerMetricSurfaceSpatialIndex(sources);

    for (const sample of createSamplePoints(80, 960, 640)) {
      const x = sample.x * 1_200 - 300_000;
      const y = sample.y * 1_100 + 150_000;

      expect(getHeatLayerMetricCellDensityFromIndex(index, x, y)).toBeCloseTo(
        getHeatLayerMetricCellDensityBruteForce(sources, x, y),
        12,
      );
    }
  });

  test("prepares color ramps without changing interpolated color output", () => {
    const ramp = prepareHeatLayerColorRamp([
      [1, "#ff0000"],
      [0, "rgba(0, 0, 0, 0)"],
      [0.5, "#00ff00"],
    ]);

    expect(resolveHeatLayerColor(ramp, 0.4)).toBe("#00ff00");
    expect(resolveHeatLayerInterpolatedColor(ramp, 0)).toBe("rgba(0, 0, 0, 0)");
    expect(resolveHeatLayerInterpolatedColor(ramp, 0.75)).toBe("rgba(128, 128, 0, 1)");
  });

  test("preserves invalid-color fallback behavior", () => {
    const ramp = prepareHeatLayerColorRamp([
      [0, "not-a-color"],
      [1, "#ff0000"],
    ]);

    expect(resolveHeatLayerInterpolatedColor(ramp, 0)).toBe("not-a-color");
    expect(resolveHeatLayerInterpolatedColor(ramp, 0.5)).toBe("#ff0000");
  });
});

function createSurfaceSources(count: number): HeatLayerSurfaceSource[] {
  return Array.from({ length: count }, (_, index) => {
    const x = 480 + Math.sin(index * 1.919) * 520 + Math.cos(index * 0.071) * 40;
    const y = 320 + Math.cos(index * 1.377) * 360 + Math.sin(index * 0.053) * 35;
    const influenceRadius = 24 + (index % 17) * 8;

    return {
      coordinate: [index, index % 37],
      dataInfluenceRadius: null,
      influenceRadius,
      metricPoint: {
        x: x * 1_000,
        y: y * 1_000,
      },
      point: {
        x,
        y,
      },
      weight: 0.15 + (index % 13) / 9,
    };
  });
}

function createSamplePoints(count: number, width: number, height: number) {
  return Array.from({ length: count }, (_, index) => ({
    x: -80 + ((index * 73) % (width + 160)),
    y: -60 + ((index * 47) % (height + 120)),
  }));
}
