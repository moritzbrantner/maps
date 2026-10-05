// Deterministic raster tiles shared by the interaction benchmarks. Each tile has a
// coordinate-derived colour, a grid and a diagonal so seams/misplacement are visible.
import { crc32, deflateSync } from "node:zlib";

const tileCache = new Map();
export function pngTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  const size = 256;
  const hue = (x * 37 + y * 91 + z * 13) % 360;
  const [r, g, b] = hslToRgb(hue / 360, 0.35, 0.82);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let row = 0; row < size; row++) {
    const offset = row * (size * 3 + 1);
    raw[offset] = 0;
    for (let col = 0; col < size; col++) {
      const border = row === 0 || col === 0;
      const grid = row % 32 === 0 || col % 32 === 0;
      const diagonal = Math.abs(row - col) < 2;
      const shade = border ? 0.45 : grid || diagonal ? 0.85 : 1;
      const index = offset + 1 + col * 3;
      raw[index] = r * shade;
      raw[index + 1] = g * shade;
      raw[index + 2] = b * shade;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  tileCache.set(key, png);
  return png;
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

// ---------------------------------------------------------------------------
// Deterministic Shortbread-like vector tiles. Content is a pattern in *world*
// space (not per tile), so engines requesting different tile pyramids (MapLibre
// 512 px vector tiles, Maps 256 px placements) draw the same geometry per screen
// area: a forest land fill, lakes with islands, a building lattice and a street
// grid, densest around z12-z14 like an OSM city.

const EXTENT = 4096;
/** Buildings per z14 tile edge. */
const BUILDINGS_PER_Z14 = 10;
const STREET_EVERY = 5;
const LAKE_EVERY_Z14 = 3;
const VECTOR_MAX_ZOOM = 14;
const vectorCache = new Map();

export function vectorTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = vectorCache.get(key);
  if (cached) return cached;
  const scale = 2 ** z;
  // Tile-local integer coordinates of a world position.
  const local = (wx, wy) => [
    Math.round((wx * scale - x) * EXTENT),
    Math.round((wy * scale - y) * EXTENT),
  ];
  const west = x / scale;
  const north = y / scale;
  const size = 1 / scale;
  const step = 1 / (2 ** VECTOR_MAX_ZOOM * BUILDINGS_PER_Z14);
  const first = (origin) => Math.ceil(origin / step);
  const last = (origin) => Math.floor((origin + size) / step);
  // Low zooms would hold millions of lattice cells: thin them like a real generalizer.
  const stride = Math.max(1, 2 ** Math.max(0, 11 - z));

  const buildings = [];
  for (let row = first(north); row <= last(north); row += stride) {
    for (let column = first(west); column <= last(west); column += stride) {
      if ((row + column) % 7 === 0 || row % STREET_EVERY === 0 || column % STREET_EVERY === 0) {
        continue;
      }
      const cx = column * step;
      const cy = row * step;
      const half = step * 0.32;
      buildings.push({
        type: 3,
        geometry: polygonCommands([
          ring([
            local(cx - half, cy - half),
            local(cx + half, cy - half),
            local(cx + half, cy + half),
            local(cx - half, cy + half),
          ]),
        ]),
      });
    }
  }

  const streets = [];
  const alongStep = step * stride;
  for (let index = first(north); index <= last(north); index++) {
    if (index % (STREET_EVERY * stride) !== 0) continue;
    const points = [];
    for (let wx = west; wx <= west + size + alongStep / 2; wx += alongStep) {
      points.push(local(wx, index * step + Math.sin(wx * 9e4) * step * 0.1));
    }
    streets.push({ type: 2, geometry: lineCommands(points) });
  }
  for (let index = first(west); index <= last(west); index++) {
    if (index % (STREET_EVERY * stride) !== 0) continue;
    const points = [];
    for (let wy = north; wy <= north + size + alongStep / 2; wy += alongStep) {
      points.push(local(index * step + Math.sin(wy * 9e4) * step * 0.1, wy));
    }
    streets.push({ type: 2, geometry: lineCommands(points) });
  }

  const lakes = [];
  const lakeStep = (LAKE_EVERY_Z14 / 2 ** VECTOR_MAX_ZOOM) * Math.max(1, stride / 4);
  for (let row = Math.ceil(north / lakeStep); row * lakeStep < north + size; row++) {
    for (let column = Math.ceil(west / lakeStep); column * lakeStep < west + size; column++) {
      const cx = (column + 0.35) * lakeStep;
      const cy = (row + 0.6) * lakeStep;
      const radius = lakeStep * 0.22;
      const circle = (r, clockwise) =>
        ring(
          Array.from({ length: 48 }, (_, i) => {
            const angle = ((clockwise ? i : -i) / 48) * Math.PI * 2;
            return local(
              cx + Math.cos(angle) * r * (1 + 0.15 * Math.sin(angle * 5)),
              cy + Math.sin(angle) * r,
            );
          }),
        );
      lakes.push({
        type: 3,
        geometry: polygonCommands([circle(radius, true), circle(radius * 0.35, false)]),
      });
    }
  }

  const land = [
    {
      type: 3,
      geometry: polygonCommands([
        ring([
          [0, 0],
          [EXTENT, 0],
          [EXTENT, EXTENT],
          [0, EXTENT],
        ]),
      ]),
      kind: "forest",
    },
  ];
  const bytes = Buffer.concat([
    mvtLayer("land", land),
    mvtLayer("water_polygons", lakes),
    mvtLayer("buildings", buildings),
    mvtLayer("streets", streets),
  ]);
  vectorCache.set(key, bytes);
  return bytes;
}

/** Drops consecutive duplicates (rounding) and orients the ring MVT-clockwise when asked. */
function ring(points) {
  const unique = points.filter(
    (point, index) =>
      index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1],
  );
  return unique;
}

