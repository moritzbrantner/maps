// Tileset integrity QA against the built Rust/WASM kernel. Synthetic archives are written by
// `test-archive.ts`, so each expected result follows from how the archive was constructed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import { auditArchive } from "../tileset-qa.ts";
import {
  runTilesetQa,
  TILESET_QA_UPSTREAM,
  type TilesetQaArtifact,
  type TilesetQaCheckId,
  type TilesetQaInput,
  type TilesetQaKernel,
} from "./core.ts";
import { knownTilesets } from "./known.ts";
import { loadTilesetQaKernel, openArchiveBytes, repositoryRoot } from "./node.ts";
import {
  buildArchive,
  mvtFeature,
  mvtLayer,
  mvtTile,
  LINE_COMMANDS,
  type TestTile,
} from "./test-archive.ts";

const WORLD: [number, number, number, number] = [-180, -85.0511287798066, 180, 85.0511287798066];
const PINNED_PASS = { ...TILESET_QA_UPSTREAM, outcome: "passed", detail: "" } as const;
const street = mvtTile(mvtLayer("streets"));

let kernel: TilesetQaKernel;
beforeAll(async () => {
  kernel = await loadTilesetQaKernel();
});

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sourceId: "qa-test",
    dataRevision: "r1",
    format: "mvt",
    schema: { id: "shortbread", version: "1.0", sourceLayers: ["streets"] },
    projection: "web-mercator",
    scheme: "xyz",
    bounds: WORLD,
    minZoom: 0,
    maxZoom: 1,
    tileSize: 512,
    attribution: "Tileset QA test",
    license: "CC0-1.0",
    provenance: "scripts/tileset-qa/test-archive.ts",
    ...overrides,
  };
}

/** Every tile of a world pyramid, optionally without some `z/x/y` keys. */
function pyramid(maxZoom: number, data = street, without: string[] = []): TestTile[] {
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

function archiveOf(tiles: TestTile[], options: Partial<Parameters<typeof buildArchive>[0]> = {}) {
  return buildArchive({ tiles, layers: ["streets"], minZoom: 0, maxZoom: 1, ...options });
}

async function audit(
  bytes: Uint8Array,
  options: Partial<TilesetQaInput> = {},
): Promise<TilesetQaArtifact> {
  const archive = openArchiveBytes("test.pmtiles", bytes);
  return runTilesetQa({
    manifest: manifest(),
    archive,
    expectedArchive: { sha256: archive.sha256, bytes: archive.bytes },
    upstreamVerify: PINNED_PASS,
    kernel,
    pmtilesReaderVersion: "test",
    ...options,
  });
}

const statusOf = (artifact: TilesetQaArtifact, id: TilesetQaCheckId) =>
  artifact.checks.find((check) => check.id === id)!.status;
const finding = (artifact: TilesetQaArtifact, code: string) =>
  artifact.findings.find((entry) => entry.code === code);
const keys = (tiles: { z: number; x: number; y: number }[]) =>
  tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);

describe("a sound archive", () => {
  test("passes every check and reports what it contains", async () => {
    const artifact = await audit(archiveOf(pyramid(1)));
    expect(artifact.schema).toBe("maps-tileset-qa-v1");
    expect(artifact.status).toBe("passed");
    expect(artifact.checks.map((check) => check.status)).toEqual(Array(8).fill("passed"));
    expect(artifact.findings).toEqual([]);
    expect(artifact.coverage).toMatchObject({ expected: 5, covered: 5, missing: 0, outside: 0 });
    expect(artifact.content).toMatchObject({ addressedTiles: 5, inspectedTiles: 5 });
    expect(artifact.content!.layers).toEqual([
      expect.objectContaining({ name: "streets", declared: true, tiles: 5, features: 5, lines: 5 }),
    ]);
    expect(artifact.source).toMatchObject({ sourceId: "qa-test", dataRevision: "r1" });
  });

  test("is reported identically on every run", async () => {
    const bytes = archiveOf(pyramid(1));
    expect(JSON.stringify(await audit(bytes))).toBe(JSON.stringify(await audit(bytes)));
  });
});

