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
import { getMapsTemporalWasmRuntime, type MapsTemporalWasmRuntime } from "./temporal-points-wasm";
import {
  attachTemporalPlaybackWork,
  createTemporalChangeTracker,
  createTemporalPlaybackWork,
  getTemporalPlaybackWork,
} from "./temporal-work";

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

export type TemporalMapPlaybackIndex<TProperties = Record<string, unknown>> = {
  getPointsAtTime(time: number): Array<MapPoint<TProperties>>;
  getTimeRange(): TemporalMapTimeRange | null;
};

type PreparedTemporalMapTrack<TProperties> = {
  frames: Array<TemporalMapKeyframe<TProperties>>;
  index: number;
  sourceTrack: TemporalMapTrack<TProperties>;
  times: number[];
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

  const runtime = getMapsTemporalWasmRuntime();

  if (runtime) {
    const index = createWasmTemporalMapPlaybackIndex(runtime, tracks);

    try {
      return index.getPointsAtTime(time);
    } finally {
      index.dispose();
    }
  }

  return tracks
    .map((track, index) => resolveTrackAtTime(track, index, time))
    .filter((point): point is MapPoint<TProperties> => point !== null);
}

/**
 * Prepares moving point tracks once for repeated sampling. When the Maps Rust/WASM temporal
 * runtime is installed (see `initializeMapsTemporalWasm`), Rust owns keyframe selection,
 * admission and the sampled positions; otherwise the TypeScript reference implementation below
 * samples the same positions.
 */
export function createTemporalMapPlaybackIndex<TProperties = Record<string, unknown>>(
  tracks: readonly TemporalMapTrack<TProperties>[],
): TemporalMapPlaybackIndex<TProperties> {
  const runtime = getMapsTemporalWasmRuntime();

  if (runtime) {
    // Playback indexes have no public dispose: the generated WASM binding frees the Rust index
    // once it is garbage collected.
    const prepared = createWasmTemporalMapPlaybackIndex(runtime, tracks);
    const { dispose: _dispose, ...index } = prepared;
    const work = getTemporalPlaybackWork(prepared);
    if (work) attachTemporalPlaybackWork(index, work);
    return index;
  }

  return createReferenceTemporalMapPlaybackIndex(tracks);
}

const TEMPORAL_KEYFRAME_STRIDE = 4;
const TEMPORAL_SAMPLE_STRIDE = 6;

function createWasmTemporalMapPlaybackIndex<TProperties>(
  runtime: MapsTemporalWasmRuntime,
  tracks: readonly TemporalMapTrack<TProperties>[],
): TemporalMapPlaybackIndex<TProperties> & { dispose(): void } {
  // Labels, properties and metrics are joined from the keyframes as they were at preparation.
  const sourceTracks = tracks.map((track) => ({ frames: [...track.frames], track }));
  const frameCounts = new Uint32Array(sourceTracks.length);
  let keyframeCount = 0;

  sourceTracks.forEach(({ frames }, trackIndex) => {
    frameCounts[trackIndex] = frames.length;
    keyframeCount += frames.length;
  });

  const keyframes = new Float64Array(keyframeCount * TEMPORAL_KEYFRAME_STRIDE);
  let offset = 0;

  for (const { frames } of sourceTracks) {
    for (const frame of frames) {
      keyframes[offset] = numberOrNaN(frame.time);
      keyframes[offset + 1] = numberOrNaN(frame.longitude);
      keyframes[offset + 2] = numberOrNaN(frame.latitude);
      keyframes[offset + 3] = frame.visible === false ? 0 : 1;
      offset += TEMPORAL_KEYFRAME_STRIDE;
    }
  }

  const rustIndex = runtime.createPointIndex(keyframes, frameCounts);
  const range = rustIndex.timeRange();
  const timeRange = range.length === 2 ? { end: range[1]!, start: range[0]! } : null;
  let disposed = false;
  const work = createTemporalPlaybackWork();
  const changes = createTemporalChangeTracker(sourceTracks.length);

  work.trackPreparations += 1;
  work.rustTrackPreparations += 1;
  work.preparedTracks += sourceTracks.length;
  work.preparedKeyframes += keyframeCount;
  work.bridgeBytesToWasm += keyframes.byteLength + frameCounts.byteLength;
  work.bridgeBytesFromWasm += range.byteLength;

  const index: TemporalMapPlaybackIndex<TProperties> & { dispose(): void } = {
    dispose() {
      if (disposed) return;
      disposed = true;
      rustIndex.free?.();
    },
    getPointsAtTime(time) {
      if (disposed) {
        throw new Error("The temporal playback index was disposed.");
      }

      if (!Number.isFinite(time)) {
        return [];
      }

      const samples = rustIndex.sample(time);
      const points: Array<MapPoint<TProperties>> = [];

      work.samples += 1;
      work.sampledTracks += sourceTracks.length;
      work.bridgeBytesFromWasm += samples.byteLength;

      sourceTracks.forEach(({ frames, track }, trackIndex) => {
        const sample = trackIndex * TEMPORAL_SAMPLE_STRIDE;
        const kind = samples[sample];
        const isPresent = kind === 1 || kind === 2;

        if (changes.observe(trackIndex, isPresent, samples[sample + 4]!, samples[sample + 5]!)) {
          work.changedFeatures += 1;
        }

        if (!isPresent) {
          return;
        }

        const previousFrame = frames[samples[sample + 1]!]!;
        const previousMetrics = mergeMetrics(track.metrics, previousFrame.metrics);

        points.push({
          id: String(track.id ?? trackIndex),
          label: previousFrame.label ?? track.label ?? "",
          latitude: samples[sample + 5]!,
          longitude: samples[sample + 4]!,
          metrics:
            kind === 1
              ? previousMetrics
              : interpolateMetrics(
                  previousMetrics,
                  mergeMetrics(track.metrics, frames[samples[sample + 2]!]!.metrics),
                  samples[sample + 3]!,
                ),
          properties: mergeProperties(track.properties, previousFrame.properties),
        });
      });

      work.emittedFeatures += points.length;
      return points;
    },
    getTimeRange() {
      return timeRange;
    },
  };

  attachTemporalPlaybackWork(index, work);
  return index;
}

