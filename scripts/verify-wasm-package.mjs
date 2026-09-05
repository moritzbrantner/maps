#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-wasm-consumer-"));
let tarballPath;
let preview;

try {
  const pack = run("npm", ["pack", "--ignore-scripts", "--json"], rootDir);
  const packInfo = JSON.parse(pack.stdout)[0];
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
          vite: rootPackage.devDependencies.vite,
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
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>',
  );
  writeFileSync(
    path.join(tempRoot, "src", "main.js"),
    `import init, { MapsPointAggregationIndex } from "@moritzbrantner/maps/wasm";

window.mapsWasmReady = init().then(() => {
  const index = new MapsPointAggregationIndex(
    [
      { id: "berlin", label: "Berlin", latitude: 52.52, longitude: 13.405, metrics: { demand: 2 } },
      { id: "stuttgart", label: "Stuttgart", latitude: 48.7758, longitude: 9.1829, metrics: { demand: 3 } },
    ],
    { extent: 512, maxZoom: 16, minZoom: 0, radius: 72 },
  );

  try {
    const aggregation = index.getViewportAggregation({
      bounds: [8, 47, 14, 53],
      zoom: 17,
    });
    return {
      featureCount: aggregation.features.length,
      pointIds: aggregation.features
        .filter((feature) => feature.kind === "point")
        .map((feature) => feature.pointId)
        .sort(),
    };
  } finally {
    index.free();
  }
});
`,
  );

  run("bun", ["install", "--frozen-lockfile=false"], tempRoot);
  run("bun", ["run", "build"], tempRoot);

  preview = spawn("bun", ["run", "preview"], {
    cwd: tempRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp("http://127.0.0.1:4187/");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4187/");
    const result = await page.evaluate(() => window.mapsWasmReady);

    if (result.featureCount !== 2) {
      throw new Error(`expected 2 WASM aggregation features, received ${result.featureCount}`);
    }
    if (JSON.stringify(result.pointIds) !== JSON.stringify(["berlin", "stuttgart"])) {
      throw new Error(`unexpected WASM point ids: ${JSON.stringify(result.pointIds)}`);
    }
  } finally {
    await browser.close();
  }

  console.log("Packed Maps WASM entrypoint initialized successfully in Chromium.");
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
      throw new Error(`Vite preview exited before serving the WASM consumer (code ${preview.exitCode})`);
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
