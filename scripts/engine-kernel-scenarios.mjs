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


import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const scenarioRoot = new URL("../engine-scenarios/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", scenarioRoot), "utf8"));
export const kernelScenarioIds = manifest.scenarios
  .filter(({ capabilities }) => capabilities.includes("bun-kernel"))
  .map(({ id }) => id);

export function prepareKernelScenario(id) {
  assert(kernelScenarioIds.includes(id), `unknown kernel scenario: ${id}`);
  const bytes = readFileSync(new URL(`${id}.json`, scenarioRoot));
  const scenario = JSON.parse(bytes);
  assert.equal(scenario.id, id);
  assert.equal(scenario.kind, "kernel");
  const { fixture } = scenario;
  let run;
  let metadata;
  switch (fixture.generator) {
    case "line-and-ring-v1": {
      const tracks = createTemporalTracks(fixture.coordinateCount);
      const index = createTemporalGeoJsonPlaybackIndex(tracks, fixture.options);
      metadata = { coordinateCount: fixture.coordinateCount, strategy: fixture.options.strategy };
      run = () => {
        const raw = getTemporalGeoJsonFeatureCollectionAtTime(tracks, fixture.time, fixture.options);
        return { raw, indexed: index.getFeatureCollectionAtTime(fixture.time) };
      };
      break;
    }
    case "ring-transition-v1":
    case "multipart-ring-transition-v1": {
      const count = fixture.coordinateCount;
      const complex = fixture.generator === "multipart-ring-transition-v1";
      const from = complex
        ? createMultiPolygonFeatureCollection("source", [createRing(count, 12, 0, 0), createRing(count, 10, 32, 0)])
        : createFeatureCollection("from", createRing(count, 20, 0, 0));
      const to = complex
        ? createMultiPolygonFeatureCollection("target", [createRing(count, 10, 32, 0), createRing(count, 12, 0, 0), createRing(count, 8, 16, 18)])
        : createFeatureCollection("to", createRing(count + 8, 24, 8, 6));
      metadata = { algorithm: fixture.options.algorithm, coordinateCount: count,
        ...(complex ? { partMatchingStrategy: fixture.options.partMatchingStrategy } : {}) };
      run = () => interpolateGeoJsonTransitionPlan(createGeoJsonTransitionPlan(from, to, fixture.options), fixture.progress);
      break;
    }
    case "europe-temperature-observations-v1": {
      const points = createTemperaturePoints();
      metadata = { cells: fixture.columns * fixture.rows, points: points.length };
      run = () => createScalarFieldGrid(points, { ...fixture.options, fieldColumns: fixture.columns, fieldRows: fixture.rows });
      break;
    }
    case "berlin-phyllotaxis-demand-v1": {
      const points = createMapPoints(fixture.pointCount);
      metadata = { pointCount: points.length };
      run = () => createHeatMapDensityIndex(points, fixture.options).getFeatureCollection(fixture.query);
      break;
    }
    default:
      throw new Error(`unknown kernel fixture generator: ${fixture.generator}`);
  }
  return { scenario, metadata, run, scenarioSha256: createHash("sha256").update(bytes).digest("hex") };
}

export function measureKernelScenario(id) {
  const workload = prepareKernelScenario(id);
  const { warmups, runs } = workload.scenario.sampling;
  assert(Number.isInteger(warmups) && warmups >= 0, "invalid warmups");
  assert(Number.isInteger(runs) && runs > 0, "invalid runs");
  for (let index = 0; index < warmups; index++) workload.run();
  const samples = [];
  let result;
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    result = workload.run();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    scenarioId: id,
    name: workload.scenario.legacyBenchmark,
    scenarioSha256: workload.scenarioSha256,
    observationSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    metadata: workload.metadata,
    stats: { mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      min: samples[0], p95: samples[Math.ceil(samples.length * 0.95) - 1] },
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

function createMultiPolygonFeatureCollection(id, rings) {
  return {
    features: [
      {
        geometry: {
          coordinates: rings.map((ring) => [ring]),
          type: "MultiPolygon",
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