describe("missing evidence is never a pass", () => {
  test("no upstream verdict, or one from another version, is inconclusive", async () => {
    const bytes = archiveOf(pyramid(1));
    const absent = await audit(bytes, { upstreamVerify: null });
    expect(statusOf(absent, "upstream-verify")).toBe("inconclusive");
    expect(absent.status).toBe("inconclusive");
    const other = await audit(bytes, { upstreamVerify: { ...PINNED_PASS, version: "1.20.0" } });
    expect(other.status).toBe("inconclusive");
    expect(finding(other, "upstream-version-mismatch")).toBeDefined();
  });

  test("a failing upstream verdict fails", async () => {
    const artifact = await audit(archiveOf(pyramid(1)), {
      upstreamVerify: { ...PINNED_PASS, outcome: "failed", detail: "bad directory" },
    });
    expect(artifact.status).toBe("failed");
    expect(finding(artifact, "upstream-verify-failed")!.message).toBe("bad directory");
  });

  test("an archive without a content pin is inconclusive", async () => {
    const artifact = await audit(archiveOf(pyramid(1)), { expectedArchive: null });
    expect(statusOf(artifact, "archive-identity")).toBe("inconclusive");
    expect(artifact.status).toBe("inconclusive");
    expect(artifact.archive.expectedSha256).toBeNull();
  });

  test("coverage or a directory beyond the budget is inconclusive", async () => {
    const bytes = archiveOf(pyramid(1));
    const coverage = await audit(bytes, { limits: { maxExpectedTiles: 3 } });
    expect(statusOf(coverage, "tile-coverage")).toBe("inconclusive");
    expect(coverage.coverage).toBeNull();
    expect(coverage.status).toBe("inconclusive");
    const directory = await audit(bytes, { limits: { maxAddressedTiles: 3 } });
    expect(statusOf(directory, "archive-directory")).toBe("inconclusive");
    expect(statusOf(directory, "tile-coverage")).toBe("inconclusive");
    expect(statusOf(directory, "tile-content")).toBe("inconclusive");
  });

  test("a full scan that cannot decode every tile is inconclusive", async () => {
    const artifact = await audit(archiveOf(pyramid(1)), {
      mode: "full",
      limits: { maxContentTiles: 2 },
    });
    expect(artifact.content!.inspectedTiles).toBe(2);
    expect(statusOf(artifact, "tile-content")).toBe("inconclusive");
  });
});

describe("archive identity", () => {
  test("changed bytes fail against the archive reference and a sha256 revision", async () => {
    const bytes = archiveOf(pyramid(1));
    const pin = openArchiveBytes("pin", bytes);
    const changed = bytes.slice();
    changed[changed.length - 1]! ^= 1; // last byte of the last tile's payload
    const artifact = await audit(changed, {
      manifest: manifest({ dataRevision: `sha256:${pin.sha256}` }),
      expectedArchive: { sha256: pin.sha256, bytes: pin.bytes + 1 },
    });
    expect(statusOf(artifact, "archive-identity")).toBe("failed");
    expect(finding(artifact, "archive-hash-mismatch")).toBeDefined();
    expect(finding(artifact, "revision-hash-mismatch")).toBeDefined();
    expect(finding(artifact, "archive-size-mismatch")).toBeDefined();
  });

  test("a sha256 data revision alone pins the archive", async () => {
    const bytes = archiveOf(pyramid(1));
    const artifact = await audit(bytes, {
      manifest: manifest({ dataRevision: `sha256:${openArchiveBytes("pin", bytes).sha256}` }),
      expectedArchive: null,
    });
    expect(statusOf(artifact, "archive-identity")).toBe("passed");
  });
});

