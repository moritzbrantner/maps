import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
  createScalarFieldGrid,
  initializeMapsScalarFieldWasm,
  resetMapsScalarFieldWasmRuntimeForTests,
} from "../src/index.ts";

const DOMAIN_BOUNDS = [-25, 34, 35, 66];
const VALUE_DOMAIN = [12, 34];
const COLOR_RAMP = [
  [0, "#1d4ed8"],
  [0.22, "#38bdf8"],
  [0.42, "#22c55e"],
  [0.62, "#fde047"],
  [0.8, "#fb923c"],
  [1, "#dc2626"],
];
const SIZES = [
  [240, 150],
  [320, 200],
  [420, 260],
];
const RUNS = 12;
const WARMUPS = 3;

installCanvasBenchmarkShim();

const points = createBenchmarkTemperaturePoints();

console.log(`Scalar field benchmark`);
console.log(`points: ${points.length}`);

resetMapsScalarFieldWasmRuntimeForTests();
for (const [columns, rows] of SIZES) {
  const gridResult = measure(() =>
    createScalarFieldGrid(points, {
      domainBounds: DOMAIN_BOUNDS,
      fieldColumns: columns,
      fieldRows: rows,
      interpolationK: 10,
      interpolationPower: 2,
      valueMetric: "temperature",
    }),
  );
  const grid = gridResult.last;
  const contourResult = measure(() =>
    createHeatFieldContourFeatureCollection(grid, {
      levels: 11,
      valueDomain: VALUE_DOMAIN,
    }),
  );
  const imageResult = measure(() =>
    createHeatFieldImage(grid, {
      colorRamp: COLOR_RAMP,
      valueDomain: VALUE_DOMAIN,
    }),
  );

  printResult({
    cells: columns * rows,
    columns,
    contourSegments: countContourSegments(contourResult.last),
    contourStats: contourResult.stats,
    gridStats: gridResult.stats,
    imageStats: imageResult.stats,
    label: "TypeScript",
    rows,
  });
}

const wasmInitialized = await initializeMapsScalarFieldWasm();

if (wasmInitialized) {
  for (const [columns, rows] of SIZES) {
    const gridResult = measure(() =>
      createScalarFieldGrid(points, {
        domainBounds: DOMAIN_BOUNDS,
        fieldColumns: columns,
        fieldRows: rows,
        interpolationK: 10,
        interpolationPower: 2,
        valueMetric: "temperature",
      }),
    );

    printResult({
      cells: columns * rows,
      columns,
      contourSegments: 0,
      contourStats: null,
      gridStats: gridResult.stats,
      imageStats: null,
      label: "WASM",
      rows,
    });
  }
} else {
  console.log("WASM: initialization skipped or unavailable");
}

resetMapsScalarFieldWasmRuntimeForTests();

function measure(callback) {
  let last;

  for (let index = 0; index < WARMUPS; index += 1) {
    last = callback();
  }

  const samples = [];

  for (let index = 0; index < RUNS; index += 1) {
    const start = performance.now();

    last = callback();
    samples.push(performance.now() - start);
  }

  samples.sort((left, right) => left - right);

  return {
    last,
    stats: {
      mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      min: samples[0],
      p95: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
    },
  };
}

function printResult({
  cells,
  columns,
  contourSegments,
  contourStats,
  gridStats,
  imageStats,
  label,
  rows,
}) {
  console.log(`\n${label} ${columns}x${rows} (${cells.toLocaleString()} cells)`);
  console.log(`  grid:    ${formatStats(gridStats)}`);

  if (contourStats) {
    console.log(`  contour: ${formatStats(contourStats)} (${contourSegments} segments)`);
  }

  if (imageStats) {
    console.log(`  image:   ${formatStats(imageStats)}`);
  }
}

function formatStats(stats) {
  return `mean ${stats.mean.toFixed(2)}ms, min ${stats.min.toFixed(2)}ms, p95 ${stats.p95.toFixed(
    2,
  )}ms`;
}

function countContourSegments(collection) {
  return collection.features.reduce(
    (sum, feature) => sum + feature.geometry.coordinates.length,
    0,
  );
}

function installCanvasBenchmarkShim() {
  if (typeof globalThis.document !== "undefined") {
    return;
  }

  globalThis.navigator = {
    userAgent: "benchmark",
  };
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
  globalThis.document = {
    createElement(tagName) {
      if (tagName !== "canvas") {
        return {};
      }

      return {
        height: 0,
        width: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return new ImageData(width, height);
            },
            putImageData() {},
          };
        },
        toDataURL() {
          return "data:image/png;base64,benchmark";
        },
      };
    },
  };
}

