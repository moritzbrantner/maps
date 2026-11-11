// Captures `heat-scalar-journey-v1` (#171 phase 5, Fast) through the runtime-profiler browser
// collector, checks that the required evidence is complete and that the journey kept the
// heat/scalar invalidation contract, and summarizes the heat lane against its control lane.
// It renders no performance verdict: no reference implementation or parent revision runs this
// journey, so comparison and Moonlight stay explicitly unavailable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Summary = {
  count: number;
  max: number | null;
  p50: number | null;
  p95: number | null;
};
type Work = { data: Record<string, number>; surface: Record<string, number> };
type Phase = {
  commits: { label: string; latencyMs: number; work: Work }[];
  durationMs: number;
  frameIntervalsMs: Summary;
  longTasks: { count: number; maxMs: number; totalMs: number };
  work: Work;
};
type Lane = {
  backend: string;
  commitLatencyMs: Summary;
  jsHeapAfterGc: { jsHeapUsedBytes: number | null; label: string }[];
  load: {
    longTasks: { count: number; maxMs: number; totalMs: number };
    presentedMs: number;
  };
  phases: Record<string, Phase>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  root,
  process.env.MAPS_HEAT_SCALAR_EVIDENCE_DIR ??
    ".runtime-profiler/maps-heat-scalar-journey-v1",
);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const scenarioFile = path.join(
  root,
  "runtime-profiler-scenarios/heat-scalar-journey-browser-v1.yaml",
);
const canonical = JSON.parse(
  readFileSync(
    path.join(root, "engine-scenarios/heat-scalar-journey-v1.json"),
    "utf8",
  ),
);
const CAMERA_PHASES = ["camera-pan", "camera-zoom", "camera-orient", "resize"];
const CONTROL_PHASES = [...CAMERA_PHASES, "teardown"];
/** Camera-independent artifacts: camera frames must never rebuild them. */
const CAMERA_INDEPENDENT = [
  "sourceIndexBuilds",
  "fieldGridBuilds",
  "fieldImageBuilds",
  "fieldContourBuilds",
] as const;

assert(
  !existsSync(output),
  `heat/scalar evidence already exists and is immutable: ${output}`,
);
mkdirSync(output, { recursive: true });

const bundle = path.join(output, "candidate");
const observationFile = path.join(output, "maps-observation.json");
invoke(["capture", "--scenario", scenarioFile, "--output", bundle], {
  MAPS_HEAT_SCALAR_OBSERVATION: observationFile,
});
invoke(["validate", "--bundle", bundle]);

// runtime-profiler owns the trace and its integrity; Maps checks that this journey actually
// produced renderer-main tasks.
const summary = JSON.parse(
  readFileSync(path.join(bundle, "chromium-trace-summary.json"), "utf8"),
);
assert(
  summary.top_level_task_count > 0,
  "heat/scalar journey produced no renderer-main tasks",
);
assert(
  summary.hot_path_count > 0,
  "heat/scalar journey produced no normalized hot paths",
);

const observation = JSON.parse(readFileSync(observationFile, "utf8"));
assert.equal(
  observation.schemaVersion,
  "maps.heat-scalar-journey-observation/v1",
);
assert.equal(observation.scenarioId, canonical.id);
assert.match(observation.backend, /^(wgpu|canvas2d)$/);
const control: Lane = observation.lanes.control;
const heat: Lane = observation.lanes.heat;
assert.equal(
  control.backend,
  heat.backend,
  "the two lanes ran on different pixel backends",
);
assert.deepEqual(Object.keys(heat.phases), canonical.runtimePhases);
assert.deepEqual(Object.keys(control.phases), CONTROL_PHASES);

for (const [laneName, lane] of [
  ["control", control],
  ["heat", heat],
] as const) {
  for (const [name, phase] of Object.entries(lane.phases)) {
    assert(
      phase.frameIntervalsMs.count > 0,
      `${laneName} ${name}: no frame intervals`,
    );
    for (const group of [phase.work.data, phase.work.surface]) {
      assert(
        Object.values(group).every((value) => Number.isInteger(value)),
        `${laneName} ${name}: incomplete work counters`,
      );
    }
  }
  assert(
    lane.jsHeapAfterGc.every(
      (sample) => typeof sample.jsHeapUsedBytes === "number",
    ),
    `${laneName}: JS heap samples are unavailable`,
  );
}

