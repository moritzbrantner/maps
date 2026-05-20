import type { MapMetricRecord } from "./aggregation";
import {
  filterFiniteMetrics,
  getTemporalMapTimeRange as getTemporalTrackTimeRange,
  interpolateMetrics,
  isRecord,
  mergeMetrics,
  mergeProperties,
  parseTemporalGeoJsonTime,
  type TemporalMapTimeRange,
} from "./temporal-core";
import { cloneGeometry, normalizeSupportedGeometry } from "./temporal-geojson-geometry";
import {
  clampProgress,
  interpolateTemporalGeoJsonGeometry,
  materializePreparedGeometry,
  prepareMatchingGeometryInterpolator,
  resolvePlaybackIndexOptions,
  type PreparedGeometryInterpolator,
  type ResolvedPlaybackIndexOptions,
} from "./temporal-geojson-interpolation";
import type {
  TemporalGeoJsonFrame,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonGeometryTrackOptions,
  TemporalGeoJsonInterpolationOptions,
  TemporalGeoJsonOutputFeature,
  TemporalGeoJsonOutputFeatureCollection,
  TemporalGeoJsonPlaybackIndex,
  TemporalGeoJsonPlaybackIndexOptions,
  TemporalGeoJsonSupportedGeometry,
  TemporalGeoJsonTrack,
} from "./temporal-geojson-types";

export { interpolateTemporalGeoJsonGeometry } from "./temporal-geojson-interpolation";
export type {
  GeoJsonLineStringGeometry,
  GeoJsonMultiLineStringGeometry,
  GeoJsonMultiPolygonGeometry,
  GeoJsonPointGeometry,
  GeoJsonPolygonGeometry,
  GeoJsonPosition,
  TemporalGeoJsonFrame,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonGeometryTrackOptions,
  TemporalGeoJsonInterpolationOptions,
  TemporalGeoJsonInterpolationStrategy,
  TemporalGeoJsonOutputFeature,
  TemporalGeoJsonOutputFeatureCollection,
  TemporalGeoJsonPlaybackIndex,
  TemporalGeoJsonPlaybackIndexOptions,
  TemporalGeoJsonSupportedGeometry,
  TemporalGeoJsonTrack,
} from "./temporal-geojson-types";

type MutableTemporalGeoJsonTrack<TProperties> = Omit<
  TemporalGeoJsonTrack<TProperties>,
  "frames"
> & {
  frames: TemporalGeoJsonFrame<TProperties>[];
};

type PreparedTemporalGeoJsonFrame<TProperties> = Omit<
  TemporalGeoJsonFrame<TProperties>,
  "geometry"
> & {
  geometry: TemporalGeoJsonSupportedGeometry;
};

type PreparedSegmentMode = "hide" | "hold" | "interpolate";

type PreparedTemporalGeoJsonSegment<TProperties> = {
  interpolator: PreparedGeometryInterpolator | null;
  mode: PreparedSegmentMode;
  nextFrame: PreparedTemporalGeoJsonFrame<TProperties>;
  previousFrame: PreparedTemporalGeoJsonFrame<TProperties>;
};

type PreparedTemporalGeoJsonTrack<TProperties> = {
  frames: PreparedTemporalGeoJsonFrame<TProperties>[];
  index: number;
  segments: PreparedTemporalGeoJsonSegment<TProperties>[];
  sourceTrack: TemporalGeoJsonTrack<TProperties>;
  times: number[];
};

