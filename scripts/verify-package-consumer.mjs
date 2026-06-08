#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-consumers-"));
let tarballPath = null;

try {
  const pack = run("npm", ["pack", "--ignore-scripts", "--json"], rootDir);
  const packInfo = JSON.parse(pack.stdout)[0];

  tarballPath = path.join(rootDir, packInfo.filename);

  verifyFullViteConsumer(path.join(tempRoot, "full-vite"), tarballPath);
  verifyFlatOnlyViteConsumer(path.join(tempRoot, "flat-vite"), tarballPath);
  verifyCoreOnlyNodeConsumer(path.join(tempRoot, "core-node"), tarballPath);
  verifyNextStyleBoundaries(path.join(tempRoot, "next-boundaries"), tarballPath);

  console.log("Packed consumer verification passed.");
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }

  rmSync(tempRoot, { force: true, recursive: true });
}

function verifyFullViteConsumer(directory, packageTarball) {
  writePackage(directory, {
    "@moritzbrantner/maps": `file:${packageTarball}`,
    "@moritzbrantner/timeline-editor": version("@moritzbrantner/timeline-editor"),
    "@moritzbrantner/ui": version("@moritzbrantner/ui"),
    "@vitejs/plugin-react": version("@vitejs/plugin-react"),
    react: version("react"),
    "react-dom": version("react-dom"),
    typescript: version("typescript"),
    vite: version("vite"),
  });
  writeViteShell(directory);
  writeFile(
    directory,
    "src/main.tsx",
    `import { createRoot } from "react-dom/client";
import "@moritzbrantner/maps/styles.css";
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";
import { createPointAggregationIndex } from "@moritzbrantner/maps/core";
import { MapLayers, MapView } from "@moritzbrantner/maps/layers";
import { FlatPointMap } from "@moritzbrantner/maps/flat";
import { EditableGeoJsonMap } from "@moritzbrantner/maps/editor";
import { createGeoJsonTimelineDocument } from "@moritzbrantner/maps/timeline";
import { GeoJsonMap } from "@moritzbrantner/maps/geojson";
import { HeatMap } from "@moritzbrantner/maps/heat";
import { getBeeLineDistanceMeters } from "@moritzbrantner/maps/measurement";
import { createTemporalMapPlaybackIndex } from "@moritzbrantner/maps/temporal";
import packageJson from "@moritzbrantner/maps/package.json";

const points: MapPoint[] = [{ id: "berlin", latitude: 52.52, longitude: 13.405 }];
const collection = { type: "FeatureCollection" as const, features: [] };

createPointAggregationIndex(points);
createGeoJsonTimelineDocument(collection);
getBeeLineDistanceMeters([13.405, 52.52], [11.582, 48.1351]);
createTemporalMapPlaybackIndex([]);
console.log(
  packageJson.name,
  Boolean(MapView),
  Boolean(MapLayers),
  Boolean(FlatPointMap),
  Boolean(EditableGeoJsonMap),
  Boolean(GeoJsonMap),
  Boolean(HeatMap),
);

createRoot(document.getElementById("root")!).render(
  <ClusteredMap
    defaultViewState={{ center: [13.405, 52.52], zoom: 8 }}
    fitToData={false}
    points={points}
    style={{ height: 320 }}
  />,
);
`,
  );

  run("bun", ["install"], directory);
  run("bunx", ["--bun", "vite", "build"], directory);
}

function verifyFlatOnlyViteConsumer(directory, packageTarball) {
  writePackage(directory, {
    "@moritzbrantner/maps": `file:${packageTarball}`,
    "@moritzbrantner/ui": version("@moritzbrantner/ui"),
    "@vitejs/plugin-react": version("@vitejs/plugin-react"),
    react: version("react"),
    "react-dom": version("react-dom"),
    typescript: version("typescript"),
    vite: version("vite"),
  });
  writeViteShell(directory);
  writeFile(
    directory,
    "src/main.tsx",
    `import { createRoot } from "react-dom/client";
import "@moritzbrantner/maps/styles.css";
import { FlatPointMap } from "@moritzbrantner/maps/flat";

const points = [
  { id: "berlin", latitude: 52.52, longitude: 13.405, metrics: {} },
];

createRoot(document.getElementById("root")!).render(
  <FlatPointMap points={points} style={{ height: 320 }} />,
);
`,
  );

  run("bun", ["install"], directory);
  run("bunx", ["--bun", "vite", "build"], directory);
}

