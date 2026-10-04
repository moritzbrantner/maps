#!/usr/bin/env bun

// Proves that a commit-pinned git dependency on this package works through bun's real install
// path: a scratch consumer depends on `git+file://<this repo>#<HEAD>` with the package in
// `trustedDependencies` (bun runs a dependency's lifecycle scripts only for trusted packages),
// installs it, re-installs it with --frozen-lockfile, and every main/types/exports target of
// the installed package must exist.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const packageName: string = manifest.name;
const consumerDir = mkdtempSync(path.join(tmpdir(), "git-install-consumer-"));

function run(args: string[]) {
  execFileSync("bun", args, { cwd: consumerDir, stdio: "inherit" });
}

function collectTargets(value: unknown, targets: string[]) {
  if (typeof value === "string") {
    targets.push(value);
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectTargets(nested, targets);
    }
  }
}

try {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot }).toString().trim();
  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({
      name: "git-install-consumer",
      private: true,
      dependencies: { [packageName]: `git+${pathToFileURL(packageRoot).href}#${head}` },
      trustedDependencies: [packageName],
    }),
  );
  run(["install"]);
  rmSync(path.join(consumerDir, "node_modules"), { recursive: true, force: true });
  run(["install", "--frozen-lockfile"]);

  const installedDir = path.join(consumerDir, "node_modules", packageName);
  const targets: string[] = [];
  collectTargets(manifest.main, targets);
  collectTargets(manifest.types, targets);
  collectTargets(manifest.exports, targets);
  targets.push("./dist/wasm/maps_wasm_bg.wasm");

  const missing = targets
    .map((target) => (target.includes("*") ? path.dirname(target) : target))
    .filter((target) => !existsSync(path.join(installedDir, target)));

  if (missing.length > 0) {
    throw new Error(`Export targets missing after a git install:\n- ${missing.join("\n- ")}`);
  }

  // Exercise the public WASM runtime with the installed bytes, not a checkout build.
  writeFileSync(
    path.join(consumerDir, "verify-runtime.ts"),
    `import { readFileSync } from "node:fs";
import { initSync, MapsFlatRasterRuntime } from "@moritzbrantner/maps/wasm";
initSync({ module: readFileSync(${JSON.stringify(path.join(installedDir, "dist/wasm/maps_wasm_bg.wasm"))}) });
const runtime = new MapsFlatRasterRuntime({
  center: [13.405, 52.52], zoom: 4, width: 800, height: 600,
  source: { minZoom: 0, maxZoom: 18, tileSize: 256 },
});
try {
  const center = runtime.project(13.405, 52.52);
  if (Math.abs(center[0] - 400) > 0.001 || Math.abs(center[1] - 300) > 0.001) {
    throw new Error("Installed Flat Map runtime projects the center incorrectly");
  }
} finally {
  runtime.free();
}
`,
  );
  run(["./verify-runtime.ts"]);

  process.stdout.write(
    `git install of ${head} builds via prepare; ${targets.length} export targets present\n`,
  );
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
}
