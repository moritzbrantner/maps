/**
 * Deterministic raster tiles for the oracle, generated in Node and served through request
 * interception, so both runtimes sample identical, network-free pixels.
 *
 * - `geographic`: a smooth pattern of the tile pixel's Web Mercator position. It looks the
 *   same at every tile zoom, so it shows misplacement without punishing level choice.
 * - `zoom-tinted`: the same pattern tinted per tile zoom, so the chosen level and the
 *   parent/child crossfade end state are visible (#303).
 */
import { crc32, deflateSync } from "node:zlib";

export const TILE_SIZE = 256;

const cache = new Map<string, Buffer>();

const TINTS: Array<[number, number, number]> = [
  [1, 0.86, 0.86],
  [0.86, 1, 0.86],
  [0.86, 0.86, 1],
  [1, 1, 0.82],
];

export function tilePng(pattern: string, z: number, x: number, y: number): Buffer {
  const key = `${pattern}/${z}/${x}/${y}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const tint = pattern === "zoom-tinted" ? TINTS[z % TINTS.length]! : ([1, 1, 1] as const);
  const rows = Buffer.alloc((TILE_SIZE * 3 + 1) * TILE_SIZE);
  const scale = 2 ** z * TILE_SIZE;
  for (let row = 0; row < TILE_SIZE; row++) {
    const offset = row * (TILE_SIZE * 3 + 1);
    rows[offset] = 0;
    const v = (y * TILE_SIZE + row + 0.5) / scale;
    for (let column = 0; column < TILE_SIZE; column++) {
      const u = (x * TILE_SIZE + column + 0.5) / scale;
      const wave = (period: number, value: number) => Math.sin(2 * Math.PI * value * period);
      const r = 196 + 22 * wave(8, u) + 14 * wave(256, u + v);
      const g = 210 + 18 * wave(8, v) + 14 * wave(256, u - v);
      const b = 204 + 16 * wave(4, u + v) + 10 * wave(128, v);
      const pixel = offset + 1 + column * 3;
      rows[pixel] = Math.round(r * tint[0]);
      rows[pixel + 1] = Math.round(g * tint[1]);
      rows[pixel + 2] = Math.round(b * tint[2]);
    }
  }
  const png = encodePng(TILE_SIZE, TILE_SIZE, rows);
  cache.set(key, png);
  return png;
}

/**
 * Terrarium-encoded elevation (`height = R·256 + G + B/256 − 32768` m) of a smooth analytic
 * massif, for the `hillshade-terrain` reference (#324).
 */
export function demPng(z: number, x: number, y: number): Buffer {
  const key = `dem/${z}/${x}/${y}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const rows = Buffer.alloc((TILE_SIZE * 3 + 1) * TILE_SIZE);
  const scale = 2 ** z * TILE_SIZE;
  for (let row = 0; row < TILE_SIZE; row++) {
    const offset = row * (TILE_SIZE * 3 + 1);
    const v = (y * TILE_SIZE + row + 0.5) / scale;
    for (let column = 0; column < TILE_SIZE; column++) {
      const u = (x * TILE_SIZE + column + 0.5) / scale;
      const ridge = Math.sin(2 * Math.PI * u * 420) * Math.cos(2 * Math.PI * v * 330);
      const valley = Math.sin(2 * Math.PI * (u + v) * 1500);
      const height = 1800 + 1200 * ridge + 250 * valley + 32768;
      const pixel = offset + 1 + column * 3;
      rows[pixel] = Math.floor(height / 256);
      rows[pixel + 1] = Math.floor(height) % 256;
      rows[pixel + 2] = Math.floor((height % 1) * 256);
    }
  }
  const png = encodePng(TILE_SIZE, TILE_SIZE, rows);
  cache.set(key, png);
  return png;
}

/** A one-pattern sprite (16 px diagonal hatch) for the `fill-pattern` reference (#323). */
export const SPRITE_JSON = { hatch: { height: 16, pixelRatio: 1, width: 16, x: 0, y: 0 } };

export function spritePng(): Buffer {
  const size = 16;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    const offset = row * (size * 4 + 1);
    for (let column = 0; column < size; column++) {
      const line = (row + column) % 8 < 2;
      const pixel = offset + 1 + column * 4;
      rows.set(line ? [37, 99, 235, 255] : [255, 255, 255, 0], pixel);
    }
  }
  return encodePng(size, size, rows, 6);
}

function encodePng(width: number, height: number, filteredRows: Buffer, colorType = 2) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = colorType; // 2 RGB, 6 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filteredRows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
