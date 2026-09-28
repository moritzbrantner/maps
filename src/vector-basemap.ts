import { parseMapsWgpuCssColor } from "./wgpu-application-frame";

/**
 * Style classes of the retained vector basemap, in the index order of
 * `maps_core::VectorBasemapStyleClass`. Rust assigns every retained primitive one
 * class; the host resolves each class to a color and line width.
 */
export const MAPS_VECTOR_BASEMAP_STYLE_CLASSES = [
  "ocean",
  "land",
  "land-forest",
  "site",
  "water",
  "water-glacier",
  "building",
  "building-outline",
  "coast",
  "water-line",
  "street",
  "boundary",
] as const;

export type MapsVectorBasemapStyleClass = (typeof MAPS_VECTOR_BASEMAP_STYLE_CLASSES)[number];

export type MapsVectorBasemapClassStyle = {
  /** Hex or rgb(a) CSS color. */
  color: string;
  /** Multiplies the color alpha (default 1); 0 hides the class. */
  opacity?: number;
  /** Line width in CSS px (line classes only; default 0). */
  width?: number;
};

/** Mirrors STYLE_ENTRY_FLOATS in crates/maps-wasm/src/vector_basemap_layout.rs. */
const STYLE_ENTRY_FLOATS = 8;

/** Packs per-class styles into the table consumed by the wgpu vector pipelines. */
export function createMapsVectorBasemapStyleTable(
  resolve: (styleClass: MapsVectorBasemapStyleClass) => MapsVectorBasemapClassStyle,
): Float32Array {
  const table = new Float32Array(MAPS_VECTOR_BASEMAP_STYLE_CLASSES.length * STYLE_ENTRY_FLOATS);
  MAPS_VECTOR_BASEMAP_STYLE_CLASSES.forEach((styleClass, index) => {
    const style = resolve(styleClass);
    const color = parseMapsWgpuCssColor(style.color, style.opacity ?? 1);
    if (!color) {
      throw new Error(`Unsupported vector basemap color for ${styleClass}: ${style.color}`);
    }
    const width = style.width ?? 0;
    if (!Number.isFinite(width) || width < 0) {
      throw new Error(`Invalid vector basemap line width for ${styleClass}: ${width}`);
    }
    table.set([...color, width, 0, 0, 0], index * STYLE_ENTRY_FLOATS);
  });
  return table;
}
