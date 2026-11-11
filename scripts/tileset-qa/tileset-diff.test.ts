// Tileset revision diff against the built Rust/WASM kernel. Each expected result follows from
// how the archives were constructed (`test-archive.ts`, `scripts/tileset-revision-fixture.mjs`),
// never from re-running the comparison algorithm.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PMTiles } from "pmtiles";
import { beforeAll, describe, expect, test } from "vitest";

import { compareArchives, knownTarget } from "../tileset-qa.ts";
import type { TilesetQaKernel } from "./core.ts";
import {
  runTilesetDiff,
  type TilesetDiffArtifact,
  type TilesetDiffCheckId,
  type TilesetDiffInput,
} from "./diff.ts";
import { knownComparisons } from "./known.ts";
import { loadTilesetQaKernel, openArchiveBytes } from "./node.ts";
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
    sourceId: "diff-test",
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
    attribution: "Tileset diff test",
    license: "CC0-1.0",
    provenance: "scripts/tileset-qa/test-archive.ts",
    ...overrides,
  };
}

/** A street layer: `kind=primary`, one line per name at the given row. */
function streets(roads: [name: string, row: number][], id?: (index: number) => number) {
  const names = [...new Set(roads.map(([name]) => name))];
  return mvtLayer(
    "streets",
    roads.map(([name, row], index) =>
      mvtFeature(
        2,
        pathCommands([
          [
            [0, row],
            [4096, row],
          ],
        ]),
        [0, 0, 1, 1 + names.indexOf(name)],
        id?.(index),
      ),
    ),
    ["kind", "name"],
    ["primary", ...names],
  );
}

const OUTER: [number, number][] = [
  [0, 0],
  [4096, 0],
  [4096, 4096],
  [0, 4096],
];
const hole = (west: number): [number, number][] => [
  [west, 1024],
  [west, 3072],
  [3072, 3072],
  [3072, 1024],
];
const water = (rings: [number, number][][]) =>
  mvtLayer(
    "water_polygons",
    [mvtFeature(3, pathCommands(rings, true), [0, 0])],
    ["kind"],
    ["water"],
  );

/** Every tile of a world pyramid with the same payload, optionally without some `z/x/y`. */
function pyramid(maxZoom: number, data: Uint8Array, without: string[] = []): TestTile[] {
  const tiles: TestTile[] = [];
  for (let z = 0; z <= maxZoom; z += 1) {
    for (let x = 0; x < 2 ** z; x += 1) {
      for (let y = 0; y < 2 ** z; y += 1) {
        if (!without.includes(`${z}/${x}/${y}`)) tiles.push({ z, x, y, data });
      }
    }
  }
  return tiles;
}

const archiveOf = (tiles: TestTile[], options: Partial<Parameters<typeof buildArchive>[0]> = {}) =>
  buildArchive({
    tiles,
    layers: ["streets", "water_polygons"],
    minZoom: 0,
    maxZoom: 1,
    ...options,
  });

async function compare(
  base: Uint8Array,
  candidate: Uint8Array,
  options: Partial<Omit<TilesetDiffInput, "base" | "candidate">> & {
    baseManifest?: Record<string, unknown>;
    candidateManifest?: Record<string, unknown>;
  } = {},
): Promise<TilesetDiffArtifact> {
  const { baseManifest, candidateManifest, ...rest } = options;
  return runTilesetDiff({
    base: {
      manifest: manifest(baseManifest),
      archive: openArchiveBytes("base.pmtiles", base),
    },
    candidate: {
      manifest: manifest({ dataRevision: "r2", ...candidateManifest }),
      archive: openArchiveBytes("candidate.pmtiles", candidate),
    },
    kernel,
    pmtilesReaderVersion: "test",
    ...rest,
  });
}

const statusOf = (artifact: TilesetDiffArtifact, id: TilesetDiffCheckId) =>
  artifact.checks.find((check) => check.id === id)!.status;
const finding = (artifact: TilesetDiffArtifact, code: string) =>
  artifact.findings.find((entry) => entry.code === code);
const keys = (tiles: { z: number; x: number; y: number }[]) =>
  tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);
