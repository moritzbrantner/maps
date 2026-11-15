// Captures `camera-transition-journey-v1` (#433, Fast) through the runtime-profiler browser
// collector, checks that the required evidence is complete and that the journey kept the
// camera transition work contract, and summarizes it per phase. It renders no performance
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
type Flight = {
  label: string;
  frames: number;
  presentedMs: number | null;
  maxFrameGapMs: number | null;
  endedOnTarget: boolean;
  ending: "completed" | "superseded" | "pointer" | "unmounted";
  framesAfterEnd: number;
  work: { animationFrames: number; framePlans: number; renders: number } | null;
};
type Phase = {
  durationMs: number;
  flights: Flight[];
  frameIntervalsMs: Summary;
  longTasks: LongTasks;
  renderer: { renders: number; translatedFrames: number } | null;
  runtime: Work;
  slowInputEventsMs: Summary;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  root,
  process.env.MAPS_CAMERA_TRANSITION_EVIDENCE_DIR ??
    ".runtime-profiler/maps-camera-transition-journey-v1",
);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const scenarioFile = path.join(
  root,
  "runtime-profiler-scenarios/camera-transition-journey-browser-v1.yaml",
);
const canonical = JSON.parse(
  readFileSync(path.join(root, "engine-scenarios/camera-transition-journey-v1.json"), "utf8"),
);
const JUMPS = 10;
const TEARDOWN_CYCLES = 3;
/** Camera phases: each presented camera frame plans and renders the base once. */
const MOTION_PHASES = ["flight", "dateline", "successive", "pointer-interrupt", "resize"];

assert(
  !existsSync(output),
  `camera transition evidence already exists and is immutable: ${output}`,
);
mkdirSync(output, { recursive: true });

const bundle = path.join(output, "candidate");
const observationFile = path.join(output, "maps-observation.json");
invoke(["capture", "--scenario", scenarioFile, "--output", bundle], {
  MAPS_CAMERA_TRANSITION_OBSERVATION: observationFile,
});
invoke(["validate", "--bundle", bundle]);

// runtime-profiler owns the trace and its integrity; Maps checks that this journey actually
// produced renderer-main tasks and measured Rust frame plans.
const summary = JSON.parse(readFileSync(path.join(bundle, "chromium-trace-summary.json"), "utf8"));
assert(summary.top_level_task_count > 0, "camera journey produced no renderer-main tasks");
assert(summary.hot_path_count > 0, "camera journey produced no normalized hot paths");
const markers = new Map<string, { occurrences: number; total_duration_us: number }>(
  summary.boundary_markers.map(
    (marker: {
      direction: string;
      label: string;
      occurrences: number;
      total_duration_us: number;
    }) => [`${marker.direction}:${marker.label}`, marker],
  ),
);
assert(markers.has("js-to-wasm:frame-plan"), "no measured js-to-wasm frame-plan crossings");

const observation = JSON.parse(readFileSync(observationFile, "utf8"));
assert.equal(observation.schemaVersion, "maps.camera-transition-journey-observation/v1");
assert.equal(observation.scenarioId, canonical.id);
assert.match(observation.backend, /^(wgpu|canvas2d)$/);
assert.equal(
  observation.backendAtEnd,
  observation.backend,
  "the base renderer changed mid-journey",
);
const phases: Record<string, Phase> = observation.phases;
assert.deepEqual(Object.keys(phases), canonical.runtimePhases);

for (const [name, phase] of Object.entries(phases)) {
  assert(phase.frameIntervalsMs.count > 0, `${name}: no frame intervals`);
  assert(
    Object.values(phase.runtime).every((value) => Number.isInteger(value)),
    `${name}: incomplete work counters`,
  );
  assert(phase.slowInputEventsMs && typeof phase.slowInputEventsMs.count === "number");
  if (name !== "teardown") {
    // Camera motion never rebuilds the runtime or re-lowers the Map Layers. A pointer press
    // may legitimately update the hovered shape in place.
    assert.equal(
      phase.runtime.freedRuntimes! + phase.runtime.freedRenderers!,
      0,
      `${name}: the Map View runtime was rebuilt`,
    );
    assert.equal(
      phase.runtime.retainedPointSets! + phase.runtime.retainedPolygonSets!,
      0,
      `${name}: retained Map Layer groups were re-lowered`,
    );
    assert(phase.renderer, `${name}: renderer stats are unavailable`);
  }
  // Every interrupted flight stops where it is: no frame after the interruption.
  for (const flight of phase.flights) {
    assert.equal(flight.framesAfterEnd, 0, `${name}/${flight.label}: frames after the end`);
    if (flight.ending === "completed") {
      assert(flight.endedOnTarget, `${name}/${flight.label}: did not end on the target`);
    }
  }
}

