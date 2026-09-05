import { afterEach, describe, expect, test } from "vitest";

import { createPointAggregationIndex } from "./aggregation";
import {
  configureMapsAggregationRuntime,
  createMapsAggregationCandidateIndex,
  initializeMapsAggregationWasm,
  resetMapsAggregationRuntimeForTests,
  setMapsAggregationWasmRuntimeForTests,
  type MapsAggregationCandidateIndex,
  type MapsAggregationCandidatePoint,
  type MapsAggregationCandidateResult,
  type MapsAggregationDiagnostic,
} from "./aggregation-runtime";

afterEach(() => {
  resetMapsAggregationRuntimeForTests();
});

describe("Maps aggregation Rust candidate", () => {
  test("builds the candidate once and reuses it across viewport queries", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];
    const builds: string[][] = [];
    const queries: number[] = [];

    setMapsAggregationWasmRuntimeForTests({
      createIndex(points) {
        builds.push(points.map((point) => point.id));
        return createPointCandidateIndex(points, queries);
      },
    });
    configureMapsAggregationRuntime({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    const index = createPointAggregationIndex(
      [
        { id: "berlin", latitude: 52.52, longitude: 13.405, metrics: { demand: 2 } },
        { id: "stuttgart", latitude: 48.7758, longitude: 9.1829, metrics: { demand: 3 } },
      ],
      { maxZoom: 16 },
    );
    const query = {
      bounds: [8, 47, 14, 53] as [number, number, number, number],
      zoom: 17,
    };

    expect(index.getViewportAggregation(query).features).toHaveLength(2);
    expect(index.getViewportAggregation({ ...query, zoom: 18 }).features).toHaveLength(2);
    expect(builds).toEqual([["berlin", "stuttgart"]]);
    expect(queries).toEqual([17, 18]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((event) => event.matched === true)).toBe(true);
  });

  test("disables and disposes the candidate after the first semantic mismatch", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];
    let queries = 0;
    let disposals = 0;

    setMapsAggregationWasmRuntimeForTests({
      createIndex() {
        return {
          dispose() {
            disposals += 1;
          },
          getClusterExpansionZoom() {
            return 0;
          },
          getClusterLeaves() {
            return [];
          },
          getPointById() {
            return null;
          },
          getViewportAggregation(query) {
            queries += 1;
            return emptyCandidateResult(query.bounds, query.zoom);
          },
        };
      },
    });
    configureMapsAggregationRuntime({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    const index = createPointAggregationIndex([{ id: "a", latitude: 52.52, longitude: 13.405 }]);
    const query = { bounds: [12, 51, 14, 53] as [number, number, number, number], zoom: 17 };

    expect(index.getViewportAggregation(query).features).toHaveLength(1);
    expect(index.getViewportAggregation(query).features).toHaveLength(1);
    expect(queries).toBe(1);
    expect(disposals).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({ matched: false, mode: "candidate" }),
      expect.objectContaining({
        fallbackReason: expect.stringContaining("did not match"),
        mode: "fallback",
      }),
    ]);
  });

  test("exposes the complete persistent candidate contract and explicit disposal", () => {
    const points: MapsAggregationCandidatePoint[] = [
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
            return pointCandidateResult(points, query.bounds, query.zoom);
          },
        };
      },
    });

    const candidate = createMapsAggregationCandidateIndex(points, {});

    expect(candidate?.getPointById("a")?.label).toBe("A");
    expect(candidate?.getClusterLeaves(5)).toEqual(points);
    expect(candidate?.getClusterExpansionZoom(5)).toBe(7);
    candidate?.dispose();
    expect(disposed).toBe(true);
  });

  test("fails closed when an explicit WASM package override cannot load", async () => {
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

function createPointCandidateIndex(
  points: readonly MapsAggregationCandidatePoint[],
  queries: number[],
): MapsAggregationCandidateIndex {
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
      return pointCandidateResult(points, query.bounds, query.zoom);
    },
  };
}

function pointCandidateResult(
  points: readonly MapsAggregationCandidatePoint[],
  bounds: [number, number, number, number],
  zoom: number,
): MapsAggregationCandidateResult {
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

function emptyCandidateResult(
  bounds: [number, number, number, number],
  zoom: number,
): MapsAggregationCandidateResult {
  return {
    features: [],
    summary: {
      bounds,
      metrics: {},
      visibleClusterCount: 0,
      visiblePointCount: 0,
      visibleUnclusteredCount: 0,
      zoom,
    },
  };
}
