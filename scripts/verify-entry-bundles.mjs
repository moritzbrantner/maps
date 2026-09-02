#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const errors = [];
const entrySizeBudgets = {
  "core.js": 16_384,
  "editor.js": 4_096,
  "flat.js": 8_192,
  "geojson.js": 4_096,
  "heat.js": 4_096,
  "index.js": 40_960,
  "layers.js": 4_096,
  "measurement.js": 4_096,
  "temporal.js": 4_096,
  "timeline.js": 4_096,
};
const maxSharedChunkBytes = 220_000;

verifyMissingImports("core", [
  "react",
  "react/jsx-runtime",
  "flat",
  "three",
  "@moritzbrantner/timeline-editor",
  "@moritzbrantner/viz-engine",
]);
verifyMissingImports("flat", [
  "three",
  "@moritzbrantner/timeline-editor",
]);
verifyBundleBudgets();

for (const [exportPath, exportValue] of Object.entries(packageJson.exports ?? {})) {
  if (exportPath === "./package.json" || exportPath === "./styles.css" || exportPath === "./styles.full.css") {
    continue;
  }

  if (!exportValue?.import || !exportValue?.types) {
    errors.push(`${exportPath}: missing import/types export`);
    continue;
  }

  verifyFile(exportValue.import);
  verifyFile(exportValue.types);
}

if (errors.length > 0) {
  console.error("Entry bundle verification failed:");

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

function verifyMissingImports(entryName, forbiddenPackages) {
  const bundlePath = path.join(rootDir, "dist", `${entryName}.js`);

  if (!existsSync(bundlePath)) {
    errors.push(`dist/${entryName}.js is missing`);
    return;
  }

  const contents = readFileSync(bundlePath, "utf8");

  for (const packageName of forbiddenPackages) {
    if (hasRuntimeImport(contents, packageName)) {
      errors.push(`dist/${entryName}.js must not import ${packageName}`);
    }
  }
}

function hasRuntimeImport(contents, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPattern = new RegExp(
    `(?:from\\s+["']${escaped}(?:/[^"']*)?["']|import\\s*\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\))`,
  );

  return importPattern.test(contents);
}

function verifyFile(exportPath) {
  const absolutePath = path.join(rootDir, exportPath);

  if (!existsSync(absolutePath)) {
    errors.push(`${exportPath} is missing`);
  }
}

function verifyBundleBudgets() {
  const distDir = path.join(rootDir, "dist");

  if (!existsSync(distDir)) {
    errors.push("dist is missing");
    return;
  }

  for (const [fileName, maxBytes] of Object.entries(entrySizeBudgets)) {
    verifyBundleSize(path.join(distDir, fileName), maxBytes, `dist/${fileName}`);
  }

  for (const fileName of readdirSync(distDir)) {
    if (/^chunk-.+\.js$/.test(fileName)) {
      verifyBundleSize(path.join(distDir, fileName), maxSharedChunkBytes, `dist/${fileName}`);
    }
  }
}

function verifyBundleSize(filePath, maxBytes, label) {
  if (!existsSync(filePath)) {
    errors.push(`${label} is missing`);
    return;
  }

  const size = statSync(filePath).size;

  if (size > maxBytes) {
    errors.push(`${label} is ${size} bytes, above budget ${maxBytes} bytes`);
  }
}
