import type {
  AggregatedMapFeature,
  VisibleAggregationSummary,
  ViewportAggregation,
} from "./aggregation";

type MapPointClusterRenderFeatureBase<TProperties> = {
  coordinates: [longitude: number, latitude: number];
  feature: AggregatedMapFeature<TProperties>;
  fillColor: string;
  id: string;
  radius: number;
};

export type MapPointClusterRenderFeature<TProperties = Record<string, unknown>> =
  | (MapPointClusterRenderFeatureBase<TProperties> & {
      expansionZoom: number;
      kind: "cluster";
      label: string;
    })
  | (MapPointClusterRenderFeatureBase<TProperties> & {
      kind: "point";
      label: null;
    });

/**
 * Private renderer-neutral frame for the current point/cluster viewport.
 *
 * It deliberately contains only Maps-owned semantic identity, coordinates and
 * resolved base visual policy. Browser renderers may project these coordinates,
 * draw pixels, and map hits back to `id`; they must not re-cluster or invent
 * geographic/metric truth.
 */
export type MapPointClusterRenderFrame<TProperties = Record<string, unknown>> = {
  features: Array<MapPointClusterRenderFeature<TProperties>>;
  kind: "point-cluster";
  summary: VisibleAggregationSummary;
};

export function createPointClusterRenderFrame<TProperties = Record<string, unknown>>(
  aggregation: ViewportAggregation<TProperties>,
  getFeatureId?: (feature: AggregatedMapFeature<TProperties>) => string,
): MapPointClusterRenderFrame<TProperties> {
  return {
    features: aggregation.features.map((feature) => {
      const id = resolvePointClusterFeatureId(feature, getFeatureId);

      if (feature.kind === "cluster") {
        return {
          coordinates: feature.coordinates,
          expansionZoom: feature.expansionZoom,
          feature,
          fillColor: getClusterColor(feature.pointCount),
          id,
          kind: "cluster" as const,
          label: feature.pointCountAbbreviated,
          radius: getClusterRadius(feature.pointCount),
        };
      }

      return {
        coordinates: feature.coordinates,
        feature,
        fillColor: "#0f172a",
        id,
        kind: "point" as const,
        label: null,
        radius: 6,
      };
    }),
    kind: "point-cluster",
    summary: aggregation.summary,
  };
}

function resolvePointClusterFeatureId<TProperties>(
  feature: AggregatedMapFeature<TProperties>,
  getFeatureId?: (feature: AggregatedMapFeature<TProperties>) => string,
) {
  return (
    getFeatureId?.(feature) ||
    (feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`)
  );
}

function getClusterColor(pointCount: number) {
  if (pointCount >= 2_500) return "#ea580c";
  if (pointCount >= 250) return "#7c3aed";
  if (pointCount >= 25) return "#0284c7";
  return "#0f766e";
}

function getClusterRadius(pointCount: number) {
  if (pointCount >= 2_500) return 42;
  if (pointCount >= 250) return 32;
  if (pointCount >= 25) return 24;
  return 18;
}
