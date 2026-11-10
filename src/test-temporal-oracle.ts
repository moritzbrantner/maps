/**
 * Independent reference samplers for temporal tests (#172 Correct). They state the temporal
 * edge policy directly, by scanning every keyframe for each sample, and share no code with the
 * prepared playback indexes or their interpolation helpers.
 */

type OracleMetrics = Record<string, number>;

type OracleFrame = {
  label?: string;
  metrics?: OracleMetrics;
  properties?: unknown;
  time: number;
  visible?: boolean;
};

type OracleTrack<TFrame extends OracleFrame> = {
  frames: readonly TFrame[];
  id?: string | number;
  label?: string;
  metrics?: OracleMetrics;
  properties?: unknown;
};

type OraclePointFrame = OracleFrame & { latitude: number; longitude: number };

type OracleGeometry = { coordinates: unknown; type: string };

type OracleGeometryFrame = OracleFrame & { geometry: OracleGeometry };

type Bracket<TFrame> = { next: TFrame | undefined; previous: TFrame };

/**
 * The keyframe in effect at `time` and the keyframe after it.
 *
 * Of the keyframes at or before `time`, the latest one is in effect; when several share that
 * time, the one declared last wins. The keyframe after it is the earliest later one; when
 * several share that time, the one declared first is the interpolation target.
 */
function bracket<TFrame extends OracleFrame>(frames: readonly TFrame[], time: number): Bracket<TFrame> | null {
  let previous: TFrame | undefined;
  let next: TFrame | undefined;

  for (const frame of frames) {
    if (frame.time <= time) {
      if (!previous || frame.time >= previous.time) {
        previous = frame;
      }
    } else if (!next || frame.time < next.time) {
      next = frame;
    }
  }

  return previous ? { next, previous } : null;
}

function mix(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function mixMetrics(from: OracleMetrics, to: OracleMetrics, progress: number) {
  const mixed: OracleMetrics = {};

  for (const key of Object.keys(from)) {
    mixed[key] = mix(from[key]!, to[key] ?? 0, progress);
  }

  for (const key of Object.keys(to)) {
    if (!(key in from)) {
      mixed[key] = mix(0, to[key]!, progress);
    }
  }

  return mixed;
}

type Resolved<TFrame extends OracleFrame> = {
  frame: TFrame;
  id: string;
  label: string;
  metrics: OracleMetrics;
  next: TFrame | undefined;
  progress: number;
  properties: Record<string, unknown>;
};

/** Shared track policy: admission, removal, hold-after-end and attribute interpolation. */
function resolve<TFrame extends OracleFrame>(
  track: OracleTrack<TFrame>,
  trackIndex: number,
  validFrames: readonly TFrame[],
  time: number,
): Resolved<TFrame> | null {
  const found = Number.isFinite(time) ? bracket(validFrames, time) : null;

  // Absent before its first keyframe, and from an invisible keyframe until the next keyframe.
  if (!found || found.previous.visible === false) {
    return null;
  }

  const { next, previous } = found;
  // Exactly on a keyframe, or after the last one, the keyframe is held as declared.
  const moving = next !== undefined && previous.time !== time;
  const progress = moving ? (time - previous.time) / (next.time - previous.time) : 0;
  const previousMetrics = { ...track.metrics, ...previous.metrics };

  return {
    frame: previous,
    id: String(track.id ?? trackIndex),
    label: previous.label ?? track.label ?? "",
    metrics: moving
      ? mixMetrics(previousMetrics, { ...track.metrics, ...next.metrics }, progress)
      : previousMetrics,
    next: moving ? next : undefined,
    progress,
    properties: {
      ...(track.properties as Record<string, unknown> | undefined),
      ...(previous.properties as Record<string, unknown> | undefined),
    },
  };
}

export type OraclePoint = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  metrics: OracleMetrics;
  properties: Record<string, unknown>;
};

/** Reference sample of moving point tracks: coordinates are linear in time as supplied. */
export function sampleTemporalPointsNaively(
  tracks: readonly OracleTrack<OraclePointFrame>[],
  time: number,
): OraclePoint[] {
  const points: OraclePoint[] = [];

  tracks.forEach((track, trackIndex) => {
    const validFrames = track.frames.filter(
      (frame) =>
        Number.isFinite(frame.time) && Number.isFinite(frame.latitude) && Number.isFinite(frame.longitude),
    );
    const resolved = resolve(track, trackIndex, validFrames, time);

    if (!resolved) {
      return;
    }

    const { frame, next, progress } = resolved;

    points.push({
      id: resolved.id,
      label: resolved.label,
      latitude: next ? mix(frame.latitude, next.latitude, progress) : frame.latitude,
      longitude: next ? mix(frame.longitude, next.longitude, progress) : frame.longitude,
      metrics: resolved.metrics,
      properties: resolved.properties,
    });
  });

  return points;
}

/** Same nesting and lengths all the way down to the coordinate numbers. */
function sameShape(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => sameShape(entry, right[index]));
  }

  return typeof left === "number" && typeof right === "number";
}

function mixCoordinates(from: unknown, to: unknown, progress: number): unknown {
  return Array.isArray(from)
    ? from.map((entry, index) => mixCoordinates(entry, (to as unknown[])[index], progress))
    : mix(from as number, to as number, progress);
}

export type OracleFeature = {
  geometry: OracleGeometry;
  id: string;
  properties: Record<string, unknown>;
  type: "Feature";
};

/**
 * Reference sample of temporal GeoJSON tracks under the default `compatible` strategy with the
 * `hold` fallback: geometries of the same type and vertex layout move vertex by vertex, and any
 * other transition holds the earlier geometry until the next keyframe.
 */
export function sampleTemporalGeoJsonNaively(
  tracks: readonly OracleTrack<OracleGeometryFrame>[],
  time: number,
): OracleFeature[] {
  const features: OracleFeature[] = [];

  tracks.forEach((track, trackIndex) => {
    const validFrames = track.frames.filter((frame) => Number.isFinite(frame.time));
    const resolved = resolve(track, trackIndex, validFrames, time);

    if (!resolved) {
      return;
    }

    const { frame, next, progress } = resolved;
    const compatible =
      next !== undefined &&
      next.geometry.type === frame.geometry.type &&
      sameShape(frame.geometry.coordinates, next.geometry.coordinates);

    features.push({
      geometry: {
        coordinates: compatible
          ? mixCoordinates(frame.geometry.coordinates, next.geometry.coordinates, progress)
          : frame.geometry.coordinates,
        type: frame.geometry.type,
      },
      id: resolved.id,
      properties: {
        ...resolved.properties,
        metrics: resolved.metrics,
        temporalLabel: resolved.label,
        temporalTrackId: resolved.id,
      },
      type: "Feature",
    });
  });

  return features;
}
