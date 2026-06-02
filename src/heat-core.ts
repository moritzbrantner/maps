import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
} from "./aggregation";
import type {
  HeatMapDensityIndex,
  HeatMapDensityIndexOptions,
  HeatMapFeatureCollection,
  HeatMapFeatureProperties,
  HeatMapWeightOptions,
} from "./heat-map";

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";

export function createHeatMapFeatureCollection<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  points: readonly MapPoint<TProperties>[],
  options: HeatMapWeightOptions<TProperties> = {},
): HeatMapFeatureCollection {
  const indexedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatMapPoint)
    .filter((point) => options.filterPoint?.(point) ?? true);
  const rawWeights = indexedPoints.map((point) => resolveHeatMapPointWeight(point, options));
  const effectiveMaxWeight = getEffectiveMaxWeight(rawWeights, options.maxWeight);
  const features = indexedPoints
    .map((point, index) => {
      const rawWeight = rawWeights[index] ?? 0;

      if (rawWeight <= 0) {
        return null;
      }

      return {
        geometry: {
          coordinates: [point.longitude, point.latitude] as [number, number],
          type: "Point" as const,
        },
        properties: {
          ...point.metrics,
          kind: "heat-point" as const,
          label: point.label,
          pointId: point.id,
          pointCount: 1,
          rawWeight,
          weight: clamp(rawWeight / effectiveMaxWeight, 0, 1),
        },
        type: "Feature" as const,
      };
    })
    .filter(isDefined);

  return {
    features,
    type: "FeatureCollection",
  };
}

export function createHeatMapDensityIndex<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  points: readonly MapPoint<TProperties>[],
  options: HeatMapDensityIndexOptions<TProperties> = {},
): HeatMapDensityIndex {
  const weightedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatMapPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      point,
      rawWeight: resolveHeatMapPointWeight(point, options),
    }))
    .filter((entry) => entry.rawWeight > 0);
  const effectiveMaxWeight = getEffectiveMaxWeight(
    weightedPoints.map((entry) => entry.rawWeight),
    options.maxWeight,
  );
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
    getFeatureCollection(query) {
      return createHeatMapFeatureCollectionFromAggregates(
        index.getViewportAggregation(query).features,
        effectiveMaxWeight,
      );
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

export function getHeatMapMaxWeight<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight"> = {},
) {
  return Math.max(
    0,
    ...points
      .map(toIndexedMapPoint)
      .filter(isValidHeatMapPoint)
      .filter((point) => options.filterPoint?.(point) ?? true)
      .map((point) => resolveHeatMapPointWeight(point, options)),
  );
}

export function resolveHeatMapPointWeight<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  point: IndexedMapPoint<TProperties>,
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight"> = {},
) {
  const rawWeight = getRawHeatMapPointWeight(point, options);

  if (!Number.isFinite(rawWeight)) {
    return 0;
  }

  return Math.max(0, rawWeight);
}

function createHeatMapFeatureCollectionFromAggregates<TProperties extends Record<string, unknown>>(
  features: readonly AggregatedMapFeature<TProperties>[],
  maxWeight: number,
): HeatMapFeatureCollection {
  return {
    features: features
      .map((feature) => {
        const rawWeight = feature.metrics[HEAT_MAP_WEIGHT_METRIC] ?? 0;

        if (rawWeight <= 0) {
          return null;
        }

        const properties: HeatMapFeatureProperties = {
          ...copyPublicHeatMapMetrics(feature.metrics),
          kind: feature.kind === "cluster" ? "heat-cluster" : "heat-point",
          label: feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.label,
          pointCount: feature.kind === "cluster" ? feature.pointCount : 1,
          pointId: feature.kind === "cluster" ? `cluster-${feature.clusterId}` : feature.point.id,
          rawWeight,
          weight: Math.max(0, rawWeight / maxWeight),
        };

        return {
          geometry: {
            coordinates: feature.coordinates,
            type: "Point" as const,
          },
          properties,
          type: "Feature" as const,
        };
      })
      .filter(isDefined),
    type: "FeatureCollection",
  };
}

function getRawHeatMapPointWeight<TProperties extends Record<string, unknown>>(
  point: IndexedMapPoint<TProperties>,
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight">,
) {
  if (options.getWeight) {
    return options.getWeight(point);
  }

  if (options.weightMetric) {
    return point.metrics[options.weightMetric] ?? 0;
  }

  return point.metrics.weight ?? 1;
}

function copyPublicHeatMapMetrics(metrics: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(metrics).filter(([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC),
  );
}

function getEffectiveMaxWeight(rawWeights: readonly number[], maxWeight: number | undefined) {
  if (Number.isFinite(maxWeight) && (maxWeight ?? 0) > 0) {
    return maxWeight!;
  }

  return Math.max(1, ...rawWeights);
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

function isValidHeatMapPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