function verifyCoreOnlyNodeConsumer(directory, packageTarball) {
  writePackage(directory, {
    "@moritzbrantner/maps": `file:${packageTarball}`,
  });
  writeFile(
    directory,
    "main.mjs",
    `import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPointAggregationIndex, getBoundsFromPoints } from "@moritzbrantner/maps/core";

const points = [{ id: "berlin", latitude: 52.52, longitude: 13.405 }];
const index = createPointAggregationIndex(points);

if (!index.getViewportAggregation({ bounds: [13, 52, 14, 53], zoom: 8 }).features.length) {
  throw new Error("core aggregation did not run in a Node-only consumer");
}

if (!getBoundsFromPoints(points)) {
  throw new Error("core bounds helper did not run in a Node-only consumer");
}

if ("window" in globalThis || "document" in globalThis) {
  throw new Error("core fixture unexpectedly depends on browser globals");
}

const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("@moritzbrantner/maps/package.json")));
const coreBundle = readFileSync(path.join(packageRoot, "dist", "core.js"), "utf8");
const forbiddenImports = [
  "react",
  "react/jsx-runtime",
  "maplibre-gl",
  "three",
  "@moritzbrantner/ui",
  "@moritzbrantner/timeline-editor",
];

for (const packageName of forbiddenImports) {
  if (hasRuntimeImport(coreBundle, packageName)) {
    throw new Error("core bundle must not import " + packageName);
  }
}

function hasRuntimeImport(contents, packageName) {
  return (
    contents.includes('from "' + packageName) ||
    contents.includes("from '" + packageName) ||
    contents.includes('import("' + packageName) ||
    contents.includes("import('" + packageName)
  );
}
`,
  );

  run("bun", ["install"], directory);
  run("bun", ["./main.mjs"], directory);
}

function verifyNextStyleBoundaries(directory, packageTarball) {
  writePackage(directory, {
    "@moritzbrantner/maps": `file:${packageTarball}`,
    "@moritzbrantner/timeline-editor": version("@moritzbrantner/timeline-editor"),
    "@moritzbrantner/ui": version("@moritzbrantner/ui"),
    "@types/geojson": version("@types/geojson"),
    "@types/react": version("@types/react"),
    "@types/react-dom": version("@types/react-dom"),
    react: version("react"),
    "react-dom": version("react-dom"),
    typescript: version("typescript"),
  });
  writeTsConfig(directory);
  writeFile(
    directory,
    "src/server.ts",
    `import {
  createPointAggregationIndex,
  type MapPoint,
} from "@moritzbrantner/maps/core";

export function summarizePoints(points: MapPoint[]) {
  return createPointAggregationIndex(points).getViewportAggregation({
    bounds: [-180, -90, 180, 90],
    zoom: 2,
  });
}
`,
  );
  writeFile(
    directory,
    "src/global.d.ts",
    `declare module "@moritzbrantner/maps/styles.css";
`,
  );
  writeFile(
    directory,
    "src/client-map.tsx",
    `"use client";

import "@moritzbrantner/maps/styles.css";
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

export function ClientMap({ points }: { points: MapPoint[] }) {
  return <ClusteredMap fitToData={false} points={points} style={{ height: 320 }} />;
}
`,
  );

  run("bun", ["install"], directory);
  run("bunx", ["tsc", "--noEmit"], directory);
}

function writePackage(directory, dependencies) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          build: "vite build",
        },
        type: "module",
        dependencies: compactObject(dependencies),
        devDependencies: {},
      },
      null,
      2,
    )}\n`,
  );
}

function writeViteShell(directory) {
  writeTsConfig(directory);
  writeFile(directory, "index.html", `<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n`);
  writeFile(
    directory,
    "vite.config.ts",
    `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
});
`,
  );
}

function writeTsConfig(directory) {
  writeFile(
    directory,
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          target: "ES2022",
          types: ["geojson", "react", "react-dom"],
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(directory, "src"), { recursive: true });
}

function writeFile(directory, relativePath, contents) {
  const filePath = path.join(directory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function version(name) {
  return (
    rootPackageJson.dependencies?.[name] ??
    rootPackageJson.devDependencies?.[name] ??
    rootPackageJson.peerDependencies?.[name]
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result;
}
