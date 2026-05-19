import {
  createTemporalGeoJsonPlaybackIndex,
  getTemporalGeoJsonFeatureCollectionAtTime,
} from "../src/temporal-geojson-geometries.ts";

const COUNTS = [128, 512, 2048, 8192];
const STRATEGIES = ["compatible", "resample", "centroid-radial"];
const BENCHMARK_TIME = 5;

for (const strategy of STRATEGIES) {
  console.log(`\nStrategy: ${strategy}`);

  for (const count of COUNTS) {
    const tracks = createBenchmarkTracks(count);
    const options =
      strategy === "compatible"
        ? {
            denseGeometryBehavior: "preserve",
            strategy,
          }
        : {
            maxCoordinatesPerLine: Math.min(count, 1024),
            maxCoordinatesPerRing: Math.min(count, 1024),
            minResampleCoordinates: 32,
            strategy,
          };

    const playbackIndex = createTemporalGeoJsonPlaybackIndex(tracks, options);
    const iterations = getIterationCount(count, strategy);
    const rawMs = measure(() => {
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, BENCHMARK_TIME, options);
    }, iterations);
    const indexedMs = measure(() => {
      playbackIndex.getFeatureCollectionAtTime(BENCHMARK_TIME);
    }, iterations);

    console.log(
      `${String(count).padStart(5)} coords  raw=${rawMs.toFixed(3)} ms  indexed=${indexedMs.toFixed(
        3,
      )} ms  speedup=${(rawMs / indexedMs).toFixed(2)}x`,
    );
  }
}

function createBenchmarkTracks(count) {
  return [
    {
      id: `line-${count}`,
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
    },
    {
      id: `polygon-${count}`,
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
    },
  ];
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

function measure(run, iterations) {
  const startedAt = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    run();
  }

  return (performance.now() - startedAt) / iterations;
}

function getIterationCount(count, strategy) {
  if (strategy === "centroid-radial") {
    if (count >= 8192) {
      return 2;
    }

    if (count >= 2048) {
      return 4;
    }
  }

  if (count >= 8192) {
    return 5;
  }

  if (count >= 2048) {
    return 10;
  }

  return 25;
}
