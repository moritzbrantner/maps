#!/usr/bin/env bun

// The `prepare` script. It only acts when the package sits below node_modules, which is where
// bun places a consumer's commit-pinned git dependency (listed in `trustedDependencies`).
// There it installs the build tools (bun does not install a git dependency's devDependencies),
// builds in a copy outside node_modules (below node_modules esbuild ignores tsconfig.json and
// TypeScript emits no declarations), copies the build output back and removes the build-only
// node_modules, so React and other peers resolve to the consumer's copies. `bun run build`
// builds JS and CSS only; the ./wasm export needs a Rust/wasm-bindgen toolchain.
// In a normal checkout it does nothing: `bun install` and `npm pack` (npm 10 runs prepare
// despite --ignore-scripts) must stay side-effect free there.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const buildOutputs = ["dist"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = path.join(packageRoot, "node_modules");

function run(args: string[], cwd: string) {
  execFileSync("bun", args, { cwd, stdio: "inherit" });
}

if (packageRoot.split(path.sep).includes("node_modules")) {
  run(["install", "--frozen-lockfile", "--ignore-scripts"], packageRoot);

  const buildRoot = mkdtempSync(path.join(tmpdir(), "git-install-build-"));
  const skipped = new Set(
    ["node_modules", ".git", ...buildOutputs].map((entry) => path.join(packageRoot, entry)),
  );

  try {
    cpSync(packageRoot, buildRoot, {
      recursive: true,
      filter: (source) => !skipped.has(source),
    });
    symlinkSync(
      nodeModules,
      path.join(buildRoot, "node_modules"),
      // A junction needs no symlink privilege on Windows.
      process.platform === "win32" ? "junction" : "dir",
    );
    run(["run", "build"], buildRoot);

    for (const output of buildOutputs) {
      rmSync(path.join(packageRoot, output), { recursive: true, force: true });
      cpSync(path.join(buildRoot, output), path.join(packageRoot, output), { recursive: true });
    }
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }

  rmSync(nodeModules, { recursive: true, force: true });
}
