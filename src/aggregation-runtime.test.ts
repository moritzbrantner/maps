import { afterEach, describe, expect, test } from "vitest";

import { createPointAggregationIndex } from "./aggregation";
import {
  configureMapsAggregationRuntime,
  initializeMapsAggregationWasm,
  resetMapsAggregationRuntimeForTests,
  setMapsAggregationWasmRuntimeForTests,
  type MapsAggregationDiagnostic,
} from "./aggregation-runtime";

afterEach(() => {
  resetMapsAggregationRuntimeForTests();
});

describe("Maps aggregation Rust candidate", () => {
  test("compares a matching candidate without changing the control result", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];
    const calls: Array<{ ids: string[]; zoom: number }> = [];

    setMapsAggregationWasmRuntimeForTests({
      aggregateViewport(points, query) {
        calls.push({
          ids: points.map((point) => point.id),
          zoom: query.zoom,
        });
        return {
          features: points.map((point) => ({
            coordinates: [point.longitude, point.latitude],
            kind: "point" as const,
            metrics: point.metrics,
            pointId: point.id,
          })),
        };
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
    const result = index.getViewportAggregation({
      bounds: [8, 47, 14, 53],
      zoom: 17,
    });

    expect(result.features).toHaveLength(2);
    expect(calls).toEqual([{ ids: ["berlin", "stuttgart"], zoom: 17 }]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        backend: "wasm",
        candidateFeatureCount: 2,
        controlFeatureCount: 2,
        matched: true,
        mode: "candidate",
      }),
    ]);
  });

  test("disables the candidate after the first semantic mismatch", () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];
    let calls = 0;

    setMapsAggregationWasmRuntimeForTests({
      aggregateViewport() {
        calls += 1;
        return { features: [] };
      },
    });
    configureMapsAggregationRuntime({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    const index = createPointAggregationIndex([{ id: "a", latitude: 52.52, longitude: 13.405 }]);
    const query = { bounds: [12, 51, 14, 53] as [number, number, number, number], zoom: 17 };

    expect(index.getViewportAggregation(query).features).toHaveLength(1);
    expect(index.getViewportAggregation(query).features).toHaveLength(1);
    expect(calls).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({ matched: false, mode: "candidate" }),
      expect.objectContaining({
        fallbackReason: expect.stringContaining("did not match"),
        mode: "fallback",
      }),
    ]);
  });

  test("fails closed when no public WASM package is configured", async () => {
    const diagnostics: MapsAggregationDiagnostic[] = [];

    const initialized = await initializeMapsAggregationWasm({
      onDiagnostic: (event) => diagnostics.push(event),
    });

    expect(initialized).toBe(false);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        fallbackReason: "No public Maps WASM package configured.",
        mode: "fallback",
      }),
    ]);
  });
});
