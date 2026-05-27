import {
  createHeatLayerDataSurfaceSvg,
  createHeatLayerInterpolatedSurfaceSvg,
  prepareHeatLayerColorRamp,
} from "../src/heat-surface.ts";

const POINT_COUNTS = [1_000, 5_000, 10_000];
const VIEWPORTS = [
  [800, 600],
  [1280, 720],
];
const RADII = [
  ["small", 32],
  ["default", 96],
  ["large", 192],
];
const METERS_PER_PIXEL = 1_250;
const COLOR_RAMP = prepareHeatLayerColorRamp([
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
]);

console.log("\nHeat layer SVG surface generation");

for (const [width, height] of VIEWPORTS) {
  console.log(`\nViewport ${width}x${height}`);

  for (const [radiusLabel, radius] of RADII) {
    for (const pointCount of POINT_COUNTS) {
      const sources = createSources(pointCount, width, height, radius);
      const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));
      const iterations = getIterationCount(pointCount, radius);
      const dataMs = measure(() => {
        createHeatLayerDataSurfaceSvg({
          colorRamp: COLOR_RAMP,
          height,
          sources,
          width,
        });
      }, iterations);
      const bruteMs = measure(() => {
        createHeatLayerInterpolatedSurfaceSvg({
          colorRamp: COLOR_RAMP,
          densityMode: "brute-force",
          height,
          maxInfluenceRadius,
          metricProjection: createMetricProjection(),
          sources,
          width,
        });
      }, Math.max(1, Math.floor(iterations / 3)));
      const optimizedMs = measure(() => {
        createHeatLayerInterpolatedSurfaceSvg({
          colorRamp: COLOR_RAMP,
          height,
          maxInfluenceRadius,
          metricProjection: createMetricProjection(),
          sources,
          width,
        });
      }, iterations);

      console.log(
        `${String(pointCount).padStart(6)} sources ${radiusLabel.padEnd(7)} data=${dataMs.toFixed(
          2,
        )} ms interpolated brute=${bruteMs.toFixed(2)} ms optimized=${optimizedMs.toFixed(
          2,
        )} ms speedup=${(bruteMs / optimizedMs).toFixed(2)}x`,
      );
    }
  }
}

function createSources(pointCount, width, height, radius) {
  return Array.from({ length: pointCount }, (_, index) => {
    const angle = index * 2.399963229728653;
    const ring = 0.2 + ((index * 37) % 1000) / 1000;
    const x = width / 2 + Math.cos(angle) * width * 0.64 * ring;
    const y = height / 2 + Math.sin(angle) * height * 0.64 * ring;
    const influenceRadius = radius * (0.72 + (index % 11) * 0.045);
    const metricPoint = {
      x: x * METERS_PER_PIXEL,
      y: y * METERS_PER_PIXEL,
    };

    return {
      coordinate: [0, 0],
      dataInfluenceRadius: influenceRadius * METERS_PER_PIXEL,
      influenceRadius,
      metricPoint,
      point: {
        x,
        y,
      },
      weight: 0.08 + (index % 29) / 22,
    };
  });
}

function createMetricProjection() {
  return {
    getMetricPoint(x, y) {
      return {
        x: x * METERS_PER_PIXEL,
        y: y * METERS_PER_PIXEL,
      };
    },
    getMetricX(x) {
      return x * METERS_PER_PIXEL;
    },
    getMetricY(y) {
      return y * METERS_PER_PIXEL;
    },
  };
}

function measure(run, iterations) {
  const startedAt = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    run();
  }

  return (performance.now() - startedAt) / iterations;
}

function getIterationCount(pointCount, radius) {
  if (pointCount >= 10_000 || radius >= 192) {
    return 2;
  }

  if (pointCount >= 5_000) {
    return 3;
  }

  return 5;
}
