#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Re-measured on main 1740615 after Milestone D (#138, 486,433-byte WASM) for #187:
// 532,422-byte WASM, 403,498-byte compressed package, 1,622,346 bytes unpacked. WASM growth per
// PR (wasm-opt -O1): #151 tile prefetch +25,560; #153 instanced circles +4,293; #163 overscan
// pans -6,930; Shortbread tile-pixel retention (289765e) +7,548; camera-ahead prefetch (8e32e7f) +3,550;
// #162 WebGPU polygons +7,015; #180 tile zoom fallback +8,143; Rust 1.99/wasm-bindgen 0.2.129
// -2,683; smaller steps net -507. The package budgets grow by about the same amount.
// #191 then lands the #167 retained vector basemap (Rust Shortbread buckets, retained
// wgpu vector pipelines, shared retained-geometry module): WASM 532,422 -> 591,763
// (+59,341), compressed package 427,892, unpacked 1,696,963.
// Local measurements since: #194 retained points and nearby steps 591,763 -> 604,819 (+13,056);
// #161 stencil polygons and encoded-sRGB blending +2,746; #196 retained polygons (fan, cover and
// screen-extruded stroke pipelines) +16,264 -> 623,829 WASM, compressed package 444,281,
// unpacked 1,750,305.
// Keep a small margin for artifact metadata variation.
const budgets = {
  compressedSize: 446_000,
  entryCount: 84,
  fullStylesheetSize: 125_000,
  stylesheetSize: 116_000,
  unpackedSize: 1_752_500,
  wasmRuntimeSize: 625_500,
};

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
  // npm 10 runs `prepare` despite --ignore-scripts; its output precedes the JSON report.
  const parsed = JSON.parse(pack.stdout.slice(pack.stdout.lastIndexOf("\n[") + 1));
  packageInfo = parsed[0];
} catch (error) {
  console.error("Package size verification failed: could not parse npm pack JSON output.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const files = Array.isArray(packageInfo?.files) ? packageInfo.files : [];
const stylesheet = files.find((file) => file.path === "styles.css");
const fullStylesheet = files.find((file) => file.path === "styles.full.css");
const mapLibreStylesheet = files.find((file) => file.path === "maplibre.css");
const wasmRuntime = files.find((file) => file.path === "dist/wasm/maps_wasm_bg.wasm");
const requiredFiles = [
  "maplibre.css",
  "styles.css",
  "styles.full.css",
  "dist/wasm/maps_wasm_bg.wasm",
  "README.md",
  "package.json",
];
const errors = [];

for (const filePath of requiredFiles) {
  if (!files.some((file) => file.path === filePath)) {
    errors.push(`${filePath} is missing from the dry-run package payload`);
  }
}

checkBudget("compressed package size", packageInfo?.size, budgets.compressedSize, "bytes");
checkBudget("unpacked package size", packageInfo?.unpackedSize, budgets.unpackedSize, "bytes");
checkBudget("package entry count", files.length, budgets.entryCount, "entries");
checkBudget("styles.css size", stylesheet?.size, budgets.stylesheetSize, "bytes");
checkBudget("styles.full.css size", fullStylesheet?.size, budgets.fullStylesheetSize, "bytes");
checkBudget("Maps WASM runtime size", wasmRuntime?.size, budgets.wasmRuntimeSize, "bytes");

console.log("Package size summary:");
console.log(`- compressed size: ${formatBytes(packageInfo?.size)}`);
console.log(`- unpacked size: ${formatBytes(packageInfo?.unpackedSize)}`);
console.log(`- entry count: ${files.length}`);
console.log(`- stylesheet size: ${formatBytes(stylesheet?.size)}`);
console.log(`- full stylesheet size: ${formatBytes(fullStylesheet?.size)}`);
console.log(
  `- MapLibre fallback stylesheet size (reported only): ${formatBytes(mapLibreStylesheet?.size)}`,
);
console.log(`- Maps WASM runtime size: ${formatBytes(wasmRuntime?.size)}`);

if (errors.length > 0) {
  console.error("Package size verification failed:");

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

function checkBudget(label, actual, max, unit) {
  if (typeof actual !== "number") {
    errors.push(`${label} is missing from npm pack output`);
    return;
  }

  if (actual > max) {
    errors.push(`${label} is ${actual} ${unit}, above budget ${max} ${unit}`);
  }
}

function formatBytes(value) {
  return typeof value === "number" ? `${value} bytes` : "missing";
}
