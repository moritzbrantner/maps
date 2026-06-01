import { describe, expect, test } from "vitest";

import {
  createMapDensityViewportSummary,
  createPointAggregationIndex,
  getBoundsFromPoints,
  type MapPoint,
} from ".";

type TestPoint = MapPoint<{
  city: string;
}>;

describe("@moritzbrantner/maps aggregation", () => {
  test("aggregates metric totals into clusters and preserves visible counts", () => {
    const index = createPointAggregationIndex<{ city: string }>([
      {
        id: "a",
        latitude: 40.7128,
        longitude: -74.006,
        metrics: { demand: 8, revenue: 1200 },
        properties: { city: "New York" },
      },
      {
        id: "b",
        latitude: 40.7134,
        longitude: -74.002,
        metrics: { demand: 5, revenue: 900 },
        properties: { city: "New York" },
      },
      {
        id: "c",
        latitude: 34.0522,
        longitude: -118.2437,
        metrics: { demand: 2, revenue: 300 },
        properties: { city: "Los Angeles" },
      },
    ]);

    const aggregation = index.getViewportAggregation({
      bounds: [-180, -85, 180, 85],
      zoom: 2,
    });

    expect(aggregation.summary.visiblePointCount).toBe(3);
    expect(aggregation.summary.metrics.revenue).toBe(2400);
    expect(createMapDensityViewportSummary(aggregation)).toMatchObject({
      itemCount: 3,
      kind: "map",
      metrics: { demand: 15, revenue: 2400 },
      visiblePointCount: 3,
    });
    expect(aggregation.features.some((feature) => feature.kind === "cluster")).toBe(true);
  });

  test("returns cluster leaves as original points", () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      id: `point-${index}`,
      latitude: 52.52 + index * 0.0002,
      longitude: 13.405 + index * 0.0002,
      metrics: { orders: 1 },
      properties: { city: "Berlin" },
    }));
    const index = createPointAggregationIndex(points);
    const aggregation = index.getViewportAggregation({
      bounds: [13.3, 52.4, 13.6, 52.7],
      zoom: 4,
    });
    const cluster = aggregation.features.find((feature) => feature.kind === "cluster");

    expect(cluster?.kind).toBe("cluster");

    const leaves = index.getClusterLeaves(cluster!.clusterId, 5, 0);

    expect(leaves).toHaveLength(5);
    expect(leaves[0]?.properties.city).toBe("Berlin");
  });

  test("filters points before building cluster totals", () => {
    const index = createPointAggregationIndex(
      [
        {
          id: "berlin-a",
          latitude: 52.52,
          longitude: 13.405,
          metrics: { orders: 3, revenue: 300 },
          properties: { city: "Berlin" },
        },
        {
          id: "berlin-b",
          latitude: 52.5204,
          longitude: 13.4054,
          metrics: { orders: 2, revenue: 180 },
          properties: { city: "Berlin" },
        },
        {
          id: "paris-a",
          latitude: 48.8566,
          longitude: 2.3522,
          metrics: { orders: 7, revenue: 700 },
          properties: { city: "Paris" },
        },
      ],
      {
        filterPoint(point) {
          return point.properties.city === "Berlin";
        },
      },
    );

    const aggregation = index.getViewportAggregation({
      bounds: [-180, -85, 180, 85],
      zoom: 6,
    });

    expect(aggregation.summary.visiblePointCount).toBe(2);
    expect(aggregation.summary.metrics.orders).toBe(5);
    expect(aggregation.summary.metrics.revenue).toBe(480);
    expect(index.getPointById("paris-a")).toBeNull();
  });

  test("returns leaves only from the filtered subset", () => {
    const index = createPointAggregationIndex(
      Array.from({ length: 20 }, (_, pointIndex) => ({
        id: `point-${pointIndex}`,
        latitude: 52.52 + pointIndex * 0.0002,
        longitude: 13.405 + pointIndex * 0.0002,
        metrics: { orders: 1 },
        properties: {
          city: pointIndex % 2 === 0 ? "Berlin" : "Hamburg",
        },
      })),
      {
        filterPoint(point) {
          return point.properties.city === "Berlin";
        },
      },
    );
    const aggregation = index.getViewportAggregation({
      bounds: [13.3, 52.4, 13.6, 52.7],
      zoom: 4,
    });
    const cluster = aggregation.features.find((feature) => feature.kind === "cluster");

    expect(cluster?.kind).toBe("cluster");
    expect(cluster?.pointCount).toBe(10);

    const leaves = index.getClusterLeaves(cluster!.clusterId, 10, 0);

    expect(leaves).toHaveLength(10);
    expect(leaves.every((point) => point.properties.city === "Berlin")).toBe(true);
  });

  test("keeps totals intact for large datasets", () => {
    const points = createSyntheticPoints(100_000);
    const index = createPointAggregationIndex(points, {
      radius: 64,
    });
    const aggregation = index.getViewportAggregation({
      bounds: [-180, -85, 180, 85],
      zoom: 1,
    });

    expect(aggregation.summary.visiblePointCount).toBe(100_000);
    expect(aggregation.summary.metrics.weight).toBe(5_050_000);
  });

  test("computes a bounding box from raw points", () => {
    const bounds = getBoundsFromPoints([
      { latitude: 10, longitude: 20 },
      { latitude: 14, longitude: 18 },
      { latitude: 9, longitude: 22 },
    ]);

    expect(bounds).toEqual([18, 9, 22, 14]);
  });

  test("ignores non-finite point coordinates in bounds and aggregation", () => {
    const index = createPointAggregationIndex([
      { id: "valid", latitude: 10, longitude: 20, metrics: { count: 1 } },
      { id: "invalid-latitude", latitude: Number.NaN, longitude: 18, metrics: { count: 100 } },
      { id: "invalid-longitude", latitude: 9, longitude: Number.POSITIVE_INFINITY, metrics: { count: 100 } },
    ]);
    const aggregation = index.getViewportAggregation({
      bounds: [-180, -85, 180, 85],
      zoom: 12,
    });

    expect(getBoundsFromPoints([
      { latitude: Number.NaN, longitude: 1 },
      { latitude: 10, longitude: 20 },
      { latitude: 12, longitude: Number.POSITIVE_INFINITY },
    ])).toEqual([20, 10, 20, 10]);
    expect(aggregation.summary.visiblePointCount).toBe(1);
    expect(aggregation.summary.metrics.count).toBe(1);
    expect(index.getPointById("invalid-latitude")).toBeNull();
  });

  test("normalizes missing point fields and stringifies generated ids", () => {
    const index = createPointAggregationIndex([{ latitude: 52.52, longitude: 13.405 }]);
    const point = index.getPointById("0");

    expect(point).toMatchObject({
      id: "0",
      label: "",
      latitude: 52.52,
      longitude: 13.405,
      metrics: {},
      properties: {},
    });
  });

  test("drops non-finite metric values from summaries", () => {
    const index = createPointAggregationIndex([
      {
        id: "a",
        latitude: 52.52,
        longitude: 13.405,
        metrics: { invalid: Number.NaN, orders: 2 },
      },
      {
        id: "b",
        latitude: 52.5201,
        longitude: 13.4051,
        metrics: { invalid: Number.POSITIVE_INFINITY, orders: 3 },
      },
    ]);
    const aggregation = index.getViewportAggregation({
      bounds: [13.3, 52.4, 13.6, 52.7],
      zoom: 4,
    });

    expect(aggregation.summary.metrics).toEqual({ orders: 5 });
    expect(createMapDensityViewportSummary(aggregation).metricKeys).toEqual(["orders"]);
  });

  test("deduplicates antimeridian-crossing viewport features", () => {
    const index = createPointAggregationIndex([
      { id: "east", latitude: 0, longitude: 179.8, metrics: { count: 1 } },
      { id: "west", latitude: 0, longitude: -179.8, metrics: { count: 1 } },
    ]);
    const aggregation = index.getViewportAggregation({
      bounds: [170, -10, -170, 10],
      zoom: 12,
    });
    const pointIds = aggregation.features
      .filter((feature) => feature.kind === "point")
      .map((feature) => feature.point.id)
      .sort();

    expect(aggregation.summary.visiblePointCount).toBe(2);
    expect(pointIds).toEqual(["east", "west"]);
  });

  test("uses visible point count for viewport summary item count", () => {
    const index = createPointAggregationIndex(
      Array.from({ length: 25 }, (_, index) => ({
        id: `point-${index}`,
        latitude: 52.52 + index * 0.0001,
        longitude: 13.405 + index * 0.0001,
        metrics: { orders: 1 },
      })),
    );
    const aggregation = index.getViewportAggregation({
      bounds: [13.3, 52.4, 13.6, 52.7],
      zoom: 4,
    });
    const summary = createMapDensityViewportSummary(aggregation);

    expect(aggregation.features.length).toBeLessThan(summary.itemCount);
    expect(summary.itemCount).toBe(25);
  });
});

function createSyntheticPoints(count: number): TestPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    latitude: -70 + (index % 140) * 0.9,
    longitude: -160 + (index % 320) * 1,
    metrics: { weight: 50.5 },
    properties: { city: "Synthetic" },
  }));
}
