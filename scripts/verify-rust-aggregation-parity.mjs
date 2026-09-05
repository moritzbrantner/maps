#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [fixturePath, rustOutputPath] = process.argv.slice(2);
if (!fixturePath || !rustOutputPath) {
  throw new Error("Usage: verify-rust-aggregation-parity.mjs <fixture.json> <rust-output.json>");
}

const fixtures = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
const rustOutput = JSON.parse(await readFile(resolve(rustOutputPath), "utf8"));
const core = await import(pathToFileURL(resolve("dist/core.js")).href);
const controlCases = fixtures.cases.map((fixture) => createControlCase(core, fixture));
const control = canonicalize({ cases: controlCases });
const candidate = canonicalize(rustOutput);

if (JSON.stringify(control) !== JSON.stringify(candidate)) {
  console.error("Rust aggregation parity mismatch.");
  console.error("--- TypeScript control ---");
  console.error(JSON.stringify(control, null, 2));
  console.error("--- Rust candidate ---");
  console.error(JSON.stringify(candidate, null, 2));
  process.exit(1);
}

console.log(`Rust aggregation parity passed for ${control.cases.length} canonical cases.`);

function createControlCase(core, fixture) {
  const index = core.createPointAggregationIndex(fixture.points, fixture.options);
  const aggregation = index.getViewportAggregation(fixture.query);
  const leavesByCluster = {};

  for (const feature of aggregation.features) {
    if (feature.kind !== "cluster") continue;
    leavesByCluster[String(feature.clusterId)] = index
      .getClusterLeaves(feature.clusterId, fixture.leafLimit, 0)
      .map((point) => point.id);
  }

  return {
    name: fixture.name,
    aggregation: {
      features: aggregation.features.map((feature) =>
        feature.kind === "cluster"
          ? {
              kind: "cluster",
              clusterId: feature.clusterId,
              coordinates: feature.coordinates,
              expansionZoom: feature.expansionZoom,
              metrics: feature.metrics,
              pointCount: feature.pointCount,
              pointCountAbbreviated: feature.pointCountAbbreviated,
            }
          : {
              kind: "point",
              coordinates: feature.coordinates,
              metrics: feature.metrics,
              pointId: feature.point.id,
            },
      ),
      summary: aggregation.summary,
    },
    leavesByCluster,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 1e10) / 1e10 : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output = Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
  );

  if (Array.isArray(output.features)) {
    output.features.sort((left, right) => featureKey(left).localeCompare(featureKey(right)));
  }

  return output;
}

function featureKey(feature) {
  return feature.kind === "cluster"
    ? `cluster:${feature.clusterId}`
    : `point:${feature.pointId}`;
}
