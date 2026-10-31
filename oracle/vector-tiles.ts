/**
 * Shortbread-shaped MVT tiles for the oracle, cut on demand from the public-domain Natural
 * Earth extract `oracle/data/alpine-foreland.json` with off-the-shelf `geojson-vt` and
 * encoded with `vt-pbf`. Both runtimes read the same bytes through request interception.
 *
 * Source layers, in paint order: `land` (one polygon around the extract), `water_polygons`
 * (lakes, `kind: glacier` for glaciated areas), `water_lines`, `streets`, `boundaries`, and
 * `places` (points for symbol layers; the Maps Shortbread decoder ignores it).
 */
import { readFileSync } from "node:fs";

import GeoJSONVT from "geojson-vt";
import vtpbf from "vt-pbf";

import { LAND_BOUNDS, VECTOR_MAX_ZOOM } from "./vector-constants.ts";

const VECTOR_LAYERS = [
  "land",
  "water_polygons",
  "water_lines",
  "streets",
  "boundaries",
  "places",
] as const;

type Feature = { type: "Feature"; geometry: unknown; properties: Record<string, unknown> };

const data = JSON.parse(
  readFileSync(new URL("./data/alpine-foreland.json", import.meta.url), "utf8"),
) as { features: Feature[] };

const [west, south, east, north] = LAND_BOUNDS;
const byLayer: Record<string, Feature[]> = {
  land: [
    {
      geometry: {
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        type: "Polygon",
      },
      properties: {},
      type: "Feature",
    },
  ],
};
for (const feature of data.features) {
  const { layer, ...properties } = feature.properties;
  (byLayer[String(layer)] ??= []).push({ ...feature, properties });
}

const indexes = VECTOR_LAYERS.map(
  (layer) =>
    [
      layer,
      new GeoJSONVT(
        { features: byLayer[layer] ?? [], type: "FeatureCollection" } as GeoJSON.FeatureCollection,
        { buffer: 64, extent: 4096, indexMaxZoom: 6, maxZoom: VECTOR_MAX_ZOOM, tolerance: 2 },
      ),
    ] as const,
);
const cache = new Map<string, Buffer>();
const EMPTY = { features: [] };

export function vectorTile(z: number, x: number, y: number): Buffer {
  const key = `${z}/${x}/${y}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const layers: Record<string, unknown> = {};
  for (const [layer, index] of indexes) layers[layer] = index.getTile(z, x, y) ?? EMPTY;
  const bytes = Buffer.from(vtpbf.fromGeojsonVt(layers, { extent: 4096, version: 2 }));
  cache.set(key, bytes);
  return bytes;
}