describe("manifest and archive agreement", () => {
  test("an invalid manifest fails and leaves archive checks unevaluated", async () => {
    const artifact = await audit(archiveOf(pyramid(1)), { manifest: manifest({ license: "" }) });
    expect(statusOf(artifact, "manifest")).toBe("failed");
    expect(statusOf(artifact, "tile-coverage")).toBe("inconclusive");
    expect(artifact.source).toBeNull();
    expect(artifact.status).toBe("failed");
  });

  test("a zoom range the archive does not have fails header and coverage", async () => {
    const artifact = await audit(archiveOf(pyramid(1)), {
      manifest: manifest({ maxZoom: 2 }),
      limits: { tilesPerFinding: 2 },
    });
    expect(statusOf(artifact, "archive-header")).toBe("failed");
    // All 16 zoom-2 tiles are absent; the sample is bounded, the count is exact.
    expect(finding(artifact, "missing-tile")).toMatchObject({ count: 16 });
    expect(keys(finding(artifact, "missing-tile")!.tiles)).toEqual(["2/0/0", "2/0/1"]);
  });

  test("source layers that drifted from the manifest fail", async () => {
    const drifted = archiveOf(pyramid(1, mvtTile(mvtLayer("streets"), mvtLayer("pois"))));
    const tileOnly = await audit(drifted);
    expect(statusOf(tileOnly, "archive-metadata")).toBe("passed");
    expect(finding(tileOnly, "undeclared-source-layer")).toMatchObject({ count: 5 });
    expect(tileOnly.content!.layers.find((layer) => layer.name === "pois")!.declared).toBe(false);
    expect(tileOnly.status).toBe("failed");

    const metadata = await audit(archiveOf(pyramid(1), { layers: ["streets", "land"] }));
    expect(statusOf(metadata, "archive-metadata")).toBe("failed");
    expect(finding(metadata, "metadata-conflict")).toBeDefined();
  });

  test("a declared layer no tile carries is a warning, not a failure", async () => {
    const artifact = await audit(archiveOf(pyramid(1), { layers: ["streets", "land"] }), {
      manifest: manifest({
        schema: { id: "shortbread", version: "1.0", sourceLayers: ["streets", "land"] },
      }),
    });
    expect(finding(artifact, "declared-layer-unobserved")).toMatchObject({ severity: "warning" });
    expect(artifact.status).toBe("passed");
  });

  test("a property outside the archive's declared fields is a warning", async () => {
    const tagged = mvtTile(
      mvtLayer(
        "streets",
        [mvtFeature(2, LINE_COMMANDS, [0, 0, 1, 1])],
        ["kind", "surface"],
        ["a", "b"],
      ),
    );
    const artifact = await audit(
      archiveOf(pyramid(0, tagged), { maxZoom: 0, fields: { streets: { kind: "String" } } }),
      { manifest: manifest({ maxZoom: 0 }) },
    );
    expect(finding(artifact, "undeclared-property")!.message).toContain("streets.surface");
    expect(artifact.content!.layers[0]!.propertyKeys).toEqual(["kind", "surface"]);
    expect(artifact.status).toBe("passed");
  });

  test("header counts that disagree with the directory fail", async () => {
    const artifact = await audit(archiveOf(pyramid(1), { header: { addressedTiles: 7 } }));
    expect(statusOf(artifact, "archive-directory")).toBe("failed");
    expect(finding(artifact, "addressed-count-mismatch")).toBeDefined();
  });
});

describe("tile coverage", () => {
  test("missing tiles inside declared coverage fail with exact references", async () => {
    const artifact = await audit(archiveOf(pyramid(1, street, ["1/1/0", "1/0/1"])));
    expect(statusOf(artifact, "tile-coverage")).toBe("failed");
    expect(finding(artifact, "missing-tile")).toMatchObject({ severity: "error", count: 2 });
    expect(keys(finding(artifact, "missing-tile")!.tiles)).toEqual(["1/0/1", "1/1/0"]);
    expect(artifact.coverage!.byZoom).toEqual([
      { zoom: 0, expected: 1, covered: 1, missing: 0, outside: 0 },
      { zoom: 1, expected: 4, covered: 2, missing: 2, outside: 0 },
    ]);
  });

  test("tiles outside declared bounds are a warning; outside the zoom range a failure", async () => {
    // The north-east quadrant: 0/0/0 and 1/1/0 are required, the other three zoom-1 tiles are not.
    const bounds: [number, number, number, number] = [0, 0, 90, 60];
    const outside = await audit(archiveOf(pyramid(1), { bounds }), {
      manifest: manifest({ bounds }),
    });
    expect(outside.coverage).toMatchObject({ expected: 2, covered: 2, outside: 3 });
    expect(finding(outside, "tile-outside-bounds")).toMatchObject({
      severity: "warning",
      count: 3,
    });
    expect(outside.status).toBe("passed");

    const deeper = await audit(archiveOf([...pyramid(1), { z: 2, x: 3, y: 3, data: street }]));
    expect(keys(finding(deeper, "tile-outside-zoom-range")!.tiles)).toEqual(["2/3/3"]);
    expect(statusOf(deeper, "tile-coverage")).toBe("failed");
  });

  test("antimeridian bounds require the tiles on both sides of ±180°", async () => {
    // 170° E … 170° W, ±10°: zoom 0 has 1 tile, zoom 1 all 4, zoom 2 columns 3 and 0 in
    // rows 1 and 2. Nine required tiles; the world pyramid holds 21.
    const bounds: [number, number, number, number] = [170, -10, -170, 10];
    const options = { maxZoom: 2, bounds };
    const input = { manifest: manifest({ bounds, maxZoom: 2 }) };
    const complete = await audit(archiveOf(pyramid(2), options), input);
    expect(complete.coverage).toMatchObject({ expected: 9, covered: 9, missing: 0, outside: 12 });
    expect(statusOf(complete, "tile-coverage")).toBe("passed");
    const gap = await audit(archiveOf(pyramid(2, street, ["2/0/1"]), options), input);
    expect(keys(finding(gap, "missing-tile")!.tiles)).toEqual(["2/0/1"]);
  });
});

