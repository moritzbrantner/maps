import { getShortbreadBasemapStyle, POLYGON_PAINT_ORDER } from "./shortbread-style";
import type { ShortbreadTilePixels, TilePixel } from "./shortbread-tile-pixels";
import type { MapsVectorBasemapStyle } from "./maps-tileset-style";
import { resolveTilesetClassStyle } from "./maps-tileset-style";

const SIZE = 512;
export function paintShortbreadTile(
  tile: ShortbreadTilePixels,
  overrides?: MapsVectorBasemapStyle,
): ImageBitmap {
  const polygonStyle = (
    kind: "ocean" | "land" | "site" | "water" | "building",
    sourceKind: string | null,
  ) => {
    const base = getShortbreadBasemapStyle(kind, sourceKind);
    let styleClass: import("./vector-basemap").MapsVectorBasemapStyleClass = kind;
    if (kind === "land" && sourceKind === "forest") {
      styleClass = "land-forest";
    } else if (kind === "water" && sourceKind === "glacier") {
      styleClass = "water-glacier";
    }
    const style = resolveTilesetClassStyle(styleClass, overrides);
    const outline = resolveTilesetClassStyle("building-outline", overrides);
    return {
      ...base,
      polygonFillColor: style.color,
      polygonFillOpacity: style.opacity,
      ...(kind === "building"
        ? { polygonStrokeColor: outline.color, polygonStrokeWidth: outline.width }
        : {}),
    };
  };
  const lineStyle = (kind: "coast" | "water" | "street" | "boundary") => {
    const style = resolveTilesetClassStyle(kind === "water" ? "water-line" : kind, overrides);
    return { lineColor: style.color, lineOpacity: style.opacity, lineWidth: style.width };
  };
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Shortbread tile Canvas context is unavailable.");
  }
  context.fillStyle = "#f9f4ee";
  context.fillRect(0, 0, SIZE, SIZE);
  const path = (points: readonly TilePixel[]) => {
    if (!points.length) {
      return;
    }
    context.moveTo(points[0]!.x, points[0]!.y);
    for (let index = 1; index < points.length; index++) {
      const point = points[index]!;
      context.lineTo(point.x, point.y);
    }
  };
  for (const kind of POLYGON_PAINT_ORDER) {
    for (const polygon of tile.polygons) {
      if (polygon.kind !== kind) {
        continue;
      }
      const style = polygonStyle(kind, polygon.sourceKind);
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
    const style = lineStyle(line.kind);
    context.beginPath();
    path(line.coordinates);
    context.strokeStyle = style.lineColor!;
    context.globalAlpha = style.lineOpacity ?? 1;
    context.lineWidth = ((style.lineWidth ?? 1) * SIZE) / 256;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
  }
  return canvas.transferToImageBitmap();
}
