#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { parseNpmPackResult } from "./npm-pack-result.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-wasm-consumer-"));
let tarballPath;
let preview;

try {
  const pack = run("npm", ["pack", "--ignore-scripts", "--json"], rootDir);
  const packInfo = parseNpmPackResult(pack.stdout);
  tarballPath = path.join(rootDir, packInfo.filename);
  const packedFiles = new Set(packInfo.files.map((file) => file.path));
  const requiredFiles = [
    "dist/wasm/maps_wasm.js",
    "dist/wasm/maps_wasm.d.ts",
    "dist/wasm/maps_wasm_bg.wasm",
  ];

  for (const requiredFile of requiredFiles) {
    if (!packedFiles.has(requiredFile)) {
      throw new Error(`packed Maps package is missing ${requiredFile}`);
    }
  }

  mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@moritzbrantner/maps": `file:${tarballPath}`,
          "@moritzbrantner/ui": rootPackage.devDependencies["@moritzbrantner/ui"],
          react: rootPackage.devDependencies.react,
          "react-dom": rootPackage.devDependencies["react-dom"],
          vite: rootPackage.devDependencies.vite,
          supercluster: rootPackage.devDependencies.supercluster,
        },
        scripts: {
          build: "vite build",
          preview: "vite preview --host 127.0.0.1 --port 4187 --strictPort",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(tempRoot, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script><script type="module" src="/src/map-view.js"></script></body></html>',
  );
  // A consumer that pins the released package must get the first-party Flat Map runtime from
  // the tarball alone: no Rust toolchain, no tile requests, no MapLibre surface.
  writeFileSync(
    path.join(tempRoot, "src", "map-view.js"),
    `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@moritzbrantner/maps/styles.css";
import { MapView, PointLayer } from "@moritzbrantner/maps/layers";

createRoot(document.getElementById("root")).render(
  createElement(
    MapView,
    {
      defaultViewState: { center: [13.405, 52.52], zoom: 8 },
      fitToData: false,
      flatRuntime: "maps",
      mapLabel: "Packed first-party Map View",
      mapStyle: {
        layers: [{ id: "background", paint: { "background-color": "#2f7d6b" }, type: "background" }],
        sources: {},
        version: 8,
      },
      style: { height: 320 },
    },
    createElement(PointLayer, {
      points: [{ id: "berlin", latitude: 52.52, longitude: 13.405 }],
    }),
  ),
);
`,
  );
  writeFileSync(
    path.join(tempRoot, "src", "supercluster-aggregation.ts"),
    readFileSync(path.join(rootDir, "scripts", "engine-reference", "supercluster-aggregation.ts")),
  );
  writeFileSync(
    path.join(tempRoot, "src", "main.js"),
    String.raw`import { createSuperclusterReference } from "./supercluster-aggregation.ts";
import init, {
  MapsPointAggregationIndex,
  normalizeMapPoints,
} from "@moritzbrantner/maps/wasm";

const DEFAULT_OPTIONS = {
  extent: 512,
  maxZoom: 16,
  minZoom: 0,
  radius: 72,
};

// The Rust index keeps cluster centroids as f64 Mercator coordinates. The supercluster 9
// reference stores them as Int32 fixed point (2^-30 of the world, about 0.0000003 degrees) and
// re-quantizes the weighted centroid on every zoom level, so centroids drift apart by some
// tens of steps. Points, metrics, counts, expansion zooms and leaves stay exact.
const CLUSTER_CENTROID_TOLERANCE_DEGREES = 2e-5;
let maxClusterCentroidDeviationDegrees = 0;

window.mapsWasmEvidence = (async () => {
  await init();

  const canonical = [
    {
      name: "clustered-metrics",
      points: [
        { id: "berlin-a", label: "Berlin A", latitude: 52.52, longitude: 13.405, metrics: { demand: 8, revenue: 1200 } },
        { id: "berlin-b", label: "Berlin B", latitude: 52.5204, longitude: 13.4054, metrics: { demand: 5, revenue: 900 } },
        { id: "berlin-c", label: "Berlin C", latitude: 52.521, longitude: 13.406, metrics: { demand: 3, revenue: 500 } },
        { id: "paris", label: "Paris", latitude: 48.8566, longitude: 2.3522, metrics: { demand: 2, revenue: 300 } },
      ],
      queries: [
        { bounds: [-180, -85, 180, 85], zoom: 2 },
        { bounds: [13.2, 52.3, 13.7, 52.8], zoom: 8 },
        { bounds: [13.2, 52.3, 13.7, 52.8], zoom: 17 },
      ],
    },
    {
      name: "sparse-global",
      points: [
        { id: "berlin", label: "Berlin", latitude: 52.52, longitude: 13.405, metrics: { weight: 1 } },
        { id: "new-york", label: "New York", latitude: 40.7128, longitude: -74.006, metrics: { weight: 2 } },
        { id: "tokyo", label: "Tokyo", latitude: 35.6762, longitude: 139.6503, metrics: { weight: 3 } },
        { id: "sydney", label: "Sydney", latitude: -33.8688, longitude: 151.2093, metrics: { weight: 4 } },
      ],
      queries: [
        { bounds: [-180, -85, 180, 85], zoom: 0 },
        { bounds: [-180, -85, 180, 85], zoom: 16 },
      ],
    },
    {
      name: "zoom-boundaries",
      options: { maxZoom: 8, minZoom: 2, radius: 64 },
      points: Array.from({ length: 24 }, (_, index) => ({
        id: "zoom-" + index,
        label: "Zoom " + index,
        latitude: 50 + (index % 6) * 0.002,
        longitude: 8 + Math.floor(index / 6) * 0.002,
        metrics: { count: 1 },
      })),
      queries: [
        { bounds: [-180, -85, 180, 85], zoom: 0 },
        { bounds: [-180, -85, 180, 85], zoom: 2 },
        { bounds: [-180, -85, 180, 85], zoom: 8 },
        { bounds: [-180, -85, 180, 85], zoom: 20 },
      ],
    },
    {
      name: "antimeridian",
      points: [
        { id: "east-a", label: "East A", latitude: 0, longitude: 179.8, metrics: { count: 1 } },
        { id: "east-b", label: "East B", latitude: 0.05, longitude: 179.9, metrics: { count: 2 } },
        { id: "west-a", label: "West A", latitude: 0, longitude: -179.8, metrics: { count: 3 } },
        { id: "west-b", label: "West B", latitude: -0.05, longitude: -179.9, metrics: { count: 4 } },
      ],
      queries: [
        { bounds: [170, -10, -170, 10], zoom: 2 },
        { bounds: [170, -10, -170, 10], zoom: 12 },
      ],
    },
    {
      name: "invalid-input-normalization",
      points: [
        { id: "valid-a", label: "Valid A", latitude: 10, longitude: 20, metrics: { count: 1, invalid: Number.NaN } },
        { id: "invalid-lat", label: "Invalid latitude", latitude: Number.NaN, longitude: 18, metrics: { count: 100 } },
        { id: "invalid-lng", label: "Invalid longitude", latitude: 9, longitude: Number.POSITIVE_INFINITY, metrics: { count: 100 } },
        { label: "Generated id", latitude: 11, longitude: 21, metrics: { count: 2, invalid: Number.POSITIVE_INFINITY } },
      ],
      queries: [
        { bounds: [-180, -85, 180, 85], zoom: 12 },
      ],
    },
  ];

  const canonicalResults = canonical.map(runFixture);
  const duplicateId = runDuplicateIdContract();
  const seeded = [7, 42, 2026].map((seed) => runSeededParity(seed));
  const performance = runPerformanceEvidence();

  return {
    canonicalResults,
    duplicateId,
    maxClusterCentroidDeviationDegrees,
    performance,
    seeded,
  };
})();

function runFixture(fixture) {
  const options = { ...DEFAULT_OPTIONS, ...(fixture.options ?? {}) };
  const control = createSuperclusterReference(fixture.points, options);
  const rustPoints = normalizeMapPoints(fixture.points);
  const rust = new MapsPointAggregationIndex(rustPoints, options);

  try {
    for (const query of fixture.queries) {
      compareQuery(fixture.name, query, control, rust);
    }

    comparePointLookups(fixture.name, rustPoints, control, rust);

    return {
      name: fixture.name,
      normalizedPointCount: rustPoints.length,
      queryCount: fixture.queries.length,
    };
  } finally {
    control.dispose();
    rust.free();
  }
}

function runDuplicateIdContract() {
  const points = [
    { id: "duplicate", label: "first", latitude: 48, longitude: 8, metrics: { count: 1 } },
    { id: "duplicate", label: "second", latitude: 49, longitude: 9, metrics: { count: 2 } },
  ];
  const control = createSuperclusterReference(points, DEFAULT_OPTIONS);
  const rustPoints = normalizeMapPoints(points);
  const rust = new MapsPointAggregationIndex(rustPoints, DEFAULT_OPTIONS);

  try {
    assertDeepEqual(
      comparablePoint(control.getPointById("duplicate")),
      comparablePoint(rust.getPointById("duplicate")),
      "duplicate-id point lookup policy",
    );

    return comparablePoint(rust.getPointById("duplicate"));
  } finally {
    control.dispose();
    rust.free();
  }
}

function runSeededParity(seed) {
  const random = createRandom(seed);
  const points = Array.from({ length: 400 }, (_, index) => ({
    id: "seed-" + seed + "-" + index,
    label: "Seed " + seed + " / " + index,
    latitude: -70 + random() * 140,
    longitude: -179.5 + random() * 359,
    metrics: {
      count: 1,
      score: Math.floor(random() * 1000) / 10,
    },
  }));
  const queries = [
    { bounds: [-180, -85, 180, 85], zoom: 0 },
    { bounds: [-180, -85, 180, 85], zoom: 4 },
    { bounds: [-30, 30, 60, 70], zoom: 7 },
    { bounds: [160, -40, -160, 40], zoom: 6 },
    { bounds: [-130, -60, -40, 20], zoom: 10 },
  ];
  const fixture = {
    name: "seeded-" + seed,
    points,
    queries,
  };

  return runFixture(fixture);
}

function compareQuery(name, query, control, rust) {
  const controlAggregation = control.getViewportAggregation(query);
  const rustAggregation = rust.getViewportAggregation(query);

  assertDeepEqual(
    comparableAggregation(controlAggregation),
    comparableAggregation(rustAggregation),
    name + " viewport " + JSON.stringify(query),
  );

  const controlClusters = sortedClusters(controlAggregation);
  const rustClusters = sortedClusters(rustAggregation);

  for (const [index, controlCluster] of controlClusters.entries()) {
    const signature = clusterSignature(controlCluster);
    const rustCluster = rustClusters[index];

    if (!rustCluster || clusterSignature(rustCluster) !== signature) {
      throw new Error(name + " missing Rust cluster for " + signature);
    }

    const deviation = Math.max(
      longitudeDistance(controlCluster.coordinates[0], rustCluster.coordinates[0]),
      Math.abs(controlCluster.coordinates[1] - rustCluster.coordinates[1]),
    );
    if (!(deviation <= CLUSTER_CENTROID_TOLERANCE_DEGREES)) {
      throw new Error(
        name +
          " cluster centroid mismatch for " +
          signature +
          ": control=" +
          JSON.stringify(controlCluster.coordinates) +
          " rust=" +
          JSON.stringify(rustCluster.coordinates),
      );
    }
    maxClusterCentroidDeviationDegrees = Math.max(maxClusterCentroidDeviationDegrees, deviation);

    const controlExpansionZoom = control.getClusterExpansionZoom(controlCluster.clusterId);
    const rustExpansionZoom = rust.getClusterExpansionZoom(rustCluster.clusterId);
    if (controlExpansionZoom !== rustExpansionZoom) {
      throw new Error(
        name +
          " expansion zoom mismatch for " +
          signature +
          ": control=" +
          controlExpansionZoom +
          " rust=" +
          rustExpansionZoom,
      );
    }

    const leafLimit = Math.min(controlCluster.pointCount, 256);
    const controlLeaves = control
      .getClusterLeaves(controlCluster.clusterId, leafLimit, 0)
      .map(comparablePoint)
      .sort(compareJson);
    const rustLeaves = rust
      .getClusterLeaves(rustCluster.clusterId, leafLimit, 0)
      .map(comparablePoint)
      .sort(compareJson);

    assertDeepEqual(controlLeaves, rustLeaves, name + " cluster leaves " + signature);
  }
}

function comparePointLookups(name, rustPoints, control, rust) {
  for (const point of rustPoints.slice(0, 12)) {
    assertDeepEqual(
      comparablePoint(control.getPointById(point.id)),
      comparablePoint(rust.getPointById(point.id)),
      name + " point lookup " + point.id,
    );
  }
}

function comparableAggregation(aggregation) {
  return {
    features: aggregation.features.map(comparableFeature).sort(compareJson),
    summary: {
      bounds: aggregation.summary.bounds.map(roundCoordinate),
      metrics: comparableMetrics(aggregation.summary.metrics),
      visibleClusterCount: aggregation.summary.visibleClusterCount,
      visiblePointCount: aggregation.summary.visiblePointCount,
      visibleUnclusteredCount: aggregation.summary.visibleUnclusteredCount,
      zoom: aggregation.summary.zoom,
    },
  };
}

function comparableFeature(feature) {
  if (feature.kind === "point") {
    return {
      coordinates: feature.coordinates.map(roundCoordinate),
      id: feature.point?.id ?? feature.pointId,
      kind: "point",
      metrics: comparableMetrics(feature.metrics),
    };
  }

  // Centroids are compared within CLUSTER_CENTROID_TOLERANCE_DEGREES in compareQuery.
  return {
    expansionZoom: feature.expansionZoom,
    kind: "cluster",
    metrics: comparableMetrics(feature.metrics),
    pointCount: feature.pointCount,
  };
}

function clusterSignature(feature) {
  return JSON.stringify({
    metrics: comparableMetrics(feature.metrics),
    pointCount: feature.pointCount,
  });
}

function sortedClusters(aggregation) {
  return aggregation.features
    .filter((feature) => feature.kind === "cluster")
    .sort(
      (left, right) =>
        clusterSignature(left).localeCompare(clusterSignature(right)) ||
        left.coordinates[0] - right.coordinates[0] ||
        left.coordinates[1] - right.coordinates[1],
    );
}

function longitudeDistance(left, right) {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

function comparablePoint(point) {
  if (!point) {
    return null;
  }

  return {
    id: point.id,
    label: point.label,
    latitude: roundCoordinate(point.latitude),
    longitude: roundCoordinate(point.longitude),
    metrics: comparableMetrics(point.metrics),
  };
}

function comparableMetrics(metrics) {
  return Object.fromEntries(
    Object.entries(metrics ?? {})
      .filter(([, value]) => Number.isFinite(value))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, roundMetric(value)]),
  );
}

function roundCoordinate(value) {
  return Math.round(value * 1e6) / 1e6;
}

function roundMetric(value) {
  return Math.round(value * 1e9) / 1e9;
}

function compareJson(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function assertDeepEqual(left, right, label) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);

  if (leftJson !== rightJson) {
    throw new Error(
      label +
        " mismatch\ncontrol=" +
        leftJson.slice(0, 4000) +
        "\nrust=" +
        rightJson.slice(0, 4000),
    );
  }
}

function createRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalizeForRust(points) {
  return points
    .map((point, index) => ({
      id: String(point.id ?? index),
      label: point.label ?? "",
      latitude: point.latitude,
      longitude: point.longitude,
      metrics: Object.fromEntries(
        Object.entries(point.metrics ?? {}).filter(([, value]) => Number.isFinite(value)),
      ),
    }))
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

function createPerformancePoints(size, seed) {
  const random = createRandom(seed);

  return Array.from({ length: size }, (_, index) => ({
    id: "perf-" + size + "-" + index,
    label: "",
    latitude: -75 + random() * 150,
    longitude: -179 + random() * 358,
    metrics: {
      count: 1,
      value: index % 97,
    },
  }));
}

function runPerformanceEvidence() {
  const cases = [
    { buildBudgetMs: 5000, queryBudgetMs: 2500, size: 10000 },
    { buildBudgetMs: 15000, queryBudgetMs: 6000, size: 100000 },
  ];

  return cases.map(({ buildBudgetMs, queryBudgetMs, size }) => {
    const points = createPerformancePoints(size, 9000 + size);
    const rustPoints = normalizeForRust(points);

    const controlBuildStart = performance.now();
    const control = createSuperclusterReference(points, DEFAULT_OPTIONS);
    const controlBuildMs = performance.now() - controlBuildStart;

    const rustBuildStart = performance.now();
    const rust = new MapsPointAggregationIndex(rustPoints, DEFAULT_OPTIONS);
    const rustBuildMs = performance.now() - rustBuildStart;

    const queries = [
      { bounds: [-180, -85, 180, 85], zoom: 2 },
      { bounds: [-30, 20, 60, 70], zoom: 5 },
      { bounds: [160, -45, -160, 45], zoom: 7 },
      { bounds: [-130, -60, -40, 30], zoom: 9 },
    ];

    let controlQueryMs = 0;
    let rustQueryMs = 0;

    try {
      for (let iteration = 0; iteration < 4; iteration += 1) {
        for (const query of queries) {
          const controlStart = performance.now();
          control.getViewportAggregation(query);
          controlQueryMs += performance.now() - controlStart;

          const rustStart = performance.now();
          rust.getViewportAggregation(query);
          rustQueryMs += performance.now() - rustStart;
        }
      }
    } finally {
      control.dispose();
      rust.free();
    }

    if (rustBuildMs > buildBudgetMs) {
      throw new Error(
        "Rust " +
          size +
          "-point build exceeded budget: " +
          rustBuildMs.toFixed(1) +
          "ms > " +
          buildBudgetMs +
          "ms",
      );
    }

    if (rustQueryMs > queryBudgetMs) {
      throw new Error(
        "Rust " +
          size +
          "-point repeated queries exceeded budget: " +
          rustQueryMs.toFixed(1) +
          "ms > " +
          queryBudgetMs +
          "ms",
      );
    }

    return {
      controlBuildMs: roundTiming(controlBuildMs),
      controlQueryMs: roundTiming(controlQueryMs),
      rustBuildMs: roundTiming(rustBuildMs),
      rustQueryMs: roundTiming(rustQueryMs),
      size,
    };
  });
}

function roundTiming(value) {
  return Math.round(value * 10) / 10;
}
`,
  );

  run("bun", ["install"], tempRoot);
  run("bun", ["run", "build"], tempRoot);

  preview = spawn("bun", ["run", "preview"], {
    cwd: tempRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp("http://127.0.0.1:4187/");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto("http://127.0.0.1:4187/");
    const result = await page.evaluate(() => window.mapsWasmEvidence);

    if (result.canonicalResults.length !== 5) {
      throw new Error(
        `expected 5 canonical parity fixtures, received ${result.canonicalResults.length}`,
      );
    }
    if (result.seeded.length !== 3) {
      throw new Error(`expected 3 seeded parity fixtures, received ${result.seeded.length}`);
    }
    if (result.performance.length !== 2) {
      throw new Error(
        `expected 2 performance evidence cases, received ${result.performance.length}`,
      );
    }

    console.log("Packed Maps WASM parity evidence passed.");
    console.log(JSON.stringify(result, null, 2));

    const mapView = page.getByLabel("Packed first-party Map View");
    const baseCanvas = mapView.locator('canvas[data-flat-runtime="maps"]');
    await mapView.and(page.locator('[data-map-runtime="maps"][data-map-ready="true"]')).waitFor();
    await page.waitForFunction(() =>
      /^(wgpu|canvas2d)$/.test(
        document.querySelector('canvas[data-flat-runtime="maps"]')?.dataset.mapBaseRenderer ?? "",
      ),
    );
    if ((await page.locator(".maplibregl-canvas").count()) !== 0) {
      throw new Error('packed flatRuntime="maps" Map View created a MapLibre surface');
    }
    if (pageErrors.length > 0) {
      throw new Error(`packed first-party Map View reported errors:\n${pageErrors.join("\n")}`);
    }

    console.log(
      `Packed first-party Map View ready (base renderer: ${await baseCanvas.getAttribute("data-map-base-renderer")}).`,
    );
  } finally {
    await browser.close();
  }
} finally {
  preview?.kill("SIGTERM");
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(tempRoot, { force: true, recursive: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }

  return result;
}

async function waitForHttp(url) {
  let lastError;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (preview?.exitCode !== null) {
      throw new Error(
        `Vite preview exited before serving the WASM consumer (code ${preview.exitCode})`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Vite preview did not become ready: ${String(lastError ?? "timeout")}`);
}
