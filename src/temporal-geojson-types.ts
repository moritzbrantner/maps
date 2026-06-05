import type { MapMetricRecord } from "./aggregation";
import type { TemporalMapTimeRange } from "./temporal-core";

export type GeoJsonPosition = [longitude: number, latitude: number];

export type GeoJsonPointGeometry = {
  coordinates: GeoJsonPosition;
  type: "Point";
};

export type GeoJsonMultiPointGeometry = {
  coordinates: GeoJsonPosition[];
  type: "MultiPoint";
};

export type GeoJsonLineStringGeometry = {
  coordinates: GeoJsonPosition[];
  type: "LineString";
};

export type GeoJsonMultiLineStringGeometry = {
  coordinates: GeoJsonPosition[][];
  type: "MultiLineString";
};

export type GeoJsonPolygonGeometry = {
  coordinates: GeoJsonPosition[][];
  type: "Polygon";
};

export type GeoJsonMultiPolygonGeometry = {
  coordinates: GeoJsonPosition[][][];
  type: "MultiPolygon";
};

export type TemporalGeoJsonSupportedGeometry =
  | GeoJsonPointGeometry
  | GeoJsonMultiPointGeometry
  | GeoJsonLineStringGeometry
  | GeoJsonMultiLineStringGeometry
  | GeoJsonPolygonGeometry
  | GeoJsonMultiPolygonGeometry;

export type GeoJsonPartMatchingStrategy =
  | "index"
  | "id"
  | "nearest-centroid"
  | "overlap"
  | "auto";

export type TemporalGeoJsonGeometryFeature<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  geometry:
    | TemporalGeoJsonSupportedGeometry
    | {
        geometries?: unknown;
        type: "GeometryCollection";
      }
    | {
        coordinates?: unknown;
        type: string;
      }
    | null;
  id?: string | number;
  properties?: TProperties | null;
  type: "Feature";
};

export type TemporalGeoJsonGeometryFeatureCollection<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  features: readonly TemporalGeoJsonGeometryFeature<TProperties>[];
  type: "FeatureCollection";
};

export type TemporalGeoJsonFrame<TProperties = Record<string, unknown>> = {
  geometry: TemporalGeoJsonSupportedGeometry;
  label?: string;
  metrics?: MapMetricRecord;
  properties?: TProperties;
  time: number;
  visible?: boolean;
};

export type TemporalGeoJsonTrack<TProperties = Record<string, unknown>> = {
  id?: string | number;
  label?: string;
  metrics?: MapMetricRecord;
  properties?: TProperties;
  frames: readonly TemporalGeoJsonFrame<TProperties>[];
};

export type TemporalGeoJsonInterpolationStrategy =
  | "hold"
  | "compatible"
  | "resample"
  | "vertex-union"
  | "centroid-radial";

export type TemporalGeoJsonInterpolationOptions = {
  fallback?: "hold" | "hide";
  maxCoordinatesPerLine?: number;
  maxCoordinatesPerRing?: number;
  minResampleCoordinates?: number;
  partMatchingStrategy?: Exclude<GeoJsonPartMatchingStrategy, "overlap">;
  strategy?: TemporalGeoJsonInterpolationStrategy;
};

/**
 * Preparation options for repeated temporal GeoJSON playback sampling.
 *
 * Dense geometry can be resampled once during index creation so animation
 * frames avoid repeatedly preparing the same rings and lines.
 */
export type TemporalGeoJsonPlaybackIndexOptions = TemporalGeoJsonInterpolationOptions & {
  denseGeometryBehavior?: "preserve" | "resample";
  denseLineThreshold?: number;
  denseRingThreshold?: number;
};

export type TemporalGeoJsonGeometryTrackOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
  TTrackProperties = TProperties,
> = {
  getLabel?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => string | undefined;
  getMetrics?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => MapMetricRecord | undefined;
  getProperties?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => TTrackProperties | undefined;
  getTime?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => number | string | Date | undefined;
  getTrackId?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => string | number | undefined;
  getVisible?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => boolean | undefined;
  metricKeys?: readonly string[];
};

export type TemporalGeoJsonOutputFeature<TProperties = Record<string, unknown>> = {
  geometry: TemporalGeoJsonSupportedGeometry;
  id: string;
  properties: TProperties & {
    metrics: MapMetricRecord;
    temporalLabel: string;
    temporalTrackId: string;
  };
  type: "Feature";
};

export type TemporalGeoJsonOutputFeatureCollection<TProperties = Record<string, unknown>> = {
  features: Array<TemporalGeoJsonOutputFeature<TProperties>>;
  type: "FeatureCollection";
};

/**
 * Precomputed temporal GeoJSON sampler for playback loops and animation frames.
 */
export type TemporalGeoJsonPlaybackIndex<TProperties = Record<string, unknown>> = {
  getFeatureCollectionAtTime(time: number): TemporalGeoJsonOutputFeatureCollection<TProperties>;
  getTimeRange(): TemporalMapTimeRange | null;
};
