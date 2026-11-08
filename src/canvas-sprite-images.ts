import type { CanvasMapPatternImage } from "./canvas-map-renderer";

/** A decoded style sprite: its JSON index and straight-alpha RGBA sheet (#323). */
export type CanvasSpriteSheet = {
  height: number;
  json: string;
  rgba: Uint8Array;
  width: number;
};

/** A sprite's images by id; `null` for an image it lacks. */
export type CanvasMapPatternImages = (id: string) => CanvasMapPatternImage | null;

type SpriteIndexEntry = {
  height: number;
  pixelRatio?: number;
  sdf?: boolean;
  width: number;
  x: number;
  y: number;
};

function isIndexEntry(value: unknown): value is SpriteIndexEntry {
  const entry = value as Partial<SpriteIndexEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    [entry.x, entry.y, entry.width, entry.height].every(
      (field) => typeof field === "number" && Number.isFinite(field),
    )
  );
}

function createImageCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * The style images of a sprite for the Canvas fallback's `fill-pattern` and `line-pattern`
 * (#350), cut from its sheet on first use. An id the sprite lacks, or whose rectangle lies
 * outside the sheet, is `null`, as a missing image draws nothing in MapLibre.
 */
export function createCanvasSpriteImages(
  sheet: CanvasSpriteSheet,
): CanvasMapPatternImages {
  const index = JSON.parse(sheet.json) as Record<string, unknown>;
  const images = new Map<string, CanvasMapPatternImage | null>();
  return (id) => {
    const cached = images.get(id);
    if (cached !== undefined) return cached;
    const image = cutImage(sheet, index[id]);
    images.set(id, image);
    return image;
  };
}

function cutImage(sheet: CanvasSpriteSheet, entry: unknown): CanvasMapPatternImage | null {
  if (!isIndexEntry(entry)) return null;
  const { height, width, x, y } = entry;
  if (width <= 0 || height <= 0 || x < 0 || y < 0) return null;
  if (x + width > sheet.width || y + height > sheet.height) return null;
  const canvas = createImageCanvas(width, height);
  const context = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) return null;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const start = ((y + row) * sheet.width + x) * 4;
    pixels.set(sheet.rgba.subarray(start, start + width * 4), row * width * 4);
  }
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return {
    height,
    pixelRatio: entry.pixelRatio ?? 1,
    sdf: entry.sdf === true,
    source: canvas,
    width,
  };
}
