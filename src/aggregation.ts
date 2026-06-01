import Supercluster from "supercluster";

export type MapMetricRecord = Record<string, number>;

export type MapPoint<TProperties = Record<string, unknown>> = {
  id?: string | number;
  label?: string;
  latitude: number;
  longitude: number;
  metrics?: MapMetricRecord;
  properties?: TProperties;
};

export type IndexedMapPoint<TProperties = Record<string, unknown>> = Required<MapPoint<TProperties>> & {
  id: string;
};

export type AggregatedMapPoint<TProperties = Record<string, unknown>> = {
  coordinates: [longitude: number, latitude: number];
  kind: "point";
  metrics: MapMetricRecord;
  point: IndexedMapPoint<TProperties>;
};

export type AggregatedMapCluster = {
  clusterId: number;
  coordinates: [longitude: number, latitude: number];
  expansionZoom: number;
  kind: "cluster";
  metrics: MapMetricRecord;
  pointCount: number;
  pointCountAbbreviated: string;
};

export type AggregatedMapFeature<TProperties = Record<string, unknown>> =
  | AggregatedMapCluster
  | AggregatedMapPoint<TProperties>;

export type ViewportAggregationQuery = {
  bounds: [west: number, south: number, east: number, north: number];
  zoom: number;
};

export type VisibleAggregationSummary = {
  bounds: ViewportAggregationQuery["bounds"];
  metrics: MapMetricRecord;
  visibleClusterCount: number;
  visiblePointCount: number;
  visibleUnclusteredCount: number;
  zoom: number;
};

export type ViewportAggregation<TProperties = Record<string, unknown>> = {
  features: Array<AggregatedMapFeature<TProperties>>;
  summary: VisibleAggregationSummary;
};

export type MapDensityViewportSummary = {
  bounds: ViewportAggregationQuery["bounds"];
  itemCount: number;
  kind: "map";
  metricKeys: string[];
  metrics: MapMetricRecord;
  visibleClusterCount: number;
  visiblePointCount: number;
  visibleUnclusteredCount: number;
  zoom: number;
};

export type MapPointFilter<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => boolean;

export type PointAggregationIndexOptions<TProperties = Record<string, unknown>> = {
  extent?: number;
  filterPoint?: MapPointFilter<TProperties>;
  maxZoom?: number;
  minZoom?: number;
  radius?: number;
};

export type PointAggregationIndex<TProperties = Record<string, unknown>> = {
  getClusterExpansionZoom(clusterId: number): number;
  getClusterLeaves(clusterId: number, limit?: number, offset?: number): Array<IndexedMapPoint<TProperties>>;
  getPointById(pointId: string): IndexedMapPoint<TProperties> | null;
  getViewportAggregation(query: ViewportAggregationQuery): ViewportAggregation<TProperties>;
};

type SuperclusterPointProperties = {
  pointId: string;
  [metricKey: string]: number | string;
};

type SuperclusterClusterProperties = MapMetricRecord;

type SuperclusterFeature =
  | Supercluster.ClusterFeature<SuperclusterClusterProperties>
  | Supercluster.PointFeature<SuperclusterPointProperties>;

const compactNumberFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
  notation: "compact",
});