const tileOf = (artifact: TilesetDiffArtifact, key: string) =>
  artifact.features!.tiles.find((tile) => `${tile.z}/${tile.x}/${tile.y}` === key);

const road = mvtTile(streets([["Alpha Road", 1000]]), water([OUTER, hole(1024)]));

describe("the committed synthetic revisions", () => {
  const known = knownComparisons.find((entry) => entry.comparisonId === "fixture-revision-r1-r2")!;
  const run = () =>
    compareArchives({
      base: knownTarget(known.base)!,
      candidate: knownTarget(known.candidate)!,
      comparisonId: known.comparisonId,
    });

  test("r1 → r2 reports exactly the differences the fixture script writes", async () => {
    const { artifact } = await run();
    expect(artifact.relation).toBe("revision");
    expect(artifact.base).toMatchObject({
      sourceId: "fixture-revision",
      dataRevision: "r1",
    });
    expect(artifact.candidate).toMatchObject({
      sourceId: "fixture-revision",
      dataRevision: "r2",
    });
    // r2 drops tile 1/1/1, which its declared coverage still requires.
    expect(statusOf(artifact, "coverage")).toBe("failed");
    expect(artifact.coverage).toMatchObject({
      base: 5,
      candidate: 4,
      common: 4,
      added: 0,
      removed: 1,
    });
    expect(keys(finding(artifact, "coverage-lost")!.tiles)).toEqual(["1/1/1"]);
    expect(finding(artifact, "coverage-lost")!.tiles[0]!.bounds).toEqual([
      0, -85.0511287798066, 180, 0,
    ]);
    // 1/0/1 is byte-identical; the three northern tiles swap Alpha Road for Gamma Road.
    expect(artifact.features).toMatchObject({
      complete: true,
      comparedTiles: 4,
      identicalTiles: 1,
      reencodedTiles: 0,
      changedTiles: 3,
      undiffableTiles: 0,
    });
    expect(artifact.features!.counts).toMatchObject({
      added: 0,
      removed: 0,
      changed: 0,
      ambiguous: 1,
      unmatchedAdded: 3,
      unmatchedRemoved: 3,
    });
    expect(keys(artifact.features!.tiles)).toEqual(["0/0/0", "1/0/0", "1/1/0"]);
    for (const key of ["0/0/0", "1/0/0", "1/1/0"]) {
      const tile = tileOf(artifact, key)!;
      const named = (kind: string) =>
        tile.changes
          .filter((change) => change.kind === kind)
          .map((change) => change.properties.name);
      expect(named("unmatched-removed")).toEqual(["Alpha Road"]);
      expect(named("unmatched-added")).toEqual(["Gamma Road"]);
    }
    // Only 1/1/0 widens its island hole: one ambiguous water polygon, never "changed".
    const widened = tileOf(artifact, "1/1/0")!.changes.find(
      (change) => change.kind === "ambiguous",
    )!;
    expect(widened).toMatchObject({
      layer: "water_polygons",
      geometryType: "polygon",
      id: null,
    });
    expect(widened.geometryChanged).toBe(true);
    expect(artifact.status).toBe("failed");
  });

  test("reproduces its committed artifact", async () => {
    const expected = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "expected", `${known.comparisonId}.json`),
        "utf8",
      ),
    ) as TilesetDiffArtifact;
    expect((await run()).artifact).toEqual(expected);
  });

  test("a revision compared with itself has no differences and reads no tile", async () => {
    const target = knownTarget(known.base)!;
    const { artifact, measurement } = await compareArchives({
      base: target,
      candidate: target,
    });
    expect(artifact.relation).toBe("identical-bytes");
    expect(artifact.status).toBe("passed");
    expect(artifact.findings).toEqual([]);
    expect(artifact.features).toMatchObject({
      identicalTiles: 5,
      comparedTiles: 0,
      changedTiles: 0,
    });
    // Header + one root-directory read per side; no tile range.
    expect(measurement.rangeReads).toBeLessThanOrEqual(4);
  });
});

