// Maps owns workload arrangement and publication. The upstream profiler owns
// capture, validation, scoring and the retained history representation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { kernelScenarioIds } from "./engine-kernel-scenarios.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".runtime-profiler/kernel-evidence" },
    report: { type: "string" },
    reference: { type: "string" },
    "previous-history": { type: "string" },
  },
});
const output = path.resolve(root, values.output);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const profilerSource = process.env.RUNTIME_PROFILER_SOURCE;
assert(profilerSource, "RUNTIME_PROFILER_SOURCE must name the pinned runtime-profiler checkout");
const { appendRuntimeScoreHistory } = await import(
  pathToFileURL(path.resolve(profilerSource, "scripts/append-score-history.mjs")).href
);
assert(!existsSync(output), `immutable kernel evidence already exists: ${output}`);
const revision = git(root, ["rev-parse", "HEAD"]);
const parent = git(root, ["rev-parse", "HEAD^"]);
const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
const timestamp = git(root, ["show", "-s", "--format=%cI", "HEAD"]);
const referenceRoot = values.reference ? path.resolve(values.reference) : undefined;
if (referenceRoot) {
  assert.equal(
    git(referenceRoot, ["rev-parse", "HEAD"]),
    parent,
    "history reference must be the candidate's first parent",
  );
  assert.equal(
    git(referenceRoot, ["status", "--porcelain", "--untracked-files=normal"]),
    "",
    "history reference must be clean",
  );
}
mkdirSync(output, { recursive: true });
const results = [];

