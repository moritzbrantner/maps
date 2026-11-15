import type { GeoJsonLayerStyle } from "./geojson-layer";
import type { MapFeatureInteractionProps } from "./map-interaction";
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
 * MapLibre style-specification layers drawn over a Maps Tileset (#321, #322, #323, #349), in order:
 * `fill` layers (color, opacity, `fill-pattern` from the map style's `sprite`, the
 * `fill-antialias` outline), `line` layers (caps, joins, dashes, `line-pattern`), `circle` layers and `symbol` layers
 * (SDF text at points or along lines, plain or SDF icons from the map style's `sprite`, and sizes and paint that follow
 * the zoom, #346) of its vector source layers, with filters, data-driven properties and MapLibre's collision placement.
 * Past the tileset's `maxZoom`, tiles are sliced and overscaled as in MapLibre (#346).
 * Properties Maps does not implement are rejected through `onError`, never approximated.
 */
export type MapsTilesetLayers = MapsTilesetLayerInteraction & {
  /** Glyph PBF URL template with `{fontstack}` and `{range}`, as a style's `glyphs`. */
  glyphs?: string;
  layers: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

/**
 * A rendered feature of a Tileset `circle` or `symbol` style layer under the pointer, as
 * MapLibre's `queryRenderedFeatures` reports it, without geometry (#346).
 */
export type MapsTilesetFeature = {
  type: "Feature";
  /** The vector tile feature id, when the feature has one. */
  id?: number;
  properties: Record<string, unknown>;
  layer: { id: string; type: "circle" | "symbol" };
  sourceLayer: string;
};

/**
 * Picking of Tileset style features through the Map View (#346). Like MapLibre's
 * layer-scoped pointer events, only `interactiveLayerIds` are picked: the topmost feature
 * of those layers under the pointer, symbols where their placed collision boxes are and
 * circles where they are drawn. Only `circle` and `symbol` layers can be interactive.
 */
export type MapsTilesetLayerInteraction = Pick<
  MapFeatureInteractionProps<MapsTilesetFeature>,
  | "getFeatureId"
  | "onFeatureHover"
  | "onHoveredFeatureIdChange"
  | "onSelectedFeatureIdChange"
  | "renderFeaturePopup"
  | "renderFeatureTooltip"
> & {
  interactiveLayerIds?: readonly string[];
  onFeatureSelect?: (feature: MapsTilesetFeature | null) => void;
};

/**
 * The `interactiveLayerIds` of `tilesetLayers`, checked against its layers: an unknown id or
 * a layer other than `circle` or `symbol` throws, as the runtime would refuse to query it.
 */
export function resolveTilesetInteractiveLayerIds(
  tilesetLayers: MapsTilesetLayers | undefined,
): readonly string[] {
  const ids = tilesetLayers?.interactiveLayerIds ?? [];
  for (const id of ids) {
    const layer = tilesetLayers?.layers.find((candidate) => candidate.id === id);
    if (!layer) throw new Error(`tilesetLayers.interactiveLayerIds: no tileset style layer "${id}"`);
    if (layer.type !== "circle" && layer.type !== "symbol") {
      throw new Error(
        `tilesetLayers.interactiveLayerIds: "${id}" is a ${String(layer.type)} layer; only circle and symbol layers are interactive`,
      );
    }
  }
  return ids;
}
