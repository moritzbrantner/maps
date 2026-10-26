import { describe, expect, it } from "vitest";
import { validateMapsTileset, type MapsTileset } from "./maps-tileset";

export const fixtureTileset: MapsTileset = {
  version: 1,
  sourceId: "fixture-a",
  dataRevision: "r1",
  format: "mvt",
  schema: { id: "shortbread", version: "1.0", sourceLayers: ["water_polygons", "streets"] },
  transport: { kind: "xyz", urlTemplate: "/tiles/{z}/{x}/{y}.mvt" },
  projection: "web-mercator",
  scheme: "xyz",
  bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  attribution: "Fixture",
  license: "CC0-1.0",
  provenance: "Deterministic fixture",
};

describe("Maps Tileset", () => {
  it("validates a server-safe manifest independently of transport and historical date", () => {
    expect(validateMapsTileset(fixtureTileset)).toEqual(fixtureTileset);
  });
  it.each([
    null,
    {},
    { ...fixtureTileset, version: 2 },
    { ...fixtureTileset, schema: { ...fixtureTileset.schema, version: "2" } },
    { ...fixtureTileset, format: "pmtiles" },
    { ...fixtureTileset, dataRevision: "" },
    { ...fixtureTileset, bounds: [-180, 20, 180, 10] },
    { ...fixtureTileset, maxZoom: 32 },
    { ...fixtureTileset, tileSize: 0 },
    { ...fixtureTileset, transport: { kind: "pmtiles", url: "/region.pmtiles" } },
    { ...fixtureTileset, transport: { kind: "xyz", urlTemplate: "javascript:{z}/{x}/{y}" } },
  ])("rejects malformed or incompatible source before activation", (input) => {
    expect(() => validateMapsTileset(input)).toThrow(/Maps Tileset/);
  });
});

it("validates the producer-facing documented manifest", async () => {
  const { default: manifest } = await import("../docs/fixtures/maps-tileset-v1.json");
  expect(validateMapsTileset(manifest).schema.sourceLayers).toEqual(["water_polygons", "land", "streets"]);
});
