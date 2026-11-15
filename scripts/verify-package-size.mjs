#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNpmPackResult } from "./npm-pack-result.ts";
import {
  approvedSizeBaseline,
  evaluatePackageSize,
  packageSizeBudgets,
} from "./package-size-budget.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pack = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (pack.status !== 0) {
  process.stderr.write(pack.stderr);
  process.exit(pack.status ?? 1);
}

let packageInfo;

try {
  packageInfo = parseNpmPackResult(pack.stdout);
} catch (error) {
  console.error("Package size verification failed: could not parse npm pack JSON output.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const {
  advisories,
  errors,
  files,
  fullStylesheet,
  mapLibreStylesheet,
  nonWasmUnpackedSize,
  stylesheet,
  wasmCoreRuntime,
  wasmRuntime,
} = evaluatePackageSize(packageInfo);

console.log("Package size summary:");
console.log(`- compressed size: ${formatBytes(packageInfo?.size)}`);
console.log(`- unpacked size: ${formatBytes(packageInfo?.unpackedSize)}`);
console.log(
  `- non-WASM unpacked: ${formatBytes(nonWasmUnpackedSize)} / ${packageSizeBudgets.advisoryUnpackedSizeWithoutWasm} bytes advisory ceiling`,
);
if (typeof nonWasmUnpackedSize === "number") {
  const delta = nonWasmUnpackedSize - approvedSizeBaseline.nonWasmUnpackedBytes;
  console.log(
    `- change since approved ${approvedSizeBaseline.revision} snapshot: ${delta >= 0 ? "+" : ""}${delta} bytes (historical reference, not a matched-PR delta)`,
  );
}
console.log(`- entry count: ${files.length}`);
console.log(`- stylesheet size: ${formatBytes(stylesheet?.size)}`);
console.log(`- full stylesheet size: ${formatBytes(fullStylesheet?.size)}`);
console.log(
  `- MapLibre fallback stylesheet size (reported only): ${formatBytes(mapLibreStylesheet?.size)}`,
);
console.log(
  `- Maps WASM renderer runtime size (@moritzbrantner/maps/wasm, WebGPU Map Views): ${formatBytes(wasmRuntime?.size)} raw, ${formatBytes(gzipSize(wasmRuntime))} gzip`,
);
console.log(
  `- Maps WASM core runtime size (@moritzbrantner/maps/wasm/core, Canvas2D and data-only): ${formatBytes(wasmCoreRuntime?.size)} raw, ${formatBytes(gzipSize(wasmCoreRuntime))} gzip`,
);

if (advisories.length > 0) {
  console.warn("Package size advisory (not a failure, #173):");

  for (const advisory of advisories) {
    console.warn(`- ${advisory}`);
  }
}

if (errors.length > 0) {
  console.error("Package size verification failed:");

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

// Transfer size of a packed file, as a gzip -9 response (reported only, #305).
function gzipSize(file) {
  const filePath = file ? path.join(rootDir, file.path) : null;
  return filePath && existsSync(filePath)
    ? gzipSync(readFileSync(filePath), { level: 9 }).length
    : undefined;
}

function formatBytes(value) {
  return typeof value === "number" ? `${value} bytes` : "missing";
}
