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
