// Test-only writers for tiny PMTiles v3 archives and MVT payloads. They follow the two
// specifications directly and share no code with the readers under test, so a test states
// its expected result by construction.
import { zxyToTileId } from "pmtiles";

const varint = (value: number): number[] => {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
  return out;
};
const field = (number: number, payload: number[]) => [
  (number << 3) | 2,
  ...varint(payload.length),
  ...payload,
];
const text = (value: string) => [...new TextEncoder().encode(value)];

/** MoveTo(10,10) LineTo(+20,+0): one two-point line in tile units. */
export const LINE_COMMANDS = [9, 20, 20, 10, 40, 0];

export function mvtFeature(
  type: 1 | 2 | 3,
  commands: number[],
  tags: number[] = [],
  id?: number,
): number[] {
  return [
    ...(id === undefined ? [] : [0x08, ...varint(id)]),
    ...field(2, tags.flatMap(varint)),
    0x18,
    type,
    ...field(4, commands.flatMap(varint)),
  ];
}

/** Command integers for absolute paths; `closed` appends ClosePath to each (polygon rings). */
export function pathCommands(paths: [number, number][][], closed = false): number[] {
  const zigzag = (value: number) => ((value << 1) ^ (value >> 31)) >>> 0;
  const commands: number[] = [];
  let cursor: [number, number] = [0, 0];
  for (const points of paths) {
    points.forEach((point, index) => {
      if (index === 0) commands.push(9);
      if (index === 1) commands.push(((points.length - 1) << 3) | 2);
      commands.push(zigzag(point[0] - cursor[0]), zigzag(point[1] - cursor[1]));
      cursor = point;
    });
    if (closed) commands.push(15);
  }
  return commands;
}

export function mvtLayer(
  name: string,
  features: number[][] = [mvtFeature(2, LINE_COMMANDS)],
  keys: string[] = [],
  values: string[] = [],
  extent = 4096,
): number[] {
  return field(3, [
    ...field(1, text(name)),
    ...features.flatMap((feature) => field(2, feature)),
    ...keys.flatMap((key) => field(3, text(key))),
    ...values.flatMap((value) => field(4, field(1, text(value)))),
    0x28, // extent
    ...varint(extent),
    0x78, // version = 2
    2,
  ]);
}

export function mvtTile(...layers: number[][]): Uint8Array {
  return Uint8Array.from(layers.flat());
}

export type TestTile = { z: number; x: number; y: number; data: Uint8Array };

/** An uncompressed, single-directory PMTiles v3 archive. `header` overrides declared values. */
export function buildArchive(options: {
  tiles: TestTile[];
  layers: string[];
  minZoom: number;
  maxZoom: number;
  bounds?: [number, number, number, number];
  fields?: Record<string, Record<string, string>>;
  header?: { addressedTiles?: number; tileEntries?: number };
}): Uint8Array {
  const tiles = options.tiles
    .map((tile) => ({ id: zxyToTileId(tile.z, tile.x, tile.y), data: tile.data }))
    .sort((a, b) => a.id - b.id);
  const offsets: number[] = [];
  let dataLength = 0;
  for (const tile of tiles) {
    offsets.push(dataLength);
    dataLength += tile.data.length;
  }
  const directory = [
    ...varint(tiles.length),
    ...tiles.flatMap((tile, index) => varint(tile.id - (index ? tiles[index - 1]!.id : 0))),
    ...tiles.flatMap(() => varint(1)),
    ...tiles.flatMap((tile) => varint(tile.data.length)),
    ...offsets.flatMap((offset) => varint(offset + 1)),
  ];
  const metadata = text(
    JSON.stringify({
      name: "Tileset QA test archive",
      format: "pbf",
      vector_layers: options.layers.map((id) => ({ id, fields: options.fields?.[id] ?? {} })),
    }),
  );
  const rootOffset = 127;
  const metadataOffset = rootOffset + directory.length;
  const dataOffset = metadataOffset + metadata.length;
  const archive = new Uint8Array(dataOffset + dataLength);
  const view = new DataView(archive.buffer);
  archive.set(text("PMTiles"), 0);
  archive[7] = 3;
  const u64 = (position: number, value: number) => view.setBigUint64(position, BigInt(value), true);
  u64(8, rootOffset);
  u64(16, directory.length);
  u64(24, metadataOffset);
  u64(32, metadata.length);
  u64(40, dataOffset);
  u64(48, 0);
  u64(56, dataOffset);
  u64(64, dataLength);
  u64(72, options.header?.addressedTiles ?? tiles.length);
  u64(80, options.header?.tileEntries ?? tiles.length);
  u64(88, tiles.length);
  archive[96] = 1; // clustered
  archive[97] = 1; // internal compression: none
  archive[98] = 1; // tile compression: none
  archive[99] = 1; // tile type: MVT
  archive[100] = options.minZoom;
  archive[101] = options.maxZoom;
  const [west, south, east, north] = options.bounds ?? [-180, -85.0511288, 180, 85.0511288];
  view.setInt32(102, Math.round(west * 1e7), true);
  view.setInt32(106, Math.round(south * 1e7), true);
  view.setInt32(110, Math.round(east * 1e7), true);
  view.setInt32(114, Math.round(north * 1e7), true);
  archive.set(directory, rootOffset);
  archive.set(metadata, metadataOffset);
  tiles.forEach((tile, index) => archive.set(tile.data, dataOffset + offsets[index]!));
  return archive;
}