function polygonCommands(rings) {
  const commands = [];
  let cursor = [0, 0];
  for (const points of rings) {
    if (points.length < 3) continue;
    for (const [index, point] of points.entries()) {
      if (index === 0) commands.push(9);
      if (index === 1) commands.push(((points.length - 1) << 3) | 2);
      commands.push(zigzag(point[0] - cursor[0]), zigzag(point[1] - cursor[1]));
      cursor = point;
    }
    commands.push(15);
  }
  return commands;
}

function lineCommands(points) {
  const commands = [];
  let cursor = [0, 0];
  for (const [index, point] of points.entries()) {
    if (index === 0) commands.push(9);
    if (index === 1) commands.push(((points.length - 1) << 3) | 2);
    commands.push(zigzag(point[0] - cursor[0]), zigzag(point[1] - cursor[1]));
    cursor = point;
  }
  return commands;
}

function mvtLayer(name, features) {
  const kinds = [...new Set(features.flatMap((feature) => (feature.kind ? [feature.kind] : [])))];
  const encoded = features
    .filter((feature) => feature.geometry.length > 0)
    .map((feature) =>
      field(
        2,
        Buffer.concat([
          ...(feature.kind
            ? [field(2, Buffer.concat([varint(0), varint(kinds.indexOf(feature.kind))]))]
            : []),
          Buffer.concat([varint(3 << 3), varint(feature.type)]),
          field(4, Buffer.concat(feature.geometry.map(varint))),
        ]),
      ),
    );
  return field(
    3,
    Buffer.concat([
      field(1, Buffer.from(name)),
      ...encoded,
      ...(kinds.length > 0 ? [field(3, Buffer.from("kind"))] : []),
      ...kinds.map((kind) => field(4, field(1, Buffer.from(kind)))),
      Buffer.concat([varint(5 << 3), varint(EXTENT)]),
      Buffer.concat([varint(15 << 3), varint(2)]),
    ]),
  );
}

function field(number, value) {
  return Buffer.concat([varint((number << 3) | 2), varint(value.length), value]);
}

function zigzag(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function varint(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

/**
 * Vite plugin serving cacheable deterministic tiles: 256px PNG raster tiles at
 * /__bench_tiles/{z}/{x}/{y}.png and Shortbread-like MVT at /__bench_vector/{z}/{x}/{y}.mvt.
 */
export const benchmarkTilePlugin = {
  name: "maps-benchmark-tiles",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = request.url ?? "";
      const raster = /^\/__bench_tiles\/(\d+)\/(-?\d+)\/(-?\d+)\.png/.exec(url);
      const vector = /^\/__bench_vector\/(\d+)\/(\d+)\/(\d+)\.mvt/.exec(url);
      if (!raster && !vector) return next();
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (raster) {
        response.setHeader("Content-Type", "image/png");
        response.end(pngTile(Number(raster[1]), Number(raster[2]), Number(raster[3])));
        return;
      }
      response.setHeader("Content-Type", "application/vnd.mapbox-vector-tile");
      response.end(vectorTile(Number(vector[1]), Number(vector[2]), Number(vector[3])));
    });
  },
};