describe("tile content", () => {
  const withTile = (data: Uint8Array) =>
    archiveOf([...pyramid(1, street, ["1/1/1"]), { z: 1, x: 1, y: 1, data }]);

  test("a tile the runtime decoder rejects fails at that tile", async () => {
    const artifact = await audit(withTile(Uint8Array.of(0x1a, 0x7f, 0x00)));
    expect(statusOf(artifact, "tile-content")).toBe("failed");
    expect(finding(artifact, "undecodable-tile")).toMatchObject({ count: 1 });
    expect(keys(finding(artifact, "undecodable-tile")!.tiles)).toEqual(["1/1/1"]);
    expect(artifact.content!.tiles).toHaveLength(4);
  });

  test("a zero-length tile and a repeated layer fail; a featureless tile warns", async () => {
    const empty = await audit(withTile(new Uint8Array()));
    expect(finding(empty, "zero-length-tile")).toMatchObject({ severity: "error", count: 1 });
    expect(statusOf(empty, "archive-directory")).toBe("failed");

    const repeated = await audit(withTile(mvtTile(mvtLayer("streets"), mvtLayer("streets"))));
    expect(keys(finding(repeated, "duplicate-source-layer")!.tiles)).toEqual(["1/1/1"]);

    const featureless = await audit(withTile(mvtTile(mvtLayer("streets", []))));
    expect(finding(featureless, "featureless-tile")).toMatchObject({ severity: "warning" });
    expect(featureless.status).toBe("passed");
  });

  test("inspected tiles carry reproducible content references", async () => {
    const artifact = await audit(archiveOf(pyramid(0), { maxZoom: 0 }), {
      manifest: manifest({ maxZoom: 0 }),
    });
    const digest = createHash("sha256").update(street).digest("hex");
    expect(artifact.content!.tiles).toEqual([
      { z: 0, x: 0, y: 0, bytes: street.length, sha256: digest, features: 1 },
    ]);
  });
});

describe("malformed archives", () => {
  test("bytes that are not a PMTiles archive fail without evaluating the rest", async () => {
    for (const bytes of [new Uint8Array(4096), archiveOf(pyramid(1)).slice(0, 60)]) {
      const artifact = await audit(bytes);
      expect(statusOf(artifact, "archive-header")).toBe("failed");
      expect(finding(artifact, "unreadable-archive")).toBeDefined();
      expect(statusOf(artifact, "tile-coverage")).toBe("inconclusive");
      expect(statusOf(artifact, "tile-content")).toBe("inconclusive");
      expect(artifact.status).toBe("failed");
      expect(artifact.archive.header).toBeNull();
    }
  });

  test("a truncated archive fails where its directory points past the end", async () => {
    const bytes = archiveOf(pyramid(1));
    const artifact = await audit(bytes.slice(0, bytes.length - street.length - 1));
    expect(finding(artifact, "tile-beyond-archive")).toMatchObject({ severity: "error", count: 2 });
    expect(statusOf(artifact, "archive-directory")).toBe("failed");
    expect(statusOf(artifact, "tile-content")).toBe("failed");
  });
});

