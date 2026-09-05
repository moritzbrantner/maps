#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLUSTER_COORDINATE_TOLERANCE_DEGREES = 5e-6;
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
const mismatch = findParityMismatch(control, candidate);

if (mismatch) {
  console.error(`Rust aggregation parity mismatch at ${mismatch.path}: ${mismatch.reason}`);
  console.error("--- TypeScript control ---");
  console.error(JSON.stringify(control, null, 2));
  console.error("--- Rust candidate ---");
  console.error(JSON.stringify(candidate, null, 2));
  process.exit(1);
}

console.log(
  `Rust aggregation parity passed for ${control.cases.length} canonical cases; cluster centers allow at most ${CLUSTER_COORDINATE_TOLERANCE_DEGREES} degrees projection drift.`,
);

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

function findParityMismatch(control, candidate, path = "root") {
  if (typeof control === "number" || typeof candidate === "number") {
    return Object.is(control, candidate)
      ? null
      : { path, reason: `expected ${control}, received ${candidate}` };
  }

  if (Array.isArray(control) || Array.isArray(candidate)) {
    if (!Array.isArray(control) || !Array.isArray(candidate)) {
      return { path, reason: "array shape differs" };
    }
    if (control.length !== candidate.length) {
      return { path, reason: `array length ${control.length} != ${candidate.length}` };
    }

    for (let index = 0; index < control.length; index += 1) {
      const mismatch = findParityMismatch(control[index], candidate[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }

  if (isRecord(control) || isRecord(candidate)) {
    if (!isRecord(control) || !isRecord(candidate)) {
      return { path, reason: "object shape differs" };
    }

    if (control.kind === "cluster" && candidate.kind === "cluster") {
      const coordinateMismatch = compareClusterCoordinates(
        control.coordinates,
        candidate.coordinates,
        `${path}.coordinates`,
      );
      if (coordinateMismatch) return coordinateMismatch;
    }

    const controlKeys = Object.keys(control).filter(
      (key) => !(key === "coordinates" && control.kind === "cluster"),
    );
    const candidateKeys = Object.keys(candidate).filter(
      (key) => !(key === "coordinates" && candidate.kind === "cluster"),
    );
    if (JSON.stringify(controlKeys) !== JSON.stringify(candidateKeys)) {
      return { path, reason: "object keys differ" };
    }

    for (const key of controlKeys) {
      const mismatch = findParityMismatch(control[key], candidate[key], `${path}.${key}`);
      if (mismatch) return mismatch;
    }
    return null;
  }

  return Object.is(control, candidate)
    ? null
    : { path, reason: `expected ${JSON.stringify(control)}, received ${JSON.stringify(candidate)}` };
}

function compareClusterCoordinates(control, candidate, path) {
  if (
    !Array.isArray(control) ||
    !Array.isArray(candidate) ||
    control.length !== 2 ||
    candidate.length !== 2
  ) {
    return { path, reason: "cluster coordinate shape differs" };
  }

  for (let index = 0; index < 2; index += 1) {
    if (
      typeof control[index] !== "number" ||
      typeof candidate[index] !== "number" ||
      Math.abs(control[index] - candidate[index]) > CLUSTER_COORDINATE_TOLERANCE_DEGREES
    ) {
      return {
        path: `${path}[${index}]`,
        reason: `projection drift ${Math.abs(control[index] - candidate[index])} exceeds ${CLUSTER_COORDINATE_TOLERANCE_DEGREES}`,
      };
    }
  }

  return null;
}

function featureKey(feature) {
  return feature.kind === "cluster"
    ? `cluster:${feature.clusterId}`
    : `point:${feature.pointId}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
