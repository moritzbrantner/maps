/** Synthetic CC0 tiles for Tile seam QA (#276, part 3): one seeded world (`fixture-seams`,
 *  z0–z1) cut into tiles twice. `scripts/create-pmtiles-fixture.mjs` writes them into
 *  `public/tilesets/fixture-seams-{clean,defects}.pmtiles`. Not geographic data.
 *
 *  The world, in z0 tile units (extent 4096, y down), from a seeded generator:
 *  - `streets`: "Seam Avenue" crosses the z1 meridian edge in the north, "Meridian Street"
 *    crosses the z1 equator edge in the west, "Ring Road" spans the world in the south and
 *    meets itself across the antimeridian (one vertex lies exactly on the z1 meridian edge);
 *  - `water_polygons`: a lake with an island hole, both centred on the z1 tile corner, so
 *    ring and hole cross both inner z1 edges;
 *  - `land`: the whole world.
 *
 *  Each tile clips the world to its extent plus a buffer and rounds to integer tile units.
 *  - **clean**: a 64-unit buffer. Seam Avenue in 1/1/0 is drawn 1.5 units lower, a
 *    simplification drift within the tolerance. Every seam continues.
 *  - **defects**: clipped exactly at the tile edge, with these deliberate seams:
 *    1. Seam Avenue is missing from 1/1/0: interrupted at 1/0/0 → 1/1/0;
 *    2. Meridian Street is drawn twice in 1/0/1: duplicated at 1/0/0 ↓ 1/0/1;
 *    3. Ring Road is drawn 24 units lower in 1/1/1: displaced at 1/0/1 → 1/1/1 and across
 *       the antimeridian at 1/1/1 → 1/0/1;
 *    4. the island is 20 % larger in 1/1/1: the lake's edge coverage disagrees at
 *       1/0/1 → 1/1/1 and 1/1/0 ↓ 1/1/1.
 */
import { encodeTile } from "./tileset-revision-fixture.mjs";

export const SEAM_FIXTURE_TILES = ["0/0/0", "1/0/0", "1/0/1", "1/1/0", "1/1/1"];
const CORNER = [2048, 2048];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world() {
  const random = mulberry32(276);
  const jitter = (amount) => (random() * 2 - 1) * amount;
  const seamAvenue = Array.from({ length: 12 }, (_, index) => {
    const x = 200 + (index * 3700) / 11;
    return [x, 700 + ((x - 200) * 700) / 3700 + jitter(60)];
  });
  const meridianStreet = Array.from({ length: 12 }, (_, index) => {
    const y = 300 + (index * 3500) / 11;
    return [1200 + ((y - 300) * 300) / 3500 + jitter(60), y];
  });
  // Endpoints on the world's edges at the same row, so the road meets itself.
  const ringRoad = Array.from({ length: 17 }, (_, index) => [
    index * 256,
    index === 0 || index === 16 ? 3000 : 3000 + jitter(40),
  ]);
  // Half-step angles keep vertices off the edges through the centre. Exterior rings have
  // positive area in tile coordinates (y down), holes negative, as MVT requires.
  const ring = (radius, count, amount, scale = 1) =>
    Array.from({ length: count }, (_, index) => {
      const angle = ((index + 0.5) * 2 * Math.PI) / count;
      const r = (radius + jitter(amount)) * scale;
      return [CORNER[0] + r * Math.cos(angle), CORNER[1] + r * Math.sin(angle)];
    });
  const lake = ring(520, 16, 60);
  const island = ring(200, 12, 30).reverse();
  return { seamAvenue, meridianStreet, ringRoad, lake, island };
}

