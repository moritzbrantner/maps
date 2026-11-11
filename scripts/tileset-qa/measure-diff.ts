// Fast evidence for the Tileset revision diff (#276, part 2), opt-in: needs the Atlas
// Liechtenstein archive (`bun scripts/fetch-atlas-tiles.ts`) and the built WASM module.
//
//   bun scripts/tileset-qa/measure-diff.ts [--runs 5]
//
// Three same-source cases over the 203-tile regional archive:
// - identical: the archive against itself (fast path: equal SHA-256, no tile read);
// - re-encoded: every tile rewritten uncompressed with its layers in reverse order, so each
//   common tile differs in bytes but not in features and goes through the Rust kernel;
// - cross-source: against the northern variant (coverage only).
// Prints medians and ranges of each measurement; nothing is written to the repository.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PMTiles } from "pmtiles";

import { compareArchives, knownTarget, type TilesetDiffRun } from "../tileset-qa.ts";
import { readDirectory } from "./core.ts";
import { openArchiveFile } from "./node.ts";
import { buildArchive, type TestTile } from "./test-archive.ts";

const { values } = parseArgs({ options: { runs: { type: "string" } } });
const runs = Number(values.runs ?? 5);

/** Top-level `layers` messages of a tile, in reverse order. */
function reverseLayers(tile: Uint8Array): Uint8Array {
  const layers: Uint8Array[] = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = tile[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (offset < tile.length) {
    const start = offset;
    const key = varint();
    if ((key & 7) !== 2) throw new Error("unexpected top-level tile field");
    const length = varint();
    offset += length;
    layers.push(tile.subarray(start, offset));
  }
  const out = new Uint8Array(tile.length);
  let position = 0;
  for (const layer of layers.reverse()) {
    out.set(layer, position);
    position += layer.length;
  }
  return out;
}

const base = knownTarget("atlas-liechtenstein")!;
const north = knownTarget("atlas-liechtenstein-north")!;
const work = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "maps-diff-measure-"));
try {
  const archive = await openArchiveFile(base.archive);
  const reader = new PMTiles(archive.source);
  const header = await reader.getHeader();
  const directory = await readDirectory(
    reader,
    header,
    archive.bytes,
    { maxAddressedTiles: 1_000_000, tilesPerFinding: 0 },
    undefined,
  );
  const tiles: TestTile[] = [];
  const layerNames = new Set<string>();
  for (let index = 0; index < directory.tiles.length / 3; index += 1) {
    const [z, x, y] = [0, 1, 2].map((offset) => directory.tiles[index * 3 + offset]!) as [
      number,
      number,
      number,
    ];
    const data = new Uint8Array((await reader.getZxy(z, x, y))!.data);
    tiles.push({ z, x, y, data: reverseLayers(data) });
  }
  await archive.close();
  for (const layer of (base.manifest as { schema: { sourceLayers: string[] } }).schema
    .sourceLayers) {
    layerNames.add(layer);
  }
  const reencodedFile = path.join(work, "liechtenstein-reencoded.pmtiles");
  writeFileSync(
    reencodedFile,
    buildArchive({
      tiles,
      layers: [...layerNames],
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    }),
  );
  const reencoded = {
    manifest: {
      ...(base.manifest as object),
      dataRevision: "measure-reencoded",
    },
    archive: reencodedFile,
  };

  const cases: [string, () => Promise<TilesetDiffRun>][] = [
    ["identical", () => compareArchives({ base, candidate: base })],
    ["re-encoded sampled", () => compareArchives({ base, candidate: reencoded })],
    ["re-encoded full", () => compareArchives({ base, candidate: reencoded, mode: "full" })],
    ["cross-source", () => compareArchives({ base, candidate: north })],
  ];
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
  for (const [name, run] of cases) {
    const results: TilesetDiffRun[] = [];
    for (let index = 0; index < runs; index += 1) results.push(await run());
    const { artifact, measurement } = results.at(-1)!;
    const checks = results.map((result) => result.measurement.checksMs);
    console.log(
      JSON.stringify({
        case: name,
        status: artifact.status,
        relation: artifact.relation,
        comparedTiles: artifact.features?.comparedTiles ?? 0,
        identicalTiles: artifact.features?.identicalTiles ?? 0,
        reencodedTiles: artifact.features?.reencodedTiles ?? 0,
        changedTiles: artifact.features?.changedTiles ?? 0,
        rangeReads: measurement.rangeReads,
        rangeBytes: measurement.rangeBytes,
        archiveBytes: measurement.archiveBytes,
        hashMsMedian: Number(median(results.map((r) => r.measurement.hashMs)).toFixed(1)),
        checksMsMedian: Number(median(checks).toFixed(1)),
        checksMsRange: [Math.min(...checks), Math.max(...checks)].map((v) => Number(v.toFixed(1))),
        peakRssBytes: measurement.peakRssBytes,
      }),
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