for (const id of kernelScenarioIds) {
  const directory = path.join(output, id);
  const candidate = path.join(directory, "candidate");
  mkdirSync(directory, { recursive: true });
  // A candidate capture is required. Failure remains a failed evidence command;
  // publication must not manufacture a successful or unavailable replacement.
  capture(root, id, candidate);
  const manifest = json(path.join(candidate, "manifest.json"));
  assert.equal(manifest.source.git_sha, revision, "candidate bundle source identity drifted");
  assert.equal(manifest.source.dirty, dirty, "candidate dirty identity drifted");
  const metrics = json(path.join(candidate, "metrics.json"));
  const observation = run("bun", ["scripts/run-engine-kernel-scenario.mjs", id], root);
  const candidateObservation = JSON.parse(observation.stdout);
  const referenceScenario =
    referenceRoot && path.join(referenceRoot, "runtime-profiler-scenarios", `${id}.yaml`);
  let score = null;
  let reason = "the parent revision has no canonical kernel capture entrypoint";

  if (referenceScenario && existsSync(referenceScenario)) {
    const reference = path.join(directory, "reference");
    // A changed workload or environment is not bridged with a Maps override.
    // runtime-profiler score is the strict comparability authority.
    capture(referenceRoot, id, reference);
    const referenceManifest = json(path.join(reference, "manifest.json"));
    assert.equal(referenceManifest.source.git_sha, parent);
    assert.equal(referenceManifest.source.dirty, false);
    const referenceObservation = JSON.parse(
      run("bun", ["scripts/run-engine-kernel-scenario.mjs", id], referenceRoot).stdout,
    );
    if (referenceObservation.scenarioSha256 !== candidateObservation.scenarioSha256) {
      reason =
        "parent/candidate canonical workload digests differ; runtime comparison is inconclusive";
    } else if (referenceObservation.observationSha256 !== candidateObservation.observationSha256) {
      reason = "parent/candidate kernel observations differ; runtime comparison is inconclusive";
    } else {
      const comparison = run(
        profiler,
        ["score", "--reference", reference, "--candidate", candidate, "--json"],
        root,
        true,
      );
      writeFileSync(path.join(directory, "comparison.stdout.json"), comparison.stdout);
      if (comparison.status === 0) {
        score = JSON.parse(comparison.stdout);
        reason = null;
      } else {
        reason = `runtime-profiler rejected comparison: ${comparison.stderr.trim() || comparison.stdout.trim()}`;
      }
    }
  }
  const previous = await previousHistory(id);
  const history = appendRuntimeScoreHistory(previous, score, {
    repository: "moritzbrantner/maps",
    commit: revision,
    parent_commit: parent,
    timestamp,
    workload_digest: `sha256:${candidateObservation.scenarioSha256}`,
    reason,
  });
  writeFileSync(path.join(output, `${id}.history.json`), `${JSON.stringify(history)}\n`);
  const viewer = `https://moritzbrantner.github.io/runtime-profiler/results/?manifest=${encodeURIComponent(
    `https://moritzbrantner.github.io/maps/evidence/kernels/${id}/candidate/manifest.json`,
  )}`;
  results.push({ id, manifest, metrics: metrics.metrics, score, reason, viewer });
}

const report = {
  schemaVersion: 1,
  producer: "runtime-profiler",
  repository: "moritzbrantner/maps",
  revision: dirty ? null : revision,
  source: { revision, dirty },
  generatedAt: new Date().toISOString(),
  status: "measured",
  description:
    "Canonical Bun kernel harness process time/RSS, not Map View frame time, per-kernel p95, or a Moonlight Fast verdict. Kernel budgets remain repository policy; adjacent-parent scores are descriptive.",
  metrics: [
    {
      id: "kernel-scope",
      label: "Runtime evidence scope",
      state: "measured",
      value: "Bun kernel harness processes. No frame-rate or architectural Fast acceptance.",
    },
    ...results.flatMap(({ id, metrics, score, reason, viewer }) => [
      ...metrics
        .filter(({ id }) => id !== "process.success_rate")
        .map((metric) => ({
          id: `${id}-${metric.id}`,
          label: `${id} · ${metric.id} · p95`,
          value: metric.statistics.p95,
          unit: metric.unit,
          state: "measured",
        })),
      {
        id: `${id}-parent-comparison`,
        label: `${id} · parent comparison`,
        state: score ? "measured" : "unavailable",
        value: score ? score.score : reason,
      },
      { id: `${id}-bundle`, label: `${id} · validated bundle`, state: "measured", value: viewer },
      {
        id: `${id}-evaluation`,
        label: `${id} · Moonlight evaluation`,
        state: "unavailable",
        value: "No calibrated Moonlight process policy is declared for this kernel workload.",
      },
    ]),
  ],
  results: results.map(({ id, score, reason, viewer }) => ({
    id,
    score: score?.score ?? null,
    reason,
    viewer,
    history: `evidence/kernels/${id}.history.json`,
  })),
  accomplishments: [],
};
const reportPath = path.resolve(root, values.report ?? path.join(output, "runtime.json"));
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, report: reportPath, scenarios: results.length })}\n`,
);

function capture(cwd, id, destination) {
  run(
    profiler,
    [
      "capture",
      "--scenario",
      path.join(cwd, "runtime-profiler-scenarios", `${id}.yaml`),
      "--output",
      destination,
    ],
    cwd,
  );
  run(profiler, ["validate", "--bundle", destination], cwd);
  const { samples } = json(path.join(destination, "metrics.json"));
  assert.equal(samples.length, 5, "kernel capture must retain all five process samples");
  assert(
    samples.every(
      ({ succeeded, timed_out, exit_code }) => succeeded && !timed_out && exit_code === 0,
    ),
    "kernel capture includes a failed or timed-out process sample",
  );
}

async function previousHistory(id) {
  if (!values["previous-history"]) return null;
  const source = `${values["previous-history"].replace(/\/$/, "")}/${id}.history.json`;
  if (!/^https?:\/\//.test(source)) return existsSync(source) ? json(source) : null;
  const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  assert(
    response.ok,
    `cannot preserve previous kernel history: ${source}: HTTP ${response.status}`,
  );
  return response.json();
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure)
    assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(cwd, args) {
  return run("git", args, cwd).stdout.trim();
}
function json(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
