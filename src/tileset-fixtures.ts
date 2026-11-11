import type { MapsTileset } from "./maps-tileset";
/** Deterministic CC0 fixtures, for examples and canonical source-lifecycle evidence. */
export function createFixtureTileset(
  source: "a" | "b",
  revision = "1",
  baseUrl = "/",
): MapsTileset {
  return {
    version: 1,
    sourceId: `fixture-${source}`,
    dataRevision: revision,
    format: "mvt",
    schema: {
      id: "shortbread",
      version: "1.0",
      sourceLayers: ["water_polygons", "land", "streets"],
    },
    transport: {
      kind: "xyz",
      urlTemplate: `${baseUrl}tilesets/fixture-${source}.mvt?z={z}&x={x}&y={y}`,
    },
    scheme: "xyz",
    projection: "web-mercator",
    bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
    minZoom: 0,
    maxZoom: 0,
    tileSize: 512,
    attribution: "Maps deterministic fixture · CC0",
    license: "CC0-1.0",
    provenance: "e2e/fixtures/shortbread-tile.mjs; illustrative geometry without geographic claims",
  };
}

/** Real PMTiles v3 archive: z0 island hole and street lines, plus one z1 tile. */
export function createFixturePmtilesTileset(revision = "1", baseUrl = "/"): MapsTileset {
  return {
    ...createFixtureTileset("a", revision, baseUrl),
    sourceId: "fixture-pmtiles",
    maxZoom: 1,
    transport: { kind: "pmtiles", url: `${baseUrl}tilesets/fixture-pmtiles-v1.pmtiles` },
    provenance: "scripts/create-pmtiles-fixture.mjs; synthetic CC0 Shortbread geometry",
  };
}

/** The same committed z0 MVT bytes exposed as XYZ for pixel-equivalence evidence. */
export function createFixturePmtilesXyzTileset(baseUrl = "/"): MapsTileset {
  return {
    ...createFixturePmtilesTileset("1", baseUrl),
    sourceId: "fixture-pmtiles-xyz",
    maxZoom: 0,
    transport: {
      kind: "xyz",
      urlTemplate: `${baseUrl}tilesets/fixture-pmtiles-v1.mvt?z={z}&x={x}&y={y}`,
    },
  };
}

/**
 * Two synthetic revisions of one source for the Tileset revision diff (#276): r2 swaps a
 * road, widens one polygon hole and drops tile 1/1/1. See `scripts/tileset-revision-fixture.mjs`.
 */
export function createFixtureRevisionTileset(revision: "r1" | "r2", baseUrl = "/"): MapsTileset {
  return {
    ...createFixtureTileset("a", revision, baseUrl),
    sourceId: "fixture-revision",
    maxZoom: 1,
    attribution: "Maps revision diff fixture · CC0",
    transport: { kind: "pmtiles", url: `${baseUrl}tilesets/fixture-revision-${revision}.pmtiles` },
    provenance:
      "scripts/tileset-revision-fixture.mjs; synthetic CC0 revisions of one source, not geographic data",
  };
}

/**
 * One seeded synthetic world cut into tiles for Tile seam QA (#276): `clean` keeps every seam
 * continuous (64-unit buffer), `defects` breaks four on purpose (clipped at the tile edge). See
 * `scripts/tileset-seam-fixture.mjs`.
 */
export function createFixtureSeamsTileset(
  variant: "clean" | "defects",
  baseUrl = "/",
): MapsTileset {
  return {
    ...createFixtureTileset("a", variant, baseUrl),
    sourceId: "fixture-seams",
    maxZoom: 1,
    attribution: "Maps tile seam fixture · CC0",
    transport: { kind: "pmtiles", url: `${baseUrl}tilesets/fixture-seams-${variant}.pmtiles` },
    provenance:
      "scripts/tileset-seam-fixture.mjs; one seeded synthetic CC0 world cut into tiles, not geographic data",
  };
}
