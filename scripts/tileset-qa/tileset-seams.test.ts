// Tile seam QA against the built Rust/WASM kernel. Each expected result follows from how the
// archive was constructed (`test-archive.ts`, `scripts/tileset-seam-fixture.mjs`), never from
// re-running the seam algorithm.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PMTiles } from "pmtiles";
import { beforeAll, describe, expect, test } from "vitest";

import { checkSeams, knownTarget } from "../tileset-qa.ts";
import { readDirectory, type TilesetQaKernel } from "./core.ts";
import { loadTilesetQaKernel, openArchiveBytes, openArchiveFile } from "./node.ts";
import {
  runTilesetSeams,
  type TilesetSeamsArtifact,
  type TilesetSeamsCheckId,
  type TilesetSeamsInput,
} from "./seams.ts";
import {
  buildArchive,
  mvtFeature,
  mvtLayer,
  mvtTile,
  pathCommands,
  type TestTile,
} from "./test-archive.ts";

const WORLD: [number, number, number, number] = [-180, -85.0511287798066, 180, 85.0511287798066];

let kernel: TilesetQaKernel;
beforeAll(async () => {
  kernel = await loadTilesetQaKernel();
});

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sourceId: "seams-test",
    dataRevision: "r1",
    format: "mvt",
    schema: {
      id: "shortbread",
      version: "1.0",
      sourceLayers: ["streets", "water_polygons"],
    },
    projection: "web-mercator",
    scheme: "xyz",
    bounds: WORLD,
    minZoom: 0,
    maxZoom: 1,
    tileSize: 512,
    attribution: "Tile seam test",
    license: "CC0-1.0",
    provenance: "scripts/tileset-qa/test-archive.ts",
    ...overrides,
  };
}

/** A `streets` layer with one `kind=primary` line per path. */
const streets = (...paths: [number, number][][]) =>
  mvtLayer(
    "streets",
    paths.map((points) => mvtFeature(2, pathCommands([points]), [0, 0])),
    ["kind"],
    ["primary"],
  );
const water = (...rings: [number, number][][]) =>
  mvtLayer(
    "water_polygons",
    [mvtFeature(3, pathCommands(rings, true), [0, 0])],
    ["kind"],
    ["water"],
  );
const FULL: [number, number][] = [
  [0, 0],
  [4096, 0],
  [4096, 4096],
  [0, 4096],
];
/** A road across the whole tile at `row`, and full-tile water. */
const across = (row: number) =>
  mvtTile(
    streets([
      [0, row],
      [4096, row],
    ]),
    water(FULL),
  );

const archiveOf = (tiles: TestTile[], options: Partial<Parameters<typeof buildArchive>[0]> = {}) =>
  buildArchive({
    tiles,
    layers: ["streets", "water_polygons"],
    minZoom: 0,
    maxZoom: 1,
    ...options,
  });

/** Every tile of z0–z1 with the same payload, except those `replaced` or `without`. */
function world(
  data: Uint8Array,
  replaced: Record<string, Uint8Array> = {},
  without: string[] = [],
): TestTile[] {
  const tiles: TestTile[] = [];
  for (const [z, x, y] of [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [1, 0, 1],
    [1, 1, 1],
  ] as const) {
    const key = `${z}/${x}/${y}`;
    if (!without.includes(key)) tiles.push({ z, x, y, data: replaced[key] ?? data });
  }
  return tiles;
}

async function seams(
  archive: Uint8Array,
  options: Partial<Omit<TilesetSeamsInput, "archive" | "kernel" | "pmtilesReaderVersion">> = {},
): Promise<TilesetSeamsArtifact> {
  return runTilesetSeams({
    manifest: manifest(),
    archive: openArchiveBytes("seams.pmtiles", archive),
    kernel,
    pmtilesReaderVersion: "test",
    ...options,
  });
}

const statusOf = (artifact: TilesetSeamsArtifact, id: TilesetSeamsCheckId) =>
  artifact.checks.find((check) => check.id === id)!.status;
