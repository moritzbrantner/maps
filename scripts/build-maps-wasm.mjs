#!/usr/bin/env node

import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmInput = path.join(
  rootDir,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "maps_wasm.wasm",
);
const outDir = path.join(rootDir, "dist", "wasm");

// #305 (owner decision, option A): one build emits two capability modules from the same
// crate and the same speed-first release profile (#343).
// - `maps_wasm` (`@moritzbrantner/maps/wasm`): the full renderer module with the WebGPU base
//   renderer. It also carries every core export, so a WebGPU Map View loads only this module.
// - `maps_wasm_core` (`@moritzbrantner/maps/wasm/core`): the WebGPU-free core (flat runtime and
//   camera planning, aggregation, temporal points, MVT decode/QA) for Canvas2D Map Views and
//   data-only consumers. Its exports are exactly the full module's minus the renderer.
const modules = [
  { features: ["wgpu-base-map"], outName: "maps_wasm" },
  { features: [], outName: "maps_wasm_core" },
];

rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });

for (const { features, outName } of modules) {
  run("cargo", [
    "build",
    "-p",
    "maps-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--locked",
    ...(features.length > 0 ? ["--features", features.join(",")] : []),
  ]);

  run("wasm-bindgen", [
    wasmInput,
    "--out-dir",
    outDir,
    "--out-name",
    outName,
    "--target",
    "web",
    "--typescript",
    "--remove-name-section",
    "--remove-producers-section",
  ]);

  const wasmOutput = path.join(outDir, `${outName}_bg.wasm`);
  const optimizedWasmOutput = path.join(outDir, `${outName}_bg.optimized.wasm`);
  run("wasm-opt", [
    wasmOutput,
    "-O1",
    "--converge",
    "--enable-bulk-memory",
    "--enable-nontrapping-float-to-int",
    "--dae",
    // Keep the existing optimization level's gzip behavior while deduplicating
    // similar monomorphized bodies. Higher levels reduced raw bytes but grew gzip.
    "--merge-similar-functions",
    "-o",
    optimizedWasmOutput,
  ]);
  renameSync(optimizedWasmOutput, wasmOutput);
}

// The demo and browser evidence must consume this build, never an older local copy.
const browserDir = path.join(rootDir, "public", "wasm");
mkdirSync(browserDir, { recursive: true });
for (const { outName } of modules) {
  for (const fileName of [`${outName}.js`, `${outName}_bg.wasm`]) {
    copyFileSync(path.join(outDir, fileName), path.join(browserDir, fileName));
  }
}

console.log(`Built Maps WASM package artifacts in ${path.relative(rootDir, outDir)}.`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT" && command === "wasm-bindgen") {
    console.error(
      "wasm-bindgen CLI is required. Install the pinned tool with: cargo install wasm-bindgen-cli --version 0.2.129 --locked",
    );
    process.exit(1);
  }

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
