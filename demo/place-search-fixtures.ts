import type { MapsPlaceSearchIndexRef } from "../src/maps-place-search";
import type { MapsTileset } from "../src/maps-tileset";

/**
 * Two tiny, hand-authored, source-pinned place-search fixtures (#281). They develop the
 * Maps reader without waiting for the asset-tooling #407 producer and make no geographic
 * claims. The Liechtenstein Atlas gets an index only from that producer.
 */
const fixtures = {
  "maps-showcase": {
    path: "search-indexes/maps-showcase-places-r1.json",
    sha256: "347c9b3f7e52bab813427e0e99444f6c97acce3668076b007d0a3fe1dd12ce3e",
    bytes: 2127,
    languages: ["en", "de", "ru", "ru-Latn"],
  },
  "fixture-pmtiles-xyz": {
    path: "search-indexes/fixture-pmtiles-xyz-places-r1.json",
    sha256: "6dda6aaddbba883b484d4a84206ed85851886f067c70892f918e57bc1c3563a9",
    bytes: 822,
    languages: ["en"],
  },
} as const;

export type PlaceSearchFixtureSource = keyof typeof fixtures;

export function createFixturePlaceSearchIndexRef(
  source: PlaceSearchFixtureSource,
  baseUrl: string,
): MapsPlaceSearchIndexRef {
  const fixture = fixtures[source];
  return {
    schema: "maps-place-search-v1",
    url: `${baseUrl}${fixture.path}`,
    sha256: fixture.sha256,
    bytes: fixture.bytes,
    languages: fixture.languages,
    bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
    license: "CC0-1.0",
    provenance: "Hand-authored synthetic Maps #281 fixture; illustrative names only",
  };
}

/** Attach the pinned fixture index to its exact synthetic tileset revision. */
export function withFixturePlaceSearch(tileset: MapsTileset, baseUrl: string): MapsTileset {
  if (tileset.dataRevision !== "1" || !(tileset.sourceId in fixtures)) return tileset;
  return {
    ...tileset,
    searchIndex: createFixturePlaceSearchIndexRef(
      tileset.sourceId as PlaceSearchFixtureSource,
      baseUrl,
    ),
  };
}
