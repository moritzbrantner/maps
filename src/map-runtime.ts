import type { IndexedMapPoint, MapMetricRecord, MapPoint } from "./aggregation";
import type { GeoJsonMapSource } from "./geojson-source";

export type MapRuntimePoint<TProperties = Record<string, unknown>> = IndexedMapPoint<TProperties>;

export type MapRuntimeFlow<TProperties = Record<string, unknown>> = {
  from: [longitude: number, latitude: number];
  id?: string;
  label?: string;
  metrics?: MapMetricRecord;
  properties?: TProperties;
  to: [longitude: number, latitude: number];
};

export type MapRuntimeDataset<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> =
  | { kind: "geo-points"; points: readonly MapPoint<TProperties>[] }
  | { featureCollection: GeoJsonMapSource<TProperties>; kind: "geojson" }
  | { flows: readonly MapRuntimeFlow<TProperties>[]; kind: "geo-flows" };

export type MapRuntimeRenderLayer<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> =
  | { features: Array<MapRuntimePoint<TProperties>>; kind: "geo-points"; layerId: string }
  | { featureCollection: GeoJsonMapSource<TProperties>; kind: "geojson"; layerId: string };

export function createMapRuntimeRenderLayer(
  dataset: MapRuntimeDataset | null,
  kind: "geo-points" | "geojson",
  layerId: string,
): MapRuntimeRenderLayer | null {
  if (!dataset || dataset.kind !== kind) return null;

  if (dataset.kind === "geo-points") {
    return {
      features: dataset.points.map(normalizeRuntimePoint).filter(isFiniteRuntimePoint),
      kind: "geo-points",
      layerId,
    };
  }

  return { featureCollection: dataset.featureCollection, kind: "geojson", layerId };
}

function normalizeRuntimePoint<TProperties>(
  point: MapPoint<TProperties>,
  index: number,
): MapRuntimePoint<TProperties> {
  return {
    id: String(point.id ?? index),
    label: point.label ?? "",
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: Object.fromEntries(
      Object.entries(point.metrics ?? {}).filter(([, value]) => Number.isFinite(value)),
    ),
    properties: point.properties ?? ({} as TProperties),
  };
}

function isFiniteRuntimePoint<TProperties>(
  point: MapRuntimePoint<TProperties>,
): point is MapRuntimePoint<TProperties> {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}
