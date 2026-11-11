/** Synthetic CC0 tiles of two revisions of one source (`fixture-revision`, z0–z1), for
 *  Tileset revision diff QA (#276). `scripts/create-pmtiles-fixture.mjs` writes them into
 *  `public/tilesets/fixture-revision-r{1,2}.pmtiles`. Not geographic data.
 *
 *  The differences are deliberate and stated here, so a test can expect them by construction:
 *  - every tile carries a full-tile `land` polygon and a `water_polygons` polygon with an
 *    island hole; no feature has an MVT ID (as with Shortbread producers);
 *  - northern tiles (0/0/0, 1/0/0, 1/1/0) carry "Alpha Road" in r1 and "Gamma Road" in r2;
 *  - southern tiles (0/0/0, 1/0/1, 1/1/1) carry "Beta Road" in both revisions;
 *  - the island hole of 1/1/0 is wider in r2;
 *  - r2 has no tile 1/1/1, so its declared coverage loses that tile;
 *  - 1/0/1 is byte-identical in both revisions.
 */

export const REVISION_FIXTURE_TILES = ["0/0/0", "1/0/0", "1/0/1", "1/1/0", "1/1/1"];

/** World-space road rows at z0 (tile units of a 4096 extent). */
const ROADS = {
  alpha: { name: "Alpha Road", y: 1000 },
  gamma: { name: "Gamma Road", y: 600 },
  beta: { name: "Beta Road", y: 2600 },
};

export function createRevisionFixtureTiles(revision) {
  if (revision !== "r1" && revision !== "r2") throw new Error(`unknown revision ${revision}`);
  const tiles = [];
  for (const key of REVISION_FIXTURE_TILES) {
    if (revision === "r2" && key === "1/1/1") continue;
    const [z, x, y] = key.split("/").map(Number);
    const northern = revision === "r1" ? ROADS.alpha : ROADS.gamma;
    const streets = [northern, ROADS.beta]
      .map((road) => ({ ...road, y: z === 0 ? road.y : road.y * 2 - y * 4096 }))
      .filter((road) => road.y >= 0 && road.y <= 4096)
      .map((road) => ({
        type: 2,
        paths: [
          [
            [0, road.y],
            [4096, road.y],
          ],
        ],
        properties: { kind: "primary", name: road.name },
      }));
    const holeWest = revision === "r2" && key === "1/1/0" ? 700 : 1024;
    tiles.push({
      z,
      x,
      y,
      data: encodeTile([
        [
          "water_polygons",
          [
            {
              type: 3,
              paths: [square(0, 4096), hole(holeWest)],
              properties: { kind: "water" },
            },
          ],
        ],
        [
          "land",
          [
            {
              type: 3,
              paths: [square(0, 4096)],
              properties: { kind: "forest" },
            },
          ],
        ],
        ["streets", streets],
      ]),
    });
  }
  return tiles;
}

function square(min, max) {
  return [
    [min, min],
    [max, min],
    [max, max],
    [min, max],
  ];
}

/** Interior ring: negative area in tile coordinates (y down), as MVT requires. */
function hole(west) {
  return [
    [west, 1024],
    [west, 3072],
    [3072, 3072],
    [3072, 1024],
  ];
}

function encodeTile(layers) {
  return Buffer.concat(layers.map(([name, features]) => bytes(3, encodeLayer(name, features))));
}

function encodeLayer(name, features) {
  const keys = [];
  const values = [];
  const index = (list, value) => {
    const found = list.indexOf(value);
    return found === -1 ? list.push(value) - 1 : found;
  };
  const encoded = features.map((feature) => {
    const tags = Object.entries(feature.properties).flatMap(([key, value]) => [
      index(keys, key),
      index(values, value),
    ]);
    return Buffer.concat([
      bytes(2, Buffer.concat(tags.map(varint))),
      number(3, feature.type),
      bytes(4, geometry(feature.paths, feature.type === 3)),
    ]);
  });
  return Buffer.concat([
    bytes(1, Buffer.from(name)),
    ...encoded.map((feature) => bytes(2, feature)),
    ...keys.map((key) => bytes(3, Buffer.from(key))),
    ...values.map((value) => bytes(4, bytes(1, Buffer.from(value)))),
    number(5, 4096),
    number(15, 2),
  ]);
}

function geometry(paths, closed) {
  const cursor = [0, 0];
  const commands = [];
  for (const points of paths) {
    points.forEach((point, index) => {
      if (index === 0) commands.push(9);
      if (index === 1) commands.push(((points.length - 1) << 3) | 2);
      commands.push(zigzag(point[0] - cursor[0]), zigzag(point[1] - cursor[1]));
      cursor[0] = point[0];
      cursor[1] = point[1];
    });
    if (closed) commands.push(15);
  }
  return Buffer.concat(commands.map(varint));
}

function number(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}
function bytes(field, value) {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}
function zigzag(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}
function varint(value) {
  const result = [];
  let remaining = value >>> 0;
  while (remaining > 127) {
    result.push((remaining & 127) | 128);
    remaining >>>= 7;
  }
  result.push(remaining);
  return Buffer.from(result);
}
