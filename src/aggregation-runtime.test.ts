import { afterEach, describe, expect, test } from "vitest";

import { createPointAggregationIndex } from "./aggregation";
import {
  configureMapsAggregationRuntime,
  createMapsAggregationRuntimeIndex,
  initializeMapsAggregationWasm,
  resetMapsAggregationRuntimeForTests,
  setMapsAggregationWasmRuntimeForTests,
  type MapsAggregationDiagnostic,
  type MapsAggregationRuntimeIndex,
  type MapsAggregationRuntimePoint,
  type MapsAggregationRuntimeResult,
} from "./aggregation-runtime";

afterEach(() => {
  resetMapsAggregationRuntimeForTests();
});

describe("Maps aggregation Rust authority", () => {
  test("builds the Rust index once and reuses it as the viewport authority", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];
    const builds: string[][] = [];
    const queries: number[] = [];

    setMapsAggregationWasmRuntimeForTests({
      createIndex(points) {
        builds.push(points.map((point) => point.id));
        return createPointRuntimeIndex(points, queries);
      },
    });
    configureMapsAggregationRuntime({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    const index = createPointAggregationIndex(
      [
        {
          id: "berlin",
          latitude: 52.52,
          longitude: 13.405,
          metrics: { demand: 2 },
          properties: { source: "application" },
        },
        { id: "stuttgart", latitude: 48.7758, longitude: 9.1829, metrics: { demand: 3 } },
      ],
      { maxZoom: 16 },
    );
    const query = {
      bounds: [8, 47, 14, 53] as [number, number, number, number],
      zoom: 17,
    };

    const first = index.getViewportAggregation(query);
    const second = index.getViewportAggregation({ ...query, zoom: 18 });

    expect(first.features).toHaveLength(2);
    expect(second.features).toHaveLength(2);
    expect(first.features[0]).toMatchObject({
      kind: "point",
      point: { id: "berlin", properties: { source: "application" } },
    });
    expect(builds).toEqual([["berlin", "stuttgart"]]);
    expect(queries).toEqual([17, 18]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ mode: "authoritative" }),
      expect.objectContaining({ featureCount: 2, mode: "authoritative" }),
      expect.objectContaining({ featureCount: 2, mode: "authoritative" }),
    ]);
  });

  test("uses Supercluster only when the Rust runtime is unavailable", () => {
    setMapsAggregationWasmRuntimeForTests(null);

    const index = createPointAggregationIndex([
      { id: "berlin", latitude: 52.52, longitude: 13.405, metrics: { demand: 2 } },
    ]);
    const aggregation = index.getViewportAggregation({
      bounds: [12, 51, 14, 53],
      zoom: 17,
    });

    expect(aggregation.features).toHaveLength(1);
    expect(aggregation.features[0]).toMatchObject({
      kind: "point",
      point: { id: "berlin" },
    });
  });

  test("fails closed when the selected Rust authority throws during a query", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];

    setMapsAggregationWasmRuntimeForTests({
      createIndex() {
        return {
          dispose() {},
          getClusterExpansionZoom() {
            return 0;
          },
          getClusterLeaves() {
            return [];
          },
          getPointById() {
            return null;
          },
          getViewportAggregation() {
            throw new Error("authoritative query failed");
          },
        };
      },
    });
    configureMapsAggregationRuntime({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    const index = createPointAggregationIndex([{ id: "a", latitude: 52.52, longitude: 13.405 }]);
    const query = { bounds: [12, 51, 14, 53] as [number, number, number, number], zoom: 17 };

    expect(() => index.getViewportAggregation(query)).toThrow("authoritative query failed");
    expect(diagnostics).toEqual([
      expect.objectContaining({ mode: "authoritative" }),
      expect.objectContaining({
        fallbackReason: "authoritative query failed",
        mode: "error",
      }),
    ]);
  });

  test("fails closed when the initialized Rust runtime cannot construct its index", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];

    setMapsAggregationWasmRuntimeForTests({
      createIndex() {
        throw new Error("authoritative build failed");
      },
    });
    configureMapsAggregationRuntime({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    expect(() =>
      createPointAggregationIndex([{ id: "a", latitude: 52.52, longitude: 13.405 }]),
    ).toThrow("authoritative build failed");
    expect(diagnostics).toEqual([
      expect.objectContaining({
        fallbackReason: "authoritative build failed",
        mode: "error",
      }),
    ]);
  });

  test("exposes the complete persistent Rust runtime contract and explicit disposal", () => {
    const points: MapsAggregationRuntimePoint[] = [
      { id: "a", label: "A", latitude: 52.52, longitude: 13.405, metrics: { demand: 2 } },
    ];
    let disposed = false;

    setMapsAggregationWasmRuntimeForTests({
      createIndex() {
        return {
          dispose() {
            disposed = true;
          },
          getClusterExpansionZoom() {
            return 7;
          },
          getClusterLeaves() {
            return points;
          },
          getPointById(pointId) {
            return pointId === "a" ? points[0] : null;
          },
          getViewportAggregation(query) {
            return pointRuntimeResult(points, query.bounds, query.zoom);
          },
        };
      },
    });

    const runtime = createMapsAggregationRuntimeIndex(points, {});

    expect(runtime?.getPointById("a")?.label).toBe("A");
    expect(runtime?.getClusterLeaves(5)).toEqual(points);
    expect(runtime?.getClusterExpansionZoom(5)).toBe(7);
    runtime?.dispose();
    expect(disposed).toBe(true);
  });

  test("reports the explicit no-WASM fallback when an override cannot load", async () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];

    const initialized = await initializeMapsAggregationWasm({
      onDiagnostic: (event) => diagnostics.push(event),
      wasmPackage: "@moritzbrantner/maps-missing-wasm-test",
    });

    expect(initialized).toBe(false);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        fallbackReason: expect.any(String),
        mode: "fallback",
      }),
    ]);
  });
});

function createPointRuntimeIndex(
  points: readonly MapsAggregationRuntimePoint[],
  queries: number[],
): MapsAggregationRuntimeIndex {
  return {
    dispose() {},
    getClusterExpansionZoom() {
      return 0;
    },
    getClusterLeaves() {
      return [...points];
    },
    getPointById(pointId) {
      return points.find((point) => point.id === pointId) ?? null;
    },
    getViewportAggregation(query) {
      queries.push(query.zoom);
      return pointRuntimeResult(points, query.bounds, query.zoom);
    },
  };
}

function pointRuntimeResult(
  points: readonly MapsAggregationRuntimePoint[],
  bounds: [number, number, number, number],
  zoom: number,
): MapsAggregationRuntimeResult {
  return {
    features: points.map((point) => ({
      coordinates: [point.longitude, point.latitude],
      kind: "point" as const,
      metrics: point.metrics,
      pointId: point.id,
    })),
    summary: {
      bounds,
      metrics: {},
      visibleClusterCount: 0,
      visiblePointCount: points.length,
      visibleUnclusteredCount: points.length,
      zoom,
    },
  };
}
