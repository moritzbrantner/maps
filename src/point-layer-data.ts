import type { IndexedMapPoint, MapPoint, MapPointFilter } from "./aggregation";
import type {
  PointLayerFeature,
  BubbleLayerFeature,
  BubbleLayerWeightAccessor,
} from "./point-layer";

export function createPointLayerFeatures<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
  } = {},
): Array<PointLayerFeature<TProperties>> {
  return points
    .map(toIndexedMapPoint)
    .filter(isValidPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      coordinates: [point.longitude, point.latitude],
      point,
    }));
}

export function createBubbleLayerFeatures<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: BubbleLayerWeightAccessor<TProperties>;
    maxRadius?: number;
    maxWeight?: number;
    minRadius?: number;
    weightMetric?: string;
  } = {},
): Array<BubbleLayerFeature<TProperties>> {
  const baseFeatures = createPointLayerFeatures(points, { filterPoint: options.filterPoint });
  const weightedFeatures = baseFeatures
    .map((feature) => ({
      feature,
      rawValue: resolveBubblePointWeight(feature.point, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFeatures.map((entry) => entry.rawValue));
  const minRadius = Math.max(0, options.minRadius ?? 5);
  const maxRadius = Math.max(minRadius, options.maxRadius ?? 32);

  return weightedFeatures.map(({ feature, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      ...feature,
      rawValue,
      radius: minRadius + Math.sqrt(value) * (maxRadius - minRadius),
      value,
    };
  });
}

function resolveBubblePointWeight<TProperties>(
  point: IndexedMapPoint<TProperties>,
  options: {
    getWeight?: BubbleLayerWeightAccessor<TProperties>;
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

function isValidPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
