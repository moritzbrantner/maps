#!/usr/bin/env node

import { mkdirSync, renameSync, rmSync } from "node:fs";
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
const wasmOutput = path.join(outDir, "maps_wasm_bg.wasm");
const optimizedWasmOutput = path.join(outDir, "maps_wasm_bg.optimized.wasm");

run("cargo", [
  "build",
  "-p",
  "maps-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--locked",
  "--features",
  "wgpu-base-map",
]);

rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });

run("wasm-bindgen", [
  wasmInput,
  "--out-dir",
  outDir,
  "--out-name",
  "maps_wasm",
  "--target",
  "web",
  "--typescript",
  "--remove-name-section",
  "--remove-producers-section",
]);

run("wasm-opt", [
  wasmOutput,
  "-O1",
  "--converge",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--dae",
  "-o",
  optimizedWasmOutput,
]);
renameSync(optimizedWasmOutput, wasmOutput);

console.log(`Built Maps WASM package artifact in ${path.relative(rootDir, outDir)}.`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT" && command === "wasm-bindgen") {
    console.error(
      "wasm-bindgen CLI is required. Install the pinned tool with: cargo install wasm-bindgen-cli --version 0.2.128 --locked",
    );
    process.exit(1);
  }

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
