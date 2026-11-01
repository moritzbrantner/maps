import type { GeoJsonLayerStyle } from "./geojson-layer";
import { getShortbreadBasemapStyle } from "./shortbread-style";
import {
  createMapsVectorBasemapStyleTable,
  type MapsVectorBasemapClassStyle,
  type MapsVectorBasemapStyleClass,
} from "./vector-basemap";
/** Existing Shortbread class palette overrides; no MapLibre expression/style language. */
export type MapsVectorBasemapStyle = Partial<
  Record<MapsVectorBasemapStyleClass, MapsVectorBasemapClassStyle>
>;
export function getShortbreadClassStyle(
  styleClass: MapsVectorBasemapStyleClass,
): MapsVectorBasemapClassStyle {
  const fill = (style: GeoJsonLayerStyle) => ({
    color: style.polygonFillColor ?? "#000000",
    opacity: style.polygonFillOpacity ?? 1,
  });
  const line = (style: GeoJsonLayerStyle) => ({
    color: style.lineColor ?? "#000000",
    opacity: style.lineOpacity ?? 1,
    width: style.lineWidth ?? 1,
  });
  switch (styleClass) {
    case "ocean":
    case "land":
    case "site":
    case "water":
    case "building":
      return fill(getShortbreadBasemapStyle(styleClass));
    case "land-forest":
      return fill(getShortbreadBasemapStyle("land", "forest"));
    case "water-glacier":
      return fill(getShortbreadBasemapStyle("water", "glacier"));
    case "building-outline": {
      const building = getShortbreadBasemapStyle("building");
      return {
        color: building.polygonStrokeColor ?? "#000000",
        opacity: 1,
        width: building.polygonStrokeWidth ?? 0,
      };
    }
    case "water-line":
      return line(getShortbreadBasemapStyle("water"));
    case "coast":
    case "street":
    case "boundary":
      return line(getShortbreadBasemapStyle(styleClass));
  }
}

export function resolveTilesetClassStyle(
  styleClass: MapsVectorBasemapStyleClass,
  overrides?: MapsVectorBasemapStyle,
) {
  return overrides?.[styleClass] ?? getShortbreadClassStyle(styleClass);
}
export function tilesetStyleTable(overrides?: MapsVectorBasemapStyle) {
  return createMapsVectorBasemapStyleTable((styleClass) =>
    resolveTilesetClassStyle(styleClass, overrides),
  );
}

/**
 * MapLibre style-specification layers drawn over a Maps Tileset (#321, #322, #323), in order:
 * `fill` layers (color, opacity, `fill-pattern` from the map style's `sprite`, the
 * `fill-antialias` outline), `line` layers (caps, joins, dashes), `circle` layers and point-placement `symbol` layers
 * (SDF text, and plain or SDF icons from the map style's `sprite`, #346) of its vector source layers, with filters, data-driven properties and MapLibre's collision placement.
 * Properties Maps does not implement are rejected through `onError`, never approximated.
 */
export type MapsTilesetLayers = {
  /** Glyph PBF URL template with `{fontstack}` and `{range}`, as a style's `glyphs`. */
  glyphs?: string;
  layers: ReadonlyArray<Readonly<Record<string, unknown>>>;
};
