#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  {
    outputFileName: "styles.css",
    sourceFileName: "styles.css",
  },
  {
    outputFileName: "styles.full.css",
    sourceFileName: "styles.full.css",
  },
];
const tempDir = path.join(rootDir, ".style-build");

rmSync(tempDir, { force: true, recursive: true });
mkdirSync(tempDir, { recursive: true });

for (const entry of entries) {
  const sourcePath = path.join(rootDir, "src", entry.sourceFileName);
  const outputPath = path.join(rootDir, entry.outputFileName);
  const entryTempDir = path.join(tempDir, path.basename(entry.outputFileName, ".css"));

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      assetsDir: ".",
      emptyOutDir: true,
      outDir: entryTempDir,
      rollupOptions: {
        input: sourcePath,
        output: {
          assetFileNames: "styles[extname]",
          entryFileNames: "style-entry.js",
        },
      },
    },
  });

  const cssPath = findCssFile(entryTempDir);

  if (!cssPath) {
    throw new Error(`Style build did not emit a CSS asset for ${entry.sourceFileName}.`);
  }

  const css = readFileSync(cssPath, "utf8");
  writeFileSync(
    outputPath,
    `/* Generated from src/${entry.sourceFileName}. Run \`bun run build:styles\` after editing package styles. */\n${css}`,
  );
}
rmSync(tempDir, { force: true, recursive: true });

function findCssFile(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const nested = findCssFile(entryPath);

      if (nested) {
        return nested;
      }
    } else if (entry.isFile() && entry.name.endsWith(".css") && existsSync(entryPath)) {
      return entryPath;
    }
  }

  return null;
}
