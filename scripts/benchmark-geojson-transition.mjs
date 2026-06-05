import {
  createGeoJsonTransitionPlan,
  interpolateGeoJsonTransitionPlan,
} from "../src/geojson-transition.ts";

const COUNTS = [64, 256, 1024];
const ALGORITHMS = ["resample", "vertex-union", "topology-plan"];
const BENCHMARK_PROGRESS = 0.5;

for (const algorithm of ALGORITHMS) {
  console.log(`\nAlgorithm: ${algorithm}`);

  for (const count of COUNTS) {
    const from = createFeatureCollection("from", createRing(count, 20, 0, 0));
    const to = createFeatureCollection("to", createRing(count + 8, 24, 8, 6));
    const iterations = getIterationCount(count, algorithm);
    const plan = createGeoJsonTransitionPlan(from, to, {
      algorithm,
      maxCoordinatesPerRing: Math.min(count + 8, 512),
      minCoordinatesPerRing: 32,
    });
    const planMs = measure(() => {
      createGeoJsonTransitionPlan(from, to, {
        algorithm,
        maxCoordinatesPerRing: Math.min(count + 8, 512),
        minCoordinatesPerRing: 32,
      });
    }, iterations);
    const interpolateMs = measure(() => {
      interpolateGeoJsonTransitionPlan(plan, BENCHMARK_PROGRESS);
    }, iterations);

    console.log(
      `${String(count).padStart(4)} ring coords  plan=${planMs.toFixed(3)} ms  interpolate=${interpolateMs.toFixed(
        3,
      )} ms`,
    );
  }
}

console.log("\nComplex topology scenarios:");

for (const scenario of createComplexScenarios()) {
  const iterations = 25;
  const plan = createGeoJsonTransitionPlan(scenario.from, scenario.to, scenario.options);
  const planMs = measure(() => {
    createGeoJsonTransitionPlan(scenario.from, scenario.to, scenario.options);
  }, iterations);
  const interpolateMs = measure(() => {
    interpolateGeoJsonTransitionPlan(plan, BENCHMARK_PROGRESS);
  }, iterations);

  console.log(
    `${scenario.name}  plan=${planMs.toFixed(3)} ms  interpolate=${interpolateMs.toFixed(3)} ms`,
  );
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

function createComplexScenarios() {
  return [
    {
      from: {
        features: [
          {
            geometry: {
              geometries: [
                { coordinates: [0, 0], type: "Point" },
                { coordinates: createLine(64, 0, 0, 12, 4), type: "LineString" },
                { coordinates: [createRing(128, 12, 0, 0)], type: "Polygon" },
              ],
              type: "GeometryCollection",
            },
            id: "mixed",
            properties: null,
            type: "Feature",
          },
        ],
        type: "FeatureCollection",
      },
      name: "geometry-collection-mixed",
      options: {
        algorithm: "topology-plan",
        maxCoordinatesPerRing: 256,
        minCoordinatesPerRing: 32,
        partMatchingStrategy: "auto",
      },
      to: {
        features: [
          {
            geometry: {
              geometries: [
                { coordinates: [8, 4], type: "Point" },
                { coordinates: createLine(64, 4, 8, 16, 6), type: "LineString" },
                { coordinates: [createRing(136, 14, 6, 4)], type: "Polygon" },
              ],
              type: "GeometryCollection",
            },
            id: "mixed",
            properties: null,
            type: "Feature",
          },
        ],
        type: "FeatureCollection",
      },
    },
    {
      from: createMultiPolygonFeatureCollection("islands", [
        createRing(128, 8, 0, 0),
        createRing(128, 8, 30, 0),
      ]),
      name: "multipolygon-reordered-islands",
      options: {
        algorithm: "topology-plan",
        maxCoordinatesPerRing: 256,
        minCoordinatesPerRing: 32,
        partMatchingStrategy: "auto",
      },
      to: createMultiPolygonFeatureCollection("islands", [
        createRing(128, 8, 30, 0),
        createRing(128, 8, 0, 0),
      ]),
    },
    {
      from: createMultiPolygonFeatureCollection("source", [createRing(128, 16, 0, 0)]),
      name: "multipolygon-one-to-many-islands",
      options: {
        algorithm: "topology-plan",
        maxCoordinatesPerRing: 256,
        minCoordinatesPerRing: 32,
        partMatchingStrategy: "auto",
      },
      to: createMultiPolygonFeatureCollection("target", [
        createRing(128, 8, -8, 0),
        createRing(128, 8, 8, 0),
      ]),
    },
  ];
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

function createRing(count, radius, offsetX, offsetY) {
  const coordinates = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    const radialOffset = radius * (1 + 0.14 * Math.sin(angle * 5));

    return [offsetX + Math.cos(angle) * radialOffset, offsetY + Math.sin(angle) * radialOffset];
  });

  coordinates.push([...coordinates[0]]);

  return coordinates;
}

function createLine(count, offsetX, offsetY, width, height) {
  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 0 : index / (count - 1);

    return [
      offsetX + progress * width,
      offsetY + Math.sin(progress * Math.PI * 2) * height,
    ];
  });
}

function measure(run, iterations) {
  const startedAt = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    run();
  }

  return (performance.now() - startedAt) / iterations;
}

function getIterationCount(count, algorithm) {
  if (algorithm === "topology-plan") {
    return count >= 1024 ? 10 : 25;
  }

  return count >= 1024 ? 25 : 50;
}
