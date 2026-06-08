#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = path.join(rootDir, ".style-build");
const sourcePath = path.join(rootDir, "src", "styles.css");
const outputPath = path.join(rootDir, "styles.css");

rmSync(tempDir, { force: true, recursive: true });
mkdirSync(tempDir, { recursive: true });

await build({
  configFile: false,
  logLevel: "silent",
  plugins: [tailwindcss()],
  build: {
    assetsDir: ".",
    emptyOutDir: true,
    outDir: tempDir,
    rollupOptions: {
      input: sourcePath,
      output: {
        assetFileNames: "styles[extname]",
        entryFileNames: "style-entry.js",
      },
    },
  },
});

const cssPath = findCssFile(tempDir);

if (!cssPath) {
  throw new Error("Style build did not emit a CSS asset.");
}

const css = readFileSync(cssPath, "utf8");
writeFileSync(
  outputPath,
  `/* Generated from src/styles.css. Run \`bun run build:styles\` after editing package styles. */\n${css}`,
);
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
