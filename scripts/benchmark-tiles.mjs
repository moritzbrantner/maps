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

/** Vite plugin serving cacheable deterministic 256px PNG tiles at /__bench_tiles/{z}/{x}/{y}.png. */
export const benchmarkTilePlugin = {
  name: "maps-benchmark-tiles",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const match = /^\/__bench_tiles\/(\d+)\/(-?\d+)\/(-?\d+)\.png/.exec(request.url ?? "");
      if (!match) return next();
      response.setHeader("Content-Type", "image/png");
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.end(pngTile(Number(match[1]), Number(match[2]), Number(match[3])));
    });
  },
};