describe("equal semantics in different bytes", () => {
  test("reordered layers and tables are re-encoded, not changed", async () => {
    const reordered = mvtTile(water([OUTER, hole(1024)]), streets([["Alpha Road", 1000]]));
    const artifact = await compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, reordered)));
    expect(artifact.status).toBe("passed");
    expect(artifact.features).toMatchObject({
      reencodedTiles: 5,
      changedTiles: 0,
    });
    expect(artifact.features!.counts.unchanged).toBe(10);
    expect(finding(artifact, "tile-reencoded")!.count).toBe(5);
  });

  test("another tile compression with the same tiles is identical tile by tile", async () => {
    // The committed r1 archive is gzip-compressed; rebuild it uncompressed from the tiles the
    // upstream reader returns.
    const r1 = knownTarget("fixture-revision-r1")!;
    const source = openArchiveBytes("r1.pmtiles", new Uint8Array(readFileSync(r1.archive)));
    const reader = new PMTiles(source.source);
    const tiles: TestTile[] = [];
    for (const key of ["0/0/0", "1/0/0", "1/0/1", "1/1/0", "1/1/1"]) {
      const [z, x, y] = key.split("/").map(Number) as [number, number, number];
      tiles.push({
        z,
        x,
        y,
        data: new Uint8Array((await reader.getZxy(z, x, y))!.data),
      });
    }
    const artifact = await runTilesetDiff({
      base: { manifest: r1.manifest, archive: source },
      candidate: {
        manifest: {
          ...(r1.manifest as object),
          dataRevision: "r1-uncompressed",
        },
        archive: openArchiveBytes(
          "uncompressed.pmtiles",
          buildArchive({
            tiles,
            layers: ["water_polygons", "land", "streets"],
            minZoom: 0,
            maxZoom: 1,
          }),
        ),
      },
      kernel,
      pmtilesReaderVersion: "test",
    });
    expect(finding(artifact, "tile-compression-changed")!.message).toBe("tile compression: 2 → 1");
    expect(artifact.features).toMatchObject({
      identicalTiles: 5,
      reencodedTiles: 0,
      changedTiles: 0,
    });
    expect(artifact.status).toBe("passed");
  });
});

describe("feature identity", () => {
  test("without stable IDs a change is ambiguous or unmatched, never identified", async () => {
    const base = mvtTile(
      streets([
        ["Alpha Road", 1000],
        ["Beta Road", 2000],
      ]),
    );
    const candidate = mvtTile(
      streets([
        ["Beta Road", 2100],
        ["Gamma Road", 3000],
      ]),
    );
    const artifact = await compare(archiveOf(pyramid(0, base)), archiveOf(pyramid(0, candidate)), {
      candidateManifest: { maxZoom: 1 },
      baseManifest: { maxZoom: 1 },
    });
    expect(artifact.features!.counts).toEqual({
      unchanged: 0,
      added: 0,
      removed: 0,
      changed: 0,
      ambiguous: 1,
      unmatchedAdded: 1,
      unmatchedRemoved: 1,
    });
    const [ambiguous] = artifact.features!.tiles[0]!.changes;
    expect(ambiguous).toMatchObject({
      kind: "ambiguous",
      properties: { name: "Beta Road" },
      baseBounds: [0, 2000, 4096, 2000],
      candidateBounds: [0, 2100, 4096, 2100],
    });
  });

  test("unique MVT IDs identify added, removed and changed features", async () => {
    const base = mvtTile(
      streets(
        [
          ["Alpha Road", 1000],
          ["Beta Road", 2000],
        ],
        (index) => index + 1,
      ),
    );
    // ID 1 removed, ID 2 moved, ID 3 added.
    const candidate = mvtTile(
      streets(
        [
          ["Beta Road", 2100],
          ["Gamma Road", 3000],
        ],
        (index) => index + 2,
      ),
    );
    const artifact = await compare(archiveOf(pyramid(0, base)), archiveOf(pyramid(0, candidate)));
    expect(artifact.features!.counts).toMatchObject({
      added: 1,
      removed: 1,
      changed: 1,
      ambiguous: 0,
    });
    const changed = artifact.features!.tiles[0]!.changes.find(
      (change) => change.kind === "changed",
    )!;
    expect(changed).toMatchObject({
      id: 2,
      geometryChanged: true,
      propertiesChanged: false,
    });
  });

  test("a feature split along a tile border is compared per tile, without cross-tile identity", async () => {
    // One road crosses the border of 1/0/0 and 1/1/0; the candidate moves only its eastern part.
    const west = mvtTile(streets([["Border Road", 1000]]));
    const east = mvtTile(streets([["Border Road", 1200]]));
    const tiles = (eastern: Uint8Array): TestTile[] => [
      { z: 1, x: 0, y: 0, data: west },
      { z: 1, x: 1, y: 0, data: eastern },
    ];
    const artifact = await compare(
      archiveOf(tiles(west), { minZoom: 1 }),
      archiveOf(tiles(east), { minZoom: 1 }),
      {
        baseManifest: { minZoom: 1, bounds: [-180, 0, 180, 85.0511287798066] },
        candidateManifest: {
          minZoom: 1,
          bounds: [-180, 0, 180, 85.0511287798066],
        },
      },
    );
    expect(artifact.features).toMatchObject({
      identicalTiles: 1,
      changedTiles: 1,
    });
    expect(keys(artifact.features!.tiles)).toEqual(["1/1/0"]);
    expect(artifact.features!.counts.ambiguous).toBe(1);
  });

  test("reversed ring winding is a geometry change, not equality", async () => {
    const reversed = [...OUTER].reverse();
    const artifact = await compare(
      archiveOf(pyramid(0, mvtTile(water([OUTER])))),
      archiveOf(pyramid(0, mvtTile(water([reversed])))),
    );
    expect(artifact.features!.counts).toMatchObject({
      unchanged: 0,
      ambiguous: 1,
    });
  });
});

