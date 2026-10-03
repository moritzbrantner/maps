#!/usr/bin/env bun

// Proves that a commit-pinned git dependency on this package works: a clean clone of HEAD,
// placed below node_modules like bun places a git dependency, must build with nothing but the
// `prepare` script, and every main/types/exports target must exist afterwards.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName: string = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).name;
// The ./wasm export needs a Rust/wasm-bindgen toolchain; prepare builds only JS and CSS.
const gitInstallOmits = new Set(["./dist/wasm/maps_wasm.d.ts", "./dist/wasm/maps_wasm.js"]);
const tempRoot = mkdtempSync(path.join(tmpdir(), "git-install-"));
const cloneDir = path.join(tempRoot, "node_modules", packageName);

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
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
  mkdirSync(path.dirname(cloneDir), { recursive: true });
  run("git", ["clone", "--quiet", "--no-checkout", packageRoot, cloneDir], packageRoot);
  run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", head], cloneDir);

  const manifest = JSON.parse(readFileSync(path.join(cloneDir, "package.json"), "utf8"));
  if (manifest.scripts?.prepare !== "bun ./scripts/prepare-git-install.ts") {
    throw new Error("package.json prepare must run ./scripts/prepare-git-install.ts");
  }

  run("bun", ["run", "prepare"], cloneDir);

  if (existsSync(path.join(cloneDir, "node_modules"))) {
    throw new Error(
      "prepare must remove its build-only node_modules so peers resolve to the consumer",
    );
  }

  const targets: string[] = [];
  collectTargets(manifest.main, targets);
  collectTargets(manifest.types, targets);
  collectTargets(manifest.exports, targets);

  const missing = targets
    .filter((target) => !gitInstallOmits.has(target))
    .map((target) => (target.includes("*") ? path.dirname(target) : target))
    .filter((target) => !existsSync(path.join(cloneDir, target)));

  if (missing.length > 0) {
    throw new Error(
      `Export targets missing after prepare in a clean clone:\n- ${missing.join("\n- ")}`,
    );
  }

  process.stdout.write(
    `Clean clone of ${head} builds via prepare; ${targets.length} export targets present\n`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
