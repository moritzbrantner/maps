import type { MapMetricRecord } from "./aggregation";

export type TemporalMapTimeRange = {
  end: number;
  start: number;
};

export type TemporalFrameWithTime = {
  time: number;
};

export type TemporalTrackWithFrames<TFrame extends TemporalFrameWithTime> = {
  frames: readonly TFrame[];
};

export function snapTemporalMapTime(
  time: number,
  timeRange: TemporalMapTimeRange,
  step: number | "any" | undefined,
) {
  if (step === "any" || !Number.isFinite(step) || (step ?? 0) <= 0) {
    return clampTemporalMapTime(time, timeRange);
  }

  const numericStep = Number(step);
  const clampedTime = clampTemporalMapTime(time, timeRange);

  if (clampedTime === timeRange.end) {
    return timeRange.end;
  }

  const stepOffset = clampedTime - timeRange.start;
  const snappedTime = timeRange.start + Math.floor(stepOffset / numericStep) * numericStep;

  return clampTemporalMapTime(snappedTime, timeRange);
}

export function getTemporalMapTimeRange<
  TFrame extends TemporalFrameWithTime,
  TTrack extends TemporalTrackWithFrames<TFrame>,
>(tracks: readonly TTrack[]): TemporalMapTimeRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  for (const track of tracks) {
    for (const frame of track.frames) {
      if (!Number.isFinite(frame.time)) {
        continue;
      }

      start = Math.min(start, frame.time);
      end = Math.max(end, frame.time);
    }
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return { end, start };
}

export function clampTemporalMapTime(time: number, timeRange: TemporalMapTimeRange) {
  if (!Number.isFinite(time)) {
    return timeRange.start;
  }

  return Math.min(Math.max(time, timeRange.start), timeRange.end);
}

export function parseTemporalGeoJsonTime(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const numericValue = Number(value);

    if (Number.isFinite(numericValue) && value.trim() !== "") {
      return numericValue;
    }

    return Date.parse(value);
  }

  return Number.NaN;
}

export function interpolate(left: number, right: number, progress: number) {
  return left + (right - left) * progress;
}

export function interpolateMetrics(
  previousMetrics: MapMetricRecord,
  nextMetrics: MapMetricRecord,
  progress: number,
): MapMetricRecord {
  const keys = new Set([...Object.keys(previousMetrics), ...Object.keys(nextMetrics)]);

  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      interpolate(previousMetrics[key] ?? 0, nextMetrics[key] ?? 0, progress),
    ]),
  );
}

export function mergeMetrics(
  baseMetrics: MapMetricRecord | undefined,
  frameMetrics: MapMetricRecord | undefined,
): MapMetricRecord {
  return {
    ...(baseMetrics ?? {}),
    ...(frameMetrics ?? {}),
  };
}

export function mergeProperties<TProperties>(
  baseProperties: TProperties | undefined,
  frameProperties: TProperties | undefined,
): TProperties {
  return {
    ...(baseProperties as Record<string, unknown> | undefined),
    ...(frameProperties as Record<string, unknown> | undefined),
  } as TProperties;
}

export function filterFiniteMetrics(record: Record<string, unknown>): MapMetricRecord {
  const metrics: MapMetricRecord = {};

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[key] = value;
    }
  }

  return metrics;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
