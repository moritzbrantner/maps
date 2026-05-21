"use client";

import { useContext, useDeferredValue, useEffect, useMemo } from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
} from "./aggregation";
import { toLeafletLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";

export type HeatLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatLayerRadius =
  | number
  | {
      max: number;
      maxZoom?: number;
      min: number;
      minZoom?: number;
    };

export type HeatLayerFeatureProperties = {
  kind: "heat-cluster" | "heat-point";
  label: string;
  pointId: string;
  pointCount: number;
  rawWeight: number;
  weight: number;
} & Record<string, number | string>;

export type HeatLayerFeature = {
  geometry: {
    coordinates: [longitude: number, latitude: number];
    type: "Point";
  };
  properties: HeatLayerFeatureProperties;
  type: "Feature";
};

export type HeatLayerFeatureCollection = {
  features: HeatLayerFeature[];
  type: "FeatureCollection";
};

export type HeatLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<HeatLayerFeature> & {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    heatmapAggregationMaxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    heatmapAggregationMinZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    heatmapAggregationRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    heatmapColorRamp?: readonly HeatLayerColorStop[];
    heatmapIntensity?: number;
    heatmapMaxZoom?: number;
    heatmapOpacity?: number;
    heatmapRadius?: HeatLayerRadius;
    maxWeight?: number;
    points: readonly MapPoint<TProperties>[];
    weightMetric?: string;
  };

const defaultHeatLayerColorRamp = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
] as const satisfies readonly HeatLayerColorStop[];

export function HeatLayer<TProperties = Record<string, unknown>>({
  filterPoint,
  getWeight,
  heatmapAggregationMaxZoom,
  heatmapAggregationMinZoom,
  heatmapAggregationRadius = 56,
  heatmapColorRamp = defaultHeatLayerColorRamp,
  heatmapIntensity = 1,
  heatmapMaxZoom = 16,
  heatmapOpacity = 0.84,
  heatmapRadius = {
    max: 42,
    min: 12,
  },
  maxWeight,
  points,
  weightMetric,
}: HeatLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const deferredPoints = useDeferredValue(points);
  const densityIndex = useMemo(
    () =>
      createHeatLayerDensityIndex(deferredPoints, {
        filterPoint,
        getWeight,
        maxWeight,
        maxZoom: heatmapAggregationMaxZoom ?? heatmapMaxZoom,
        minZoom: heatmapAggregationMinZoom,
        radius: heatmapAggregationRadius,
        weightMetric,
      }),
    [
      deferredPoints,
      filterPoint,
      getWeight,
      heatmapAggregationMaxZoom,
      heatmapAggregationMinZoom,
      heatmapAggregationRadius,
      heatmapMaxZoom,
      maxWeight,
      weightMetric,
    ],
  );

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer("heat-layer", ({ isMeasuring, layer, leaflet, map }) => {
      layer.clearLayers();

      if (map.getZoom() > heatmapMaxZoom) {
        return;
      }

      const bounds = map.getBounds();
      const data = densityIndex.getFeatureCollection({
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        zoom: map.getZoom(),
      });
      const safeOpacity = clamp(heatmapOpacity, 0, 1);

      for (const feature of data.features) {
        const [longitude, latitude] = feature.geometry.coordinates;
        const normalizedWeight = clamp(feature.properties.weight, 0, 1);
        const markerRadius =
          resolveHeatLayerRadius(heatmapRadius, map.getZoom()) *
          Math.max(0.35, Math.sqrt(normalizedWeight)) *
          Math.max(0, heatmapIntensity);

        leaflet
          .circleMarker([latitude, longitude], {
            className: "mb-maps__heat-marker",
            color: "transparent",
            fillColor: resolveHeatLayerColor(heatmapColorRamp, normalizedWeight),
            fillOpacity: safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65),
            interactive: !isMeasuring,
            opacity: 0,
            radius: markerRadius,
            weight: 0,
          })
          .addTo(layer);
      }
    });
  }, [
    densityIndex,
    heatmapColorRamp,
    heatmapIntensity,
    heatmapMaxZoom,
    heatmapOpacity,
    heatmapRadius,
    surface,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  const data = densityIndex.getFeatureCollection({
    bounds: [-180, -90, 180, 90],
    zoom: surface.viewState.zoom,
  });

  return (
    <>
      {surface.viewState.zoom <= heatmapMaxZoom
        ? data.features.map((feature) => {
            const projected = surface.projectGlobeCoordinate(
              feature.geometry.coordinates,
              surface.viewState,
            );

            if (!projected.visible) {
              return null;
            }

            const normalizedWeight = clamp(feature.properties.weight, 0, 1);
            const markerRadius =
              resolveHeatLayerRadius(heatmapRadius, surface.viewState.zoom) *
              Math.max(0.35, Math.sqrt(normalizedWeight)) *
              Math.max(0, heatmapIntensity) *
              (0.62 + projected.scale * 0.38);
            const safeOpacity = clamp(heatmapOpacity, 0, 1);

            return (
              <circle
                className="mb-maps__globe-heat-marker"
                cx={projected.x}
                cy={projected.y}
                fill={resolveHeatLayerColor(heatmapColorRamp, normalizedWeight)}
                fillOpacity={safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65)}
                key={feature.properties.pointId}
                r={markerRadius}
                style={{ opacity: 0.34 + projected.scale * 0.66 }}
              >
                <title>{feature.properties.label}</title>
              </circle>
            );
          })
        : null}
    </>
  );
}

