import type { GeoJsonLayerProps, MapViewState } from "@moritzbrantner/maps";

export type BenchmarkPointProperties = {
  benchmarkIndex: number;
};

export type BenchmarkFeatureCollection =
  GeoJsonLayerProps<BenchmarkPointProperties>["featureCollection"];

export type BenchmarkSummary = {
  p50Ms: number;
  p95Ms: number;
  samples: number;
  totalMs: number;
};

export const BENCHMARK_INITIAL_VIEW: MapViewState = {
  center: [13.405, 52.52],
  zoom: 10.75,
};

export function createBenchmarkFeatureCollection(count: number): BenchmarkFeatureCollection {
  const resolvedCount = Math.max(1, Math.floor(count));
  const columns = Math.ceil(Math.sqrt(resolvedCount));
  const rowSpacing = 0.0018;
  const columnSpacing = 0.0028;

  return {
    type: "FeatureCollection",
    features: Array.from({ length: resolvedCount }, (_, benchmarkIndex) => {
      const column = benchmarkIndex % columns;
      const row = Math.floor(benchmarkIndex / columns);
      const longitude =
        BENCHMARK_INITIAL_VIEW.center[0] + (column - (columns - 1) / 2) * columnSpacing;
      const latitude =
        BENCHMARK_INITIAL_VIEW.center[1] - (row - (columns - 1) / 2) * rowSpacing;

      return {
        type: "Feature" as const,
        id: "benchmark-point-" + benchmarkIndex,
        properties: { benchmarkIndex },
        geometry: {
          type: "Point" as const,
          coordinates: [longitude, latitude] as [number, number],
        },
      };
    }),
  };
}

export function createBenchmarkJourney(stepCount: number): MapViewState[] {
  const resolvedCount = Math.max(1, Math.floor(stepCount));

  return Array.from({ length: resolvedCount }, (_, index) => ({
    center: [
      BENCHMARK_INITIAL_VIEW.center[0] + ((index % 5) - 2) * 0.0024,
      BENCHMARK_INITIAL_VIEW.center[1] + ((index % 4) - 1.5) * 0.0018,
    ],
    zoom: BENCHMARK_INITIAL_VIEW.zoom + ((index % 3) - 1) * 0.08,
  }));
}

export function summarizeBenchmarkSamples(samples: readonly number[]): BenchmarkSummary {
  if (samples.length === 0) {
    throw new Error("Benchmark samples must not be empty.");
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!;

  return {
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    samples: sorted.length,
    totalMs: sorted.reduce((total, sample) => total + sample, 0),
  };
}
