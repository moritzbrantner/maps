#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const scenario = JSON.parse(
  readFileSync(path.join(rootDir, "engine-scenarios", "camera-world-pan-v1.json"), "utf8"),
);
const referenceAdapter = readFileSync(
  path.join(rootDir, "scripts", "engine-reference", "maplibre-camera.mjs"),
  "utf8",
);
const wasmEntry = path.join(rootDir, "dist", "wasm", "maps_wasm.js");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-camera-evidence-"));
let preview;

try {
  readFileSync(wasmEntry);

  mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@moritzbrantner/maps": `file:${rootDir}`,
          "maplibre-gl": rootPackage.dependencies["maplibre-gl"],
          vite: rootPackage.devDependencies.vite,
        },
        scripts: {
          build: "vite build",
          preview: "vite preview --host 127.0.0.1 --port 4188 --strictPort",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(tempRoot, "index.html"),
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>',
  );
  writeFileSync(path.join(tempRoot, "src", "maplibre-camera-reference.js"), referenceAdapter);
  writeFileSync(
    path.join(tempRoot, "src", "main.js"),
    String.raw`import init, { executeEngineScenario } from "@moritzbrantner/maps/wasm";
import { executeMapLibreCameraScenario } from "./maplibre-camera-reference.js";

const scenario = ${JSON.stringify(scenario)};
const EPSILON = 1e-6;

window.mapsEngineCameraEvidence = (async () => {
  await init();

  const candidate = executeEngineScenario(scenario);
  const reference = await executeMapLibreCameraScenario(scenario);
  const comparison = compareSemanticObservations(reference, candidate);

  return {
    comparison,
    candidateImplementation: candidate.implementation,
    referenceImplementation: reference.implementation,
    scenarioId: scenario.id,
    stateCount: candidate.states.length,
  };
})();

function compareSemanticObservations(reference, candidate) {
  const referenceSemantic = { ...reference };
  const candidateSemantic = { ...candidate };
  delete referenceSemantic.implementation;
  delete candidateSemantic.implementation;

  const stats = { maxNumericDelta: 0, numericComparisons: 0 };
  compareValue(referenceSemantic, candidateSemantic, "observation", stats);
  return stats;
}

function compareValue(reference, candidate, path, stats) {
  if (typeof reference === "number" || typeof candidate === "number") {
    if (!Number.isFinite(reference) || !Number.isFinite(candidate)) {
      throw new Error(path + " must contain finite numbers");
    }
    const delta = Math.abs(reference - candidate);
    stats.maxNumericDelta = Math.max(stats.maxNumericDelta, delta);
    stats.numericComparisons += 1;
    if (delta > EPSILON) {
      throw new Error(path + " numeric mismatch: reference=" + reference + " candidate=" + candidate + " delta=" + delta);
    }
    return;
  }

  if (Array.isArray(reference) || Array.isArray(candidate)) {
    if (!Array.isArray(reference) || !Array.isArray(candidate)) {
      throw new Error(path + " array/type mismatch");
    }
    if (reference.length !== candidate.length) {
      throw new Error(path + " length mismatch: reference=" + reference.length + " candidate=" + candidate.length);
    }
    reference.forEach((value, index) => compareValue(value, candidate[index], path + "[" + index + "]", stats));
    return;
  }

  if (reference !== null && typeof reference === "object") {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(path + " object/type mismatch");
    }
    const referenceKeys = Object.keys(reference).sort();
    const candidateKeys = Object.keys(candidate).sort();
    if (JSON.stringify(referenceKeys) !== JSON.stringify(candidateKeys)) {
      throw new Error(path + " key mismatch: reference=" + JSON.stringify(referenceKeys) + " candidate=" + JSON.stringify(candidateKeys));
    }
    for (const key of referenceKeys) {
      compareValue(reference[key], candidate[key], path + "." + key, stats);
    }
    return;
  }

  if (reference !== candidate) {
    throw new Error(path + " mismatch: reference=" + JSON.stringify(reference) + " candidate=" + JSON.stringify(candidate));
  }
}
`,
  );

  run("bun", ["install"], tempRoot);
  run("bun", ["run", "build"], tempRoot);

  preview = spawn("bun", ["run", "preview"], {
    cwd: tempRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp("http://127.0.0.1:4188/");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4188/");
    const result = await page.evaluate(() => window.mapsEngineCameraEvidence);

    if (result.scenarioId !== "camera-world-pan-v1") {
      throw new Error(`unexpected camera scenario ${result.scenarioId}`);
    }
    if (result.stateCount !== scenario.operations.length + 1) {
      throw new Error(
        `expected ${scenario.operations.length + 1} camera states, received ${result.stateCount}`,
      );
    }
    if (result.comparison.numericComparisons === 0) {
      throw new Error("camera parity did not compare numeric observations");
    }

    console.log("Maps Rust/WASM camera reference parity passed.");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  preview?.kill("SIGTERM");
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
      throw new Error(`Vite preview exited before camera evidence was served (code ${preview.exitCode})`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`camera evidence preview did not become ready: ${String(lastError ?? "timeout")}`);
}