const finding = (artifact: TilesetSeamsArtifact, code: string) =>
  artifact.findings.find((entry) => entry.code === code);
const key = (tile: { z: number; x: number; y: number }) => `${tile.z}/${tile.x}/${tile.y}`;
const reportedPairs = (artifact: TilesetSeamsArtifact) =>
  artifact.seams!.reported.map(
    (pair) => `${key(pair.first)} ${pair.edge} ${key(pair.second)}: ${pair.reason}`,
  );

describe("the committed seam fixtures", () => {
  for (const variant of ["clean", "defects"] as const) {
    test(`fixture-seams-${variant} reproduces its committed artifact`, async () => {
      const fixtureId = `fixture-seams-${variant}`;
      const expected = JSON.parse(
        readFileSync(path.join(import.meta.dirname, "expected", `seams-${fixtureId}.json`), "utf8"),
      ) as TilesetSeamsArtifact;
      const { artifact } = await checkSeams({
        ...knownTarget(fixtureId)!,
        fixtureId,
      });
      expect(artifact).toEqual(expected);
    });
  }

  test("the clean cut keeps every seam, including a drift within the slack", async () => {
    const { artifact } = await checkSeams(knownTarget("fixture-seams-clean")!);
    expect(artifact.status).toBe("passed");
    // z0 across the antimeridian, z1: two inner east, two antimeridian and two south edges.
    expect(artifact.pairs).toMatchObject({
      adjacent: 7,
      east: 2,
      antimeridian: 3,
      south: 2,
      checked: 7,
      complete: true,
      withoutNeighbour: 0,
    });
    // Seam Avenue, Meridian Street, Ring Road at the inner edge and across the antimeridian
    // at z1 and z0.
    expect(artifact.seams!.counts).toMatchObject({
      lineCrossings: 5,
      lineInterrupted: 0,
      lineDuplicated: 0,
      lineOffset: 0,
      polygonMismatches: 0,
    });
    // The 1.5-unit drift of Seam Avenue in 1/1/0 needs the slack.
    expect(artifact.seams!.counts.lineSlackUsed).toBe(1);
    const layers = Object.fromEntries(artifact.seams!.layers.map((layer) => [layer.name, layer]));
    expect(layers.streets!.buffer).toEqual([0, 64]);
  });

  test("the defects cut reports exactly the seams the fixture breaks", async () => {
    const { artifact } = await checkSeams(knownTarget("fixture-seams-defects")!);
    expect(artifact.status).toBe("failed");
    expect(statusOf(artifact, "line-seams")).toBe("failed");
    expect(statusOf(artifact, "polygon-seams")).toBe("failed");
    // Pairs are listed in PMTiles tile-ID order of their first tile.
    expect(reportedPairs(artifact)).toEqual([
      "1/0/0 east 1/1/0: line-interrupted 1",
      "1/0/0 south 1/0/1: line-duplicated 1",
      "1/0/1 east 1/1/1: line-offset 1; polygon-edge-mismatch 1",
      "1/1/1 antimeridian 1/0/1: line-offset 1",
      "1/1/0 south 1/1/1: polygon-edge-mismatch 1",
    ]);
    const changes = artifact.seams!.reported.flatMap((pair) =>
      pair.findings.map(
        (entry) =>
          `${key(pair.first)} ${key(pair.second)} ${entry.kind} ${entry.side} ${
            entry.properties.name ?? entry.properties.kind
          }`,
      ),
    );
    expect(changes).toEqual([
      "1/0/0 1/1/0 line-interrupted first Seam Avenue",
      "1/0/0 1/0/1 line-duplicated second Meridian Street",
      "1/0/1 1/1/1 line-offset null Ring Road",
      // The larger island leaves lake water on the first side only.
      "1/0/1 1/1/1 polygon-edge-mismatch first water",
      "1/1/1 1/0/1 line-offset null Ring Road",
      "1/1/0 1/1/1 polygon-edge-mismatch first water",
    ]);
    // Both tiles are clipped at the edge, so polygon coverage must continue across it.
    expect(
      artifact
        .seams!.reported.flatMap((pair) => pair.findings)
        .filter((entry) => entry.kind === "polygon-edge-mismatch")
        .map((entry) => entry.strip),
    ).toEqual([null, null]);
    // Ring Road is drawn 24 units lower in 1/1/1.
    const offsets = artifact
      .seams!.reported.flatMap((pair) => pair.findings)
      .filter((entry) => entry.kind === "line-offset")
      .map((entry) => entry.distanceUnits);
    expect(offsets).toEqual([24, 24]);
    // Every finding names both tiles of its pair with their bounds.
    expect(finding(artifact, "line-interrupted")!.tiles.map(key)).toEqual(["1/0/0", "1/1/0"]);
    expect(finding(artifact, "line-interrupted")!.tiles[1]!.bounds).toEqual([
      0, 0, 180, 85.0511287798066,
    ]);
  });
});

