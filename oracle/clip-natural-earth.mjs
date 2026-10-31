/**
 * Regenerates `oracle/data/alpine-foreland.json`: a small, public-domain Natural Earth 1:10m
 * extract around Lake Constance and the northern Alps, used for the oracle's vector tiles,
 * line and symbol scenarios. Run once with a directory of Natural Earth GeoJSON files
 * (https://github.com/nvkelso/natural-earth-vector/tree/master/geojson):
 *
 *   node oracle/clip-natural-earth.mjs ~/natural-earth-vector/geojson
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BBOX = [7.4, 46.2, 10.8, 48.1];
const [source] = process.argv.slice(2);
if (!source) throw new Error("usage: node oracle/clip-natural-earth.mjs <natural-earth geojson dir>");

const read = (name) => JSON.parse(readFileSync(path.join(source, `${name}.geojson`), "utf8"));
const round = (value) => Math.round(value * 1e4) / 1e4;
const roundCoords = (coords) => (typeof coords[0] === "number" ? coords.map(round) : coords.map(roundCoords));
const flat = (coords) => (typeof coords[0] === "number" ? [coords] : coords.flatMap(flat));
const intersects = (geometry) => {
  const points = flat(geometry.coordinates);
  const lons = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  return (
    Math.min(...lons) <= BBOX[2] &&
    Math.max(...lons) >= BBOX[0] &&
    Math.min(...lats) <= BBOX[3] &&
    Math.max(...lats) >= BBOX[1]
  );
};
/** Latin-1 only, so the committed 0-255 glyph range covers every label. */
const latin1 = (text) => String(text ?? "").normalize("NFC").replace(/[^ -ÿ]/g, "");

function pick(name, layer, properties) {
  return read(name)
    .features.filter((feature) => feature.geometry && intersects(feature.geometry))
    .map((feature) => ({
      geometry: { coordinates: roundCoords(feature.geometry.coordinates), type: feature.geometry.type },
      properties: { layer, ...properties(feature.properties) },
      type: "Feature",
    }));
}

const features = [
  ...pick("ne_10m_glaciated_areas", "water_polygons", () => ({ kind: "glacier" })),
  ...pick("ne_10m_lakes", "water_polygons", (p) => ({ kind: "lake", name: latin1(p.name) })),
  ...pick("ne_10m_rivers_lake_centerlines", "water_lines", (p) => ({
    kind: "river",
    name: latin1(p.name),
    rank: Number(p.scalerank),
  })),
  ...pick("ne_10m_roads", "streets", (p) => ({ kind: p.type === "Major Highway" ? "motorway" : p.type === "Secondary Highway" ? "primary" : "secondary", rank: Number(p.scalerank) })),
  ...pick("ne_10m_admin_0_boundary_lines_land", "boundaries", (p) => ({ admin_level: 2, name: latin1(p.name) })),
  ...pick("ne_10m_populated_places_simple", "places", (p) => ({
    kind: p.featurecla === "Admin-0 capital" ? "capital" : "city",
    name: latin1(p.name),
    population: Number(p.pop_max),
    rank: Number(p.scalerank),
  })).filter((feature) => feature.properties.rank <= 8),
];

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "data/alpine-foreland.json");
writeFileSync(
  out,
  `${JSON.stringify({
    bbox: BBOX,
    features,
    license: "Public domain (Natural Earth, https://www.naturalearthdata.com/about/terms-of-use/)",
    type: "FeatureCollection",
  })}\n`,
);
console.log(`${features.length} features -> ${path.relative(process.cwd(), out)}`);
