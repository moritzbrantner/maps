import type { MapsTileset } from "../src/maps-tileset";
import { createFixturePmtilesTileset } from "../src/tileset-fixtures";

/** Complete, synthetic first-party Map View sample; actual geographic Atlas is #270. */
export function createShowcaseTileset(baseUrl: string): MapsTileset {
  return {
    ...createFixturePmtilesTileset("1", baseUrl),
    sourceId: "maps-showcase",
    maxZoom: 2,
    attribution: "Maps synthetic CC0 geometry",
    transport: { kind: "pmtiles", url: `${baseUrl}tilesets/showcase-pmtiles-v1.pmtiles` },
    provenance:
      "scripts/create-pmtiles-fixture.mjs; complete z0–z2 synthetic vector geometry, not real-world geographic data",
  };
}
