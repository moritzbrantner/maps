import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildPagesRuntimeEvidence(evaluation, { repository, revision }) {
  if (evaluation?.schemaVersion !== 1) {
    throw new Error("unsupported Moonlight runtime evaluation schema");
  }
  if (evaluation?.evaluator?.component !== "moonlight") {
    throw new Error("runtime evaluation producer is not Moonlight");
  }
  if (evaluation?.evaluator?.protocol !== "runtime-profiler-bundle/v1") {
    throw new Error("runtime evaluation does not use runtime-profiler bundle v1 evidence");
  }
  if (!repository || !revision) {
    throw new Error("repository and exact revision are required");
  }

  const outcome = evaluation.outcome;
  if (!["passed", "failed", "inconclusive"].includes(outcome)) {
    throw new Error(`unsupported Moonlight outcome: ${outcome}`);
  }

  const moonlightMetrics = evaluation.metrics ?? {};
  const scenarioId = stringMetric(moonlightMetrics, "scenarioId") ?? "runtime scenario";
  const metrics = [];

  pushNumberMetric(metrics, moonlightMetrics, "runtimeScore", "Runtime score", "score", outcome);
  pushStringMetric(metrics, moonlightMetrics, "runtimeRating", "Runtime rating", outcome);
  pushNumberMetric(
    metrics,
    moonlightMetrics,
    "minimumScore",
    "Required runtime score",
    "score",
    outcome,
  );
  pushNumberMetric(
    metrics,
    moonlightMetrics,
    "minimumSamples",
    "Required samples per metric",
    "samples",
    outcome,
  );
  pushNumberMetric(
    metrics,
    moonlightMetrics,
    "referenceMinimumSampleCount",
    "Reference minimum sample count",
    "samples",
    outcome,
  );
  pushNumberMetric(
    metrics,
    moonlightMetrics,
    "candidateMinimumSampleCount",
    "Candidate minimum sample count",
    "samples",
    outcome,
  );

  const successRate = numberMetric(moonlightMetrics, "candidateSuccessRate");
  if (successRate != null) {
    metrics.push({
      id: "candidate-success-rate",
      label: "Candidate success rate",
      value: successRate * 100,
      unit: "%",
      state: outcome,
    });
  }

  const accomplishments =
    outcome === "passed"
      ? [
          {
            title: `${scenarioId} runtime policy passed`,
            detail: evaluation.summary ?? "Moonlight accepted the runtime evidence.",
            state: outcome,
            revision,
          },
        ]
      : [];

  return {
    schemaVersion: 1,
    producer: "moonlight-runtime-profile",
    repository,
    revision,
    generatedAt: evaluation.finishedAt ?? null,
    status: outcome,
    metrics,
    accomplishments,
    provenance: {
      evaluationId: evaluation.evaluationId ?? null,
      evaluator: evaluation.evaluator,
      baseline: evaluation.baseline ?? null,
      candidate: evaluation.candidate ?? null,
      evidence: Array.isArray(evaluation.evidence) ? evaluation.evidence : [],
    },
  };
}

function pushNumberMetric(target, source, key, label, unit, state) {
  const value = numberMetric(source, key);
  if (value == null) return;
  target.push({ id: kebab(key), label, value, unit, state });
}

function pushStringMetric(target, source, key, label, state) {
  const value = stringMetric(source, key);
  if (value == null) return;
  target.push({ id: kebab(key), label, value, state });
}

function numberMetric(source, key) {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringMetric(source, key) {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.evaluation || !args.output || !args.repository || !args.revision) {
    throw new Error(
      "usage: build-pages-runtime-evidence --evaluation <file> --output <file> --repository <owner/repo> --revision <sha>",
    );
  }

  const evaluation = JSON.parse(await readFile(resolve(args.evaluation), "utf8"));
  const document = buildPagesRuntimeEvidence(evaluation, {
    repository: args.repository,
    revision: args.revision,
  });
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument: ${key ?? ""}`);
    result[key.slice(2)] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
