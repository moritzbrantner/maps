#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const limit = Number(process.env.MAPS_BUNDLE_ANALYSIS_LIMIT ?? "12");

if (!existsSync(distDir)) {
  console.error("dist is missing. Run `bun run build` before bundle analysis.");
  process.exit(1);
}

const files = readdirSync(distDir)
  .filter((fileName) => fileName.endsWith(".js"))
  .map((fileName) => {
    const absolutePath = path.join(distDir, fileName);

    return {
      bytes: statSync(absolutePath).size,
      fileName,
      kib: statSync(absolutePath).size / 1024,
    };
  })
  .sort((left, right) => right.bytes - left.bytes);

console.log(`Largest ${Math.min(limit, files.length)} JavaScript bundles in dist:`);

for (const item of files.slice(0, limit)) {
  console.log(`${item.fileName.padEnd(32)} ${item.kib.toFixed(2).padStart(8)} KiB`);
}