function createBenchmarkTemperaturePoints() {
  return [
    temperaturePoint("reykjavik", 64.1466, -21.9426, 14.3),
    temperaturePoint("dublin", 53.3498, -6.2603, 15.8),
    temperaturePoint("belfast", 54.5973, -5.9301, 14.9),
    temperaturePoint("glasgow", 55.8642, -4.2518, 13.9),
    temperaturePoint("london", 51.5072, -0.1276, 18.5),
    temperaturePoint("manchester", 53.4808, -2.2426, 15.6),
    temperaturePoint("amsterdam", 52.3676, 4.9041, 18.7),
    temperaturePoint("brussels", 50.8503, 4.3517, 19.3),
    temperaturePoint("luxembourg", 49.6116, 6.1319, 18.6),
    temperaturePoint("paris", 48.8566, 2.3522, 20.9),
    temperaturePoint("strasbourg", 48.5734, 7.7521, 21.3),
    temperaturePoint("nantes", 47.2184, -1.5536, 19.4),
    temperaturePoint("bordeaux", 44.8378, -0.5792, 22.1),
    temperaturePoint("lyon", 45.764, 4.8357, 22.6),
    temperaturePoint("marseille", 43.2965, 5.3698, 26.8),
    temperaturePoint("nice", 43.7102, 7.262, 23.7),
    temperaturePoint("porto", 41.1579, -8.6291, 23.4),
    temperaturePoint("lisbon", 38.7223, -9.1393, 25.9),
    temperaturePoint("madrid", 40.4168, -3.7038, 30.4),
    temperaturePoint("barcelona", 41.3874, 2.1686, 25.7),
    temperaturePoint("valencia", 39.4699, -0.3763, 27.1),
    temperaturePoint("seville", 37.3891, -5.9845, 31.2),
    temperaturePoint("milan", 45.4642, 9.19, 27.3),
    temperaturePoint("venice", 45.4408, 12.3155, 25.1),
    temperaturePoint("rome", 41.9028, 12.4964, 27.7),
    temperaturePoint("naples", 40.8518, 14.2681, 27.3),
    temperaturePoint("palermo", 38.1157, 13.3615, 27.4),
    temperaturePoint("zurich", 47.3769, 8.5417, 19.7),
    temperaturePoint("geneva", 46.2044, 6.1432, 21.4),
    temperaturePoint("vienna", 48.2082, 16.3738, 23.8),
    temperaturePoint("innsbruck", 47.2692, 11.4041, 19.8),
    temperaturePoint("munich", 48.1351, 11.582, 18.5),
    temperaturePoint("berlin", 52.52, 13.405, 18.6),
    temperaturePoint("hamburg", 53.5511, 9.9937, 17.6),
    temperaturePoint("copenhagen", 55.6761, 12.5683, 17.7),
    temperaturePoint("oslo", 59.9139, 10.7522, 20.5),
    temperaturePoint("bergen", 60.3913, 5.3221, 19.1),
    temperaturePoint("stockholm", 59.3293, 18.0686, 18.7),
    temperaturePoint("gothenburg", 57.7089, 11.9746, 18.7),
    temperaturePoint("helsinki", 60.1699, 24.9384, 21.3),
    temperaturePoint("tallinn", 59.437, 24.7536, 18.7),
    temperaturePoint("riga", 56.9496, 24.1052, 19.2),
    temperaturePoint("vilnius", 54.6872, 25.2797, 18.9),
    temperaturePoint("warsaw", 52.2297, 21.0122, 20.9),
    temperaturePoint("krakow", 50.0647, 19.945, 21.2),
    temperaturePoint("prague", 50.0755, 14.4378, 20.8),
    temperaturePoint("bratislava", 48.1486, 17.1077, 25),
    temperaturePoint("budapest", 47.4979, 19.0402, 26.2),
    temperaturePoint("ljubljana", 46.0569, 14.5058, 23),
    temperaturePoint("zagreb", 45.815, 15.9819, 24.9),
    temperaturePoint("belgrade", 44.7866, 20.4489, 25.4),
    temperaturePoint("sarajevo", 43.8563, 18.4131, 22.7),
    temperaturePoint("podgorica", 42.4304, 19.2594, 29),
    temperaturePoint("tirana", 41.3275, 19.8187, 26.8),
    temperaturePoint("skopje", 41.9981, 21.4254, 27.5),
    temperaturePoint("sofia", 42.6977, 23.3219, 24.1),
    temperaturePoint("thessaloniki", 40.6401, 22.9444, 30.7),
    temperaturePoint("athens", 37.9838, 23.7275, 30.8),
    temperaturePoint("istanbul", 41.0082, 28.9784, 26.9),
    temperaturePoint("izmir", 38.4237, 27.1428, 32.5),
    temperaturePoint("bucharest", 44.4268, 26.1025, 29),
    temperaturePoint("cluj", 46.7712, 23.6236, 23.6),
    temperaturePoint("chisinau", 47.0105, 28.8638, 25.4),
    temperaturePoint("lviv", 49.8397, 24.0297, 21.1),
    temperaturePoint("kyiv", 50.4501, 30.5234, 26),
    temperaturePoint("minsk", 53.9006, 27.559, 19.6),
    temperaturePoint("valletta", 35.8989, 14.5146, 28.2),
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
