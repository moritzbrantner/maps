// Captures `mixed-layer-journey-v1` (#170 Fast) through the runtime-profiler browser
// collector and checks that the required evidence is complete. It renders no verdict:
// no reference or parent runs this journey, so comparison stays explicitly unavailable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  root,
  process.env.MAPS_MIXED_LAYER_EVIDENCE_DIR ?? ".runtime-profiler/maps-mixed-layer-journey-v1",
);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const scenarioFile = path.join(root, "runtime-profiler-scenarios/mixed-layer-journey-browser-v1.yaml");
const canonical = JSON.parse(
  readFileSync(path.join(root, "engine-scenarios/mixed-layer-journey-v1.json"), "utf8"),
);
assert(!existsSync(output), `mixed-layer evidence already exists and is immutable: ${output}`);
mkdirSync(output, { recursive: true });

const bundle = path.join(output, "candidate");
const observationFile = path.join(output, "maps-observation.json");
invoke(["capture", "--scenario", scenarioFile, "--output", bundle], {
  MAPS_MIXED_LAYER_OBSERVATION: observationFile,
});
invoke(["validate", "--bundle", bundle]);

// runtime-profiler owns the trace and its integrity; Maps checks that this journey
// actually produced renderer-main tasks and its explicit JS → WASM crossings.
const summary = JSON.parse(readFileSync(path.join(bundle, "chromium-trace-summary.json"), "utf8"));
assert(summary.top_level_task_count > 0, "mixed-layer journey produced no renderer-main tasks");
assert(summary.hot_path_count > 0, "mixed-layer journey produced no normalized hot paths");
const markers = new Map<string, { occurrences: number; total_duration_us: number }>(
  summary.boundary_markers.map(
    (marker: { direction: string; label: string; occurrences: number; total_duration_us: number }) => [
      `${marker.direction}:${marker.label}`,
      marker,
    ],
  ),
);
assert(markers.has("js-to-wasm:frame-plan"), "no measured js-to-wasm frame-plan crossings");

const observation = JSON.parse(readFileSync(observationFile, "utf8"));
assert.equal(observation.schemaVersion, "maps.mixed-layer-journey-observation/v1");
assert.equal(observation.scenarioId, canonical.id);
assert.match(observation.backend, /^(wgpu|canvas2d)$/);
assert.deepEqual(Object.keys(observation.phases), canonical.runtimePhases);
for (const [name, phase] of Object.entries<{ work: Record<string, unknown> }>(observation.phases)) {
  assert(
    Object.values(phase.work).every((value) => Number.isInteger(value)),
    `phase ${name} has incomplete work counters`,
  );
}
assert(observation.picks.count >= 9, "pointer → interaction latency was not observed");
assert(
  observation.memory.jsHeapAfterGc.every(
    (sample: { jsHeapUsedBytes: unknown }) => typeof sample.jsHeapUsedBytes === "number",
  ),
  "JS heap samples are unavailable",
);

const evaluation = {
  schemaVersion: "maps.mixed-layer-journey-evaluation/v1",
  scenarioId: canonical.id,
  candidateBundle: path.relative(output, bundle),
  observation: path.relative(output, observationFile),
  comparison: "unavailable",
  moonlight: "unavailable",
  reasons: [
    "no reference implementation runs this first-party mixed-layer journey",
    "the parent revision has no capture of this journey",
  ],
};
writeFileSync(path.join(output, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    scenarioId: canonical.id,
    backend: observation.backend,
    longTasks: summary.long_task_count,
    boundaryMarkers: Object.fromEntries(
      [...markers].map(([label, marker]) => [label, marker.occurrences]),
    ),
    comparison: evaluation.comparison,
    output,
  })}\n`,
);

function invoke(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(profiler, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 360_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${profiler} ${args[0]} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
