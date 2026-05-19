import type { MapMetricRecord } from "./aggregation";
import { filterFiniteMetrics, isRecord, parseTemporalGeoJsonTime } from "./temporal-core";
import type { TemporalMapKeyframe, TemporalMapTrack } from "./temporal-points";

export type TemporalGeoJsonProperties = Record<string, unknown>;

export type TemporalGeoJsonPointFeature<
  TProperties extends TemporalGeoJsonProperties = TemporalGeoJsonProperties,
> = {
  geometry:
    | {
        coordinates: readonly [longitude: number, latitude: number, ...rest: number[]];
        type: "Point";
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

export type TemporalGeoJsonPointFeatureCollection<
  TProperties extends TemporalGeoJsonProperties = TemporalGeoJsonProperties,
> = {
  features: readonly TemporalGeoJsonPointFeature<TProperties>[];
  type: "FeatureCollection";
};

export type TemporalGeoJsonTrackOptions<
  TProperties extends TemporalGeoJsonProperties = TemporalGeoJsonProperties,
  TTrackProperties = TProperties,
> = {
  getLabel?: (
    feature: TemporalGeoJsonPointFeature<TProperties>,
    index: number,
  ) => string | undefined;
  getMetrics?: (
    feature: TemporalGeoJsonPointFeature<TProperties>,
    index: number,
  ) => MapMetricRecord | undefined;
  getProperties?: (
    feature: TemporalGeoJsonPointFeature<TProperties>,
    index: number,
  ) => TTrackProperties | undefined;
  getTime?: (
    feature: TemporalGeoJsonPointFeature<TProperties>,
    index: number,
  ) => number | string | Date | undefined;
  getTrackId?: (
    feature: TemporalGeoJsonPointFeature<TProperties>,
    index: number,
  ) => string | number | undefined;
  getVisible?: (
    feature: TemporalGeoJsonPointFeature<TProperties>,
    index: number,
  ) => boolean | undefined;
  metricKeys?: readonly string[];
};

type MutableTemporalMapTrack<TProperties> = Omit<TemporalMapTrack<TProperties>, "frames"> & {
  frames: TemporalMapKeyframe<TProperties>[];
};

export function createTemporalMapTracksFromGeoJson<
  TProperties extends TemporalGeoJsonProperties = TemporalGeoJsonProperties,
  TTrackProperties = TProperties,
>(
  collection: TemporalGeoJsonPointFeatureCollection<TProperties>,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties> = {},
): Array<TemporalMapTrack<TTrackProperties>> {
  const tracks = new Map<string, MutableTemporalMapTrack<TTrackProperties>>();

  collection.features.forEach((feature, index) => {
    const pointCoordinates = getPointCoordinates(feature);

    if (!pointCoordinates) {
      return;
    }

    const time = parseTemporalGeoJsonTime(readTime(feature, index, options));

    if (!Number.isFinite(time)) {
      return;
    }

    const trackId = readTrackId(feature, index, options);
    const trackKey = String(trackId);
    const label = readLabel(feature, index, options, trackId);
    const frame: TemporalMapKeyframe<TTrackProperties> = {
      latitude: pointCoordinates[1],
      longitude: pointCoordinates[0],
      metrics: readMetrics(feature, index, options),
      properties: readProperties(feature, index, options),
      time,
      visible: readVisible(feature, index, options),
    };
    const track = tracks.get(trackKey);

    if (track) {
      if (track.label === undefined && label !== undefined) {
        track.label = label;
      }

      track.frames.push(frame);
      return;
    }

    tracks.set(trackKey, {
      frames: [frame],
      id: trackId,
      label,
    });
  });

  return [...tracks.values()].map((track) => ({
    ...track,
    frames: [...track.frames].sort((left, right) => left.time - right.time),
  }));
}

function getPointCoordinates<TProperties extends TemporalGeoJsonProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
): [longitude: number, latitude: number] | null {
  const { geometry } = feature;

  if (!geometry) {
    return null;
  }

  if (geometry.type !== "Point") {
    // TODO: Add temporal LineString and Polygon normalization here without changing TemporalMapTrack.
    return null;
  }

  if (!Array.isArray(geometry.coordinates)) {
    return null;
  }

  const [longitude, latitude] = geometry.coordinates;

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  return [longitude, latitude];
}

function readTrackId<TProperties extends TemporalGeoJsonProperties, TTrackProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties>,
) {
  const customTrackId = options.getTrackId?.(feature, index);

  if (customTrackId !== undefined) {
    return customTrackId;
  }

  if (feature.id !== undefined) {
    return feature.id;
  }

  const propertyTrackId = feature.properties?.trackId;

  return typeof propertyTrackId === "string" || typeof propertyTrackId === "number"
    ? propertyTrackId
    : `feature-${index}`;
}

function readTime<TProperties extends TemporalGeoJsonProperties, TTrackProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties>,
): unknown {
  const customTime = options.getTime?.(feature, index);

  if (customTime !== undefined) {
    return customTime;
  }

  return feature.properties?.time ?? feature.properties?.timestamp;
}

function readLabel<TProperties extends TemporalGeoJsonProperties, TTrackProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties>,
  trackId: string | number,
) {
  const customLabel = options.getLabel?.(feature, index);

  if (customLabel !== undefined) {
    return customLabel;
  }

  const propertyLabel = feature.properties?.label;

  return typeof propertyLabel === "string" ? propertyLabel : String(trackId);
}

function readMetrics<TProperties extends TemporalGeoJsonProperties, TTrackProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties>,
): MapMetricRecord {
  const customMetrics = options.getMetrics?.(feature, index);

  if (customMetrics) {
    return filterFiniteMetrics(customMetrics);
  }

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

  return metrics;
}

function readVisible<TProperties extends TemporalGeoJsonProperties, TTrackProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties>,
) {
  const customVisible = options.getVisible?.(feature, index);

  if (customVisible !== undefined) {
    return customVisible;
  }

  return feature.properties?.visible !== false;
}

function readProperties<TProperties extends TemporalGeoJsonProperties, TTrackProperties>(
  feature: TemporalGeoJsonPointFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonTrackOptions<TProperties, TTrackProperties>,
): TTrackProperties {
  const customProperties = options.getProperties?.(feature, index);

  if (customProperties !== undefined) {
    return customProperties;
  }

  return { ...(feature.properties ?? {}) } as TTrackProperties;
}
