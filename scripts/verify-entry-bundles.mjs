#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const errors = [];
const entrySizeBudgets = {
  "core.js": 16_384,
  "editor.js": 8_192,
  "flat.js": 8_192,
  "geojson.js": 4_096,
  "heat.js": 4_096,
  "index.js": 40_960,
  "layers.js": 4_096,
  "measurement.js": 4_096,
  "temporal.js": 4_096,
  "timeline.js": 4_096,
};
const maxSharedChunkBytes = 222_600;

verifyMissingImports("core", [
  "react",
  "react/jsx-runtime",
  "flat",
  "three",
  "@moritzbrantner/ui",
  "@moritzbrantner/timeline-editor",
  "@moritzbrantner/viz-engine",
  "@moritzbrantner/2d-lab",
  "2d-lab",
]);
verifyMissingImports("flat", [
  "three",
  "@moritzbrantner/timeline-editor",
]);
// Bundlers (Rollup/Vite) resolve dynamically imported chunks too and fail on named imports from
// a missing optional peer, so nothing the root entry reaches may import it.
verifyMissingImports("index", ["@moritzbrantner/timeline-editor"], { transitive: true });
verifyDefaultOnlyImports(["polygon-clipping"]);
verifyBundleBudgets();

for (const [exportPath, exportValue] of Object.entries(packageJson.exports ?? {})) {
  if (exportPath === "./package.json") {
    continue;
  }

  if (typeof exportValue === "string" && exportValue.endsWith(".css")) {
    verifyFile(exportValue);
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

function verifyMissingImports(entryName, forbiddenPackages, { transitive = false } = {}) {
  const bundlePath = path.join(rootDir, "dist", `${entryName}.js`);

  if (!existsSync(bundlePath)) {
    errors.push(`dist/${entryName}.js is missing`);
    return;
  }

  for (const filePath of (transitive ? collectBundleGraph(bundlePath) : [bundlePath])) {
    const contents = readFileSync(filePath, "utf8");
    const via = path.basename(filePath) === `${entryName}.js` ? "" : ` (via dist/${path.basename(filePath)})`;

    for (const packageName of forbiddenPackages) {
      if (hasRuntimeImport(contents, packageName)) {
        errors.push(`dist/${entryName}.js must not import ${packageName}${via}`);
      }
    }
  }
}

// An entry plus every local chunk it reaches through static or dynamic imports.
function collectBundleGraph(entryPath) {
  const seen = new Set();
  const pending = [entryPath];
  const localImportPattern = /(?:from\s*|import\s*\(?\s*)["'](\.\/[^"']+\.js)["']/g;

  while (pending.length > 0) {
    const filePath = pending.pop();

    if (seen.has(filePath) || !existsSync(filePath)) {
      continue;
    }

    seen.add(filePath);

    for (const match of readFileSync(filePath, "utf8").matchAll(localImportPattern)) {
      pending.push(path.join(path.dirname(filePath), match[1]));
    }
  }

  return seen;
}

// Packages whose ESM build only has a default export: named imports fail under Rollup.
function verifyDefaultOnlyImports(packageNames) {
  const distDir = path.join(rootDir, "dist");

  if (!existsSync(distDir)) {
    return;
  }

  for (const fileName of readdirSync(distDir)) {
    if (!fileName.endsWith(".js")) {
      continue;
    }

    const contents = readFileSync(path.join(distDir, fileName), "utf8");

    for (const packageName of packageNames) {
      const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const namedImportPattern = new RegExp(`import\\s*(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\}\\s*from\\s*["']${escaped}["']`);

      if (namedImportPattern.test(contents)) {
        errors.push(`dist/${fileName} uses named imports from ${packageName}; import its default export`);
      }
    }
  }
}

function hasRuntimeImport(contents, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPattern = new RegExp(
    `(?:from\\s*["']${escaped}(?:/[^"']*)?["']|import\\s*\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\))`,
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
