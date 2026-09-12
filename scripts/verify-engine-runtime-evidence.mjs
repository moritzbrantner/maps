#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.resolve(
  rootDir,
  process.env.MAPS_RUNTIME_EVIDENCE_DIR ?? ".runtime-profiler/maps-camera-world-pan-v1",
);
const referenceBundle = path.join(evidenceRoot, "reference");
const candidateBundle = path.join(evidenceRoot, "candidate");
const scenario = path.join(
  rootDir,
  "runtime-profiler-scenarios",
  "camera-world-pan-v1.yaml",
);
const runtimeProfiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const moonlight = process.env.MOONLIGHT_RUNTIME_PROFILE_BIN ?? "moonlight-runtime-profile";

if (existsSync(evidenceRoot)) {
  throw new Error(
    `runtime evidence root already exists and is immutable: ${path.relative(rootDir, evidenceRoot)}`,
  );
}
mkdirSync(evidenceRoot, { recursive: true });

run("bun", ["run", "verify:engine-camera:prepared"], {
  cwd: rootDir,
  label: "semantic camera parity",
});

capture("reference", referenceBundle);
capture("candidate", candidateBundle);

const score = run(runtimeProfiler, [
  "score",
  "--reference",
  referenceBundle,
  "--candidate",
  candidateBundle,
  "--json",
], {
  cwd: rootDir,
  label: "runtime-profiler score",
});
writeFileSync(path.join(evidenceRoot, "runtime-score.json"), score.stdout);

const evaluation = run(
  moonlight,
  [
    "--runtime-profiler",
    runtimeProfiler,
    "--reference",
    referenceBundle,
    "--candidate",
    candidateBundle,
    "--reference-uri",
    "artifact://maps/milestone-b/camera-world-pan-v1/reference",
    "--candidate-uri",
    "artifact://maps/milestone-b/camera-world-pan-v1/candidate",
    "--minimum-score",
    "75",
    "--minimum-samples",
    "5",
  ],
  {
    allowFailure: true,
    cwd: rootDir,
    label: "Moonlight runtime evaluation",
  },
);
writeFileSync(path.join(evidenceRoot, "moonlight-evaluation.json"), evaluation.stdout);

const result = JSON.parse(evaluation.stdout);
if (result.schemaVersion !== 1) {
  throw new Error(`unexpected Moonlight evaluation schema ${result.schemaVersion}`);
}
if (result.outcome !== "passed") {
  throw new Error(
    `Moonlight runtime evaluation did not pass: ${result.outcome}: ${result.summary}`,
  );
}
if (!Array.isArray(result.evidence) || result.evidence.length !== 2) {
  throw new Error("Moonlight runtime evaluation did not retain both neutral evidence references");
}
if (evaluation.status !== 0) {
  throw new Error(
    `Moonlight returned ${evaluation.status} despite a passed evaluation: ${evaluation.stderr}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    candidateBundle: path.relative(rootDir, candidateBundle),
    evaluation: path.relative(rootDir, path.join(evidenceRoot, "moonlight-evaluation.json")),
    outcome: result.outcome,
    referenceBundle: path.relative(rootDir, referenceBundle),
    runtimeScore: result.metrics?.runtimeScore,
    scenarioId: result.metrics?.scenarioId,
  })}\n`,
);

function capture(implementation, output) {
  run(
    runtimeProfiler,
    ["capture", "--scenario", scenario, "--output", output],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        MAPS_RUNTIME_PROFILE_IMPLEMENTATION: implementation,
      },
      label: `${implementation} runtime-profiler capture`,
    },
  );
  run(runtimeProfiler, ["validate", "--bundle", output], {
    cwd: rootDir,
    label: `${implementation} runtime-profiler validation`,
  });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  const output = {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${options.label} failed with exit code ${result.status}\n${output.stdout}\n${output.stderr}`,
    );
  }
  return output;
}
