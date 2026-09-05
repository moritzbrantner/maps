import { describe, expect, it } from "vitest";

import { createMapsRustRuntimeFromModule } from "./rust-runtime";

class FakePointAggregationIndex {
  constructor(
    readonly points: readonly unknown[],
    readonly options: Record<string, unknown>,
  ) {}

  getClusterExpansionZoom() {
    return 7;
  }

  getClusterLeaves() {
    return [
      {
        id: "42",
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ];
  }

  getPointById(pointId: string) {
    return pointId === "42"
      ? {
          id: "42",
          label: "Karlsruhe",
          latitude: 49,
          longitude: 8,
          metrics: { demand: 3 },
        }
      : null;
  }

  getViewportAggregation() {
    return {
      features: [
        {
          clusterId: 11,
          coordinates: [8, 49],
          expansionZoom: 7,
          kind: "cluster",
          metrics: { demand: 3 },
          pointCount: 1,
          pointCountAbbreviated: "1",
        },
      ],
      summary: {
        bounds: [7, 48, 9, 50],
        metrics: { demand: 3 },
        visibleClusterCount: 1,
        visiblePointCount: 1,
        visibleUnclusteredCount: 0,
        zoom: 6,
      },
    };
  }
}

describe("Maps Rust runtime adapter", () => {
  it("keeps transport encoding narrow and normalizes ids before crossing WASM", () => {
    let receivedPoints: unknown;
    const runtime = createMapsRustRuntimeFromModule({
      boundsFromMapPoints(points) {
        receivedPoints = points;
        return [7, 48, 9, 50];
      },
      normalizeMapPoints(points) {
        receivedPoints = points;
        return [
          {
            id: "42",
            label: "Karlsruhe",
            latitude: 49,
            longitude: 8,
            metrics: { demand: 3 },
          },
        ];
      },
    });

    const points = [
      {
        id: 42,
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ];

    expect(runtime.normalizePoints(points)).toEqual([
      {
        id: "42",
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ]);
    expect(receivedPoints).toEqual([
      {
        id: "42",
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ]);
    expect(runtime.boundsFromPoints(points)).toEqual([7, 48, 9, 50]);
  });

  it("wraps the Maps-owned point aggregation candidate without hydrating app properties", () => {
    const runtime = createMapsRustRuntimeFromModule({
      boundsFromMapPoints() {
        return null;
      },
      MapsPointAggregationIndex: FakePointAggregationIndex,
      normalizeMapPoints() {
        return [];
      },
    });
    const point = {
      id: "42",
      label: "Karlsruhe",
      latitude: 49,
      longitude: 8,
      metrics: { demand: 3 },
    };
    const index = runtime.createPointAggregationIndex([point], { radius: 72 });

    expect(index.getViewportAggregation({ bounds: [7, 48, 9, 50], zoom: 6 })).toMatchObject({
      features: [{ clusterId: 11, kind: "cluster", metrics: { demand: 3 } }],
      summary: { visiblePointCount: 1 },
    });
    expect(index.getClusterExpansionZoom(11)).toBe(7);
    expect(index.getClusterLeaves(11)).toEqual([point]);
    expect(index.getPointById("42")).toEqual(point);
    expect(index.getPointById("missing")).toBeNull();
  });

  it("fails closed when point aggregation is unavailable or malformed", () => {
    const runtime = createMapsRustRuntimeFromModule({
      boundsFromMapPoints() {
        return [7, 48, 9, 50];
      },
      normalizeMapPoints() {
        return [];
      },
    });

    expect(() => runtime.createPointAggregationIndex([])).toThrow(
      "Maps WASM point aggregation is unavailable.",
    );

    const malformed = createMapsRustRuntimeFromModule({
      boundsFromMapPoints() {
        return null;
      },
      MapsPointAggregationIndex: class extends FakePointAggregationIndex {
        override getViewportAggregation() {
          return { features: [{ kind: "cluster" }], summary: {} };
        }
      },
      normalizeMapPoints() {
        return [];
      },
    });

    expect(() =>
      malformed.createPointAggregationIndex([]).getViewportAggregation({
        bounds: [-180, -85, 180, 85],
        zoom: 2,
      }),
    ).toThrow("Maps WASM returned invalid viewport aggregation summary.");
  });

  it("rejects malformed normalization and bounds results", () => {
    const runtime = createMapsRustRuntimeFromModule({
      boundsFromMapPoints() {
        return [7, 48, Number.NaN, 50];
      },
      normalizeMapPoints() {
        return [{ id: "point-1" }];
      },
    });

    expect(() => runtime.boundsFromPoints([])).toThrow("Maps WASM returned invalid bounds.");
    expect(() => runtime.normalizePoints([])).toThrow(
      "Maps WASM returned an invalid normalized point.",
    );
  });
});