// One frame plan and at most one base render per animation frame of a flight. Before #433's
// Fast work, tile arrivals, raster fade-ins and the controlled echo planned and rendered again
// inside the flight's frames (about 1.4-1.8 per frame on the Canvas fallback).
let measuredFlights = 0;
for (const name of MOTION_PHASES) {
  const phase = phases[name]!;
  for (const flight of phase.flights) {
    if (!flight.work || flight.frames < 2) continue;
    measuredFlights += 1;
    const { animationFrames, framePlans, renders } = flight.work;
    // A resize re-plans once outside an animation frame (ResizeObserver).
    const slack = name === "resize" ? 2 : 0;
    assert(
      framePlans <= animationFrames + slack,
      `${name}/${flight.label}: ${framePlans} frame plans in ${animationFrames} animation frames`,
    );
    assert(
      renders <= animationFrames + slack,
      `${name}/${flight.label}: ${renders} base renders in ${animationFrames} animation frames`,
    );
  }
  const presented = phase.flights.reduce((sum, flight) => sum + flight.frames, 0);
  assert(presented > 0, `${name}: presented no flight frame`);
}
assert(measuredFlights >= 6, `only ${measuredFlights} completed flights were measured`);

assert.deepEqual(
  phases.flight!.flights.map((flight) => flight.ending),
  ["completed", "completed"],
);
assert.deepEqual(
  phases.successive!.flights.map((flight) => flight.ending),
  ["superseded", "superseded", "superseded", "completed"],
  "successive commands did not supersede the flights in progress",
);
assert.equal(phases["pointer-interrupt"]!.flights[0]!.ending, "pointer", "no pointer interruption");
assert.equal(phases.jumps!.flights.length, JUMPS);
for (const jump of phases.jumps!.flights) {
  assert.equal(jump.frames, 1, `${jump.label}: an animate:false jump presents one frame`);
}
assert.deepEqual(
  phases.teardown!.flights.map((flight) => flight.ending),
  Array.from({ length: TEARDOWN_CYCLES }, () => "unmounted"),
  "the Map View did not unmount mid-flight",
);
assert.equal(
  phases.teardown!.runtime.freedRuntimes,
  TEARDOWN_CYCLES,
  "teardown: released runtimes",
);

const heap = observation.jsHeapAfterGc as { jsHeapUsedBytes: number | null; label: string }[];
assert(
  heap.every((sample) => typeof sample.jsHeapUsedBytes === "number"),
  "JS heap samples are unavailable",
);
const unmounted = heap.filter((sample) => sample.label.startsWith("unmounted-"));
assert.equal(unmounted.length, TEARDOWN_CYCLES);
// Unmounted mid-flight, the heap returns to the same level each cycle (no retained flight).
assert(
  unmounted.at(-1)!.jsHeapUsedBytes! - unmounted[0]!.jsHeapUsedBytes! < 1_000_000,
  "JS heap grew across unmount cycles",
);

const perPhase = Object.fromEntries(
  Object.entries(phases).map(([name, phase]) => [
    name,
    {
      animationFrames: phase.frameIntervalsMs.count + 1,
      frameIntervalsMs: phase.frameIntervalsMs,
      longTasks: phase.longTasks,
      slowInputEventsMs: phase.slowInputEventsMs,
      flightFrames: phase.flights.reduce((sum, flight) => sum + flight.frames, 0),
      maxFlightFrameGapMs: Math.max(0, ...phase.flights.map((flight) => flight.maxFrameGapMs ?? 0)),
      baseRenders: phase.renderer?.renders ?? null,
      runtime: {
        framePlans: phase.runtime.framePlans,
        gpuFrames: phase.runtime.gpuFrames,
        canvasBaseRedraws: phase.runtime.canvasBaseRedraws,
        canvasOverlayRedraws: phase.runtime.canvasOverlayRedraws,
        projectedCoordinates: phase.runtime.projectedCoordinates,
        retainedWrites:
          phase.runtime.retainedPointSets! +
          phase.runtime.retainedPointUpdates! +
          phase.runtime.retainedPolygonSets! +
          phase.runtime.retainedPolygonUpdates!,
        tileUploads: phase.runtime.tileUploads,
      },
    },
  ]),
);

const evaluation = {
  schemaVersion: "maps.camera-transition-journey-evaluation/v1",
  scenarioId: canonical.id,
  backend: observation.backend,
  candidateBundle: path.relative(output, bundle),
  observation: path.relative(output, observationFile),
  invariants: "passed",
  perPhase,
  animatedFlightFramesPerSecond: observation.animatedFlightFramesPerSecond,
  maxFlightFrameGapMs: observation.maxFlightFrameGapMs,
  jsHeapAfterGc: heap,
  framePlanCrossings: markers.get("js-to-wasm:frame-plan"),
  comparison: "unavailable",
  moonlight: "unavailable",
  reasons: [
    "no reference implementation runs this first-party camera transition journey",
    "the parent revision has no capture of this journey",
    "the idle phase is the same Map View at rest, not a baseline for a verdict",
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
          frames: entry.animationFrames,
          flightFrames: entry.flightFrames,
          renders: entry.baseRenders,
          plans: entry.runtime.framePlans,
          longTaskMs: Math.round(entry.longTasks.totalMs),
        },
      ]),
    ),
    animatedFlightFramesPerSecond: observation.animatedFlightFramesPerSecond,
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
  assert.equal(
    result.status,
    0,
    `${profiler} ${args[0]} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
