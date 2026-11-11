// Captures `temporal-playback-journey-v1` (#172 phase E, Fast) through the runtime-profiler
// browser collector, checks that the required evidence is complete and that the journey kept
// the Map-Scoped Timeline work contract, and summarizes it per phase. It renders no performance
// verdict: no reference implementation or parent revision runs this journey, so comparison and
// Moonlight stay explicitly unavailable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Summary = { count: number; max: number | null; p50: number | null; p95: number | null };
type LongTasks = { count: number; maxMs: number; totalMs: number };
type Work = Record<string, number>;
type Commit = { label: string; latencyMs: number; runtime: Work; temporal: Work };
type Phase = {
  commits: Commit[];
  durationMs: number;
  frameIntervalsMs: Summary;
  longTasks: LongTasks;
  runtime: Work;
  slowInputEventsMs: Summary;
  temporal: Work;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  root,
  process.env.MAPS_TEMPORAL_EVIDENCE_DIR ?? ".runtime-profiler/maps-temporal-playback-journey-v1",
);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const scenarioFile = path.join(
  root,
  "runtime-profiler-scenarios/temporal-playback-journey-browser-v1.yaml",
);
const canonical = JSON.parse(
  readFileSync(path.join(root, "engine-scenarios/temporal-playback-journey-v1.json"), "utf8"),
);
const TRACKS = canonical.fixture.tracks.trackCount as number;
/** Bytes of one packed Rust sample: `[kind, previous, next, progress, lon, lat]` per track. */
const SAMPLE_BYTES = TRACKS * 6 * 8;
const SEEKS = 8;
const SCRUB_STEPS = 40;
const SOURCE_REPLACEMENTS = 3;
const TEARDOWN_CYCLES = 3;

assert(!existsSync(output), `temporal evidence already exists and is immutable: ${output}`);
mkdirSync(output, { recursive: true });

const bundle = path.join(output, "candidate");
const observationFile = path.join(output, "maps-observation.json");
invoke(["capture", "--scenario", scenarioFile, "--output", bundle], {
  MAPS_TEMPORAL_OBSERVATION: observationFile,
});
invoke(["validate", "--bundle", bundle]);

// runtime-profiler owns the trace and its integrity; Maps checks that this journey actually
// produced renderer-main tasks and measured Rust temporal samples.
const summary = JSON.parse(readFileSync(path.join(bundle, "chromium-trace-summary.json"), "utf8"));
assert(summary.top_level_task_count > 0, "temporal journey produced no renderer-main tasks");
assert(summary.hot_path_count > 0, "temporal journey produced no normalized hot paths");
const markers = new Map<string, { occurrences: number; total_duration_us: number }>(
  summary.boundary_markers.map(
    (marker: { direction: string; label: string; occurrences: number; total_duration_us: number }) => [
      `${marker.direction}:${marker.label}`,
      marker,
    ],
  ),
);
assert(markers.has("js-to-wasm:temporal-sample"), "no measured js-to-wasm temporal-sample crossings");

const observation = JSON.parse(readFileSync(observationFile, "utf8"));
assert.equal(observation.schemaVersion, "maps.temporal-playback-journey-observation/v1");
assert.equal(observation.scenarioId, canonical.id);
assert.match(observation.backend, /^(wgpu|canvas2d)$/);
const phases: Record<string, Phase> = observation.phases;
assert.deepEqual(Object.keys(phases), canonical.runtimePhases);

// Load: the TypeScript reference samples until Rust is ready, then Rust prepares once; the
// runtime's loading status alone never re-prepares the tracks.
assert.equal(observation.load.sampler, "ready", "the Rust temporal sampler was not ready");
assert.equal(observation.load.temporal.playback.rustTrackPreparations, 1);
assert(
  observation.load.temporal.playback.trackPreparations <= 2,
  `load prepared the tracks ${observation.load.temporal.playback.trackPreparations} times`,
);

for (const [name, phase] of Object.entries(phases)) {
  assert(phase.frameIntervalsMs.count > 0, `${name}: no frame intervals`);
  for (const group of [phase.runtime, phase.temporal]) {
    assert(
      Object.values(group).every((value) => Number.isInteger(value)),
      `${name}: incomplete work counters`,
    );
  }
  assert(phase.slowInputEventsMs && typeof phase.slowInputEventsMs.count === "number");
  // Time, camera and source changes never rebuild the static regions or the runtime.
  assert.equal(
    phase.runtime.retainedPolygonSets! + phase.runtime.retainedPolygonUpdates!,
    0,
    `${name}: static regions were rewritten`,
  );
  assert.equal(phase.runtime.tileUploads, 0, `${name}: base tiles were re-uploaded`);
  if (name !== "teardown") {
    assert.equal(
      phase.runtime.freedRuntimes! + phase.runtime.freedRenderers!,
      0,
      `${name}: the Map View runtime was rebuilt`,
    );
  }
  // Every Rust sample is one measured crossing, and nothing else samples.
  assert.equal(phase.runtime.temporalSamples, phase.temporal.samples, `${name}: unattributed samples`);
  assert.equal(phase.temporal.sampledTracks, phase.temporal.samples! * TRACKS, `${name}: sampled tracks`);
  assert.equal(
    phase.temporal.bridgeBytesFromWasm,
    phase.temporal.samples! * SAMPLE_BYTES + phase.temporal.rustTrackPreparations! * 16,
    `${name}: bridge bytes`,
  );
}

