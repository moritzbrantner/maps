import { describe, expect, it } from "vitest";

import type { ViewportAggregation } from "./aggregation";
import { createPointClusterRenderFrame } from "./point-cluster-render-frame";

describe("createPointClusterRenderFrame", () => {
  it("copies only renderer inputs while preserving Maps feature identity", () => {
    const aggregation: ViewportAggregation<{ region: string }> = {
      features: [
        {
          clusterId: 7,
          coordinates: [9.1, 48.7],
          expansionZoom: 8,
          kind: "cluster",
          metrics: { demand: 12 },
          pointCount: 32,
          pointCountAbbreviated: "32",
        },
        {
          coordinates: [13.405, 52.52],
          kind: "point",
          metrics: { demand: 4 },
          point: {
            id: "berlin",
            label: "Berlin",
            latitude: 52.52,
            longitude: 13.405,
            metrics: { demand: 4 },
            properties: { region: "DACH" },
          },
        },
      ],
      summary: {
        bounds: [5, 45, 16, 55],
        metrics: { demand: 16 },
        visibleClusterCount: 1,
        visiblePointCount: 33,
        visibleUnclusteredCount: 1,
        zoom: 5,
      },
    };

    const frame = createPointClusterRenderFrame(aggregation);

    expect(frame.kind).toBe("point-cluster");
    expect(frame.summary).toBe(aggregation.summary);
    expect(frame.features).toEqual([
      expect.objectContaining({
        coordinates: [9.1, 48.7],
        expansionZoom: 8,
        fillColor: "#0284c7",
        id: "cluster:7",
        kind: "cluster",
        label: "32",
        radius: 24,
      }),
      expect.objectContaining({
        coordinates: [13.405, 52.52],
        fillColor: "#0f172a",
        id: "point:berlin",
        kind: "point",
        label: null,
        radius: 6,
      }),
    ]);
    expect(frame.features[0]?.feature).toBe(aggregation.features[0]);
    expect(frame.features[1]?.feature).toBe(aggregation.features[1]);
  });

  it("uses Maps-owned feature ids and deterministic cluster style thresholds", () => {
    const counts = [24, 25, 249, 250, 2_499, 2_500];
    const aggregation: ViewportAggregation = {
      features: counts.map((pointCount, index) => ({
        clusterId: index,
        coordinates: [index, index],
        expansionZoom: 10,
        kind: "cluster" as const,
        metrics: {},
        pointCount,
        pointCountAbbreviated: String(pointCount),
      })),
      summary: {
        bounds: [-180, -90, 180, 90],
        metrics: {},
        visibleClusterCount: counts.length,
        visiblePointCount: counts.reduce((total, count) => total + count, 0),
        visibleUnclusteredCount: 0,
        zoom: 4,
      },
    };

    const frame = createPointClusterRenderFrame(aggregation, (feature) => `maps:${feature.kind}`);

    expect(frame.features.map(({ fillColor, id, radius }) => ({ fillColor, id, radius }))).toEqual([
      { fillColor: "#0f766e", id: "maps:cluster", radius: 18 },
      { fillColor: "#0284c7", id: "maps:cluster", radius: 24 },
      { fillColor: "#0284c7", id: "maps:cluster", radius: 24 },
      { fillColor: "#7c3aed", id: "maps:cluster", radius: 32 },
      { fillColor: "#7c3aed", id: "maps:cluster", radius: 32 },
      { fillColor: "#ea580c", id: "maps:cluster", radius: 42 },
    ]);
  });
});
