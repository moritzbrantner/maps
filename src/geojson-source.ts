import type { MapMetricRecord, MapPoint } from "./aggregation";
import type { MapFlow } from "./flow-layer";
import { cloneGeometry, normalizeGeometryParts } from "./temporal-geojson-geometry";
import { isRecord } from "./temporal-core";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonMapSource<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  TemporalGeoJsonGeometryFeatureCollection<TProperties>;

export type GeoJsonSourceOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties = TProperties,
> = {
  getFeatureId?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
    partIndex?: number,
  ) => string | number | undefined;
  getLabel?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
    partIndex?: number,
  ) => string | undefined;
  getMetrics?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
    partIndex?: number,
  ) => MapMetricRecord | undefined;
  getProperties?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
    partIndex?: number,
  ) => TOutputProperties | undefined;
  metricKeys?: readonly string[];
};

export type GeoJsonOverlayMode = boolean | "all" | "incompatible" | "none";

export type GeoJsonOverlayTarget = "flow" | "point";

export type GeoJsonOverlayOptions = {
  mode?: GeoJsonOverlayMode;
  target?: GeoJsonOverlayTarget;
};

type FlattenedGeoJsonFeature<TProperties extends Record<string, unknown>> = {
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  geometry: TemporalGeoJsonSupportedGeometry;
  index: number;
  partIndex?: number;
};

export function createMapPointsFromGeoJson<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = TProperties,
>(
  collection: GeoJsonMapSource<TProperties>,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties> = {},
): Array<MapPoint<TOutputProperties>> {
  return flattenGeoJsonFeatures(collection).flatMap((entry) => {
    switch (entry.geometry.type) {
      case "Point":
        return [
          createMapPointFromPosition(entry, entry.geometry.coordinates, options, entry.partIndex),
        ];
      case "MultiPoint":
        return entry.geometry.coordinates.map((position, pointIndex) =>
          createMapPointFromPosition(
            entry,
            position,
            options,
            createNestedPartIndex(entry.partIndex, pointIndex),
          ),
        );
      case "LineString":
      case "MultiLineString":
      case "MultiPolygon":
      case "Polygon":
        return [];
    }
  });
}

export function createMapFlowsFromGeoJson<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = TProperties,
>(
  collection: GeoJsonMapSource<TProperties>,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties> = {},
): Array<MapFlow<TOutputProperties>> {
  return flattenGeoJsonFeatures(collection).flatMap((entry) => {
    switch (entry.geometry.type) {
      case "LineString":
        return createMapFlowFromLine(entry, entry.geometry.coordinates, options, entry.partIndex);
      case "MultiLineString":
        return entry.geometry.coordinates.flatMap((line, lineIndex) =>
          createMapFlowFromLine(
            entry,
            line,
            options,
            createNestedPartIndex(entry.partIndex, lineIndex),
          ),
        );
      case "MultiPoint":
      case "MultiPolygon":
      case "Point":
      case "Polygon":
        return [];
    }
  });
}

export function createGeoJsonOverlayFeatureCollection<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: GeoJsonMapSource<TProperties>,
  options: GeoJsonOverlayOptions = {},
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  const mode = normalizeOverlayMode(options.mode);

  if (mode === "none") {
    return { features: [], type: "FeatureCollection" };
  }

  const features = flattenGeoJsonFeatures(collection)
    .filter((entry) => mode === "all" || shouldOverlayGeometry(entry.geometry, options.target ?? "point"))
    .map((entry) => ({
      geometry: cloneGeometry(entry.geometry),
      id: createFeaturePartId(entry.feature, entry.index, entry.partIndex),
      properties: entry.feature.properties ?? null,
      type: "Feature" as const,
    }));

  return {
    features,
    type: "FeatureCollection",
  };
}

export function getBoundsFromGeoJson<TProperties extends Record<string, unknown>>(
  collection: GeoJsonMapSource<TProperties>,
): [west: number, south: number, east: number, north: number] | null {
  const coordinates = flattenGeoJsonFeatures(collection).flatMap((entry) =>
    getGeometryPositions(entry.geometry),
  );

  if (coordinates.length === 0) {
    return null;
  }

  return coordinates.reduce(
    (bounds, [longitude, latitude]) =>
      [
        Math.min(bounds[0], longitude),
        Math.min(bounds[1], latitude),
        Math.max(bounds[2], longitude),
        Math.max(bounds[3], latitude),
      ] as [number, number, number, number],
    [180, 90, -180, -90] as [number, number, number, number],
  );
}

export function mergeMapDataBounds(
  ...bounds: Array<[west: number, south: number, east: number, north: number] | null | undefined>
): [west: number, south: number, east: number, north: number] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const item of bounds) {
    if (!item) {
      continue;
    }

    west = Math.min(west, item[0]);
    south = Math.min(south, item[1]);
    east = Math.max(east, item[2]);
    north = Math.max(north, item[3]);
  }

  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
    return null;
  }

  return [west, south, east, north];
}

export function flattenGeoJsonFeatures<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: GeoJsonMapSource<TProperties>,
): Array<FlattenedGeoJsonFeature<TProperties>> {
  return collection.features.flatMap((feature, index) => {
    const parts = normalizeGeometryParts(feature.geometry);

    return parts.map((part) => ({
      feature,
      geometry: part.geometry,
      index,
      partIndex: parts.length > 1 ? part.partIndex : undefined,
    }));
  });
}

