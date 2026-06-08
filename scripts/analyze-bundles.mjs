#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const baselinePath = path.join(rootDir, "bundle-baseline.json");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const limit = Number(process.env.MAPS_BUNDLE_ANALYSIS_LIMIT ?? "16");
const updateBaseline = process.argv.includes("--update-baseline");

if (!existsSync(distDir)) {
  console.error("dist is missing. Run `bun run build` before bundle analysis.");
  process.exit(1);
}

const jsFiles = readdirSync(distDir)
  .filter((fileName) => fileName.endsWith(".js"))
  .sort();
const entries = getPackageEntries();
const importsByFile = new Map(
  jsFiles.map((fileName) => [fileName, getStaticImports(path.join(distDir, fileName))]),
);
const ownersByFile = getOwnersByFile(entries, importsByFile);
const files = jsFiles
  .map((fileName) => {
    const absolutePath = path.join(distDir, fileName);
    const bytes = statSync(absolutePath).size;
    const owners = ownersByFile.get(fileName) ?? [];

    return {
      baselineBytes: readBaseline()?.files?.[fileName],
      bytes,
      fileName,
      kib: bytes / 1024,
      owner: owners.length === 0 ? "unattributed" : owners.length === 1 ? owners[0] : `shared: ${owners.join(", ")}`,
    };
  })
  .sort((left, right) => right.bytes - left.bytes);

if (updateBaseline) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        files: Object.fromEntries(files.map((file) => [file.fileName, file.bytes])),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Updated ${path.relative(rootDir, baselinePath)}`);
}

console.log(`Largest ${Math.min(limit, files.length)} JavaScript bundles in dist:`);
console.log(`${"file".padEnd(34)} ${"size".padStart(10)} ${"delta".padStart(10)}  owner`);

for (const item of files.slice(0, limit)) {
  console.log(
    `${item.fileName.padEnd(34)} ${formatKib(item.bytes).padStart(10)} ${formatDelta(
      item.bytes,
      item.baselineBytes,
    ).padStart(10)}  ${item.owner}`,
  );
}

function getPackageEntries() {
  const result = new Map();

  for (const [exportPath, exportValue] of Object.entries(packageJson.exports ?? {})) {
    if (exportPath === "./package.json" || exportPath === "./styles.css") {
      continue;
    }

    const importPath = exportValue?.import;

    if (typeof importPath !== "string" || !importPath.startsWith("./dist/")) {
      continue;
    }

    result.set(path.basename(importPath), exportPath === "." ? "root" : exportPath.slice(2));
  }

  return result;
}

function getStaticImports(filePath) {
  const contents = readFileSync(filePath, "utf8");
  const imports = new Set();
  const importPattern =
    /(?:import\s*(?:[^"'()]+?\s+from\s*)?["'](\.\/[^"']+\.js)["']|from\s+["'](\.\/[^"']+\.js)["'])/g;

  for (const match of contents.matchAll(importPattern)) {
    const importPath = match[1] ?? match[2];

    if (importPath) {
      imports.add(path.basename(importPath));
    }
  }

  return [...imports].filter((fileName) => jsFiles.includes(fileName));
}

function getOwnersByFile(entriesByFile, importsByFile) {
  const owners = new Map();

  for (const [entryFile, entryName] of entriesByFile) {
    const visited = new Set();

    visit(entryFile);

    for (const fileName of visited) {
      const fileOwners = owners.get(fileName) ?? [];

      if (!fileOwners.includes(entryName)) {
        fileOwners.push(entryName);
      }

      owners.set(fileName, fileOwners.sort());
    }

    function visit(fileName) {
      if (visited.has(fileName)) {
        return;
      }

      visited.add(fileName);

      for (const importFile of importsByFile.get(fileName) ?? []) {
        visit(importFile);
      }
    }
  }

  return owners;
}

function readBaseline() {
  if (!existsSync(baselinePath)) {
    return null;
  }

  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function formatKib(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function formatDelta(bytes, baselineBytes) {
  if (typeof baselineBytes !== "number") {
    return "new";
  }

  const delta = bytes - baselineBytes;

  if (delta === 0) {
    return "0.00 KiB";
  }

  const sign = delta > 0 ? "+" : "";

  return `${sign}${formatKib(delta)}`;
}
