import type { ShortbreadBasemapLineKind, ShortbreadBasemapPolygonKind } from "./vector-tile-wasm";

export type TilePixel = { x: number; y: number };
export type ShortbreadTilePixels = {
  lines: Array<{ kind: ShortbreadBasemapLineKind; coordinates: TilePixel[] }>;
  polygons: Array<{
    kind: ShortbreadBasemapPolygonKind;
    sourceKind: string | null;
    rings: TilePixel[][];
  }>;
};
