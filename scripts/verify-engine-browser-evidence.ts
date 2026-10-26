import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  root,
  process.env.MAPS_BROWSER_EVIDENCE_DIR ?? ".runtime-profiler/maps-camera-world-pan-v1/browser",
);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const scenario = path.join(root, "runtime-profiler-scenarios/camera-world-pan-browser-v1.yaml");
assert(!existsSync(output), `browser evidence already exists and is immutable: ${output}`);
mkdirSync(output, { recursive: true });

for (const implementation of ["reference", "candidate"]) {
  const bundle = path.join(output, implementation);
  invoke(["capture", "--scenario", scenario, "--output", bundle], implementation);
  invoke(["validate", "--bundle", bundle]);
  // The profiler validates its schema and artifact integrity. Maps checks that
  // this workload actually produced renderer-main evidence and its explicit seam.
  const summary = JSON.parse(
    readFileSync(path.join(bundle, "chromium-trace-summary.json"), "utf8"),
  );
  assert(summary.top_level_task_count > 0, "camera journey produced no renderer-main tasks");
  assert(summary.hot_path_count > 0, "camera journey produced no normalized hot paths");
  if (implementation === "candidate") {
    assert(
      summary.boundary_markers.some(
        (marker: { direction: string; label: string; occurrences: number }) =>
          marker.direction === "js-to-wasm" &&
          marker.label === "camera-world-pan" &&
          marker.occurrences === 12,
      ),
      "candidate must retain all 12 explicit camera JS/WASM boundary measures",
    );
  }
}
const comparison = invoke([
  "compare-browser",
  "--reference",
  path.join(output, "reference"),
  "--candidate",
  path.join(output, "candidate"),
  "--json",
]);
writeFileSync(path.join(output, "comparability.json"), comparison);
const report = JSON.parse(comparison);
assert.equal(
  report.status,
  "comparable",
  `browser evidence is unavailable for comparison: ${JSON.stringify(report.reasons)}`,
);
process.stdout.write(
  `${JSON.stringify({ scenarioId: "maps-camera-world-pan-v1", comparability: report.status, output })}\n`,
);

function invoke(args: string[], implementation?: string) {
  const result = spawnSync(profiler, args, {
    cwd: root,
    env: implementation
      ? { ...process.env, MAPS_RUNTIME_PROFILE_IMPLEMENTATION: implementation }
      : process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(
    result.status,
    0,
    `${profiler} ${args[0]} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