describe("tile seams", () => {
  test("a continuous world passes and its artifact is deterministic", async () => {
    const archive = archiveOf(world(across(1000)));
    const first = await seams(archive);
    expect(first.status).toBe("passed");
    // The horizontal road crosses the z0 antimeridian edge and the four z1 east edges.
    expect(first.seams!.counts.lineCrossings).toBe(5);
    expect(first.seams!.counts.polygonGroups).toBe(7);
    expect(await seams(archive)).toEqual(first);
  });

  test("a road broken in one tile is reported at each of its edges", async () => {
    // 1/1/0 has its road 300 units lower: beyond the 64-unit window, so interrupted.
    const archive = archiveOf(world(across(1000), { "1/1/0": across(1300) }));
    const artifact = await seams(archive);
    expect(statusOf(artifact, "line-seams")).toBe("failed");
    expect(statusOf(artifact, "polygon-seams")).toBe("passed");
    expect(reportedPairs(artifact)).toEqual([
      "1/0/0 east 1/1/0: line-interrupted 2",
      "1/1/0 antimeridian 1/0/0: line-interrupted 2",
    ]);
    // Within the offset window: one displaced line per edge instead.
    const displaced = await seams(archiveOf(world(across(1000), { "1/1/0": across(1040) })));
    expect(displaced.seams!.counts).toMatchObject({
      lineOffset: 2,
      lineInterrupted: 0,
    });
    // A wider window or slack is a provider choice the artifact records.
    const tolerant = await seams(archiveOf(world(across(1000), { "1/1/0": across(1040) })), {
      tolerance: { slackUnits: 40 },
    });
    expect(tolerant.status).toBe("passed");
    expect(tolerant.tolerance).toEqual({
      quantizationUnits: 0.5,
      slackUnits: 40,
      offsetWindowUnits: 64,
    });
  });

  test("absent evidence is inconclusive, never passed", async () => {
    // One z1 tile and z0: no z1 neighbours; the z0 tile meets itself across the antimeridian.
    const sparse = await seams(archiveOf(world(across(1000), {}, ["1/1/0", "1/0/1", "1/1/1"])));
    expect(sparse.pairs).toMatchObject({ adjacent: 1, withoutNeighbour: 2 });
    expect(finding(sparse, "edge-without-neighbour")).toMatchObject({ count: 2, severity: "info" });
    expect(finding(sparse, "edge-without-neighbour")!.tiles.map(key)).toEqual(["1/0/0"]);
    // A lone z1 tile: no adjacent pair at all.
    const lonely = await seams(
      archiveOf(world(across(1000), {}, ["0/0/0", "1/1/0", "1/0/1", "1/1/1"])),
    );
    expect(lonely.pairs!.adjacent).toBe(0);
    expect(statusOf(lonely, "pairs")).toBe("inconclusive");
    expect(statusOf(lonely, "line-seams")).toBe("inconclusive");
    expect(lonely.status).toBe("inconclusive");
    // Polygons only: nothing says whether lines continue.
    const polygons = await seams(archiveOf(world(mvtTile(water(FULL)))));
    expect(statusOf(polygons, "polygon-seams")).toBe("passed");
    expect(statusOf(polygons, "line-seams")).toBe("inconclusive");
    // A full run over more pairs than its budget.
    const budget = await seams(archiveOf(world(across(1000))), {
      mode: "full",
      limits: { maxPairs: 3 },
    });
    expect(budget.pairs).toMatchObject({ checked: 3, complete: false });
    expect(statusOf(budget, "line-seams")).toBe("inconclusive");
  });

  test("a sampled run checks a seeded, bounded set of pairs from every zoom", async () => {
    const archive = archiveOf(world(across(1000)));
    const sampled = await seams(archive, {
      limits: { samplePairs: 2 },
      seed: 7,
    });
    expect(sampled.pairs).toMatchObject({ checked: 2, complete: false });
    expect(sampled.pairs!.byZoom.map((level) => level.checked)).toEqual([1, 1]);
    // Sampled mode is a declared sample, not a failure to finish.
    expect(sampled.status).toBe("passed");
    expect(await seams(archive, { limits: { samplePairs: 2 }, seed: 7 })).toEqual(sampled);
  });

  test("neighbours with different extents compare as fractions of the edge", async () => {
    // Row 250 of a 1024 extent is row 1000 of a 4096 extent.
    const tile = mvtTile(
      mvtLayer(
        "streets",
        [
          mvtFeature(
            2,
            pathCommands([
              [
                [0, 250],
                [1024, 250],
              ],
            ]),
            [0, 0],
          ),
        ],
        ["kind"],
        ["primary"],
        1024,
      ),
    );
    const artifact = await seams(
      archiveOf(
        world(
          mvtTile(
            streets([
              [0, 1000],
              [4096, 1000],
            ]),
          ),
          { "1/1/0": tile },
        ),
      ),
    );
    expect(artifact.seams!.layers.find((entry) => entry.name === "streets")!.extents).toEqual([
      1024, 4096,
    ]);
    expect(statusOf(artifact, "line-seams")).toBe("passed");
    expect(artifact.seams!.counts.lineCrossings).toBe(5);
  });

  test("unreadable inputs fail the check that reads them", async () => {
    const corrupt = await seams(
      archiveOf(world(across(1000), { "1/1/1": Uint8Array.from([0x1a, 0x05, 0x01]) })),
    );
    expect(statusOf(corrupt, "pairs")).toBe("failed");
    expect(finding(corrupt, "undecodable-tile")!.count).toBe(3);
    expect(corrupt.seams!.reported.every((pair) => pair.status === "undecodable")).toBe(true);

    const raster = archiveOf(world(across(1000)));
    raster[99] = 2; // PNG
    expect(finding(await seams(raster), "not-vector-tiles")?.severity).toBe("error");
    const truncated = await seams(archiveOf(world(across(1000))).slice(0, 60));
    expect(statusOf(truncated, "archive")).toBe("failed");
    expect(truncated.pairs).toBeNull();
    const invalid = await seams(archiveOf(world(across(1000))), {
      manifest: manifest({ minZoom: 3 }),
    });
    expect(finding(invalid, "invalid-manifest")?.severity).toBe("error");
    expect(invalid.checks.slice(1).every((check) => check.status === "inconclusive")).toBe(true);
  });

  test("cancellation rejects instead of reporting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      seams(archiveOf(world(across(1000))), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

/** The tile without one top-level layer, found by its name (protobuf framing only). */
function withoutLayer(tile: Uint8Array, name: string): Uint8Array {
  const kept: number[] = [];
  let offset = 0;
  const varint = (bytes: Uint8Array, at: { offset: number }) => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at.offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (offset < tile.length) {
    const at = { offset };
    varint(tile, at);
    const length = varint(tile, at);
    const body = tile.subarray(at.offset, at.offset + length);
    const inner = { offset: 0 };
    let layerName = "";
    while (inner.offset < body.length) {
      const fieldKey = varint(body, inner);
      if ((fieldKey & 7) === 0) {
        varint(body, inner);
        continue;
      }
      const size = varint(body, inner);
      if (fieldKey >> 3 === 1) {
        layerName = new TextDecoder().decode(body.subarray(inner.offset, inner.offset + size));
        break;
      }
      inner.offset += size;
    }
    if (layerName !== name) kept.push(...tile.subarray(offset, at.offset + length));
    offset = at.offset + length;
  }
  return Uint8Array.from(kept);
}

const atlas = knownTarget("atlas-liechtenstein");
describe.skipIf(!atlas || !existsSync(atlas.archive))("the published Atlas archive", () => {
  test("has no seam beyond the tolerance in a full run", async () => {
    const { artifact } = await checkSeams({ ...atlas!, mode: "full" });
    expect(artifact.status).toBe("passed");
    expect(artifact.pairs).toMatchObject({
      adjacent: 336,
      checked: 336,
      complete: true,
    });
    // Planetiler buffers streets by 64 units; buildings touching an edge are not seams.
    expect(artifact.seams!.counts).toMatchObject({
      lineInterrupted: 0,
      lineDuplicated: 0,
      lineOffset: 0,
      polygonMismatches: 0,
    });
    expect(artifact.seams!.counts.lineCrossings).toBeGreaterThan(2_000);
  });

  test("detects a layer removed from one real tile at that tile's edges only", async () => {
    // Rebuild the archive uncompressed with one interior z14 tile missing its streets and land.
    const file = await openArchiveFile(atlas!.archive);
    const reader = new PMTiles(file.source);
    const header = await reader.getHeader();
    const directory = await readDirectory(
      reader,
      header,
      file.bytes,
      { maxAddressedTiles: 1_000_000, tilesPerFinding: 0 },
      undefined,
    );
    const tiles: TestTile[] = [];
    for (let index = 0; index < directory.tiles.length / 3; index += 1) {
      const [z, x, y] = [0, 1, 2].map((offset) => directory.tiles[index * 3 + offset]!) as [
        number,
        number,
        number,
      ];
      tiles.push({
        z,
        x,
        y,
        data: new Uint8Array((await reader.getZxy(z, x, y))!.data),
      });
    }
    await file.close();
    const has = (z: number, x: number, y: number) =>
      tiles.some((tile) => tile.z === z && tile.x === x && tile.y === y);
    const victim = tiles.find(
      (tile) =>
        tile.z === 14 &&
        has(14, tile.x - 1, tile.y) &&
        has(14, tile.x + 1, tile.y) &&
        has(14, tile.x, tile.y - 1) &&
        has(14, tile.x, tile.y + 1),
    )!;
    victim.data = withoutLayer(withoutLayer(victim.data, "streets"), "land");
    const archive = buildArchive({
      tiles,
      layers: (atlas!.manifest as { schema: { sourceLayers: string[] } }).schema.sourceLayers,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    });
    const artifact = await runTilesetSeams({
      manifest: atlas!.manifest,
      archive: openArchiveBytes("mutated.pmtiles", archive),
      kernel,
      pmtilesReaderVersion: "test",
      mode: "full",
    });
    expect(artifact.status).toBe("failed");
    const victimKey = key(victim);
    // Every defect lies on an edge of the mutated tile, and the line events left are on the
    // neighbour's side.
    for (const pair of artifact.seams!.reported) {
      expect([key(pair.first), key(pair.second)]).toContain(victimKey);
      const neighbourSide = key(pair.first) === victimKey ? "second" : "first";
      for (const entry of pair.findings) {
        if (entry.kind === "line-interrupted") expect(entry.side).toBe(neighbourSide);
      }
    }
    expect(artifact.seams!.counts.lineInterrupted).toBeGreaterThan(0);
    expect(artifact.seams!.counts.polygonMismatches).toBeGreaterThan(0);
    expect(artifact.seams!.defectivePairs).toBeLessThanOrEqual(4);
  });
});