export function createPointAggregationIndex<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: PointAggregationIndexOptions<TProperties> = {},
): PointAggregationIndex<TProperties> {
  const normalizedPoints = points
    .map((point, index) => normalizeMapPoint(point, index))
    .filter(isFiniteMapPoint)
    .filter((point) => options.filterPoint?.(point) ?? true);
  const pointLookup = new Map(normalizedPoints.map((point) => [point.id, point]));
  const metricKeys = collectMapMetricKeys(normalizedPoints.map((point) => point.metrics));
  const tree = new Supercluster<SuperclusterPointProperties, SuperclusterClusterProperties>({
    extent: options.extent ?? 512,
    map: (properties) => mapSuperclusterProperties(properties, metricKeys),
    maxZoom: options.maxZoom ?? 16,
    minZoom: options.minZoom ?? 0,
    radius: options.radius ?? 72,
    reduce: (accumulated, properties) => {
      for (const metricKey of metricKeys) {
        accumulated[metricKey] =
          readNumericMetric(accumulated, metricKey) + readNumericMetric(properties, metricKey);
      }
    },
  });

  tree.load(
    normalizedPoints.map((point) => ({
      geometry: {
        coordinates: [point.longitude, point.latitude],
        type: "Point" as const,
      },
      properties: {
        pointId: point.id,
        ...point.metrics,
      },
      type: "Feature" as const,
    })),
  );

  return {
    getClusterExpansionZoom(clusterId) {
      return tree.getClusterExpansionZoom(clusterId);
    },
    getClusterLeaves(clusterId, limit = 10, offset = 0) {
      return tree
        .getLeaves(clusterId, limit, offset)
        .map((feature) => pointLookup.get(feature.properties.pointId))
        .filter(isDefined);
    },
    getPointById(pointId) {
      return pointLookup.get(pointId) ?? null;
    },
    getViewportAggregation(query) {
      const rawFeatures = getFeaturesForBounds(tree, query.bounds, query.zoom);
      const features = rawFeatures
        .map((feature) => toAggregatedMapFeature(feature, pointLookup, metricKeys, tree))
        .filter(isDefined);

      return {
        features,
        summary: summarizeMapFeatures(query, features, metricKeys),
      };
    },
  };
}

export function createMapDensityViewportSummary<TProperties = Record<string, unknown>>(
  aggregation: ViewportAggregation<TProperties>,
): MapDensityViewportSummary {
  const metricRecords = aggregation.features.map((feature) => feature.metrics);
  const metricKeys = collectMapMetricKeys(metricRecords);

  return {
    bounds: aggregation.summary.bounds,
    itemCount: aggregation.summary.visiblePointCount,
    kind: "map",
    metricKeys,
    metrics: sumMapMetrics(metricRecords, metricKeys),
    visibleClusterCount: aggregation.summary.visibleClusterCount,
    visiblePointCount: aggregation.summary.visiblePointCount,
    visibleUnclusteredCount: aggregation.summary.visibleUnclusteredCount,
    zoom: aggregation.summary.zoom,
  };
}

export function getBoundsFromPoints<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
): [west: number, south: number, east: number, north: number] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let hasPoint = false;

  for (const point of points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
      continue;
    }

    hasPoint = true;
    west = Math.min(west, point.longitude);
    south = Math.min(south, point.latitude);
    east = Math.max(east, point.longitude);
    north = Math.max(north, point.latitude);
  }

  return hasPoint ? [west, south, east, north] : null;
}

function normalizeMapMetrics(metrics: MapMetricRecord | undefined): MapMetricRecord {
  if (!metrics) {
    return {};
  }

  return Object.fromEntries(Object.entries(metrics).filter((entry) => Number.isFinite(entry[1])));
}

function collectMapMetricKeys(metricRecords: readonly (MapMetricRecord | undefined)[]): string[] {
  const metricKeys = new Set<string>();

  for (const metrics of metricRecords) {
    for (const metricKey of Object.keys(metrics ?? {})) {
      metricKeys.add(metricKey);
    }
  }

  return Array.from(metricKeys).sort((left, right) => left.localeCompare(right));
}

function sumMapMetrics(
  metricRecords: readonly (MapMetricRecord | undefined)[],
  metricKeys = collectMapMetricKeys(metricRecords),
): MapMetricRecord {
  const totals = Object.fromEntries(metricKeys.map((metricKey) => [metricKey, 0]));

  for (const metrics of metricRecords) {
    for (const metricKey of metricKeys) {
      totals[metricKey] += readNumericMetric(metrics ?? {}, metricKey);
    }
  }

  return totals;
}

function normalizeMapPoint<TProperties>(
  point: MapPoint<TProperties>,
  index: number,
): IndexedMapPoint<TProperties> {
  return {
    id: String(point.id ?? index),
    label: point.label ?? "",
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: normalizeMapMetrics(point.metrics),
    properties: point.properties ?? ({} as TProperties),
  };
}

function isFiniteMapPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function mapSuperclusterProperties(
  properties: SuperclusterPointProperties,
  metricKeys: readonly string[],
): SuperclusterClusterProperties {
  const aggregated: SuperclusterClusterProperties = {};

  for (const metricKey of metricKeys) {
    aggregated[metricKey] = readNumericMetric(properties, metricKey);
  }

  return aggregated;
}

