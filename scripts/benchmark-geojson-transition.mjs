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

function createRing(count, radius, offsetX, offsetY) {
  const coordinates = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    const radialOffset = radius * (1 + 0.14 * Math.sin(angle * 5));

    return [offsetX + Math.cos(angle) * radialOffset, offsetY + Math.sin(angle) * radialOffset];
  });

  coordinates.push([...coordinates[0]]);

  return coordinates;
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