export function createHeatLayerDensityIndex<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    maxWeight?: number;
    maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    radius?: PointAggregationIndexOptions<TProperties>["radius"];
    weightMetric?: string;
  } = {},
) {
  const weightedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatLayerPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      point,
      rawWeight: resolveHeatLayerPointWeight(point, options),
    }))
    .filter((entry) => entry.rawWeight > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedPoints.map((entry) => entry.rawWeight));
  const index = createPointAggregationIndex(
    weightedPoints.map(({ point, rawWeight }) => ({
      id: point.id,
      label: point.label,
      latitude: point.latitude,
      longitude: point.longitude,
      metrics: {
        ...point.metrics,
        [HEAT_MAP_WEIGHT_METRIC]: rawWeight,
      },
      properties: point.properties,
    })),
    {
      maxZoom: options.maxZoom,
      minZoom: options.minZoom,
      radius: options.radius,
    },
  );

  return {
    getFeatureCollection(query: ViewportAggregationQuery) {
      return createHeatLayerFeatureCollectionFromAggregates(
        index.getViewportAggregation(query).features,
        effectiveMaxWeight,
      );
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

function createHeatLayerFeatureCollectionFromAggregates<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  effectiveMaxWeight: number,
): HeatLayerFeatureCollection {
  return {
    features: features
      .map((feature) => createHeatLayerFeatureFromAggregate(feature, effectiveMaxWeight))
      .filter(isDefined),
    type: "FeatureCollection",
  };
}

function createHeatLayerFeatureFromAggregate<TProperties>(
  feature: AggregatedMapFeature<TProperties>,
  effectiveMaxWeight: number,
): HeatLayerFeature | null {
  const rawWeight = feature.metrics[HEAT_MAP_WEIGHT_METRIC] ?? 0;

  if (rawWeight <= 0) {
    return null;
  }

  return {
    geometry: {
      coordinates: feature.coordinates,
      type: "Point",
    },
    properties: {
      ...Object.fromEntries(
        Object.entries(feature.metrics).filter(([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC),
      ),
      kind: feature.kind === "cluster" ? "heat-cluster" : "heat-point",
      label: feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.label,
      pointId: feature.kind === "cluster" ? `cluster-${feature.clusterId}` : feature.point.id,
      pointCount: feature.kind === "cluster" ? feature.pointCount : 1,
      rawWeight,
      weight: Math.max(0, rawWeight / effectiveMaxWeight),
    },
    type: "Feature",
  };
}

function resolveHeatLayerPointWeight<TProperties>(
  point: IndexedMapPoint<TProperties>,
  options: {
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(point)
    : options.weightMetric
      ? point.metrics[options.weightMetric] ?? 0
      : point.metrics.weight ?? 1;

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
}

function resolveHeatLayerRadius(radius: HeatLayerRadius, zoom: number) {
  if (typeof radius === "number") {
    return Math.max(0, radius);
  }

  const minZoom = radius.minZoom ?? 0;
  const maxZoom = radius.maxZoom ?? 9;

  if (maxZoom <= minZoom) {
    return Math.max(0, radius.max);
  }

  const progress = clamp((zoom - minZoom) / (maxZoom - minZoom), 0, 1);

  return Math.max(0, radius.min + (radius.max - radius.min) * progress);
}

function resolveHeatLayerColor(colorRamp: readonly HeatLayerColorStop[], weight: number) {
  if (colorRamp.length === 0) {
    return "#dc2626";
  }

  const sortedRamp = [...colorRamp].sort(([left], [right]) => left - right);
  const fallback = sortedRamp[sortedRamp.length - 1];

  for (const [density, color] of sortedRamp) {
    if (weight <= density) {
      return color;
    }
  }

  return fallback?.[1] ?? "#dc2626";
}

function toIndexedMapPoint<TProperties>(
  point: MapPoint<TProperties>,
  index: number,
): IndexedMapPoint<TProperties> {
  return {
    id: String(point.id ?? index),
    label: point.label ?? "",
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: point.metrics ?? {},
    properties: point.properties ?? ({} as TProperties),
  };
}

function isValidHeatLayerPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
