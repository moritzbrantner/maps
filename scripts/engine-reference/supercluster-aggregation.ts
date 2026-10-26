// Validation-only oracle. Never imported by the Maps runtime or package entries.
import Supercluster from "supercluster";

type Metrics = Record<string, number>;
type InputPoint = {
  id?: string | number;
  label?: string;
  latitude: number;
  longitude: number;
  metrics?: Metrics;
};
type Point = Omit<InputPoint, "id" | "label" | "metrics"> & {
  id: string;
  label: string;
  metrics: Metrics;
};
type Options = { extent?: number; maxZoom?: number; minZoom?: number; radius?: number };
type Query = { bounds: [number, number, number, number]; zoom: number };
type Feature = {
  coordinates: [number, number];
  metrics: Metrics;
} & (
  | { kind: "point"; point: Point }
  | { kind: "cluster"; clusterId: number; expansionZoom: number; pointCount: number }
);

export function createSuperclusterReference(points: readonly InputPoint[], options: Options) {
  const normalized: Point[] = points
    .map((point, index) => ({
      ...point,
      id: String(point.id ?? index),
      label: point.label ?? "",
      metrics: Object.fromEntries(
        Object.entries(point.metrics ?? {}).filter(([, value]) => Number.isFinite(value)),
      ),
    }))
    .filter(({ latitude, longitude }) => Number.isFinite(latitude) && Number.isFinite(longitude));
  const lookup = new Map(normalized.map((point) => [point.id, point]));
  const metricKeys = [...new Set(normalized.flatMap(({ metrics }) => Object.keys(metrics)))].sort();
  const tree = new Supercluster<{ pointId: string; metrics: Metrics }, { metrics: Metrics }>({
    extent: options.extent ?? 512,
    maxZoom: options.maxZoom ?? 16,
    minZoom: options.minZoom ?? 0,
    radius: options.radius ?? 72,
    map: ({ metrics }) => ({
      metrics: Object.fromEntries(metricKeys.map((key) => [key, metrics[key] ?? 0])),
    }),
    reduce: (accumulated, properties) => {
      // Supercluster shallow-copies cluster properties between zoom levels.
      // Replace the nested metrics record instead of mutating a finer cluster.
      accumulated.metrics = Object.fromEntries(
        metricKeys.map((key) => [
          key,
          (accumulated.metrics[key] ?? 0) + (properties.metrics[key] ?? 0),
        ]),
      );
    },
  });
  tree.load(
    normalized.map((point) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
      properties: { pointId: point.id, metrics: point.metrics },
    })),
  );

  function pointById(id: string) {
    const point = lookup.get(id);
    if (!point) {
      throw new Error(`reference returned unknown point ${id}`);
    }
    return point;
  }

  return {
    dispose() {},
    getPointById(id: string) {
      return lookup.get(id) ?? null;
    },
    getClusterExpansionZoom(id: number) {
      return tree.getClusterExpansionZoom(id);
    },
    getClusterLeaves(id: number, limit = 10, offset = 0) {
      return tree
        .getLeaves(id, limit, offset)
        .map(({ properties }) => pointById(properties.pointId));
    },
    getViewportAggregation(query: Query) {
      const features: Feature[] = tree
        .getClusters(query.bounds, Math.round(query.zoom))
        .map((raw) => {
          const [longitude, latitude] = raw.geometry.coordinates;
          if (longitude === undefined || latitude === undefined) {
            throw new Error("reference returned an invalid coordinate");
          }
          if ("pointId" in raw.properties) {
            const point = pointById(raw.properties.pointId);
            return {
              kind: "point",
              coordinates: [longitude, latitude],
              metrics: point.metrics,
              point,
            };
          }
          return {
            kind: "cluster",
            coordinates: [longitude, latitude],
            metrics: raw.properties.metrics,
            clusterId: raw.properties.cluster_id,
            expansionZoom: tree.getClusterExpansionZoom(raw.properties.cluster_id),
            pointCount: raw.properties.point_count,
          };
        });
      return {
        features,
        summary: {
          bounds: query.bounds,
          zoom: query.zoom,
          metrics: Object.fromEntries(
            metricKeys.map((key) => [
              key,
              features.reduce((sum, feature) => sum + (feature.metrics[key] ?? 0), 0),
            ]),
          ),
          visibleClusterCount: features.filter(({ kind }) => kind === "cluster").length,
          visibleUnclusteredCount: features.filter(({ kind }) => kind === "point").length,
          visiblePointCount: features.reduce(
            (sum, feature) => sum + (feature.kind === "cluster" ? feature.pointCount : 1),
            0,
          ),
        },
      };
    },
  };
}
