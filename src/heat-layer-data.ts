"use client";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
} from "./aggregation";
import {
  normalizeScalarFieldValue,
  resolveScalarFieldValuePoints,
  type HeatFieldOptions,
} from "./scalar-field";
import type { HeatFieldContourOptions, HeatFieldColorStop } from "./scalar-field-render";
import {
  HEAT_MAP_WEIGHT_METRIC,
  type HeatFieldRenderMode,
  type HeatLayerFeature,
  type HeatLayerFeatureCollection,
  type HeatLayerFeatureProperties,
  type HeatLayerWeightAccessor,
} from "./heat-layer-types";
import { clamp, roundHeatLayerCacheNumber } from "./heat-layer-utils";

export function isHeatFieldRasterVisible(renderMode: HeatFieldRenderMode) {
  return renderMode === "raster" || renderMode === "raster-contours";
}

export function isHeatFieldContoursVisible(renderMode: HeatFieldRenderMode) {
  return renderMode === "contours" || renderMode === "raster-contours";
}

export function createHeatLayerNumberArrayKey(values: readonly number[] | null | undefined) {
  return values?.map(createHeatLayerNumberKey).join(",") ?? "";
}

export function createHeatLayerColorRampKey(
  colorRamp: readonly HeatFieldColorStop[] | null | undefined,
) {
  return (
    colorRamp?.map(([value, color]) => `${createHeatLayerNumberKey(value)}:${color}`).join("|") ??
    ""
  );
}

export function createHeatLayerContourLevelsKey(levels: HeatFieldContourOptions["levels"]) {
  if (Array.isArray(levels)) {
    return createHeatLayerNumberArrayKey(levels);
  }

  return levels ?? "";
}

function createHeatLayerNumberKey(value: number) {
  return Number.isFinite(value) ? String(value) : "NaN";
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
  let cachedQueryKey: string | null = null;
  let cachedFeatureCollection: HeatLayerFeatureCollection | null = null;

  return {
    getFeatureCollection(query: ViewportAggregationQuery) {
      const queryKey = getHeatLayerViewportQueryCacheKey(query);

      if (cachedQueryKey === queryKey && cachedFeatureCollection) {
        return cachedFeatureCollection;
      }

      cachedQueryKey = queryKey;
      cachedFeatureCollection = createHeatLayerFeatureCollectionFromAggregates(
        index.getViewportAggregation(query).features,
        effectiveMaxWeight,
      );

      return cachedFeatureCollection;
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

export function createHeatLayerSourceIndex<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    maxWeight?: number;
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
  const features = weightedPoints.map(({ point, rawWeight }): HeatLayerFeature => {
    const properties: HeatLayerFeatureProperties = {
      ...Object.fromEntries(
        Object.entries(point.metrics).filter(([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC),
      ),
      kind: "heat-point",
      label: point.label,
      pointCount: 1,
      pointId: point.id,
      rawWeight,
      weight: Math.max(0, rawWeight / effectiveMaxWeight),
    };

    return {
      geometry: {
        coordinates: [point.longitude, point.latitude],
        type: "Point",
      },
      properties,
      type: "Feature",
    };
  });
  let cachedBoundsKey: string | null = null;
  let cachedFeatureCollection: HeatLayerFeatureCollection | null = null;

  return {
    getFeatureCollection(bounds: [west: number, south: number, east: number, north: number]) {
      const boundsKey = getHeatLayerBoundsCacheKey(bounds);

      if (cachedBoundsKey === boundsKey && cachedFeatureCollection) {
        return cachedFeatureCollection;
      }

      cachedBoundsKey = boundsKey;
      cachedFeatureCollection = getHeatLayerFeatureCollectionInBounds(
        {
          features,
          type: "FeatureCollection",
        },
        bounds,
      );

      return cachedFeatureCollection;
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

export function createHeatLayerValueFeatureCollection<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    valueDomain?: HeatFieldOptions<TProperties>["valueDomain"];
    valueMetric?: string;
  },
): HeatLayerFeatureCollection {
  const valuePoints = resolveScalarFieldValuePoints(points, options);
  const valueDomain =
    options.valueDomain ?? getHeatLayerValueDomain(valuePoints.map((entry) => entry.value));

  return {
    features: valuePoints.map((entry) => {
      const normalizedValue = normalizeScalarFieldValue(entry.value, valueDomain) ?? 1;

      return {
        geometry: {
          coordinates: [entry.point.longitude, entry.point.latitude] as [number, number],
          type: "Point" as const,
        },
        properties: {
          ...entry.point.metrics,
          kind: "heat-point" as const,
          label: entry.point.label,
          pointCount: 1,
          pointId: entry.point.id,
          rawWeight: entry.value,
          weight: normalizedValue,
        },
        type: "Feature" as const,
      };
    }),
    type: "FeatureCollection",
  };
}

export function getHeatLayerFeatureCollectionInBounds(
  data: HeatLayerFeatureCollection,
  [west, south, east, north]: [west: number, south: number, east: number, north: number],
): HeatLayerFeatureCollection {
  return {
    features: data.features.filter((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;

      return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
    }),
    type: "FeatureCollection",
  };
}

export function formatHeatLayerFeatureValue(
  feature: HeatLayerFeature,
  formatValue: ((value: number) => string) | undefined,
) {
  const value = feature.properties.rawWeight;
  const valueLabel = formatValue?.(value) ?? formatHeatLayerValue(value);

  return feature.properties.label ? `${feature.properties.label}: ${valueLabel}` : valueLabel;
}

function getHeatLayerValueDomain(values: readonly number[]): [min: number, max: number] | null {
  const finiteValues = values.filter((value) => Number.isFinite(value));

  if (finiteValues.length === 0) {
    return null;
  }

  return [Math.min(...finiteValues), Math.max(...finiteValues)];
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
        Object.entries(feature.metrics).filter(
          ([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC,
        ),
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
      ? (point.metrics[options.weightMetric] ?? 0)
      : (point.metrics.weight ?? 1);

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
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

function getHeatLayerViewportQueryCacheKey(query: ViewportAggregationQuery) {
  return `${roundHeatLayerCacheNumber(query.zoom)}:${getHeatLayerBoundsCacheKey(query.bounds)}`;
}

export function getHeatLayerBoundsCacheKey(bounds: readonly number[]) {
  return bounds.map(roundHeatLayerCacheNumber).join(",");
}

function formatHeatLayerValue(value: number) {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 100) {
    return value.toFixed(0);
  }

  if (absoluteValue >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

export function canUseAsyncHeatLayerRender() {
  return (
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent)
  );
}

export { clamp } from "./heat-layer-utils";