/** Liang–Barsky: the part of segment a–b inside [min, max]², or null. */
function clipSegment(a, b, min, max) {
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (const [p, q] of [
    [-d[0], a[0] - min],
    [d[0], max - a[0]],
    [-d[1], a[1] - min],
    [d[1], max - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  // Unclipped ends stay the original points, so consecutive segments join exactly.
  return [
    t0 === 0 ? a : [a[0] + t0 * d[0], a[1] + t0 * d[1]],
    t1 === 1 ? b : [a[0] + t1 * d[0], a[1] + t1 * d[1]],
  ];
}

/** A polyline clipped to [min, max]²: one path per run inside the window. */
function clipLine(points, min, max) {
  const paths = [];
  let current = null;
  for (let index = 1; index < points.length; index += 1) {
    const clipped = clipSegment(points[index - 1], points[index], min, max);
    if (!clipped) {
      current = null;
      continue;
    }
    if (current?.[current.length - 1] !== clipped[0]) {
      current = [clipped[0]];
      paths.push(current);
    }
    current.push(clipped[1]);
  }
  return paths;
}

/** Sutherland–Hodgman against the square [min, max]². */
function clipRing(points, min, max) {
  let output = points;
  for (const [axis, bound, keep] of [
    [0, min, (value) => value >= min],
    [0, max, (value) => value <= max],
    [1, min, (value) => value >= min],
    [1, max, (value) => value <= max],
  ]) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const inside = keep(current[axis]);
      if (inside !== keep(previous[axis])) {
        const t = (bound - previous[axis]) / (current[axis] - previous[axis]);
        output.push([
          previous[0] + t * (current[0] - previous[0]),
          previous[1] + t * (current[1] - previous[1]),
        ]);
      }
      if (inside) output.push(current);
    }
    if (!output.length) return [];
  }
  return output;
}

function rounded(points) {
  const out = [];
  for (const [x, y] of points) {
    const point = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out;
}

export function createSeamFixtureTiles(variant) {
  if (variant !== "clean" && variant !== "defects") throw new Error(`unknown variant ${variant}`);
  const shapes = world();
  const buffer = variant === "clean" ? 64 : 0;
  const [min, max] = [-buffer, 4096 + buffer];
  return SEAM_FIXTURE_TILES.map((key) => {
    const [z, x, y] = key.split("/").map(Number);
    const local = ([wx, wy], dy = 0) => [wx * 2 ** z - x * 4096, wy * 2 ** z - y * 4096 + dy];
    const line = (points, dy = 0) =>
      clipLine(
        points.map((point) => local(point, dy)),
        min,
        max,
      )
        .map(rounded)
        .filter((path) => path.length >= 2);
    const polygon = (rings) => {
      const clipped = rings.map((ring) =>
        rounded(
          clipRing(
            ring.map((p) => local(p)),
            min,
            max,
          ),
        ),
      );
      if (clipped[0].length < 3) return [];
      return [clipped[0], ...clipped.slice(1).filter((ring) => ring.length >= 3)];
    };
    const streets = [];
    const road = (name, kind, paths) => {
      for (const path of paths)
        streets.push({ type: 2, paths: [path], properties: { kind, name } });
    };
    if (!(variant === "defects" && key === "1/1/0")) {
      road(
        "Seam Avenue",
        "primary",
        line(shapes.seamAvenue, variant === "clean" && key === "1/1/0" ? 1.5 : 0),
      );
    }
    const meridian = line(shapes.meridianStreet);
    road("Meridian Street", "secondary", meridian);
    if (variant === "defects" && key === "1/0/1") road("Meridian Street", "secondary", meridian);
    road(
      "Ring Road",
      "primary",
      line(shapes.ringRoad, variant === "defects" && key === "1/1/1" ? 24 : 0),
    );
    const island =
      variant === "defects" && key === "1/1/1"
        ? shapes.island.map(([px, py]) => [
            CORNER[0] + (px - CORNER[0]) * 1.2,
            CORNER[1] + (py - CORNER[1]) * 1.2,
          ])
        : shapes.island;
    const lake = polygon([shapes.lake, island]);
    const land = polygon([
      [
        [0, 0],
        [4096, 0],
        [4096, 4096],
        [0, 4096],
      ],
    ]);
    return {
      z,
      x,
      y,
      data: encodeTile([
        [
          "water_polygons",
          lake.length ? [{ type: 3, paths: lake, properties: { kind: "water" } }] : [],
        ],
        ["land", land.length ? [{ type: 3, paths: land, properties: { kind: "forest" } }] : []],
        ["streets", streets],
      ]),
    };
  });
}
