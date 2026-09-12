import type { GeoJsonLayerFeature, GeoJsonLayerStyle } from "./geojson-layer";
import { resolveFeatureStyle } from "./geojson-rendering";
import {
  createMapRenderFrame,
  type MapCircleRenderBatch,
  type MapLineRenderBatch,
  type MapPolygonRenderBatch,
  type MapRenderBatch,
  type MapRenderFrame,
} from "./map-render-frame";
import type { TemporalGeoJsonSupportedGeometry } from "./temporal-geojson-types";

export type GeoJsonRenderFrameOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  getFeatureId?: (feature: GeoJsonLayerFeature<TProperties>) => string;
  getFeatureStyle?: (feature: GeoJsonLayerFeature<TProperties>) => GeoJsonLayerStyle;
  isFeatureInteractive?: (feature: GeoJsonLayerFeature<TProperties>) => boolean;
  isFeatureSelected?: (feature: GeoJsonLayerFeature<TProperties>) => boolean;
  style?: GeoJsonLayerStyle;
};

export function createGeoJsonRenderFrame<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  features: readonly GeoJsonLayerFeature<TProperties>[],
  options: GeoJsonRenderFrameOptions<TProperties> = {},
): MapRenderFrame<GeoJsonLayerFeature<TProperties>> {
  const batches: Array<MapRenderBatch<GeoJsonLayerFeature<TProperties>>> = [];

  for (const feature of features) {
    const id = options.getFeatureId?.(feature) || feature.id;
    const style = resolveFeatureStyle(feature, options.style ?? {}, options.getFeatureStyle);
    const interactive = options.isFeatureInteractive?.(feature) ?? true;
    const selected = options.isFeatureSelected?.(feature) ?? false;

    batches.push(
      ...geometryBatches(feature.geometry, {
        feature,
        id,
        interactive,
        selected,
        style,
      }),
    );
  }

  return createMapRenderFrame(batches);
}

function geometryBatches<TProperties extends Record<string, unknown>>(
  geometry: TemporalGeoJsonSupportedGeometry,
  resolved: {
    feature: GeoJsonLayerFeature<TProperties>;
    id: string;
    interactive: boolean;
    selected: boolean;
    style: Required<GeoJsonLayerStyle>;
  },
): Array<MapRenderBatch<GeoJsonLayerFeature<TProperties>>> {
  const { feature, id, interactive, selected, style } = resolved;
  const identity = { feature, id, interactive };

  switch (geometry.type) {
    case "Point":
      return [
        circleBatch([
          {
            ...identity,
            coordinates: geometry.coordinates,
            fillColor: style.pointColor,
            fillOpacity: 0.94,
            label: null,
            radius: style.pointRadius,
            strokeColor: "#ffffff",
            strokeWidth: selected ? 3 : 2,
          },
        ]),
      ];
    case "MultiPoint":
      return [
        circleBatch(
          geometry.coordinates.map((coordinates) => ({
            ...identity,
            coordinates,
            fillColor: style.pointColor,
            fillOpacity: 0.94,
            label: null,
            radius: style.pointRadius,
            strokeColor: "#ffffff",
            strokeWidth: selected ? 3 : 2,
          })),
        ),
      ];
    case "LineString":
      return [
        lineBatch([
          {
            ...identity,
            coordinates: geometry.coordinates,
            strokeColor: style.lineColor,
            strokeOpacity: style.lineOpacity,
            strokeWidth: selected ? style.lineWidth + 1.5 : style.lineWidth,
          },
        ]),
      ];
    case "MultiLineString":
      return [
        lineBatch(
          geometry.coordinates.map((coordinates) => ({
            ...identity,
            coordinates,
            strokeColor: style.lineColor,
            strokeOpacity: style.lineOpacity,
            strokeWidth: selected ? style.lineWidth + 1.5 : style.lineWidth,
          })),
        ),
      ];
    case "Polygon":
      return [
        polygonBatch([
          {
            ...identity,
            fillColor: style.polygonFillColor,
            fillOpacity: style.polygonFillOpacity,
            rings: geometry.coordinates,
            strokeColor: style.polygonStrokeColor,
            strokeOpacity: 0.9,
            strokeWidth: selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth,
          },
        ]),
      ];
    case "MultiPolygon":
      return [
        polygonBatch(
          geometry.coordinates.map((rings) => ({
            ...identity,
            fillColor: style.polygonFillColor,
            fillOpacity: style.polygonFillOpacity,
            rings,
            strokeColor: style.polygonStrokeColor,
            strokeOpacity: 0.9,
            strokeWidth: selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth,
          })),
        ),
      ];
  }
}

function circleBatch<TFeature>(items: MapCircleRenderBatch<TFeature>["items"]): MapCircleRenderBatch<TFeature> {
  return { items, kind: "circles" };
}

function lineBatch<TFeature>(items: MapLineRenderBatch<TFeature>["items"]): MapLineRenderBatch<TFeature> {
  return { items, kind: "lines" };
}

function polygonBatch<TFeature>(
  items: MapPolygonRenderBatch<TFeature>["items"],
): MapPolygonRenderBatch<TFeature> {
  return { items, kind: "polygons" };
}
