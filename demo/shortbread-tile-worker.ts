import { importMapsWasmModule, type MapsWasmModuleBase } from "../src/aggregation-wasm";
import { getShortbreadBasemapStyle, POLYGON_PAINT_ORDER } from "./shortbread-style";
import type {
  ShortbreadTilePixels,
  TilePaintRequest,
  TilePaintResult,
  TilePixel,
} from "./shortbread-tile-protocol";

type TileModule = MapsWasmModuleBase & {
  decodeShortbreadTilePixels(bytes: Uint8Array, size: number): ShortbreadTilePixels;
};

// Two physical pixels per tile CSS pixel also cover fractional zoom magnification.
const SIZE = 512;
self.addEventListener("message", (event: MessageEvent<TilePaintRequest>) => {
  void paint(event.data);
});

async function paint({ id, bytes, wasmPackage }: TilePaintRequest) {
  try {
    const wasm = await importMapsWasmModule<TileModule>(wasmPackage);
    const tile = wasm.decodeShortbreadTilePixels(new Uint8Array(bytes), SIZE);
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Shortbread tile Canvas context is unavailable.");
    context.fillStyle = "#f9f4ee";
    context.fillRect(0, 0, SIZE, SIZE);
    const path = (points: readonly TilePixel[]) => {
      if (!points.length) return;
      context.moveTo(points[0]!.x, points[0]!.y);
      for (let index = 1; index < points.length; index++) {
        const point = points[index]!;
        context.lineTo(point.x, point.y);
      }
    };
    for (const kind of POLYGON_PAINT_ORDER) {
      for (const polygon of tile.polygons) {
        if (polygon.kind !== kind) continue;
        const style = getShortbreadBasemapStyle(kind, polygon.sourceKind);
        context.beginPath();
        for (const ring of polygon.rings) {
          path(ring);
          context.closePath();
        }
        context.fillStyle = style.polygonFillColor!;
        context.globalAlpha = style.polygonFillOpacity ?? 1;
        context.fill("evenodd");
        if ((style.polygonStrokeWidth ?? 0) > 0) {
          context.strokeStyle = style.polygonStrokeColor!;
          context.lineWidth = (style.polygonStrokeWidth! * SIZE) / 256;
          context.globalAlpha = 1;
          context.stroke();
        }
      }
    }
    for (const line of tile.lines) {
      const style = getShortbreadBasemapStyle(line.kind);
      context.beginPath();
      path(line.coordinates);
      context.strokeStyle = style.lineColor!;
      context.globalAlpha = style.lineOpacity ?? 1;
      context.lineWidth = ((style.lineWidth ?? 1) * SIZE) / 256;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    }
    const image = canvas.transferToImageBitmap();
    self.postMessage({ id, image } satisfies TilePaintResult, { transfer: [image] });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies TilePaintResult);
  }
}
