import type { GeoJsonLayerFeature, GeoJsonLayerStyle } from "./geojson-layer";
import { resolveFeatureStyle } from "./geojson-rendering";
import type { MapPointClusterRenderFrame } from "./point-cluster-render-frame";

export type MapRenderCoordinate = [longitude: number, latitude: number];

type MapRenderFeatureBase<TFeature> = {
  feature: TFeature;
  featureId: string;
  interactive: boolean;
};

type MapRenderPrimitiveBase<TFeature> = MapRenderFeatureBase<TFeature> & {
  primitiveId: string;
};

export type MapRenderCircle<TFeature = unknown> = MapRenderPrimitiveBase<TFeature> & {
  center: MapRenderCoordinate;
  fillColor: string;
  fillOpacity: number;
  kind: "circle";
  label: string | null;
  radius: number;
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
};

export type MapRenderLine<TFeature = unknown> = MapRenderPrimitiveBase<TFeature> & {
  coordinates: MapRenderCoordinate[];
  kind: "line";
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
};

export type MapRenderPolygon<TFeature = unknown> = MapRenderPrimitiveBase<TFeature> & {
  fillColor: string;
  fillOpacity: number;
  kind: "polygon";
  rings: MapRenderCoordinate[][];
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
};

export type MapVectorRenderPrimitive<TFeature = unknown> =
  | MapRenderCircle<TFeature>
  | MapRenderLine<TFeature>
  | MapRenderPolygon<TFeature>;

/**
 * Maps-owned semantic vector render frame.
 *
 * Geographic coordinates, stable feature identity, interaction eligibility and
 * resolved base visual policy live here. Pixel backends may project, batch,
 * draw and hit-test these primitives, but must not invent map-domain identity
 * or geometry semantics.
 */
export type MapVectorRenderFrame<TFeature = unknown> = {
  kind: "vector";
  primitives: Array<MapVectorRenderPrimitive<TFeature>>;
};

export type CreateCircleVectorRenderFrameOptions<TFeature> = {
  fillOpacity?: number;
  getCoordinates: (feature: TFeature) => readonly [longitude: number, latitude: number];
  getFeatureId: (feature: TFeature) => string;
  getFillColor: (feature: TFeature) => string;
  getLabel?: (feature: TFeature) => string | null;
  getRadius: (feature: TFeature) => number;
  isFeatureInteractive?: (feature: TFeature) => boolean;
  primitivePrefix?: string;
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
};

export function createCircleVectorRenderFrame<TFeature>(
  features: readonly TFeature[],
  options: CreateCircleVectorRenderFrameOptions<TFeature>,
): MapVectorRenderFrame<TFeature> {
  const primitivePrefix = options.primitivePrefix ?? "circle";

  return {
    kind: "vector",
    primitives: features.map((feature) => {
      const featureId = options.getFeatureId(feature);

      return {
        center: copyCoordinate(options.getCoordinates(feature)),
        feature,
        featureId,
        fillColor: options.getFillColor(feature),
        fillOpacity: options.fillOpacity ?? 0.92,
        interactive: options.isFeatureInteractive?.(feature) ?? true,
        kind: "circle" as const,
        label: options.getLabel?.(feature) ?? null,
        primitiveId: `${primitivePrefix}:${featureId}`,
        radius: Math.max(0, options.getRadius(feature)),
        strokeColor: options.strokeColor ?? "#ffffff",
        strokeOpacity: options.strokeOpacity ?? 1,
        strokeWidth: Math.max(0, options.strokeWidth ?? 2),
      };
    }),
  };
}

export function createPointClusterVectorRenderFrame<TProperties = Record<string, unknown>>(
  frame: MapPointClusterRenderFrame<TProperties>,
  options: { primitivePrefix?: string } = {},
): MapVectorRenderFrame<(typeof frame.features)[number]["feature"]> {
  const primitivePrefix = options.primitivePrefix ?? "point-cluster";

  return {
    kind: "vector",
    primitives: frame.features.map((renderFeature) => ({
      center: copyCoordinate(renderFeature.coordinates),
      feature: renderFeature.feature,
      featureId: renderFeature.id,
      fillColor: renderFeature.fillColor,
      fillOpacity: 0.92,
      interactive: true,
      kind: "circle" as const,
      label: renderFeature.label,
      primitiveId: `${primitivePrefix}:${renderFeature.id}`,
      radius: renderFeature.radius,
      strokeColor: "#ffffff",
      strokeOpacity: 1,
      strokeWidth: 2,
    })),
  };
}

