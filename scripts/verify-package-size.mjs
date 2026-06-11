#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const budgets = {
  compressedSize: 190_000,
  entryCount: 80,
  fullStylesheetSize: 125_000,
  stylesheetSize: 116_000,
  unpackedSize: 1_060_000,
};

const pack = spawnSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  {
    cwd: rootDir,
    encoding: "utf8",
  },
);

if (pack.status !== 0) {
  process.stderr.write(pack.stderr);
  process.exit(pack.status ?? 1);
}

let packageInfo;

try {
  const parsed = JSON.parse(pack.stdout);
  packageInfo = parsed[0];
} catch (error) {
  console.error("Package size verification failed: could not parse npm pack JSON output.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const files = Array.isArray(packageInfo?.files) ? packageInfo.files : [];
const stylesheet = files.find((file) => file.path === "styles.css");
const fullStylesheet = files.find((file) => file.path === "styles.full.css");
const requiredFiles = ["styles.css", "styles.full.css", "README.md", "package.json"];
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

console.log("Package size summary:");
console.log(`- compressed size: ${formatBytes(packageInfo?.size)}`);
console.log(`- unpacked size: ${formatBytes(packageInfo?.unpackedSize)}`);
console.log(`- entry count: ${files.length}`);
console.log(`- stylesheet size: ${formatBytes(stylesheet?.size)}`);
console.log(`- full stylesheet size: ${formatBytes(fullStylesheet?.size)}`);

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
