import { createProjectedClusterVoronoiGeometry } from "../src/cluster-area.ts";
import { createHeatMapDensityIndex } from "../src/heat-map.tsx";
import {
  configureMapsKernelRuntime,
  getMapsKernelRuntime,
  initializeMapsWasmKernels,
  resetMapsKernelRuntimeForTests,
} from "../src/kernels/runtime.ts";
import {
  resampleLineFlat as resampleLineFlatTypeScript,
  resampleRingFlat as resampleRingFlatTypeScript,
} from "../src/kernels/typescript-kernels.ts";
import {
  createTemporalMapPlaybackIndex,
  getTemporalMapPointsAtTime,
} from "../src/temporal-points.ts";

const TEMPORAL_TRACK_COUNTS = [128, 512, 2048];
const POINT_COUNTS = [1_000, 5_000, 10_000];
const CLUSTER_COUNTS = [32, 96, 160];
const KERNEL_COORDINATE_COUNTS = [32, 128, 512, 2048, 8192, 32768];
const QUERY_TIME = 4.5;

console.log("\nFlat resampling kernels");

const wasmInitialized = await initializeMapsWasmKernels({
  backend: "wasm",
  wasmPackage: process.env.MAPS_KERNELS_WASM_PACKAGE,
});

for (const count of KERNEL_COORDINATE_COUNTS) {
  const line = createFlatLine(count);
  const ring = createFlatRing(count);
  const outputCount = Math.min(count, 1024);
  const iterations = count >= 8192 ? 20 : 100;
  const lineTypeScriptMs = measure(() => {
    resampleLineFlatTypeScript(line, outputCount);
  }, iterations);
  const ringTypeScriptMs = measure(() => {
    resampleRingFlatTypeScript(ring, outputCount);
  }, iterations);

  let lineWasmSummary = "wasm=skipped";
  let ringWasmSummary = "wasm=skipped";

  if (wasmInitialized) {
    configureMapsKernelRuntime({
      backend: "wasm",
      wasmThresholdCoordinates: 0,
    });

    const runtime = getMapsKernelRuntime();
    const lineWasmMs = measure(() => {
      runtime.resampleLineFlat(line, outputCount);
    }, iterations);
    const ringWasmMs = measure(() => {
      runtime.resampleRingFlat(ring, outputCount);
    }, iterations);

    lineWasmSummary = `wasm=${lineWasmMs.toFixed(3)} ms speedup=${(
      lineTypeScriptMs / lineWasmMs
    ).toFixed(2)}x`;
    ringWasmSummary = `wasm=${ringWasmMs.toFixed(3)} ms speedup=${(
      ringTypeScriptMs / ringWasmMs
    ).toFixed(2)}x`;
  }

  console.log(
    `${String(count).padStart(6)} coords line ts=${lineTypeScriptMs.toFixed(
      3,
    )} ms ${lineWasmSummary}`,
  );
  console.log(
    `${String(count).padStart(6)} coords ring ts=${ringTypeScriptMs.toFixed(
      3,
    )} ms ${ringWasmSummary}`,
  );
}

resetMapsKernelRuntimeForTests();

console.log("\nTemporal point playback");

for (const trackCount of TEMPORAL_TRACK_COUNTS) {
  const tracks = createTemporalPointTracks(trackCount, 8);
  const index = createTemporalMapPlaybackIndex(tracks);
  const iterations = trackCount >= 2048 ? 20 : 50;
  const rawMs = measure(() => {
    getTemporalMapPointsAtTime(tracks, QUERY_TIME);
  }, iterations);
  const indexedMs = measure(() => {
    index.getPointsAtTime(QUERY_TIME);
  }, iterations);

  console.log(
    `${String(trackCount).padStart(5)} tracks raw=${rawMs.toFixed(
      3,
    )} ms indexed=${indexedMs.toFixed(3)} ms speedup=${(rawMs / indexedMs).toFixed(2)}x`,
  );
}

console.log("\nHeat map density index rebuild");

for (const pointCount of POINT_COUNTS) {
  const points = createMapPoints(pointCount);
  const iterations = pointCount >= 10_000 ? 5 : 10;
  const rebuildMs = measure(() => {
    createHeatMapDensityIndex(points, {
      radius: 48,
      weightMetric: "weight",
    });
  }, iterations);

  console.log(`${String(pointCount).padStart(6)} points rebuild=${rebuildMs.toFixed(3)} ms`);
}

console.log("\nCluster area Voronoi geometry");

for (const clusterCount of CLUSTER_COUNTS) {
  const inputs = createProjectedClusterInputs(clusterCount);
  const iterations = clusterCount >= 160 ? 5 : 10;
  const geometryMs = measure(() => {
    createProjectedClusterVoronoiGeometry(inputs, {
      includeOuterEdges: false,
      project: identity,
      unproject: identity,
      viewportBounds: [-24, -24, 1024, 768],
    });
  }, iterations);

  console.log(`${String(clusterCount).padStart(5)} clusters geometry=${geometryMs.toFixed(3)} ms`);
}

function createTemporalPointTracks(trackCount, frameCount) {
  return Array.from({ length: trackCount }, (_, trackIndex) => ({
    id: `track-${trackIndex}`,
    label: `Track ${trackIndex}`,
    metrics: {
      baseline: trackIndex % 9,
    },
    frames: Array.from({ length: frameCount }, (_, frameIndex) => ({
      latitude: 35 + Math.sin(trackIndex * 0.07 + frameIndex * 0.3) * 20,
      longitude: -100 + Math.cos(trackIndex * 0.05 + frameIndex * 0.2) * 35,
      metrics: {
        load: (trackIndex + frameIndex) % 17,
      },
      properties: {
        frameIndex,
      },
      time: frameIndex,
      visible: frameIndex % 7 !== 6,
    })),
  }));
}

function createMapPoints(pointCount) {
  return Array.from({ length: pointCount }, (_, index) => ({
    id: `point-${index}`,
    label: `Point ${index}`,
    latitude: 30 + Math.sin(index * 0.09) * 22,
    longitude: -96 + Math.cos(index * 0.11) * 42,
    metrics: {
      weight: 1 + (index % 23),
    },
    properties: {},
  }));
}

function createProjectedClusterInputs(clusterCount) {
  return Array.from({ length: clusterCount }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = 90 + (index % 17) * 11;

    return {
      clusterId: `cluster-${index}`,
      coordinates: [512 + Math.cos(angle) * radius, 384 + Math.sin(angle) * radius],
    };
  });
}

function createFlatLine(count) {
  const coordinates = new Float64Array(count * 2);

  for (let index = 0; index < count; index += 1) {
    const progress = count === 1 ? 0 : index / (count - 1);

    coordinates[index * 2] = progress * 120;
    coordinates[index * 2 + 1] = progress * 20 + Math.sin(progress * Math.PI * 6) * 3;
  }

  return coordinates;
}

function createFlatRing(count) {
  const coordinates = new Float64Array(count * 2);

  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const radius = 20 * (1 + 0.14 * Math.sin(angle * 5));

    coordinates[index * 2] = Math.cos(angle) * radius;
    coordinates[index * 2 + 1] = Math.sin(angle) * radius;
  }

  return coordinates;
}

function identity(coordinate) {
  return coordinate;
}

function measure(run, iterations) {
  const startedAt = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    run();
  }

  return (performance.now() - startedAt) / iterations;
}