describe("source metadata and schema drift", () => {
  test("changed attribution, license and provenance are flagged for review", async () => {
    const artifact = await compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, road)), {
      candidateManifest: {
        attribution: "Another producer",
        license: "ODbL-1.0",
        provenance: "another recipe",
      },
    });
    // Byte-identical archives still have their manifests compared.
    expect(artifact.relation).toBe("identical-bytes");
    expect(finding(artifact, "attribution-changed")).toMatchObject({
      severity: "warning",
      message: "attribution: Tileset diff test → Another producer",
    });
    expect(finding(artifact, "license-changed")!.severity).toBe("warning");
    expect(finding(artifact, "provenance-changed")!.severity).toBe("info");
    expect(artifact.status).toBe("passed");
  });

  test("source layers and property keys that drift are reported per layer and tile", async () => {
    const candidate = mvtTile(
      mvtLayer(
        "streets",
        [
          mvtFeature(
            2,
            pathCommands([
              [
                [0, 1000],
                [4096, 1000],
              ],
            ]),
            [0, 0, 1, 1],
          ),
        ],
        ["kind", "ref"],
        ["primary", "A1"],
      ),
      mvtLayer("buildings", [mvtFeature(1, [9, 50, 34])]),
    );
    const artifact = await compare(archiveOf(pyramid(0, road)), archiveOf(pyramid(0, candidate)), {
      candidateManifest: {
        schema: {
          id: "shortbread",
          version: "1.0",
          sourceLayers: ["streets", "buildings"],
        },
      },
    });
    expect(finding(artifact, "source-layer-removed")!.message).toBe(
      "declared source layers removed: water_polygons",
    );
    expect(finding(artifact, "source-layer-added")!.message).toBe(
      "declared source layers added: buildings",
    );
    expect(finding(artifact, "tile-layer-added")!.count).toBe(1);
    expect(finding(artifact, "tile-layer-removed")!.count).toBe(1);
    const streetsLayer = artifact.features!.layers.find((layer) => layer.name === "streets")!;
    expect(streetsLayer).toMatchObject({
      propertyKeysAdded: ["ref"],
      propertyKeysRemoved: ["name"],
    });
    expect(artifact.features!.tiles[0]!.schemaChanges).toEqual([
      "layer buildings added",
      "layer streets property keys +ref -name",
      "layer water_polygons removed",
    ]);
  });
});

