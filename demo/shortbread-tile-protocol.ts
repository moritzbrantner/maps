import type {
  ShortbreadBasemapLineKind,
  ShortbreadBasemapPolygonKind,
} from "../src/vector-tile-wasm";

export type TilePixel = { x: number; y: number };
export type ShortbreadTilePixels = {
  lines: Array<{ kind: ShortbreadBasemapLineKind; coordinates: TilePixel[] }>;
  polygons: Array<{
    kind: ShortbreadBasemapPolygonKind;
    sourceKind: string | null;
    rings: TilePixel[][];
  }>;
};
export type TilePaintRequest = {
  id: number;
  bytes: ArrayBuffer;
  wasmPackage: string;
};
export type TilePaintResult = { id: number; image: ImageBitmap } | { id: number; error: string };