function createMapPointFromPosition<
  TProperties extends Record<string, unknown>,
  TOutputProperties extends Record<string, unknown>,
>(
  entry: FlattenedGeoJsonFeature<TProperties>,
  [longitude, latitude]: GeoJsonPosition,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties>,
  partIndex: number | undefined,
): MapPoint<TOutputProperties> {
  const id = createSourceId(entry.feature, entry.index, partIndex, options);

  return {
    id,
    label: createSourceLabel(entry.feature, entry.index, partIndex, options, id),
    latitude,
    longitude,
    metrics: readMetrics(entry.feature, entry.index, partIndex, options),
    properties: readProperties(entry.feature, entry.index, partIndex, options),
  };
}

function createMapFlowFromLine<
  TProperties extends Record<string, unknown>,
  TOutputProperties extends Record<string, unknown>,
>(
  entry: FlattenedGeoJsonFeature<TProperties>,
  line: readonly GeoJsonPosition[],
  options: GeoJsonSourceOptions<TProperties, TOutputProperties>,
  partIndex: number | undefined,
): Array<MapFlow<TOutputProperties>> {
  if (line.length < 2) {
    return [];
  }

  const id = createSourceId(entry.feature, entry.index, partIndex, options);

  return [
    {
      from: line[0]!,
      id: String(id),
      label: createSourceLabel(entry.feature, entry.index, partIndex, options, id),
      metrics: readMetrics(entry.feature, entry.index, partIndex, options),
      properties: readProperties(entry.feature, entry.index, partIndex, options),
      to: line[line.length - 1]!,
    },
  ];
}

function shouldOverlayGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
  target: GeoJsonOverlayTarget,
) {
  if (target === "point") {
    return geometry.type !== "Point" && geometry.type !== "MultiPoint";
  }

  switch (geometry.type) {
    case "LineString":
      return geometry.coordinates.length > 2;
    case "MultiLineString":
      return geometry.coordinates.some((line) => line.length > 2);
    case "MultiPoint":
    case "MultiPolygon":
    case "Point":
    case "Polygon":
      return true;
  }
}

function createSourceId<
  TProperties extends Record<string, unknown>,
  TOutputProperties,
>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  partIndex: number | undefined,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties>,
) {
  return (
    options.getFeatureId?.(feature, index, partIndex) ??
    createFeaturePartId(feature, index, partIndex)
  );
}

function createFeaturePartId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  partIndex?: number,
) {
  const baseId =
    feature.id ??
    (typeof feature.properties?.id === "string" || typeof feature.properties?.id === "number"
      ? feature.properties.id
      : typeof feature.properties?.trackId === "string" || typeof feature.properties?.trackId === "number"
        ? feature.properties.trackId
      : `feature-${index}`);

  return partIndex === undefined ? String(baseId) : `${String(baseId)}:part-${partIndex}`;
}

function createSourceLabel<TProperties extends Record<string, unknown>, TOutputProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  partIndex: number | undefined,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties>,
  fallback: string | number,
) {
  const customLabel = options.getLabel?.(feature, index, partIndex);

  if (customLabel !== undefined) {
    return customLabel;
  }

  return typeof feature.properties?.label === "string" ? feature.properties.label : String(fallback);
}

function readMetrics<TProperties extends Record<string, unknown>, TOutputProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  partIndex: number | undefined,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties>,
): MapMetricRecord {
  const metrics: MapMetricRecord = {};
  const rawMetrics = feature.properties?.metrics;

  if (isRecord(rawMetrics)) {
    Object.assign(metrics, filterFiniteMetrics(rawMetrics));
  }

  for (const metricKey of options.metricKeys ?? []) {
    const value = feature.properties?.[metricKey];

    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[metricKey] = value;
    }
  }

  const customMetrics = options.getMetrics?.(feature, index, partIndex);

  if (customMetrics) {
    Object.assign(metrics, filterFiniteMetrics(customMetrics));
  }

  return metrics;
}

function readProperties<
  TProperties extends Record<string, unknown>,
  TOutputProperties,
>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  partIndex: number | undefined,
  options: GeoJsonSourceOptions<TProperties, TOutputProperties>,
): TOutputProperties {
  const customProperties = options.getProperties?.(feature, index, partIndex);

  if (customProperties !== undefined) {
    return customProperties;
  }

  return { ...feature.properties } as TOutputProperties;
}

function filterFiniteMetrics(value: Record<string, unknown>): MapMetricRecord {
  const metrics: MapMetricRecord = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      metrics[key] = entry;
    }
  }

  return metrics;
}

function normalizeOverlayMode(mode: GeoJsonOverlayMode | undefined): "all" | "incompatible" | "none" {
  if (mode === true || mode === "all") {
    return "all";
  }

  if (mode === false || mode === "none") {
    return "none";
  }

  return "incompatible";
}

function createNestedPartIndex(parentPartIndex: number | undefined, childPartIndex: number) {
  return parentPartIndex === undefined ? childPartIndex : parentPartIndex * 100_000 + childPartIndex;
}

function getGeometryPositions(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
      return geometry.coordinates;
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
      return geometry.coordinates.flat();
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
}
