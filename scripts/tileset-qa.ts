// Tileset QA CLI (#276).
//
// Integrity: audits one PMTiles archive against its manifest (`maps-tileset-qa-v1`).
//   bun scripts/tileset-qa.ts --known showcase-pmtiles-v1
//   bun scripts/tileset-qa.ts --manifest tileset.json --archive tiles.pmtiles --mode full
//
// Revision diff: compares a base and a candidate archive (`maps-tileset-diff-v1`).
//   bun scripts/tileset-qa.ts diff --comparison fixture-revision-r1-r2
//   bun scripts/tileset-qa.ts diff --base-known fixture-revision-r1 --candidate-known fixture-revision-r2
//   bun scripts/tileset-qa.ts diff --base-manifest a.json --base-archive a.pmtiles \
//     --candidate-manifest b.json --candidate-archive b.pmtiles
//
// Seams: lines and polygons across the shared edges of adjacent tiles (`maps-tileset-seams-v1`).
//   bun scripts/tileset-qa.ts seams --known fixture-seams-defects
//   bun scripts/tileset-qa.ts seams --manifest tileset.json --archive tiles.pmtiles --mode full
//
// A manifest file is a Maps Tileset manifest, optionally with `archiveRef: { sha256, bytes }`.
// Exit status: 0 passed, 1 failed, 2 inconclusive, 3 usage or runtime error.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import {
  runTilesetQa,
  type TilesetQaArtifact,
  type TilesetQaLimits,
  type TilesetQaMode,
} from "./tileset-qa/core.ts";
import {
  runTilesetDiff,
  type TilesetDiffArtifact,
  type TilesetDiffLimits,
} from "./tileset-qa/diff.ts";
import {
  runTilesetSeams,
  type TilesetSeamsArtifact,
  type TilesetSeamsLimits,
  type TilesetSeamsTolerance,
} from "./tileset-qa/seams.ts";
import { knownComparisons, knownTilesets } from "./tileset-qa/known.ts";
import {
  loadTilesetQaKernel,
  openArchiveFile,
  pmtilesReaderVersion,
  repositoryRoot,
  runUpstreamVerify,
} from "./tileset-qa/node.ts";

/** Fast evidence of a run; never part of the deterministic artifact. */
export type TilesetQaMeasurement = {
  hashMs: number;
  checksMs: number;
  rangeReads: number;
  rangeBytes: number;
  archiveBytes: number;
  peakRssBytes: number;
};

export type TilesetQaRun = { artifact: TilesetQaArtifact; measurement: TilesetQaMeasurement };
export type TilesetDiffRun = { artifact: TilesetDiffArtifact; measurement: TilesetQaMeasurement };
export type TilesetSeamsRun = {
  artifact: TilesetSeamsArtifact;
  measurement: TilesetQaMeasurement;
};

type ArchiveTarget = {
  manifest: unknown;
  archive: string;
  expectedArchive?: { sha256: string; bytes?: number } | null;
  fixtureId?: string | null;
};

