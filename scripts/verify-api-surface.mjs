#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = path.join(rootDir, "api-surface.json");
const shouldUpdate = process.argv.includes("--update");

const entrySources = {
  ".": "src/index.ts",
  "./core": "src/entries/core.ts",
  "./editor": "src/entries/editor.ts",
  "./flat": "src/entries/flat.ts",
  "./geojson": "src/entries/geojson.ts",
  "./heat": "src/entries/heat.ts",
  "./layers": "src/entries/layers.ts",
  "./measurement": "src/entries/measurement.ts",
  "./temporal": "src/entries/temporal.ts",
  "./timeline": "src/entries/timeline.ts",
};

const actual = Object.fromEntries(
  Object.entries(entrySources).map(([entry, sourcePath]) => [
    entry,
    readExportedNames(path.join(rootDir, sourcePath)),
  ]),
);

if (shouldUpdate) {
  writeFileSync(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Updated ${path.relative(rootDir, snapshotPath)}`);
  process.exit(0);
}

if (!existsSync(snapshotPath)) {
  console.error("Missing api-surface.json. Run `node scripts/verify-api-surface.mjs --update`.");
  process.exit(1);
}

const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
const errors = [];

for (const entry of Object.keys(entrySources)) {
  const expectedNames = expected[entry] ?? [];
  const actualNames = actual[entry] ?? [];
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const added = actualNames.filter((name) => !expectedNames.includes(name));

  if (missing.length > 0 || added.length > 0) {
    errors.push({
      added,
      entry,
      missing,
    });
  }
}

if (errors.length > 0) {
  console.error("API surface verification failed:");

  for (const error of errors) {
    console.error(`- ${error.entry}`);

    if (error.missing.length > 0) {
      console.error(`  missing: ${error.missing.join(", ")}`);
    }

    if (error.added.length > 0) {
      console.error(`  added: ${error.added.join(", ")}`);
    }
  }

  console.error("Run `node scripts/verify-api-surface.mjs --update` after intentional API changes.");
  process.exit(1);
}

function readExportedNames(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const names = new Set();
  const exportBlockPattern = /export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["'];/g;

  for (const match of source.matchAll(exportBlockPattern)) {
    for (const specifier of match[1].split(",")) {
      const name = getExportedSpecifierName(specifier);

      if (name) {
        names.add(name);
      }
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function getExportedSpecifierName(specifier) {
  const cleaned = specifier.trim().replace(/^type\s+/, "");

  if (!cleaned) {
    return null;
  }

  const aliasParts = cleaned.split(/\s+as\s+/);
  const exportedName = aliasParts[aliasParts.length - 1]?.trim();

  return exportedName && /^[A-Za-z_$][\w$]*$/.test(exportedName) ? exportedName : null;
}
