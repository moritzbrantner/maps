#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHeatMapDensityIndex } from "../src/heat-map.tsx";
import {
  createTemporalGeoJsonPlaybackIndex,
  getTemporalGeoJsonFeatureCollectionAtTime,
} from "../src/temporal-geojson-geometries.ts";
import {
  createGeoJsonTransitionPlan,
  interpolateGeoJsonTransitionPlan,
} from "../src/geojson-transition.ts";
import { createScalarFieldGrid } from "../src/scalar-field.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "benchmark-results");
const outputPath = path.join(outputDir, "maps-benchmark-summary.json");
const budgetMultiplier = Number(process.env.MAPS_BENCHMARK_BUDGET_MULTIPLIER ?? "1");

const benchmarks = [
  benchmarkTemporalGeoJson(),
  benchmarkGeoJsonTransition(),
  benchmarkScalarField(),
  benchmarkHeatAggregation(),
];
const failures = benchmarks.filter((item) => item.stats.p95 > item.budgetMs);

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      benchmarks,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${path.relative(rootDir, outputPath)}`);

for (const benchmark of benchmarks) {
  console.log(
    `${benchmark.name}: p95=${benchmark.stats.p95.toFixed(2)}ms budget=${benchmark.budgetMs.toFixed(
      2,
    )}ms`,
  );
}

if (failures.length > 0) {
  console.error("Benchmark budget verification failed:");

  for (const failure of failures) {
    console.error(
      `- ${failure.name}: p95 ${failure.stats.p95.toFixed(2)}ms exceeded ${failure.budgetMs.toFixed(
        2,
      )}ms`,
    );
  }

  process.exit(1);
}

function benchmarkTemporalGeoJson() {
  const coordinateCount = 512;
  const tracks = createTemporalTracks(coordinateCount);
  const options = {
    maxCoordinatesPerLine: 256,
    maxCoordinatesPerRing: 256,
    minResampleCoordinates: 32,
    strategy: "resample",
  };
  const playbackIndex = createTemporalGeoJsonPlaybackIndex(tracks, options);

  return createBenchmarkResult(
    "temporal-geojson-indexed-playback",
    100,
    measureStats(() => {
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, options);
      playbackIndex.getFeatureCollectionAtTime(5);
    }),
    {
      coordinateCount,
      strategy: options.strategy,
    },
  );
}

function benchmarkGeoJsonTransition() {
  const coordinateCount = 256;
  const from = createFeatureCollection("from", createRing(coordinateCount, 20, 0, 0));
  const to = createFeatureCollection("to", createRing(coordinateCount + 8, 24, 8, 6));

  return createBenchmarkResult(
    "geojson-transition-topology-plan",
    500,
    measureStats(() => {
      const plan = createGeoJsonTransitionPlan(from, to, {
        algorithm: "topology-plan",
        maxCoordinatesPerRing: 256,
        minCoordinatesPerRing: 32,
      });

      interpolateGeoJsonTransitionPlan(plan, 0.5);
    }),
    {
      algorithm: "topology-plan",
      coordinateCount,
    },
  );
}

function benchmarkScalarField() {
  const columns = 320;
  const rows = 200;
  const points = createTemperaturePoints();

  return createBenchmarkResult(
    "scalar-field-grid",
    1_500,
    measureStats(() => {
      createScalarFieldGrid(points, {
        domainBounds: [-25, 34, 35, 66],
        fieldColumns: columns,
        fieldRows: rows,
        interpolationK: 10,
        interpolationPower: 2,
        valueMetric: "temperature",
      });
    }),
    {
      cells: columns * rows,
      points: points.length,
    },
  );
}

function benchmarkHeatAggregation() {
  const pointCount = 10_000;
  const points = createMapPoints(pointCount);

  return createBenchmarkResult(
    "heat-map-density-index",
    1_000,
    measureStats(() => {
      const index = createHeatMapDensityIndex(points, {
        radius: 56,
        weightMetric: "demand",
      });

      index.getFeatureCollection({
        bounds: [5, 45, 16, 56],
        zoom: 6,
      });
    }),
    {
      pointCount,
    },
  );
}

function createBenchmarkResult(name, baseBudgetMs, stats, metadata) {
  return {
    budgetMs: baseBudgetMs * budgetMultiplier,
    metadata,
    name,
    stats,
  };
}

function measureStats(callback) {
  const warmups = 2;
  const runs = 8;
  const samples = [];

  for (let index = 0; index < warmups; index += 1) {
    callback();
  }

  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();

    callback();
    samples.push(performance.now() - startedAt);
  }

  samples.sort((left, right) => left - right);

  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    min: samples[0],
    p95: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
  };
}

function createTemporalTracks(count) {
  return [
    {
      frames: [
        {
          geometry: {
            coordinates: createLine(count, 0, 0, 120, 20),
            type: "LineString",
          },
          time: 0,
        },
        {
          geometry: {
            coordinates: createLine(count, 10, 15, 130, 36),
            type: "LineString",
          },
          time: 10,
        },
      ],
      id: `line-${count}`,
    },
    {
      frames: [
        {
          geometry: {
            coordinates: [createRing(count, 20, 0, 0)],
            type: "Polygon",
          },
          time: 0,
        },
        {
          geometry: {
            coordinates: [createRing(count, 24, 8, 6)],
            type: "Polygon",
          },
          time: 10,
        },
      ],
      id: `polygon-${count}`,
    },
  ];
}

function createFeatureCollection(id, ring) {
  return {
    features: [
      {
        geometry: {
          coordinates: [ring],
          type: "Polygon",
        },
        id,
        properties: null,
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };
}

function createLine(count, offsetX, offsetY, width, height) {
  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 0 : index / (count - 1);
    const wave = Math.sin(progress * Math.PI * 6) * (height / 6);

    return [offsetX + progress * width, offsetY + progress * height + wave];
  });
}

function createRing(count, radius, offsetX, offsetY) {
  const coordinates = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    const radialOffset = radius * (1 + 0.14 * Math.sin(angle * 5));

    return [offsetX + Math.cos(angle) * radialOffset, offsetY + Math.sin(angle) * radialOffset];
  });

  coordinates.push([...coordinates[0]]);

  return coordinates;
}

function createTemperaturePoints() {
  return [
    temperaturePoint("reykjavik", 64.1466, -21.9426, 14.3),
    temperaturePoint("dublin", 53.3498, -6.2603, 15.8),
    temperaturePoint("london", 51.5072, -0.1276, 18.5),
    temperaturePoint("paris", 48.8566, 2.3522, 20.9),
    temperaturePoint("berlin", 52.52, 13.405, 21.5),
    temperaturePoint("madrid", 40.4168, -3.7038, 28.6),
    temperaturePoint("rome", 41.9028, 12.4964, 29.4),
    temperaturePoint("warsaw", 52.2297, 21.0122, 22.4),
    temperaturePoint("athens", 37.9838, 23.7275, 31.2),
    temperaturePoint("stockholm", 59.3293, 18.0686, 17.1),
  ];
}

function temperaturePoint(id, latitude, longitude, temperature) {
  return {
    id,
    latitude,
    longitude,
    metrics: {
      temperature,
    },
  };
}

function createMapPoints(count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt(index / count);

    return {
      id: `point-${index}`,
      latitude: 52.52 + Math.sin(angle) * radius * 4,
      longitude: 13.405 + Math.cos(angle) * radius * 6,
      metrics: {
        demand: 1 + (index % 17),
      },
    };
  });
}