describe("coverage delta", () => {
  test("tiles the candidate no longer declares are narrowed coverage; declared ones are lost", async () => {
    // Antimeridian bounds: z1 declares all four tiles, z2 only columns 0 and 3 of rows 1–2.
    const bounds = [170, -10, -170, 10];
    const declared = [
      "0/0/0",
      "1/0/0",
      "1/0/1",
      "1/1/0",
      "1/1/1",
      "2/0/1",
      "2/0/2",
      "2/3/1",
      "2/3/2",
    ];
    const all = pyramid(2, road);
    const kept = all.filter((tile) => declared.includes(`${tile.z}/${tile.x}/${tile.y}`));
    const candidate = kept.filter((tile) => `${tile.z}/${tile.x}/${tile.y}` !== "2/3/2");
    const artifact = await compare(
      archiveOf(all, { maxZoom: 2 }),
      archiveOf(candidate, { maxZoom: 2, bounds: [170, -10, -170, 10] }),
      {
        baseManifest: { maxZoom: 2 },
        candidateManifest: { maxZoom: 2, bounds },
      },
    );
    expect(artifact.coverage).toMatchObject({
      base: 21,
      candidate: 8,
      removed: 13,
      added: 0,
    });
    expect(finding(artifact, "coverage-narrowed")!.count).toBe(12);
    expect(keys(finding(artifact, "coverage-lost")!.tiles)).toEqual(["2/3/2"]);
    expect(finding(artifact, "coverage-lost")!.count).toBe(1);
    expect(finding(artifact, "bounds-changed")).toBeDefined();
    expect(artifact.features!.identicalTiles).toBe(8);
  });

  test("tiles only the candidate has are added coverage", async () => {
    const artifact = await compare(
      archiveOf(pyramid(1, road, ["1/1/1"])),
      archiveOf(pyramid(1, road)),
    );
    expect(keys(finding(artifact, "coverage-added")!.tiles)).toEqual(["1/1/1"]);
    expect(finding(artifact, "coverage-added")!.severity).toBe("info");
    expect(artifact.status).toBe("passed");
  });
});

describe("what a diff cannot establish is never a pass", () => {
  test("different sources compare coverage only and stay inconclusive", async () => {
    const other = mvtTile(streets([["Gamma Road", 3000]]));
    const artifact = await compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, other)), {
      candidateManifest: { sourceId: "another-source" },
    });
    expect(artifact.relation).toBe("cross-source");
    expect(statusOf(artifact, "coverage")).toBe("passed");
    expect(statusOf(artifact, "features")).toBe("inconclusive");
    expect(artifact.features).toMatchObject({
      complete: false,
      comparedTiles: 0,
    });
    expect(artifact.status).toBe("inconclusive");
  });

  test("one revision label on two different archives fails pairing", async () => {
    const other = mvtTile(streets([["Gamma Road", 3000]]));
    const artifact = await compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, other)), {
      candidateManifest: { dataRevision: "r1" },
    });
    expect(finding(artifact, "revision-label-reused")!.severity).toBe("error");
    expect(artifact.status).toBe("failed");
  });

  test("an invalid manifest or a malformed archive fails and leaves the rest unevaluated", async () => {
    const invalid = await compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, road)), {
      candidateManifest: { minZoom: 5 },
    });
    expect(statusOf(invalid, "pairing")).toBe("failed");
    expect(statusOf(invalid, "features")).toBe("inconclusive");

    const malformed = await compare(
      archiveOf(pyramid(1, road)),
      new TextEncoder().encode("not an archive"),
    );
    expect(statusOf(malformed, "archives")).toBe("failed");
    expect(statusOf(malformed, "coverage")).toBe("inconclusive");
    expect(malformed.status).toBe("failed");
  });

  test("a tile the runtime decoder rejects fails at that tile", async () => {
    const broken = Uint8Array.from([0x1a, 0x7f, 0x00]);
    const artifact = await compare(
      archiveOf(pyramid(1, road)),
      archiveOf(pyramid(1, road).map((tile) => (tile.z === 0 ? { ...tile, data: broken } : tile))),
    );
    expect(keys(finding(artifact, "undiffable-tile")!.tiles)).toEqual(["0/0/0"]);
    expect(finding(artifact, "undiffable-tile")!.message).toMatch(/^candidate tile/);
    expect(tileOf(artifact, "0/0/0")!.status).toBe("undiffable");
    expect(artifact.status).toBe("failed");
  });

  test("a full comparison beyond its tile budget is inconclusive", async () => {
    const changed = mvtTile(streets([["Gamma Road", 3000]]));
    const artifact = await compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, changed)), {
      mode: "full",
      limits: { maxContentTiles: 2 },
    });
    expect(artifact.features).toMatchObject({
      complete: false,
      comparedTiles: 2,
    });
    expect(statusOf(artifact, "features")).toBe("inconclusive");
  });
});