describe("bounded sampling and cancellation", () => {
  test("a sampled run reads only the tiles it inspects and covers every zoom", async () => {
    const bytes = archiveOf(pyramid(2), { maxZoom: 2 });
    const archive = openArchiveBytes("sampled.pmtiles", bytes);
    const run = (seed: number) =>
      runTilesetQa({
        manifest: manifest({ maxZoom: 2 }),
        archive,
        expectedArchive: { sha256: archive.sha256 },
        upstreamVerify: PINNED_PASS,
        kernel,
        pmtilesReaderVersion: "test",
        seed,
        limits: { sampleTiles: 6 },
      });
    const first = await run(7);
    // Header with root directory, metadata, and one range per inspected tile.
    expect(archive.io.reads).toBe(8);
    expect(first.content).toMatchObject({ addressedTiles: 21, inspectedTiles: 6 });
    expect(new Set(first.content!.tiles.map((tile) => tile.z))).toEqual(new Set([0, 1, 2]));
    expect(first.coverage).toMatchObject({ expected: 21, covered: 21 });
    expect(first.status).toBe("passed");
    expect(JSON.stringify(await run(7))).toBe(JSON.stringify(first));
    expect(keys((await run(8)).content!.tiles)).not.toEqual(keys(first.content!.tiles));
  });

  test("an aborted run rejects instead of reporting", async () => {
    const bytes = archiveOf(pyramid(1));
    await expect(audit(bytes, { signal: AbortSignal.abort() })).rejects.toThrow();

    const controller = new AbortController();
    const archive = openArchiveBytes("abort.pmtiles", bytes);
    let reads = 0;
    const source = {
      getKey: archive.source.getKey,
      getBytes: (...args: Parameters<typeof archive.source.getBytes>) => {
        reads += 1;
        if (reads === 3) controller.abort(); // first tile read, after header and metadata
        return archive.source.getBytes(...args);
      },
    };
    await expect(
      audit(bytes, { archive: { ...archive, source }, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("known archives", () => {
  const upstreamRequired = process.env.MAPS_QA_REQUIRE_UPSTREAM === "1";
  /** The parts of an artifact that do not depend on the upstream validator having run. */
  const withoutUpstream = (artifact: TilesetQaArtifact) => ({
    ...artifact,
    status: null,
    tools: { ...artifact.tools, upstreamVerify: null },
    checks: artifact.checks.filter((check) => check.id !== "upstream-verify"),
    findings: artifact.findings.filter((entry) => entry.check !== "upstream-verify"),
  });

  for (const known of knownTilesets.filter((entry) => entry.committed)) {
    test(`${known.fixtureId} reproduces its committed artifact`, async () => {
      const expected = JSON.parse(
        readFileSync(path.join(import.meta.dirname, "expected", `${known.fixtureId}.json`), "utf8"),
      ) as TilesetQaArtifact;
      const { artifact } = await auditArchive({
        manifest: known.manifest,
        archive: path.join(repositoryRoot, known.archive),
        expectedArchive: known.expectedArchive,
        fixtureId: known.fixtureId,
      });
      if (artifact.tools.upstreamVerify || upstreamRequired) {
        // With the pinned go-pmtiles the whole artifact, verdict included, must reproduce.
        expect(artifact).toEqual(expected);
      } else {
        expect(statusOf(artifact, "upstream-verify")).toBe("inconclusive");
        expect(artifact.status).not.toBe("passed");
        expect(withoutUpstream(artifact)).toEqual(withoutUpstream(expected));
      }
    });
  }

  test("the complete showcase archive passes and the sparse fixture fails on coverage", () => {
    const read = (id: string) =>
      JSON.parse(
        readFileSync(path.join(import.meta.dirname, "expected", `${id}.json`), "utf8"),
      ) as TilesetQaArtifact;
    expect(read("showcase-pmtiles-v1").status).toBe("passed");
    const sparse = read("fixture-pmtiles-v1");
    expect(sparse.status).toBe("failed");
    // scripts/create-pmtiles-fixture.mjs writes one of the four zoom-1 tiles.
    expect(keys(finding(sparse, "missing-tile")!.tiles)).toEqual(["1/0/1", "1/1/0", "1/1/1"]);
  });

  // Opt-in regional QA: the Atlas archives are fetched by scripts/fetch-atlas-tiles.ts.
  const atlas = knownTilesets.find((entry) => entry.fixtureId === "atlas-liechtenstein")!;
  test.skipIf(!existsSync(path.join(repositoryRoot, atlas.archive)))(
    "the published Liechtenstein archive is sparse inside its declared bounds",
    async () => {
      const { artifact } = await auditArchive({
        manifest: atlas.manifest,
        archive: path.join(repositoryRoot, atlas.archive),
        expectedArchive: atlas.expectedArchive,
        mode: "full",
        limits: { tilesPerFinding: 64 },
      });
      expect(statusOf(artifact, "archive-identity")).toBe("passed");
      expect(statusOf(artifact, "tile-content")).toBe("passed");
      expect(statusOf(artifact, "tile-coverage")).toBe("failed");
      expect(artifact.coverage).toMatchObject({ expected: 244, covered: 203, missing: 41 });
      // The tile on which the Map View was seen to fail closed around Vaduz.
      expect(keys(finding(artifact, "missing-tile")!.tiles)).toContain("14/8623/5754");
      expect(artifact.status).toBe("failed");
    },
  );
});
