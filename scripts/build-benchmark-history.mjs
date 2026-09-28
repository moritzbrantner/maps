#!/usr/bin/env node
// Appends one interaction benchmark run to the published benchmark history.
//
// The history lives only on GitHub Pages: each Pages build fetches the currently
// published history, appends the run it just measured and publishes the result.
// Runs are descriptive evidence (software GPU on shared CI runners), never a gate.
//
// Usage: node scripts/build-benchmark-history.mjs --run=benchmark-results/interactions.json
//        --out=dist/benchmarks/history.json [--previous=<url or path>] [--limit=300]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }),
);
const SCHEMA = "maps.interaction-benchmark-history/v1";
const METRICS = [
  "fps",
  "frameP50",
  "frameP95",
  "frameMax",
  "jankFrames",
  "mainThreadMs",
  "scriptMs",
  "loafBlockingMs",
];
const limit = Number(args.limit ?? 300);

if (!args.run || !args.out) {
  console.error(
    "Usage: build-benchmark-history.mjs --run=<interactions.json> --out=<history.json>",
  );
  process.exit(2);
}

const run = JSON.parse(readFileSync(args.run, "utf8"));
if (run.schema !== "maps.interaction-benchmark/v2") {
  throw new Error(`Unsupported benchmark run schema: ${run.schema}`);
}

const previous = args.previous ? await loadPrevious(args.previous) : null;
const entry = {
  revision: run.revision,
  generatedAt: run.generatedAt,
  environment: run.environment,
  gpu: run.gpu,
  repeats: run.repeats,
  cpuThrottle: run.cpuThrottle,
  results: run.results.map((result) => ({
    engine: result.engine,
    scenario: result.scenario,
    basemap: result.basemap ?? "raster",
    renderer: result.renderer ?? null,
    responded: result.responded,
    ...Object.fromEntries(METRICS.map((metric) => [metric, round(result[metric])])),
  })),
};
const runs = (previous?.runs ?? []).filter((candidate) => candidate.revision !== entry.revision);
runs.push(entry);
runs.sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));

const history = { schema: SCHEMA, runs: runs.slice(-limit) };
mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(history)}\n`);
console.log(
  `Wrote ${history.runs.length} benchmark run(s) to ${args.out}` +
    (previous ? "" : " (no previous history)"),
);

async function loadPrevious(source) {
  try {
    if (/^https?:/.test(source)) {
      const response = await fetch(source, { headers: { "Cache-Control": "no-cache" } });
      // Before the first publish there is nothing to extend.
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return validate(await response.json());
    }
    return existsSync(source) ? validate(JSON.parse(readFileSync(source, "utf8"))) : null;
  } catch (error) {
    // Never silently drop published history: a failed read fails the build.
    throw new Error(`Could not read previous benchmark history from ${source}: ${error.message}`);
  }
}

function validate(history) {
  if (history?.schema !== SCHEMA || !Array.isArray(history.runs)) {
    throw new Error(`unexpected history schema ${history?.schema}`);
  }
  return history;
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}
