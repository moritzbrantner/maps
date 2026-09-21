import { importMapsWasmModule, type MapsWasmModuleBase } from "./aggregation-wasm";

export type ShortbreadBasemapLineKind = "coast" | "water" | "street" | "boundary";

export type ShortbreadBasemapLine = {
  coordinates: Array<[longitude: number, latitude: number]>;
  kind: ShortbreadBasemapLineKind;
};

export type ShortbreadBasemapPolygonKind = "ocean" | "water" | "land" | "site" | "building";

export type ShortbreadBasemapPolygon = {
  kind: ShortbreadBasemapPolygonKind;
  sourceKind: string | null;
  rings: Array<Array<[longitude: number, latitude: number]>>;
};

export type ShortbreadBasemapTile = {
  lines: ShortbreadBasemapLine[];
  polygons: ShortbreadBasemapPolygon[];
};

type MapsVectorTileWasmModule = MapsWasmModuleBase & {
  decodeShortbreadBasemap?: (
    bytes: Uint8Array,
    z: number,
    x: number,
    y: number,
  ) => ShortbreadBasemapTile;
  decodeShortbreadBasemapLines?: (
    bytes: Uint8Array,
    z: number,
    x: number,
    y: number,
  ) => ShortbreadBasemapLine[];
};

export async function decodeShortbreadBasemap(
  bytes: ArrayBuffer,
  tile: { x: number; y: number; z: number },
  packageName?: string,
): Promise<ShortbreadBasemapTile> {
  const wasmModule = await importMapsWasmModule<MapsVectorTileWasmModule>(packageName);
  await wasmModule.default?.();
  const decode = wasmModule.decodeShortbreadBasemap;
  if (!decode) throw new Error("Maps WASM Shortbread polygon decoder is unavailable.");
  return decode(new Uint8Array(bytes), tile.z, tile.x, tile.y);
}

export async function decodeShortbreadBasemapLines(
  bytes: ArrayBuffer,
  tile: { x: number; y: number; z: number },
  packageName?: string,
): Promise<ShortbreadBasemapLine[]> {
  const wasmModule = await importMapsWasmModule<MapsVectorTileWasmModule>(packageName);
  await wasmModule.default?.();
  const decode = wasmModule.decodeShortbreadBasemapLines;

  if (!decode) {
    throw new Error("Maps WASM Shortbread decoder is unavailable.");
  }

  return decode(new Uint8Array(bytes), tile.z, tile.x, tile.y);
}