export type CreateGeoJsonVectorRenderFrameOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  getFeatureId?: (feature: GeoJsonLayerFeature<TProperties>) => string;
  getFeatureStyle?: (feature: GeoJsonLayerFeature<TProperties>) => GeoJsonLayerStyle;
  isFeatureInteractive?: (feature: GeoJsonLayerFeature<TProperties>) => boolean;
  primitivePrefix?: string;
  style?: GeoJsonLayerStyle;
};

export function createGeoJsonVectorRenderFrame<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  features: readonly GeoJsonLayerFeature<TProperties>[],
  options: CreateGeoJsonVectorRenderFrameOptions<TProperties> = {},
): MapVectorRenderFrame<GeoJsonLayerFeature<TProperties>> {
  const primitivePrefix = options.primitivePrefix ?? "geojson";

  return {
    kind: "vector",
    primitives: features.flatMap<MapVectorRenderPrimitive<GeoJsonLayerFeature<TProperties>>>(
      (feature) => {
        const featureId = options.getFeatureId?.(feature) || feature.id;
        const style = resolveFeatureStyle(feature, options.style ?? {}, options.getFeatureStyle);
        const interactive = options.isFeatureInteractive?.(feature) ?? true;
        const base: MapRenderFeatureBase<GeoJsonLayerFeature<TProperties>> = {
          feature,
          featureId,
          interactive,
        };

        switch (feature.geometry.type) {
          case "Point":
            return [
              createGeoJsonCircle(
                base,
                `${primitivePrefix}:${featureId}:point`,
                feature.geometry.coordinates,
                style,
              ),
            ];
          case "MultiPoint":
            return feature.geometry.coordinates.map((coordinates, index) =>
              createGeoJsonCircle(
                base,
                `${primitivePrefix}:${featureId}:point:${index}`,
                coordinates,
                style,
              ),
            );
          case "LineString":
            return [
              createGeoJsonLine(
                base,
                `${primitivePrefix}:${featureId}:line`,
                feature.geometry.coordinates,
                style,
              ),
            ];
          case "MultiLineString":
            return feature.geometry.coordinates.map((coordinates, index) =>
              createGeoJsonLine(
                base,
                `${primitivePrefix}:${featureId}:line:${index}`,
                coordinates,
                style,
              ),
            );
          case "Polygon":
            return [
              createGeoJsonPolygon(
                base,
                `${primitivePrefix}:${featureId}:polygon`,
                feature.geometry.coordinates,
                style,
              ),
            ];
          case "MultiPolygon":
            return feature.geometry.coordinates.map((rings, index) =>
              createGeoJsonPolygon(
                base,
                `${primitivePrefix}:${featureId}:polygon:${index}`,
                rings,
                style,
              ),
            );
        }
      },
    ),
  };
}

function createGeoJsonCircle<TFeature>(
  base: MapRenderFeatureBase<TFeature>,
  primitiveId: string,
  center: readonly [number, number],
  style: Required<GeoJsonLayerStyle>,
): MapRenderCircle<TFeature> {
  return {
    ...base,
    center: copyCoordinate(center),
    fillColor: style.pointColor,
    fillOpacity: 0.94,
    kind: "circle",
    label: null,
    primitiveId,
    radius: style.pointRadius,
    strokeColor: "#ffffff",
    strokeOpacity: 1,
    strokeWidth: 2,
  };
}

function createGeoJsonLine<TFeature>(
  base: MapRenderFeatureBase<TFeature>,
  primitiveId: string,
  coordinates: readonly (readonly [number, number])[],
  style: Required<GeoJsonLayerStyle>,
): MapRenderLine<TFeature> {
  return {
    ...base,
    coordinates: coordinates.map(copyCoordinate),
    kind: "line",
    primitiveId,
    strokeColor: style.lineColor,
    strokeOpacity: style.lineOpacity,
    strokeWidth: style.lineWidth,
  };
}

function createGeoJsonPolygon<TFeature>(
  base: MapRenderFeatureBase<TFeature>,
  primitiveId: string,
  rings: readonly (readonly (readonly [number, number])[])[],
  style: Required<GeoJsonLayerStyle>,
): MapRenderPolygon<TFeature> {
  return {
    ...base,
    fillColor: style.polygonFillColor,
    fillOpacity: style.polygonFillOpacity,
    kind: "polygon",
    primitiveId,
    rings: rings.map((ring) => ring.map(copyCoordinate)),
    strokeColor: style.polygonStrokeColor,
    strokeOpacity: 0.9,
    strokeWidth: style.polygonStrokeWidth,
  };
}

function copyCoordinate(coordinate: readonly [number, number]): MapRenderCoordinate {
  return [coordinate[0], coordinate[1]];
}