export function createTemporalGeoJsonTracksFromGeoJson<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
  TTrackProperties = TProperties,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties> = {},
): Array<TemporalGeoJsonTrack<TTrackProperties>> {
  const tracks = new Map<string, MutableTemporalGeoJsonTrack<TTrackProperties>>();

  collection.features.forEach((feature, index) => {
    const geometry = normalizeSupportedGeometry(feature.geometry);

    if (!geometry) {
      return;
    }

    const time = parseTemporalGeoJsonTime(readTime(feature, index, options));

    if (!Number.isFinite(time)) {
      return;
    }

    const trackId = readTrackId(feature, index, options);
    const trackKey = String(trackId);
    const label = readLabel(feature, index, options, trackId);
    const frame: TemporalGeoJsonFrame<TTrackProperties> = {
      geometry,
      metrics: readMetrics(feature, index, options),
      properties: readProperties(feature, index, options),
      time,
      visible: readVisible(feature, index, options),
    };
    const track = tracks.get(trackKey);

    if (label !== undefined) {
      frame.label = label;
    }

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

export function getTemporalGeoJsonTimeRange<TProperties = Record<string, unknown>>(
  tracks: readonly TemporalGeoJsonTrack<TProperties>[],
): TemporalMapTimeRange | null {
  return getTemporalTrackTimeRange(tracks);
}

export function createTemporalGeoJsonPlaybackIndex<TProperties = Record<string, unknown>>(
  tracks: readonly TemporalGeoJsonTrack<TProperties>[],
  options: TemporalGeoJsonPlaybackIndexOptions = {},
): TemporalGeoJsonPlaybackIndex<TProperties> {
  const resolvedOptions = resolvePlaybackIndexOptions(options);
  const preparedTracks = tracks.map((track, index) =>
    prepareTemporalGeoJsonTrack(track, index, resolvedOptions),
  );
  const timeRange = getPreparedTemporalGeoJsonTimeRange(preparedTracks);

  return {
    getFeatureCollectionAtTime(time) {
      if (!Number.isFinite(time)) {
        return createEmptyFeatureCollection();
      }

      return {
        features: preparedTracks
          .map((track) => resolvePreparedTrackAtTime(track, time))
          .filter(
            (feature): feature is TemporalGeoJsonOutputFeature<TProperties> => feature !== null,
          ),
        type: "FeatureCollection",
      };
    },
    getTimeRange() {
      return timeRange;
    },
  };
}

/**
 * Resolves a temporal GeoJSON feature collection for one-off calls.
 *
 * For playback or repeated lookups, prefer createTemporalGeoJsonPlaybackIndex so frame
 * sorting, normalization, dense geometry resampling, and interpolation setup happen once.
 */
export function getTemporalGeoJsonFeatureCollectionAtTime<TProperties = Record<string, unknown>>(
  tracks: readonly TemporalGeoJsonTrack<TProperties>[],
  time: number,
  options: TemporalGeoJsonInterpolationOptions = {},
): TemporalGeoJsonOutputFeatureCollection<TProperties> {
  if (!Number.isFinite(time)) {
    return createEmptyFeatureCollection();
  }

  return {
    features: tracks
      .map((track, index) => resolveTrackAtTime(track, index, time, options))
      .filter((feature): feature is TemporalGeoJsonOutputFeature<TProperties> => feature !== null),
    type: "FeatureCollection",
  };
}

function createEmptyFeatureCollection<TProperties = Record<string, unknown>>() {
  return {
    features: [],
    type: "FeatureCollection",
  } satisfies TemporalGeoJsonOutputFeatureCollection<TProperties>;
}

function getSortedValidFrames<TProperties>(
  track: TemporalGeoJsonTrack<TProperties>,
): PreparedTemporalGeoJsonFrame<TProperties>[] {
  return track.frames
    .flatMap((frame) => {
      if (!Number.isFinite(frame.time)) {
        return [];
      }

      const geometry = normalizeSupportedGeometry(frame.geometry);

      if (!geometry) {
        return [];
      }

      return [{ ...frame, geometry }];
    })
    .sort((left, right) => left.time - right.time);
}

function getPreparedTemporalGeoJsonTimeRange<TProperties>(
  tracks: readonly PreparedTemporalGeoJsonTrack<TProperties>[],
): TemporalMapTimeRange | null {
  return getTemporalTrackTimeRange(tracks);
}

function prepareTemporalGeoJsonTrack<TProperties>(
  track: TemporalGeoJsonTrack<TProperties>,
  index: number,
  options: ResolvedPlaybackIndexOptions,
): PreparedTemporalGeoJsonTrack<TProperties> {
  const frames = getSortedValidFrames(track);

  return {
    frames,
    index,
    segments: frames
      .slice(0, -1)
      .map((previousFrame, segmentIndex) =>
        prepareTemporalGeoJsonSegment(previousFrame, frames[segmentIndex + 1]!, options),
      ),
    sourceTrack: track,
    times: frames.map((frame) => frame.time),
  };
}

function prepareTemporalGeoJsonSegment<TProperties>(
  previousFrame: PreparedTemporalGeoJsonFrame<TProperties>,
  nextFrame: PreparedTemporalGeoJsonFrame<TProperties>,
  options: ResolvedPlaybackIndexOptions,
): PreparedTemporalGeoJsonSegment<TProperties> {
  if (options.strategy === "hold") {
    return {
      interpolator: null,
      mode: "hold",
      nextFrame,
      previousFrame,
    };
  }

  if (previousFrame.geometry.type !== nextFrame.geometry.type) {
    return {
      interpolator: null,
      mode: options.fallback === "hide" ? "hide" : "hold",
      nextFrame,
      previousFrame,
    };
  }

  const interpolator = prepareMatchingGeometryInterpolator(
    previousFrame.geometry,
    nextFrame.geometry,
    options,
  );

  return {
    interpolator,
    mode: interpolator ? "interpolate" : options.fallback === "hide" ? "hide" : "hold",
    nextFrame,
    previousFrame,
  };
}

function resolvePreparedTrackAtTime<TProperties>(
  track: PreparedTemporalGeoJsonTrack<TProperties>,
  time: number,
): TemporalGeoJsonOutputFeature<TProperties> | null {
  if (track.frames.length === 0) {
    return null;
  }

  const firstFrameAfterTime = findFirstTimeIndexAfter(track.times, time);

  if (firstFrameAfterTime === 0) {
    return null;
  }

  if (firstFrameAfterTime === track.frames.length) {
    const lastFrame = track.frames[track.frames.length - 1]!;

    return lastFrame.visible === false
      ? null
      : toFeature(track.sourceTrack, track.index, lastFrame);
  }

  const previousFrame = track.frames[firstFrameAfterTime - 1]!;

  if (previousFrame.time === time) {
    return previousFrame.visible === false
      ? null
      : toFeature(track.sourceTrack, track.index, previousFrame);
  }

  if (previousFrame.visible === false) {
    return null;
  }

  const nextFrame = track.frames[firstFrameAfterTime]!;
  const progress = clampProgress(
    (time - previousFrame.time) / (nextFrame.time - previousFrame.time),
  );
  const segment = track.segments[firstFrameAfterTime - 1]!;
  const geometry = resolvePreparedSegmentGeometry(segment, progress);

  if (!geometry) {
    return null;
  }

  return toFeature(track.sourceTrack, track.index, {
    geometry,
    label: previousFrame.label,
    metrics: interpolateMetrics(
      mergeMetrics(track.sourceTrack.metrics, previousFrame.metrics),
      mergeMetrics(track.sourceTrack.metrics, nextFrame.metrics),
      progress,
    ),
    properties: mergeProperties(track.sourceTrack.properties, previousFrame.properties),
    time,
    visible: true,
  });
}

function resolvePreparedSegmentGeometry<TProperties>(
  segment: PreparedTemporalGeoJsonSegment<TProperties>,
  progress: number,
): TemporalGeoJsonSupportedGeometry | null {
  if (segment.mode === "hide") {
    return null;
  }

  if (segment.mode === "hold" || !segment.interpolator) {
    return cloneGeometry(segment.previousFrame.geometry);
  }

  return materializePreparedGeometry(segment.interpolator, progress);
}

function findFirstTimeIndexAfter(times: readonly number[], time: number) {
  let low = 0;
  let high = times.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (times[middle]! <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function resolveTrackAtTime<TProperties>(
  track: TemporalGeoJsonTrack<TProperties>,
  index: number,
  time: number,
  options: TemporalGeoJsonInterpolationOptions,
): TemporalGeoJsonOutputFeature<TProperties> | null {
  const frames = getSortedValidFrames(track);

  if (frames.length === 0) {
    return null;
  }

  const firstFrameAfterTime = findFirstTimeIndexAfter(
    frames.map((frame) => frame.time),
    time,
  );

  if (firstFrameAfterTime === 0) {
    return null;
  }

  if (firstFrameAfterTime === frames.length) {
    return frames[frames.length - 1]?.visible === false
      ? null
      : toFeature(track, index, frames[frames.length - 1]!);
  }

  const previousFrame = frames[firstFrameAfterTime - 1]!;

  if (previousFrame.time === time) {
    return previousFrame.visible === false ? null : toFeature(track, index, previousFrame);
  }

  if (previousFrame.visible === false) {
    return null;
  }

  const nextFrame = frames[firstFrameAfterTime]!;
  const progress = (time - previousFrame.time) / (nextFrame.time - previousFrame.time);
  const geometry = interpolateTemporalGeoJsonGeometry(
    previousFrame.geometry,
    nextFrame.geometry,
    progress,
    options,
  );

  if (!geometry) {
    return null;
  }

  return toFeature(track, index, {
    geometry,
    label: previousFrame.label,
    metrics: interpolateMetrics(
      mergeMetrics(track.metrics, previousFrame.metrics),
      mergeMetrics(track.metrics, nextFrame.metrics),
      progress,
    ),
    properties: mergeProperties(track.properties, previousFrame.properties),
    time,
    visible: true,
  });
}

function toFeature<TProperties>(
  track: TemporalGeoJsonTrack<TProperties>,
  index: number,
  frame: TemporalGeoJsonFrame<TProperties>,
): TemporalGeoJsonOutputFeature<TProperties> {
  const trackId = String(track.id ?? index);
  const temporalLabel = frame.label ?? track.label ?? "";
  const metrics = mergeMetrics(track.metrics, frame.metrics);
  const properties = {
    ...(mergeProperties(track.properties, frame.properties) as Record<string, unknown>),
    metrics,
    temporalLabel,
    temporalTrackId: trackId,
  } as TemporalGeoJsonOutputFeature<TProperties>["properties"];

  return {
    geometry: cloneGeometry(frame.geometry),
    id: trackId,
    properties,
    type: "Feature",
  };
}

function readTrackId<TProperties extends Record<string, unknown>, TTrackProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties>,
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

function readTime<TProperties extends Record<string, unknown>, TTrackProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties>,
): unknown {
  const customTime = options.getTime?.(feature, index);

  if (customTime !== undefined) {
    return customTime;
  }

  return feature.properties?.time ?? feature.properties?.timestamp;
}

function readLabel<TProperties extends Record<string, unknown>, TTrackProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties>,
  trackId: string | number,
) {
  const customLabel = options.getLabel?.(feature, index);

  if (customLabel !== undefined) {
    return customLabel;
  }

  const propertyLabel = feature.properties?.label;

  return typeof propertyLabel === "string" ? propertyLabel : String(trackId);
}

function readMetrics<TProperties extends Record<string, unknown>, TTrackProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties>,
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

function readVisible<TProperties extends Record<string, unknown>, TTrackProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties>,
) {
  const customVisible = options.getVisible?.(feature, index);

  if (customVisible !== undefined) {
    return customVisible;
  }

  return feature.properties?.visible !== false;
}

function readProperties<TProperties extends Record<string, unknown>, TTrackProperties>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  options: TemporalGeoJsonGeometryTrackOptions<TProperties, TTrackProperties>,
): TTrackProperties {
  const customProperties = options.getProperties?.(feature, index);

  if (customProperties !== undefined) {
    return customProperties;
  }

  return { ...(feature.properties ?? {}) } as TTrackProperties;
}