const noTemporalWork = (name: string) =>
  assert.deepEqual(
    { preparations: phases[name]!.temporal.trackPreparations, samples: phases[name]!.temporal.samples },
    { preparations: 0, samples: 0 },
    `${name}: did temporal work`,
  );
noTemporalWork("idle");
noTemporalWork("camera-pan-paused");
noTemporalWork("unrelated-commits");
assert(phases["camera-pan-paused"]!.runtime.framePlans! > 0, "camera-pan-paused: no camera frames");

for (const name of ["playback", "seek", "scrub", "camera-pan-playing"]) {
  assert.equal(phases[name]!.temporal.trackPreparations, 0, `${name}: re-prepared the tracks`);
  assert(phases[name]!.temporal.samples! > 0, `${name}: sampled nothing`);
  assert(phases[name]!.temporal.changedFeatures! > 0, `${name}: changed no feature`);
}
assert(
  phases.scrub!.temporal.samples! <= SCRUB_STEPS + 2,
  `scrub: ${phases.scrub!.temporal.samples} samples for ${SCRUB_STEPS} inputs`,
);

assert.equal(phases.seek!.commits.length, SEEKS);
for (const commit of phases.seek!.commits) {
  assert.equal(commit.temporal.samples, 1, `${commit.label}: samples`);
  assert.equal(commit.temporal.trackPreparations, 0, `${commit.label}: re-prepared the tracks`);
}
assert.equal(phases["source-replace"]!.commits.length, SOURCE_REPLACEMENTS);
for (const commit of phases["source-replace"]!.commits) {
  assert.equal(commit.temporal.trackPreparations, 1, `${commit.label}: preparations`);
  assert.equal(commit.temporal.rustTrackPreparations, 1, `${commit.label}: not prepared by Rust`);
}
assert.equal(phases.teardown!.temporal.trackPreparations, TEARDOWN_CYCLES);
assert.equal(phases.teardown!.temporal.rustTrackPreparations, TEARDOWN_CYCLES);
assert.equal(observation.timeKeptAcrossTeardown, true, "teardown lost the map-scoped time");
assert.equal(
  observation.commitLatencyMs.count,
  SEEKS + SOURCE_REPLACEMENTS,
  "input → presented latency samples are missing",
);
assert(
  observation.jsHeapAfterGc.every(
    (sample: { jsHeapUsedBytes: unknown }) => typeof sample.jsHeapUsedBytes === "number",
  ),
  "JS heap samples are unavailable",
);

const perPhase = Object.fromEntries(
  Object.entries(phases).map(([name, phase]) => [
    name,
    {
      frameIntervalsMs: phase.frameIntervalsMs,
      longTasks: phase.longTasks,
      slowInputEventsMs: phase.slowInputEventsMs,
      temporal: {
        bridgeBytesFromWasm: phase.temporal.bridgeBytesFromWasm,
        changedFeatures: phase.temporal.changedFeatures,
        samples: phase.temporal.samples,
        trackPreparations: phase.temporal.trackPreparations,
      },
      runtime: {
        aggregationIndexesReleased: phase.runtime.freedAggregationIndexes,
        aggregationQueries: phase.runtime.aggregationQueries,
        framePlans: phase.runtime.framePlans,
        repaints: phase.runtime.gpuFrames! + phase.runtime.canvasOverlayRedraws!,
        projectedCoordinates: phase.runtime.projectedCoordinates,
      },
    },
  ]),
);
const sampleMarker = markers.get("js-to-wasm:temporal-sample")!;

const evaluation = {
  schemaVersion: "maps.temporal-playback-journey-evaluation/v1",
  scenarioId: canonical.id,
  backend: observation.backend,
  candidateBundle: path.relative(output, bundle),
  observation: path.relative(output, observationFile),
  invariants: "passed",
  perPhase,
  temporalSampleCrossings: sampleMarker,
  commitLatencyMs: observation.commitLatencyMs,
  comparison: "unavailable",
  moonlight: "unavailable",
  reasons: [
    "no reference implementation runs this first-party temporal journey",
    "the parent revision has no capture of this journey",
    "the idle phase is the same Map View paused, not a baseline for a verdict",
  ],
};
writeFileSync(path.join(output, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    scenarioId: canonical.id,
    backend: observation.backend,
    longTasks: summary.long_task_count,
    phases: Object.fromEntries(
      Object.entries(perPhase).map(([name, entry]) => [
        name,
        {
          p95: entry.frameIntervalsMs.p95,
          longTaskMs: Math.round(entry.longTasks.totalMs),
          samples: entry.temporal.samples,
        },
      ]),
    ),
    temporalSampleCrossings: sampleMarker,
    commitLatencyP95: observation.commitLatencyMs.p95,
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
    timeout: 480_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${profiler} ${args[0]} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
