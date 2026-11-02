// Deterministic vector-city-style-v1 tile: forest below water with an island hole,
// plus dense street geometry. No external tile service participates in verification.
export function createShortbreadTileFixture({
  dense = false,
  building = false,
  islandWest = 1024,
  islandEast = 3072,
  streetRows = 128,
  pointsPerStreet = 256,
  streetJitter = 0,
} = {}) {
  const water = polygon([
    [
      [0, 0],
      [4096, 0],
      [4096, 4096],
      [0, 4096],
    ],
    [
      [islandWest, 1024],
      [islandWest, 3072],
      [islandEast, 3072],
      [islandEast, 1024],
    ],
  ]);
  const land = polygon([
    [
      [0, 0],
      [4096, 0],
      [4096, 4096],
      [0, 4096],
    ],
  ]);
  const layers = [
    layer("water_polygons", [feature(3, water)]),
    layer("land", [feature(3, land, true)], true),
  ];
  if (building) {
    layers.push(
      layer("buildings", [
        feature(
          3,
          polygon([
            [
              [1536, 1536],
              [2560, 1536],
              [2560, 2560],
              [1536, 2560],
            ],
          ]),
        ),
      ]),
    );
  }
  if (dense) {
    const streets = [];
    for (let row = 0; row < streetRows; row++) {
      const points = Array.from({ length: pointsPerStreet }, (_, column) => {
        // Optional reproducible geometric variation for the real range-read fixture.
        const noise = (salt) => {
          let value = (row + 1) * 0x9e3779b1 + (column + 1) * 0x85ebca6b + salt;
          value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
          value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
          return (((value ^ (value >>> 16)) >>> 0) % (streetJitter * 2 + 1)) - streetJitter;
        };
        return [
          column * 16 + (streetJitter ? noise(17) : 0),
          16 + row * 31 + Math.round(Math.sin(column / 8) * 10) + (streetJitter ? noise(29) : 0),
        ];
      });
      streets.push(feature(2, path(points, false)));
    }
    layers.push(layer("streets", streets));
  }
  return Buffer.concat(layers.map((value) => bytes(3, value)));
}
function polygon(rings) {
  const cursor = [0, 0];
  return Buffer.concat(rings.map((ring) => path(ring, true, cursor)));
}
function path(points, closed, cursor = [0, 0]) {
  const commands = [];
  for (let index = 0; index < points.length; index++) {
    if (index === 0) commands.push(varint(9));
    if (index === 1) commands.push(varint(((points.length - 1) << 3) | 2));
    const point = points[index];
    commands.push(varint(zigzag(point[0] - cursor[0])), varint(zigzag(point[1] - cursor[1])));
    cursor[0] = point[0];
    cursor[1] = point[1];
  }
  if (closed) commands.push(varint(15));
  return Buffer.concat(commands);
}
function feature(type, geometry, tagged = false) {
  return Buffer.concat([
    ...(tagged ? [bytes(2, Buffer.from([0, 0]))] : []),
    number(3, type),
    bytes(4, geometry),
  ]);
}
function layer(name, features, forest = false) {
  return Buffer.concat([
    bytes(1, Buffer.from(name)),
    ...features.map((f) => bytes(2, f)),
    ...(forest ? [bytes(3, Buffer.from("kind")), bytes(4, bytes(1, Buffer.from("forest")))] : []),
    number(5, 4096),
    number(15, 2),
  ]);
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
