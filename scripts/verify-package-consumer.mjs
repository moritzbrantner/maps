#!/usr/bin/env node

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const tempDir = mkdtempSync(path.join(os.tmpdir(), "maps-consumer-"));
let tarballPath = null;

try {
  const pack = run("npm", ["pack", "--ignore-scripts", "--json"], rootDir);
  const packInfo = JSON.parse(pack.stdout)[0];

  tarballPath = path.join(rootDir, packInfo.filename);

  writeConsumerFiles(tempDir, tarballPath, rootPackageJson);
  run("bun", ["install"], tempDir);
  run("bunx", ["--bun", "vite", "build"], tempDir);

  console.log("Packed consumer verification passed.");
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }

  rmSync(tempDir, { force: true, recursive: true });
}

function writeConsumerFiles(directory, packageTarball, packageJson) {
  const version = (name) =>
    packageJson.dependencies?.[name] ??
    packageJson.devDependencies?.[name] ??
    packageJson.peerDependencies?.[name];

  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          build: "vite build",
        },
        type: "module",
        dependencies: {
          "@moritzbrantner/maps": `file:${packageTarball}`,
          "@moritzbrantner/timeline-editor": version("@moritzbrantner/timeline-editor"),
          "@moritzbrantner/ui": version("@moritzbrantner/ui"),
          "@tailwindcss/vite": version("@tailwindcss/vite"),
          "@vitejs/plugin-react": version("@vitejs/plugin-react"),
          react: version("react"),
          "react-dom": version("react-dom"),
          typescript: version("typescript"),
          vite: version("vite"),
        },
        devDependencies: {},
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "index.html"),
    `<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n`,
  );
  writeFileSync(
    path.join(directory, "vite.config.ts"),
    `import tailwindcss from "@tailwindcss/vite";\nimport react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n});\n`,
  );
  writeFileSync(path.join(directory, "tsconfig.json"), `{"compilerOptions":{"jsx":"react-jsx","module":"ESNext","moduleResolution":"Bundler","strict":true,"target":"ES2022"},"include":["src"]}\n`);
  mkdirSync(path.join(directory, "src"));
  writeFileSync(
    path.join(directory, "src", "main.tsx"),
    `import { createRoot } from "react-dom/client";\nimport "@moritzbrantner/maps/styles.css";\nimport { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";\nimport { createPointAggregationIndex } from "@moritzbrantner/maps/core";\nimport { MapLayers, MapView } from "@moritzbrantner/maps/layers";\nimport { FlatPointMap } from "@moritzbrantner/maps/flat";\nimport { GlobePointMap } from "@moritzbrantner/maps/globe";\nimport { EditableGeoJsonMap } from "@moritzbrantner/maps/editor";\nimport { createGeoJsonTimelineDocument } from "@moritzbrantner/maps/timeline";\nimport packageJson from "@moritzbrantner/maps/package.json";\n\nconst points: MapPoint[] = [{ id: "berlin", latitude: 52.52, longitude: 13.405 }];\nconst collection = { type: "FeatureCollection" as const, features: [] };\n\ncreatePointAggregationIndex(points);\ncreateGeoJsonTimelineDocument(collection);\nconsole.log(packageJson.name, Boolean(MapView), Boolean(MapLayers), Boolean(FlatPointMap), Boolean(GlobePointMap), Boolean(EditableGeoJsonMap));\n\ncreateRoot(document.getElementById("root")!).render(\n  <ClusteredMap\n    defaultViewState={{ center: [13.405, 52.52], zoom: 8 }}\n    fitToData={false}\n    points={points}\n    style={{ height: 320 }}\n  />,\n);\n`,
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
