#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const errors = [];

verifyMissingImports("core", [
  "react",
  "react/jsx-runtime",
  "flat",
  "three",
  "world-atlas",
  "topojson-client",
  "@moritzbrantner/ui",
  "@moritzbrantner/timeline-editor",
]);
verifyMissingImports("flat", [
  "three",
  "world-atlas",
  "topojson-client",
  "@moritzbrantner/timeline-editor",
]);

for (const [exportPath, exportValue] of Object.entries(packageJson.exports ?? {})) {
  if (exportPath === "./styles.css") {
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
