import type { MapMetricRecord, MapPoint } from "./aggregation";
import {
  getTemporalMapTimeRange as getTemporalTrackTimeRange,
  interpolate,
  interpolateMetrics,
  mergeMetrics,
  mergeProperties,
  snapTemporalMapTime,
  type TemporalMapTimeRange,
} from "./temporal-core";

export type TemporalMapKeyframe<TProperties = Record<string, unknown>> = {
  latitude: number;
  longitude: number;
  label?: string;
  metrics?: MapMetricRecord;
  properties?: TProperties;
  time: number;
  visible?: boolean;
};

export type TemporalMapTrack<TProperties = Record<string, unknown>> = {
  id?: string | number;
  label?: string;
  metrics?: MapMetricRecord;
  properties?: TProperties;
  frames: readonly TemporalMapKeyframe<TProperties>[];
};

export { snapTemporalMapTime, type TemporalMapTimeRange };

export function getTemporalMapTimeRange<TProperties = Record<string, unknown>>(
  tracks: readonly TemporalMapTrack<TProperties>[],
): TemporalMapTimeRange | null {
  return getTemporalTrackTimeRange(tracks);
}

export function getTemporalMapPointsAtTime<TProperties = Record<string, unknown>>(
  tracks: readonly TemporalMapTrack<TProperties>[],
  time: number,
): Array<MapPoint<TProperties>> {
  if (!Number.isFinite(time)) {
    return [];
  }

  return tracks
    .map((track, index) => resolveTrackAtTime(track, index, time))
    .filter((point): point is MapPoint<TProperties> => point !== null);
}

function resolveTrackAtTime<TProperties>(
  track: TemporalMapTrack<TProperties>,
  index: number,
  time: number,
): MapPoint<TProperties> | null {
  const frames = [...track.frames]
    .filter(
      (frame) =>
        Number.isFinite(frame.time) &&
        Number.isFinite(frame.latitude) &&
        Number.isFinite(frame.longitude),
    )
    .sort((left, right) => left.time - right.time);

  if (frames.length === 0) {
    return null;
  }

  const firstFrameAfterTime = frames.findIndex((frame) => frame.time > time);

  if (firstFrameAfterTime === 0) {
    return null;
  }

  if (firstFrameAfterTime === -1) {
    return frames[frames.length - 1]?.visible === false
      ? null
      : toMapPoint(track, index, frames[frames.length - 1]!);
  }

  const previousFrame = frames[firstFrameAfterTime - 1]!;

  if (previousFrame.time === time) {
    return previousFrame.visible === false ? null : toMapPoint(track, index, previousFrame);
  }

  if (previousFrame.visible === false) {
    return null;
  }

  const nextFrame = frames[firstFrameAfterTime]!;
  const progress = (time - previousFrame.time) / (nextFrame.time - previousFrame.time);

  return {
    id: String(track.id ?? index),
    label: previousFrame.label ?? track.label ?? "",
    latitude: interpolate(previousFrame.latitude, nextFrame.latitude, progress),
    longitude: interpolate(previousFrame.longitude, nextFrame.longitude, progress),
    metrics: interpolateMetrics(
      mergeMetrics(track.metrics, previousFrame.metrics),
      mergeMetrics(track.metrics, nextFrame.metrics),
      progress,
    ),
    properties: mergeProperties(track.properties, previousFrame.properties),
  };
}

function toMapPoint<TProperties>(
  track: TemporalMapTrack<TProperties>,
  index: number,
  frame: TemporalMapKeyframe<TProperties>,
): MapPoint<TProperties> {
  return {
    id: String(track.id ?? index),
    label: frame.label ?? track.label ?? "",
    latitude: frame.latitude,
    longitude: frame.longitude,
    metrics: mergeMetrics(track.metrics, frame.metrics),
    properties: mergeProperties(track.properties, frame.properties),
  };
}
