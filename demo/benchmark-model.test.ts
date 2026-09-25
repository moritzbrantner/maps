import { describe, expect, it } from "vitest";

import {
  BENCHMARK_INITIAL_VIEW,
  createBenchmarkFeatureCollection,
  createBenchmarkJourney,
  summarizeBenchmarkSamples,
} from "./benchmark-model";

describe("benchmark model", () => {
  it("creates a deterministic dense point fixture without random input", () => {
    const first = createBenchmarkFeatureCollection(9);
    const second = createBenchmarkFeatureCollection(9);

    expect(second).toEqual(first);
    expect(first.features).toHaveLength(9);
    expect(first.features[0]).toMatchObject({
      id: "benchmark-point-0",
      geometry: { type: "Point" },
      properties: { benchmarkIndex: 0 },
    });
    expect(first.features[8]).toMatchObject({
      id: "benchmark-point-8",
      properties: { benchmarkIndex: 8 },
    });
  });

  it("creates a bounded deterministic camera journey from the Maps scenario anchor", () => {
    const journey = createBenchmarkJourney(6);

    expect(journey).toHaveLength(6);
    expect(journey[0]?.center[0]).toBeCloseTo(BENCHMARK_INITIAL_VIEW.center[0] - 0.0048, 8);
    expect(new Set(journey.map((state) => state.zoom)).size).toBe(3);
  });

  it("summarizes browser observations without turning them into a verdict", () => {
    expect(summarizeBenchmarkSamples([5, 1, 4, 2, 3])).toEqual({
      p50Ms: 3,
      p95Ms: 5,
      samples: 5,
      totalMs: 15,
    });
  });
});