function getFeaturesForBounds(
  tree: Supercluster<SuperclusterPointProperties, SuperclusterClusterProperties>,
  bounds: ViewportAggregationQuery["bounds"],
  zoom: number,
): SuperclusterFeature[] {
  const roundedZoom = Math.round(zoom);

  if (bounds[0] <= bounds[2]) {
    return tree.getClusters(bounds, roundedZoom);
  }

  const features = [
    ...tree.getClusters([bounds[0], bounds[1], 180, bounds[3]], roundedZoom),
    ...tree.getClusters([-180, bounds[1], bounds[2], bounds[3]], roundedZoom),
  ];
  const seen = new Set<string>();

  return features.filter((feature) => {
    const key =
      feature.properties.cluster === true
        ? `cluster:${feature.properties.cluster_id}`
        : `point:${feature.properties.pointId}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function toAggregatedMapFeature<TProperties>(
  feature: SuperclusterFeature,
  pointLookup: Map<string, IndexedMapPoint<TProperties>>,
  metricKeys: readonly string[],
  tree: Supercluster<SuperclusterPointProperties, SuperclusterClusterProperties>,
): AggregatedMapFeature<TProperties> | null {
  const [longitude, latitude] = feature.geometry.coordinates;

  if (feature.properties.cluster === true) {
    const clusterId = feature.properties.cluster_id;
    const pointCount = feature.properties.point_count;
    const pointCountAbbreviated = feature.properties.point_count_abbreviated;

    if (
      typeof clusterId !== "number" ||
      !Number.isFinite(clusterId) ||
      typeof pointCount !== "number" ||
      !Number.isFinite(pointCount)
    ) {
      return null;
    }

    return {
      clusterId,
      coordinates: [longitude, latitude],
      expansionZoom: tree.getClusterExpansionZoom(clusterId),
      kind: "cluster",
      metrics: getMetricsFromProperties(feature.properties, metricKeys),
      pointCount,
      pointCountAbbreviated:
        typeof pointCountAbbreviated === "string"
          ? pointCountAbbreviated
          : compactNumberFormatter.format(pointCount),
    };
  }

  const pointId = feature.properties.pointId;
  if (typeof pointId !== "string") {
    return null;
  }

  const point = pointLookup.get(pointId);

  if (!point) {
    return null;
  }

  return {
    coordinates: [longitude, latitude],
    kind: "point",
    metrics: point.metrics,
    point,
  };
}

function getMetricsFromProperties(properties: Record<string, unknown>, metricKeys: readonly string[]) {
  const metrics: MapMetricRecord = {};

  for (const metricKey of metricKeys) {
    metrics[metricKey] = readNumericMetric(properties, metricKey);
  }

  return metrics;
}

function summarizeMapFeatures<TProperties>(
  query: ViewportAggregationQuery,
  features: readonly AggregatedMapFeature<TProperties>[],
  metricKeys: readonly string[],
): VisibleAggregationSummary {
  const metrics = Object.fromEntries(metricKeys.map((metricKey) => [metricKey, 0]));
  let visibleClusterCount = 0;
  let visiblePointCount = 0;
  let visibleUnclusteredCount = 0;

  for (const feature of features) {
    if (feature.kind === "cluster") {
      visibleClusterCount += 1;
      visiblePointCount += feature.pointCount;

      for (const metricKey of metricKeys) {
        metrics[metricKey] += feature.metrics[metricKey] ?? 0;
      }

      continue;
    }

    visiblePointCount += 1;
    visibleUnclusteredCount += 1;

    for (const metricKey of metricKeys) {
      metrics[metricKey] += feature.metrics[metricKey] ?? 0;
    }
  }

  return {
    bounds: query.bounds,
    metrics,
    visibleClusterCount,
    visiblePointCount,
    visibleUnclusteredCount,
    zoom: query.zoom,
  };
}

function readNumericMetric(properties: Record<string, unknown>, metricKey: string) {
  const value = properties[metricKey];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isDefined<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}