function numberOrNaN(value: unknown) {
  return typeof value === "number" ? value : Number.NaN;
}

function createReferenceTemporalMapPlaybackIndex<TProperties>(
  tracks: readonly TemporalMapTrack<TProperties>[],
): TemporalMapPlaybackIndex<TProperties> {
  const preparedTracks = tracks.map(prepareTemporalMapTrack);
  const timeRange = getTemporalTrackTimeRange(preparedTracks);
  const work = createTemporalPlaybackWork();
  const changes = createTemporalChangeTracker(preparedTracks.length);

  work.trackPreparations += 1;
  work.preparedTracks += preparedTracks.length;
  work.preparedKeyframes += tracks.reduce((count, track) => count + track.frames.length, 0);

  const index: TemporalMapPlaybackIndex<TProperties> = {
    getPointsAtTime(time) {
      if (!Number.isFinite(time)) {
        return [];
      }

      const points: Array<MapPoint<TProperties>> = [];

      work.samples += 1;
      work.sampledTracks += preparedTracks.length;

      for (const track of preparedTracks) {
        const point = resolvePreparedTrackAtTime(track, time);

        if (
          changes.observe(track.index, point !== null, point?.longitude ?? 0, point?.latitude ?? 0)
        ) {
          work.changedFeatures += 1;
        }

        if (point) {
          points.push(point);
        }
      }

      work.emittedFeatures += points.length;
      return points;
    },
    getTimeRange() {
      return timeRange;
    },
  };

  attachTemporalPlaybackWork(index, work);
  return index;
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

function prepareTemporalMapTrack<TProperties>(
  track: TemporalMapTrack<TProperties>,
  index: number,
): PreparedTemporalMapTrack<TProperties> {
  const frames = getSortedValidFrames(track);

  return {
    frames,
    index,
    sourceTrack: track,
    times: frames.map((frame) => frame.time),
  };
}

function getSortedValidFrames<TProperties>(
  track: TemporalMapTrack<TProperties>,
): Array<TemporalMapKeyframe<TProperties>> {
  return track.frames
    .filter(
      (frame) =>
        Number.isFinite(frame.time) &&
        Number.isFinite(frame.latitude) &&
        Number.isFinite(frame.longitude),
    )
    .sort((left, right) => left.time - right.time);
}

function resolvePreparedTrackAtTime<TProperties>(
  track: PreparedTemporalMapTrack<TProperties>,
  time: number,
): MapPoint<TProperties> | null {
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
      : toMapPoint(track.sourceTrack, track.index, lastFrame);
  }

  const previousFrame = track.frames[firstFrameAfterTime - 1]!;

  if (previousFrame.time === time) {
    return previousFrame.visible === false
      ? null
      : toMapPoint(track.sourceTrack, track.index, previousFrame);
  }

  if (previousFrame.visible === false) {
    return null;
  }

  const nextFrame = track.frames[firstFrameAfterTime]!;
  const progress = (time - previousFrame.time) / (nextFrame.time - previousFrame.time);

  return {
    id: String(track.sourceTrack.id ?? track.index),
    label: previousFrame.label ?? track.sourceTrack.label ?? "",
    latitude: interpolate(previousFrame.latitude, nextFrame.latitude, progress),
    longitude: interpolate(previousFrame.longitude, nextFrame.longitude, progress),
    metrics: interpolateMetrics(
      mergeMetrics(track.sourceTrack.metrics, previousFrame.metrics),
      mergeMetrics(track.sourceTrack.metrics, nextFrame.metrics),
      progress,
    ),
    properties: mergeProperties(track.sourceTrack.properties, previousFrame.properties),
  };
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
