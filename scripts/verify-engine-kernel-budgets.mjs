#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { kernelScenarioIds, measureKernelScenario } from "./engine-kernel-scenarios.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "benchmark-results");
const outputPath = path.join(outputDir, "maps-benchmark-summary.json");
const baselinePath = path.join(rootDir, "benchmark-baseline.json");
const budgetMultiplier = Number(process.env.MAPS_BENCHMARK_BUDGET_MULTIPLIER ?? "1");
const warnAsError = process.env.MAPS_BENCHMARK_WARN_AS_ERROR === "1";
const updateBaseline = process.argv.includes("--update-baseline");
const benchmarkThresholds = {
  "temporal-geojson-indexed-playback": {
    budgetMs: 25,
    warnMs: 5,
  },
  "geojson-transition-topology-plan": {
    budgetMs: 100,
    warnMs: 25,
  },
  "geojson-transition-complex-topology-plan": {
    budgetMs: 200,
    warnMs: 50,
  },
  "scalar-field-grid": {
    budgetMs: 300,
    warnMs: 75,
  },
  "heat-map-density-index": {
    budgetMs: 400,
    warnMs: 150,
  },
};

const benchmarks = kernelScenarioIds.map((id) => {
  const measured = measureKernelScenario(id);
  return { ...measured, ...createBenchmarkResult(measured.name, measured.stats, measured.metadata) };
});
const failures = benchmarks.filter((item) => item.status === "failed");
const warnings = benchmarks.filter((item) => item.status === "warning");

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      benchmarks,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${path.relative(rootDir, outputPath)}`);

if (updateBaseline) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        benchmarks: Object.fromEntries(
          benchmarks.map((benchmark) => [
            benchmark.name,
            {
              baselineP95Ms: benchmark.stats.p95,
              budgetMs: benchmark.budgetMs,
              warnMs: benchmark.warnMs,
            },
          ]),
        ),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Updated ${path.relative(rootDir, baselinePath)}`);
}

for (const benchmark of benchmarks) {
  const baselineDelta =
    typeof benchmark.baselineDeltaMs === "number"
      ? ` baselineDelta=${formatDelta(benchmark.baselineDeltaMs)}`
      : "";

  console.log(
    `${benchmark.name}: status=${benchmark.status} p95=${benchmark.stats.p95.toFixed(
      2,
    )}ms warn=${benchmark.warnMs.toFixed(2)}ms budget=${benchmark.budgetMs.toFixed(
      2,
    )}ms${baselineDelta}`,
  );
}

if (warnings.length > 0) {
  const log = warnAsError ? console.error : console.warn;

  log(
    warnAsError
      ? "Benchmark warning verification failed because MAPS_BENCHMARK_WARN_AS_ERROR=1:"
      : "Benchmark warning thresholds exceeded:",
  );

  for (const warning of warnings) {
    log(
      `- ${warning.name}: p95 ${warning.stats.p95.toFixed(2)}ms exceeded warning ${warning.warnMs.toFixed(
        2,
      )}ms`,
    );
  }
}

if (failures.length > 0 || (warnAsError && warnings.length > 0)) {
  console.error("Benchmark budget verification failed:");

  for (const failure of failures) {
    console.error(
      `- ${failure.name}: p95 ${failure.stats.p95.toFixed(2)}ms exceeded ${failure.budgetMs.toFixed(
        2,
      )}ms`,
    );
  }

  if (warnAsError) {
    for (const warning of warnings) {
      console.error(
        `- ${warning.name}: p95 ${warning.stats.p95.toFixed(2)}ms exceeded warning ${warning.warnMs.toFixed(
          2,
        )}ms`,
      );
    }
  }

  process.exit(1);
}

function readBenchmarkBaseline(name) {
  if (!existsSync(baselinePath)) {
    return null;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  const entry = baseline.benchmarks?.[name] ?? null;

  if (!entry) {
    return null;
  }

  return {
    baselineP95Ms: entry.baselineP95Ms ?? entry.p95,
    budgetMs: entry.budgetMs,
    warnMs: entry.warnMs,
  };
}

function formatDelta(delta) {
  const sign = delta > 0 ? "+" : "";

  return `${sign}${delta.toFixed(2)}ms`;
}

function createBenchmarkResult(name, stats, metadata) {
  const thresholds = resolveBenchmarkThresholds(name);
  const baseline = readBenchmarkBaseline(name);
  const baselineP95Ms = baseline?.baselineP95Ms;
  const baselineDeltaMs =
    typeof baselineP95Ms === "number" ? stats.p95 - baselineP95Ms : undefined;
  const status =
    stats.p95 > thresholds.budgetMs
      ? "failed"
      : stats.p95 > thresholds.warnMs
        ? "warning"
        : "ok";

  return {
    baselineDeltaMs,
    baselineP95Ms,
    budgetMs: thresholds.budgetMs,
    metadata,
    name,
    stats,
    status,
    warnMs: thresholds.warnMs,
  };
}

function resolveBenchmarkThresholds(name) {
  const configured = benchmarkThresholds[name];
  if (!configured) throw new Error(`missing historical kernel budget: ${name}`);
  return {
    budgetMs: configured.budgetMs * budgetMultiplier,
    warnMs: configured.warnMs * budgetMultiplier,
  };
}