describe("bounded sampling and cancellation", () => {
  test("a sampled comparison reads only its sample, every zoom represented, and bounds its lists", async () => {
    const changed = mvtTile(streets([["Gamma Road", 3000]]));
    const tiles = (data: Uint8Array) => pyramid(3, data);
    const base = openArchiveBytes("base.pmtiles", archiveOf(tiles(road), { maxZoom: 3 }));
    const candidate = openArchiveBytes(
      "candidate.pmtiles",
      archiveOf(tiles(changed), { maxZoom: 3 }),
    );
    const artifact = await runTilesetDiff({
      base: { manifest: manifest({ maxZoom: 3 }), archive: base },
      candidate: {
        manifest: manifest({ maxZoom: 3, dataRevision: "r2" }),
        archive: candidate,
      },
      kernel,
      pmtilesReaderVersion: "test",
      seed: 7,
      limits: {
        sampleTiles: 4,
        reportedTiles: 2,
        changesPerTile: 1,
        tilesPerFinding: 4,
      },
    });
    expect(artifact.features).toMatchObject({
      commonTiles: 85,
      comparedTiles: 4,
      complete: false,
    });
    expect(statusOf(artifact, "features")).toBe("passed");
    // One tile per zoom level: the seeded sample takes zoom levels in turn.
    expect(
      finding(artifact, "features-unmatched-added")!
        .tiles.map((tile) => tile.z)
        .sort(),
    ).toEqual([0, 1, 2, 3]);
    expect(artifact.features!.tiles).toHaveLength(2);
    expect(artifact.features!.tiles[0]!.changes).toHaveLength(1);
    expect(artifact.features!.tiles[0]!.changesTruncated).toBe(true);
    expect(finding(artifact, "features-unmatched-added")!.count).toBe(4);

    // Header + directory, then the four sampled tiles per side.
    expect(base.io.reads).toBeLessThanOrEqual(2 + 4);
    expect(candidate.io.reads).toBeLessThanOrEqual(2 + 4);
  });

  test("an aborted comparison rejects instead of reporting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      compare(archiveOf(pyramid(1, road)), archiveOf(pyramid(1, road)), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// Opt-in regional QA: the Atlas archives are fetched by scripts/fetch-atlas-tiles.ts.
const atlas = knownComparisons.find(
  (entry) => entry.comparisonId === "atlas-liechtenstein-north-coverage",
)!;
const atlasBase = knownTarget(atlas.base)!;
test.skipIf(!existsSync(atlasBase.archive) || !existsSync(knownTarget(atlas.candidate)!.archive))(
  "the Atlas variants are a cross-source coverage comparison, never feature identity",
  async () => {
    const { artifact } = await compareArchives({
      base: atlasBase,
      candidate: knownTarget(atlas.candidate)!,
      comparisonId: atlas.comparisonId,
    });
    expect(artifact.relation).toBe("cross-source");
    expect(artifact.coverage).toMatchObject({
      base: 203,
      candidate: 89,
      common: 89,
      removed: 114,
    });
    // Every tile only the full archive has lies outside the northern variant's bounds.
    expect(finding(artifact, "coverage-narrowed")!.count).toBe(114);
    expect(finding(artifact, "coverage-lost")).toBeUndefined();
    expect(artifact.status).toBe("inconclusive");
  },
);
