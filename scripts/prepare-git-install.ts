#!/usr/bin/env bun

// Build step of the `prepare` script. A consumer that pins this package as a git dependency
// makes bun run `prepare` inside its node_modules. Below node_modules, esbuild ignores
// tsconfig.json and TypeScript emits no declarations, so the build there would fail or differ.
// There, build JS and CSS in a copy outside node_modules and copy the build output back.
// The ./wasm export needs a Rust/wasm-bindgen toolchain and is not built for git installs.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const buildOutputs = ["dist"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function build(cwd: string) {
  execFileSync("bun", ["run", "build"], { cwd, stdio: "inherit" });
}

// In a normal checkout, `bun install` and `npm pack` (npm 10 runs prepare despite
// --ignore-scripts) must not rebuild dist/: that would drop the separately built dist/wasm.
if (packageRoot.split(path.sep).includes("node_modules")) {
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
      path.join(packageRoot, "node_modules"),
      path.join(buildRoot, "node_modules"),
      // A junction needs no symlink privilege on Windows.
      process.platform === "win32" ? "junction" : "dir",
    );
    build(buildRoot);

    for (const output of buildOutputs) {
      rmSync(path.join(packageRoot, output), { recursive: true, force: true });
      cpSync(path.join(buildRoot, output), path.join(packageRoot, output), { recursive: true });
    }
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}