export async function auditArchive(
  options: ArchiveTarget & {
    mode?: TilesetQaMode;
    seed?: number;
    limits?: Partial<TilesetQaLimits>;
    pmtilesCli?: string;
    wasmDirectory?: string;
    signal?: AbortSignal;
  },
): Promise<TilesetQaRun> {
  const kernel = await loadTilesetQaKernel(options.wasmDirectory);
  const opened = performance.now();
  const archive = await openArchiveFile(options.archive);
  const hashed = performance.now();
  try {
    const artifact = await runTilesetQa({
      manifest: options.manifest,
      archive,
      expectedArchive: options.expectedArchive ?? null,
      upstreamVerify: runUpstreamVerify(options.archive, options.pmtilesCli),
      kernel,
      pmtilesReaderVersion: pmtilesReaderVersion(),
      fixtureId: options.fixtureId ?? null,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      artifact,
      measurement: {
        hashMs: hashed - opened,
        checksMs: performance.now() - hashed,
        rangeReads: archive.io.reads,
        rangeBytes: archive.io.bytes,
        archiveBytes: archive.bytes,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      },
    };
  } finally {
    await archive.close();
  }
}

/** Compare two archives. Neither is loaded whole: each is hashed by streaming, then range-read. */
export async function compareArchives(options: {
  base: Pick<ArchiveTarget, "manifest" | "archive">;
  candidate: Pick<ArchiveTarget, "manifest" | "archive">;
  comparisonId?: string | null;
  mode?: TilesetQaMode;
  seed?: number;
  limits?: Partial<TilesetDiffLimits>;
  wasmDirectory?: string;
  signal?: AbortSignal;
}): Promise<TilesetDiffRun> {
  const kernel = await loadTilesetQaKernel(options.wasmDirectory);
  const opened = performance.now();
  const base = await openArchiveFile(options.base.archive);
  try {
    const candidate = await openArchiveFile(options.candidate.archive);
    const hashed = performance.now();
    try {
      const artifact = await runTilesetDiff({
        base: { manifest: options.base.manifest, archive: base },
        candidate: { manifest: options.candidate.manifest, archive: candidate },
        kernel,
        pmtilesReaderVersion: pmtilesReaderVersion(),
        comparisonId: options.comparisonId ?? null,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        artifact,
        measurement: {
          hashMs: hashed - opened,
          checksMs: performance.now() - hashed,
          rangeReads: base.io.reads + candidate.io.reads,
          rangeBytes: base.io.bytes + candidate.io.bytes,
          archiveBytes: base.bytes + candidate.bytes,
          peakRssBytes: process.resourceUsage().maxRSS * 1024,
        },
      };
    } finally {
      await candidate.close();
    }
  } finally {
    await base.close();
  }
}

/** Check the seams of one archive; it is hashed by streaming, then range-read. */
export async function checkSeams(
  options: Pick<ArchiveTarget, "manifest" | "archive" | "fixtureId"> & {
    mode?: TilesetQaMode;
    seed?: number;
    limits?: Partial<TilesetSeamsLimits>;
    tolerance?: Partial<TilesetSeamsTolerance>;
    wasmDirectory?: string;
    signal?: AbortSignal;
  },
): Promise<TilesetSeamsRun> {
  const kernel = await loadTilesetQaKernel(options.wasmDirectory);
  const opened = performance.now();
  const archive = await openArchiveFile(options.archive);
  const hashed = performance.now();
  try {
    const artifact = await runTilesetSeams({
      manifest: options.manifest,
      archive,
      kernel,
      pmtilesReaderVersion: pmtilesReaderVersion(),
      fixtureId: options.fixtureId ?? null,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.tolerance ? { tolerance: options.tolerance } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      artifact,
      measurement: {
        hashMs: hashed - opened,
        checksMs: performance.now() - hashed,
        rangeReads: archive.io.reads,
        rangeBytes: archive.io.bytes,
        archiveBytes: archive.bytes,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      },
    };
  } finally {
    await archive.close();
  }
}

/** A known fixture's manifest, archive path and content pin. */
export function knownTarget(fixtureId: string): ArchiveTarget | null {
  const known = knownTilesets.find((entry) => entry.fixtureId === fixtureId);
  return known
    ? {
        manifest: known.manifest,
        archive: path.join(repositoryRoot, known.archive),
        expectedArchive: known.expectedArchive,
        fixtureId: known.fixtureId,
      }
    : null;
}

function readManifestFile(file: string, archive: string): ArchiveTarget {
  const { archiveRef, ...manifest } = JSON.parse(readFileSync(file, "utf8")) as {
    archiveRef?: { sha256?: unknown; bytes?: unknown };
  };
  return {
    manifest,
    archive,
    expectedArchive:
      typeof archiveRef?.sha256 === "string"
        ? {
            sha256: archiveRef.sha256,
            ...(typeof archiveRef.bytes === "number" ? { bytes: archiveRef.bytes } : {}),
          }
        : null,
  };
}

function usage(message: string): never {
  console.error(
    `${message}\nusage: bun scripts/tileset-qa.ts (--known <fixture-id> | --manifest <json> --archive <pmtiles>)\n` +
      `  [--mode sampled|full] [--seed <n>] [--sample <n>] [--output <json>] [--measure]\n` +
      `  [--pmtiles-cli <path>] [--wasm <dir>]\n` +
      `       bun scripts/tileset-qa.ts diff (--comparison <id> | --base-known <id> --candidate-known <id>\n` +
      `  | --base-manifest <json> --base-archive <pmtiles> --candidate-manifest <json> --candidate-archive <pmtiles>)\n` +
      `  [--mode sampled|full] [--seed <n>] [--sample <n>] [--output <json>] [--measure] [--wasm <dir>]\n` +
      `       bun scripts/tileset-qa.ts seams (--known <fixture-id> | --manifest <json> --archive <pmtiles>)\n` +
      `  [--mode sampled|full] [--seed <n>] [--sample <n>] [--slack <units>] [--offset-window <units>]\n` +
      `  [--output <json>] [--measure] [--wasm <dir>]\n` +
      `known:${knownTilesets.map((known) => known.fixtureId).join(", ")}\n` +
      `comparisons: ${knownComparisons.map((known) => known.comparisonId).join(", ")}`,
  );
  process.exit(3);
}

type Reported = {
  status: string;
  checks: { status: string; id: string; summary: string }[];
  findings: {
    severity: string;
    code: string;
    count: number;
    message: string;
    tiles: { z: number; x: number; y: number }[];
  }[];
};

function report(artifact: Reported, label: string) {
  for (const check of artifact.checks) {
    console.error(`${check.status.padEnd(12)} ${check.id}: ${check.summary}`);
  }
  for (const finding of artifact.findings) {
    const tiles = finding.tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`).join(" ");
    console.error(
      `  ${finding.severity} ${finding.code} ×${finding.count}: ${finding.message}${tiles ? ` [${tiles}]` : ""}`,
    );
  }
  console.error(`${label} ${artifact.status}`);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      known: { type: "string" },
      manifest: { type: "string" },
      archive: { type: "string" },
      comparison: { type: "string" },
      "base-known": { type: "string" },
      "candidate-known": { type: "string" },
      "base-manifest": { type: "string" },
      "base-archive": { type: "string" },
      "candidate-manifest": { type: "string" },
      "candidate-archive": { type: "string" },
      mode: { type: "string" },
      seed: { type: "string" },
      sample: { type: "string" },
      output: { type: "string" },
      measure: { type: "boolean" },
      "pmtiles-cli": { type: "string" },
      wasm: { type: "string" },
      slack: { type: "string" },
      "offset-window": { type: "string" },
    },
  });
  const command = positionals[0] ?? "audit";
  if (command !== "audit" && command !== "diff" && command !== "seams") {
    usage(`unknown command ${command}`);
  }
  if (values.mode !== undefined && values.mode !== "sampled" && values.mode !== "full") {
    usage("--mode must be sampled or full");
  }
  const count = (name: "seed" | "sample") => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) usage(`--${name} must be a non-negative integer`);
    return Number(value);
  };
  const seed = count("seed");
  const sampleTiles = count("sample");
  const common = {
    ...(values.mode ? { mode: values.mode as TilesetQaMode } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(sampleTiles === undefined ? {} : { limits: { sampleTiles } }),
    ...(values.wasm ? { wasmDirectory: values.wasm } : {}),
  };
  const emit = (artifact: object, measurement: TilesetQaMeasurement, status: string) => {
    const json = `${JSON.stringify(artifact, null, 2)}\n`;
    if (values.output) writeFileSync(values.output, json);
    else process.stdout.write(json);
    if (values.measure) console.error(JSON.stringify(measurement));
    process.exit(status === "passed" ? 0 : status === "failed" ? 1 : 2);
  };
  const units = (name: "slack" | "offset-window") => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (!/^\d+(\.\d+)?$/.test(value)) usage(`--${name} must be a non-negative number`);
    return Number(value);
  };
  try {
    if (command === "seams") {
      let target: ArchiveTarget | null;
      if (values.known) {
        target = knownTarget(values.known);
        if (!target) usage(`unknown fixture ${values.known}`);
      } else if (values.manifest && values.archive) {
        target = readManifestFile(values.manifest, values.archive);
      } else {
        usage("name a known fixture, or a manifest and an archive");
      }
      const slackUnits = units("slack");
      const offsetWindowUnits = units("offset-window");
      const { artifact, measurement } = await checkSeams({
        manifest: target.manifest,
        archive: target.archive,
        fixtureId: target.fixtureId ?? null,
        ...(values.mode ? { mode: values.mode as TilesetQaMode } : {}),
        ...(seed === undefined ? {} : { seed }),
        ...(sampleTiles === undefined ? {} : { limits: { samplePairs: sampleTiles } }),
        ...(values.wasm ? { wasmDirectory: values.wasm } : {}),
        tolerance: {
          ...(slackUnits === undefined ? {} : { slackUnits }),
          ...(offsetWindowUnits === undefined ? {} : { offsetWindowUnits }),
        },
      });
      report(artifact, `Tileset seams ${path.basename(target.archive)}:`);
      emit(artifact, measurement, artifact.status);
    } else if (command === "diff") {
      let base: ArchiveTarget | null;
      let candidate: ArchiveTarget | null;
      let comparisonId: string | null = null;
      if (values.comparison) {
        const known = knownComparisons.find((entry) => entry.comparisonId === values.comparison);
        if (!known) usage(`unknown comparison ${values.comparison}`);
        comparisonId = known.comparisonId;
        base = knownTarget(known.base);
        candidate = knownTarget(known.candidate);
      } else if (values["base-known"] && values["candidate-known"]) {
        base = knownTarget(values["base-known"]);
        candidate = knownTarget(values["candidate-known"]);
      } else if (
        values["base-manifest"] &&
        values["base-archive"] &&
        values["candidate-manifest"] &&
        values["candidate-archive"]
      ) {
        base = readManifestFile(values["base-manifest"], values["base-archive"]);
        candidate = readManifestFile(values["candidate-manifest"], values["candidate-archive"]);
      } else {
        usage("name a comparison, two known fixtures, or two manifests and archives");
      }
      if (!base || !candidate) usage("unknown fixture");
      const { artifact, measurement } = await compareArchives({
        base,
        candidate,
        comparisonId,
        ...common,
      });
      report(artifact, `Tileset revision diff (${artifact.relation ?? "unpaired"})`);
      emit(artifact, measurement, artifact.status);
    } else {
      let target: ArchiveTarget | null;
      if (values.known) {
        target = knownTarget(values.known);
        if (!target) usage(`unknown fixture ${values.known}`);
      } else if (values.manifest && values.archive) {
        target = readManifestFile(values.manifest, values.archive);
      } else {
        usage("name a known fixture, or a manifest and an archive");
      }
      const { artifact, measurement } = await auditArchive({
        ...target,
        ...common,
        ...(values["pmtiles-cli"] ? { pmtilesCli: values["pmtiles-cli"] } : {}),
      });
      report(artifact, `Tileset QA ${artifact.archive.name}:`);
      emit(artifact, measurement, artifact.status);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(3);
  }
}
