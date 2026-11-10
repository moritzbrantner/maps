// Tileset integrity QA CLI (#276). Audits one PMTiles archive against its manifest and
// writes the `maps-tileset-qa-v1` artifact.
//
//   bun scripts/tileset-qa.ts --known showcase-pmtiles-v1
//   bun scripts/tileset-qa.ts --manifest tileset.json --archive tiles.pmtiles --mode full
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
import { knownTilesets } from "./tileset-qa/known.ts";
import {
  loadTilesetQaKernel,
  openArchiveFile,
  pmtilesReaderVersion,
  repositoryRoot,
  runUpstreamVerify,
} from "./tileset-qa/node.ts";

export type TilesetQaRun = {
  artifact: TilesetQaArtifact;
  /** Fast evidence of this run; never part of the deterministic artifact. */
  measurement: {
    hashMs: number;
    checksMs: number;
    rangeReads: number;
    rangeBytes: number;
    archiveBytes: number;
    peakRssBytes: number;
  };
};

export async function auditArchive(options: {
  manifest: unknown;
  archive: string;
  expectedArchive?: { sha256: string; bytes?: number } | null;
  fixtureId?: string | null;
  mode?: TilesetQaMode;
  seed?: number;
  limits?: Partial<TilesetQaLimits>;
  pmtilesCli?: string;
  wasmDirectory?: string;
  signal?: AbortSignal;
}): Promise<TilesetQaRun> {
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

function usage(message: string): never {
  console.error(
    `${message}\nusage: bun scripts/tileset-qa.ts (--known <fixture-id> | --manifest <json> --archive <pmtiles>)\n` +
      `  [--mode sampled|full] [--seed <n>] [--sample <n>] [--output <json>] [--measure]\n` +
      `  [--pmtiles-cli <path>] [--wasm <dir>]\nknown: ${knownTilesets.map((known) => known.fixtureId).join(", ")}`,
  );
  process.exit(3);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      known: { type: "string" },
      manifest: { type: "string" },
      archive: { type: "string" },
      mode: { type: "string" },
      seed: { type: "string" },
      sample: { type: "string" },
      output: { type: "string" },
      measure: { type: "boolean" },
      "pmtiles-cli": { type: "string" },
      wasm: { type: "string" },
    },
  });
  if (values.mode !== undefined && values.mode !== "sampled" && values.mode !== "full") {
    usage("--mode must be sampled or full");
  }
  const count = (name: "seed" | "sample") => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) usage(`--${name} must be a non-negative integer`);
    return Number(value);
  };
  let target: Parameters<typeof auditArchive>[0];
  if (values.known) {
    const known = knownTilesets.find((entry) => entry.fixtureId === values.known);
    if (!known) usage(`unknown fixture ${values.known}`);
    target = {
      manifest: known.manifest,
      archive: path.join(repositoryRoot, known.archive),
      expectedArchive: known.expectedArchive,
      fixtureId: known.fixtureId,
    };
  } else if (values.manifest && values.archive) {
    const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as {
      archiveRef?: { sha256?: unknown; bytes?: unknown };
    };
    const { archiveRef, ...metadata } = manifest;
    target = {
      manifest: metadata,
      archive: values.archive,
      expectedArchive:
        typeof archiveRef?.sha256 === "string"
          ? {
              sha256: archiveRef.sha256,
              ...(typeof archiveRef.bytes === "number" ? { bytes: archiveRef.bytes } : {}),
            }
          : null,
    };
  } else {
    usage("name a known fixture, or a manifest and an archive");
  }
  const seed = count("seed");
  const sampleTiles = count("sample");
  try {
    const { artifact, measurement } = await auditArchive({
      ...target,
      ...(values.mode ? { mode: values.mode as TilesetQaMode } : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(sampleTiles === undefined ? {} : { limits: { sampleTiles } }),
      ...(values["pmtiles-cli"] ? { pmtilesCli: values["pmtiles-cli"] } : {}),
      ...(values.wasm ? { wasmDirectory: values.wasm } : {}),
    });
    const json = `${JSON.stringify(artifact, null, 2)}\n`;
    if (values.output) writeFileSync(values.output, json);
    else process.stdout.write(json);
    for (const check of artifact.checks) {
      console.error(`${check.status.padEnd(12)} ${check.id}: ${check.summary}`);
    }
    for (const finding of artifact.findings) {
      const tiles = finding.tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`).join(" ");
      console.error(
        `  ${finding.severity} ${finding.code} ×${finding.count}: ${finding.message}${tiles ? ` [${tiles}]` : ""}`,
      );
    }
    console.error(`Tileset QA ${artifact.status}: ${artifact.archive.name}`);
    if (values.measure) console.error(JSON.stringify(measurement));
    process.exit(artifact.status === "passed" ? 0 : artifact.status === "failed" ? 1 : 2);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(3);
  }
}