// The control lane mounts no Heat Layer, so it does no heat/scalar work at all.
for (const [name, phase] of Object.entries(control.phases)) {
  for (const [key, value] of Object.entries({
    ...phase.work.data,
    ...phase.work.surface,
  })) {
    assert.equal(value, 0, `control ${name}: heat/scalar work ${key}=${value}`);
  }
}

// Camera-only changes never rebuild the camera-independent heat/scalar artifacts.
for (const name of CAMERA_PHASES) {
  for (const key of CAMERA_INDEPENDENT) {
    assert.equal(
      heat.phases[name]!.work.data[key],
      0,
      `heat ${name}: camera frame rebuilt ${key}`,
    );
  }
  assert(
    heat.phases[name]!.work.surface.rasterDraws! > 0,
    `heat ${name}: no raster was drawn`,
  );
}

// Each data/style change rebuilds only its dependent artifacts, and every one was presented.
const commits = (name: string) => heat.phases[name]!.commits;
assert.equal(commits("density-seek").length, 6);
for (const commit of commits("density-seek")) {
  assert(
    commit.work.data.sourceIndexBuilds! >= 1,
    `${commit.label}: density index not rebuilt`,
  );
  assert.equal(
    commit.work.data.fieldGridBuilds,
    0,
    `${commit.label}: rebuilt the scalar field`,
  );
}
assert.equal(commits("field-update").length, 6);
for (const commit of commits("field-update")) {
  assert.equal(
    commit.work.data.fieldGridBuilds,
    1,
    `${commit.label}: field grid builds`,
  );
  // The field layer's own density index is empty; the density layer's points are not re-indexed.
  assert.equal(
    commit.work.data.sourceIndexPoints,
    0,
    `${commit.label}: re-indexed density points`,
  );
}
assert.equal(commits("style").length, 4);
for (const commit of commits("style")) {
  assert.equal(
    commit.work.data.fieldGridBuilds,
    0,
    `${commit.label}: style change re-interpolated`,
  );
  assert.equal(
    commit.work.data.sourceIndexBuilds,
    0,
    `${commit.label}: style change re-indexed`,
  );
}
assert.equal(commits("superseded-bursts").length, 2);
assert.equal(
  heat.commitLatencyMs.count,
  18,
  "input → presented latency samples are missing",
);

const ratio = (candidate: number | null, base: number | null) =>
  candidate === null || base === null || base === 0 ? null : candidate / base;
const cameraComparison = Object.fromEntries(
  CAMERA_PHASES.map((name) => {
    const withHeat = heat.phases[name]!;
    const without = control.phases[name]!;
    return [
      name,
      {
        control: {
          frameIntervalsMs: without.frameIntervalsMs,
          longTasks: without.longTasks,
        },
        heat: {
          frameIntervalsMs: withHeat.frameIntervalsMs,
          longTasks: withHeat.longTasks,
          rasterDrawTriangles: withHeat.work.surface.rasterDrawTriangles,
          rasterDraws: withHeat.work.surface.rasterDraws,
          rasterizations: withHeat.work.surface.surfaceRasterizations,
        },
        frameP95Ratio: ratio(
          withHeat.frameIntervalsMs.p95,
          without.frameIntervalsMs.p95,
        ),
        longTaskMsAdded: withHeat.longTasks.totalMs - without.longTasks.totalMs,
      },
    ];
  }),
);

const evaluation = {
  schemaVersion: "maps.heat-scalar-journey-evaluation/v1",
  scenarioId: canonical.id,
  backend: observation.backend,
  candidateBundle: path.relative(output, bundle),
  observation: path.relative(output, observationFile),
  invariants: "passed",
  cameraComparison,
  commitLatencyMs: heat.commitLatencyMs,
  comparison: "unavailable",
  moonlight: "unavailable",
  reasons: [
    "no reference implementation runs this first-party heat/scalar journey",
    "the parent revision has no capture of this journey",
    "the control lane is the same Map View without heat layers, not a baseline for a verdict",
  ],
};
writeFileSync(
  path.join(output, "evaluation.json"),
  `${JSON.stringify(evaluation, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    scenarioId: canonical.id,
    backend: observation.backend,
    longTasks: summary.long_task_count,
    camera: Object.fromEntries(
      Object.entries(cameraComparison).map(([name, entry]) => [
        name,
        {
          controlP95: entry.control.frameIntervalsMs.p95,
          heatP95: entry.heat.frameIntervalsMs.p95,
          longTaskMsAdded: Math.round(entry.longTaskMsAdded),
          triangles: entry.heat.rasterDrawTriangles,
        },
      ]),
    ),
    commitLatencyP95: heat.commitLatencyMs.p95,
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
