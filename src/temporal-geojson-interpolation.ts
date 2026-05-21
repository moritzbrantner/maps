import { centroid } from "@turf/centroid";
import { polygon as createTurfPolygon } from "@turf/helpers";

import { getMapsKernelRuntime } from "./kernels/runtime";
import { interpolate } from "./temporal-core";
import {
  alignRingStart,
  cloneGeometry,
  clonePosition,
  closeRing,
  getOpenRing,
  normalizeRing,
  orientRingLike,
} from "./temporal-geojson-geometry";
import type {
  GeoJsonLineStringGeometry,
  GeoJsonMultiLineStringGeometry,
  GeoJsonMultiPointGeometry,
  GeoJsonMultiPolygonGeometry,
  GeoJsonPointGeometry,
  GeoJsonPolygonGeometry,
  GeoJsonPosition,
  TemporalGeoJsonInterpolationOptions,
  TemporalGeoJsonPlaybackIndexOptions,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type ResolvedInterpolationOptions = Required<TemporalGeoJsonInterpolationOptions>;

export type ResolvedPlaybackIndexOptions = ResolvedInterpolationOptions & {
  denseGeometryBehavior: "preserve" | "resample";
  denseLineThreshold: number;
  denseRingThreshold: number;
};

export type PreparedFlatCoordinates = {
  coordinateCount: number;
  delta: Float64Array;
  start: Float64Array;
};

export type PreparedGeometryInterpolator =
  | {
      point: PreparedFlatCoordinates;
      type: "Point";
    }
  | {
      points: PreparedFlatCoordinates;
      type: "MultiPoint";
    }
  | {
      line: PreparedFlatCoordinates;
      type: "LineString";
    }
  | {
      lines: PreparedFlatCoordinates[];
      type: "MultiLineString";
    }
  | {
      rings: PreparedFlatCoordinates[];
      type: "Polygon";
    }
  | {
      polygons: PreparedFlatCoordinates[][];
      type: "MultiPolygon";
    };

const DEFAULT_INTERPOLATION_OPTIONS: ResolvedInterpolationOptions = {
  fallback: "hold",
  maxCoordinatesPerLine: 512,
  maxCoordinatesPerRing: 512,
  minResampleCoordinates: 16,
  strategy: "compatible",
};

export function interpolateTemporalGeoJsonGeometry(
  previousGeometry: TemporalGeoJsonSupportedGeometry,
  nextGeometry: TemporalGeoJsonSupportedGeometry,
  progress: number,
  options: TemporalGeoJsonInterpolationOptions = {},
): TemporalGeoJsonSupportedGeometry | null {
  const resolvedOptions = resolveInterpolationOptions(options);

  if (!Number.isFinite(progress)) {
    return applyInterpolationFallback(previousGeometry, resolvedOptions);
  }

  if (resolvedOptions.strategy === "hold") {
    return cloneGeometry(previousGeometry);
  }

  if (previousGeometry.type !== nextGeometry.type) {
    return applyInterpolationFallback(previousGeometry, resolvedOptions);
  }

  const geometry = interpolateMatchingGeometry(
    previousGeometry,
    nextGeometry,
    clampProgress(progress),
    resolvedOptions,
  );

  return geometry ?? applyInterpolationFallback(previousGeometry, resolvedOptions);
}

export function prepareMatchingGeometryInterpolator(
  previousGeometry: TemporalGeoJsonSupportedGeometry,
  nextGeometry: TemporalGeoJsonSupportedGeometry,
  options: ResolvedPlaybackIndexOptions,
): PreparedGeometryInterpolator | null {
  switch (previousGeometry.type) {
    case "Point":
      return {
        point: createPreparedFlatCoordinates(
          [previousGeometry.coordinates],
          [(nextGeometry as GeoJsonPointGeometry).coordinates],
        ),
        type: "Point",
      };
    case "MultiPoint": {
      const nextPoints = (nextGeometry as GeoJsonMultiPointGeometry).coordinates;

      if (previousGeometry.coordinates.length !== nextPoints.length) {
        return null;
      }

      return {
        points: createPreparedFlatCoordinates(previousGeometry.coordinates, nextPoints),
        type: "MultiPoint",
      };
    }
    case "LineString": {
      const line = prepareLineInterpolator(
        previousGeometry.coordinates,
        (nextGeometry as GeoJsonLineStringGeometry).coordinates,
        options,
      );

      return line ? { line, type: "LineString" } : null;
    }
    case "MultiLineString": {
      const nextLines = (nextGeometry as GeoJsonMultiLineStringGeometry).coordinates;

      if (previousGeometry.coordinates.length !== nextLines.length) {
        return null;
      }

      const lines = previousGeometry.coordinates.map((line, index) =>
        prepareLineInterpolator(line, nextLines[index]!, options),
      );

      return lines.some((line) => line === null)
        ? null
        : { lines: lines as PreparedFlatCoordinates[], type: "MultiLineString" };
    }
    case "Polygon": {
      const rings = preparePolygonInterpolators(
        previousGeometry.coordinates,
        (nextGeometry as GeoJsonPolygonGeometry).coordinates,
        options,
      );

      return rings ? { rings, type: "Polygon" } : null;
    }
    case "MultiPolygon": {
      const nextPolygons = (nextGeometry as GeoJsonMultiPolygonGeometry).coordinates;

      if (previousGeometry.coordinates.length !== nextPolygons.length) {
        return null;
      }

      const polygons = previousGeometry.coordinates.map((polygon, index) =>
        preparePolygonInterpolators(polygon, nextPolygons[index]!, options),
      );

      return polygons.some((polygon) => polygon === null)
        ? null
        : { polygons: polygons as PreparedFlatCoordinates[][], type: "MultiPolygon" };
    }
  }
}

function prepareLineInterpolator(
  previousCoordinates: readonly GeoJsonPosition[],
  nextCoordinates: readonly GeoJsonPosition[],
  options: ResolvedPlaybackIndexOptions,
): PreparedFlatCoordinates | null {
  const shouldForceResample =
    options.denseGeometryBehavior === "resample" &&
    Math.max(previousCoordinates.length, nextCoordinates.length) >
      Math.max(2, options.denseLineThreshold);

  if (options.strategy === "compatible" && !shouldForceResample) {
    if (previousCoordinates.length !== nextCoordinates.length || previousCoordinates.length < 2) {
      return null;
    }

    return createPreparedFlatCoordinates(previousCoordinates, nextCoordinates);
  }

  if (
    options.strategy !== "resample" &&
    options.strategy !== "centroid-radial" &&
    !(options.strategy === "compatible" && shouldForceResample)
  ) {
    return null;
  }

  const coordinateCount = clampInteger(
    Math.max(previousCoordinates.length, nextCoordinates.length, options.minResampleCoordinates, 2),
    2,
    options.maxCoordinatesPerLine,
  );

  return createPreparedFlatCoordinates(
    resampleLine(previousCoordinates, coordinateCount),
    resampleLine(nextCoordinates, coordinateCount),
  );
}

function preparePolygonInterpolators(
  previousCoordinates: readonly GeoJsonPosition[][],
  nextCoordinates: readonly GeoJsonPosition[][],
  options: ResolvedPlaybackIndexOptions,
): PreparedFlatCoordinates[] | null {
  if (previousCoordinates.length !== nextCoordinates.length) {
    return null;
  }

  const rings = previousCoordinates.map((ring, index) =>
    preparePolygonRingInterpolator(ring, nextCoordinates[index]!, options),
  );

  return rings.some((ring) => ring === null) ? null : (rings as PreparedFlatCoordinates[]);
}

function preparePolygonRingInterpolator(
  previousRing: readonly GeoJsonPosition[],
  nextRing: readonly GeoJsonPosition[],
  options: ResolvedPlaybackIndexOptions,
): PreparedFlatCoordinates | null {
  const previousOpenRing = getOpenRing(previousRing);
  const nextOpenRing = getOpenRing(nextRing);

  if (!previousOpenRing || !nextOpenRing) {
    return null;
  }

  const shouldForceResample =
    options.denseGeometryBehavior === "resample" &&
    Math.max(previousOpenRing.length, nextOpenRing.length) >
      Math.max(3, options.denseRingThreshold);

  if (options.strategy === "compatible" && !shouldForceResample) {
    if (previousOpenRing.length !== nextOpenRing.length) {
      return null;
    }

    return createPreparedFlatCoordinates(previousOpenRing, nextOpenRing);
  }

  if (options.strategy === "compatible" && shouldForceResample) {
    return createPreparedFlatCoordinates(
      ...prepareResampledRingPair(previousOpenRing, nextOpenRing, options),
    );
  }

  if (options.strategy === "resample") {
    return createPreparedFlatCoordinates(
      ...prepareResampledRingPair(previousOpenRing, nextOpenRing, options),
    );
  }

  if (options.strategy === "centroid-radial") {
    const coordinateCount = clampInteger(
      Math.max(previousOpenRing.length, nextOpenRing.length, options.minResampleCoordinates, 3),
      3,
      options.maxCoordinatesPerRing,
    );

    return createPreparedFlatCoordinates(
      sampleRingByAngle(previousOpenRing, coordinateCount),
      sampleRingByAngle(nextOpenRing, coordinateCount),
    );
  }

  return null;
}

function prepareResampledRingPair(
  previousOpenRing: readonly GeoJsonPosition[],
  nextOpenRing: readonly GeoJsonPosition[],
  options: ResolvedPlaybackIndexOptions,
): [GeoJsonPosition[], GeoJsonPosition[]] {
  const orientedNextRing = orientRingLike(nextOpenRing, previousOpenRing);
  const alignedNextRing = alignRingStart(orientedNextRing, previousOpenRing[0]!);
  const coordinateCount = clampInteger(
    Math.max(previousOpenRing.length, alignedNextRing.length, options.minResampleCoordinates, 3),
    3,
    options.maxCoordinatesPerRing,
  );

  return [
    resampleRing(previousOpenRing, coordinateCount),
    resampleRing(alignedNextRing, coordinateCount),
  ];
}

export function materializePreparedGeometry(
  interpolator: PreparedGeometryInterpolator,
  progress: number,
): TemporalGeoJsonSupportedGeometry {
  switch (interpolator.type) {
    case "Point":
      return {
        coordinates: materializePreparedPositions(interpolator.point, progress)[0]!,
        type: "Point",
      };
    case "MultiPoint":
      return {
        coordinates: materializePreparedPositions(interpolator.points, progress),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: materializePreparedPositions(interpolator.line, progress),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: interpolator.lines.map((line) => materializePreparedPositions(line, progress)),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: interpolator.rings.map((ring) =>
          closeRing(materializePreparedPositions(ring, progress)),
        ),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: interpolator.polygons.map((polygon) =>
          polygon.map((ring) => closeRing(materializePreparedPositions(ring, progress))),
        ),
        type: "MultiPolygon",
      };
  }
}

function createPreparedFlatCoordinates(
  previousCoordinates: readonly GeoJsonPosition[],
  nextCoordinates: readonly GeoJsonPosition[],
): PreparedFlatCoordinates {
  const coordinateCount = previousCoordinates.length;
  const start = new Float64Array(coordinateCount * 2);
  const delta = new Float64Array(coordinateCount * 2);

  for (let index = 0; index < coordinateCount; index += 1) {
    const offset = index * 2;
    const previousPosition = previousCoordinates[index]!;
    const nextPosition = nextCoordinates[index]!;

    start[offset] = previousPosition[0];
    start[offset + 1] = previousPosition[1];
    delta[offset] = nextPosition[0] - previousPosition[0];
    delta[offset + 1] = nextPosition[1] - previousPosition[1];
  }

  return {
    coordinateCount,
    delta,
    start,
  };
}

function materializePreparedPositions(
  coordinates: PreparedFlatCoordinates,
  progress: number,
): GeoJsonPosition[] {
  const positions = new Array<GeoJsonPosition>(coordinates.coordinateCount);

  for (let index = 0; index < coordinates.coordinateCount; index += 1) {
    const offset = index * 2;

    positions[index] = [
      coordinates.start[offset]! + coordinates.delta[offset]! * progress,
      coordinates.start[offset + 1]! + coordinates.delta[offset + 1]! * progress,
    ];
  }

  return positions;
}

function interpolateMatchingGeometry(
  previousGeometry: TemporalGeoJsonSupportedGeometry,
  nextGeometry: TemporalGeoJsonSupportedGeometry,
  progress: number,
  options: ResolvedInterpolationOptions,
): TemporalGeoJsonSupportedGeometry | null {
  switch (previousGeometry.type) {
    case "Point":
      return {
        coordinates: interpolatePosition(
          previousGeometry.coordinates,
          (nextGeometry as GeoJsonPointGeometry).coordinates,
          progress,
        ),
        type: "Point",
      };
    case "MultiPoint": {
      const nextPoints = (nextGeometry as GeoJsonMultiPointGeometry).coordinates;

      if (previousGeometry.coordinates.length !== nextPoints.length) {
        return null;
      }

      return {
        coordinates: previousGeometry.coordinates.map((position, index) =>
          interpolatePosition(position, nextPoints[index]!, progress),
        ),
        type: "MultiPoint",
      };
    }
    case "LineString":
      return interpolateLineStringGeometry(
        previousGeometry,
        nextGeometry as GeoJsonLineStringGeometry,
        progress,
        options,
      );
    case "MultiLineString":
      return interpolateMultiLineStringGeometry(
        previousGeometry,
        nextGeometry as GeoJsonMultiLineStringGeometry,
        progress,
        options,
      );
    case "Polygon":
      return interpolatePolygonGeometry(
        previousGeometry,
        nextGeometry as GeoJsonPolygonGeometry,
        progress,
        options,
      );
    case "MultiPolygon":
      return interpolateMultiPolygonGeometry(
        previousGeometry,
        nextGeometry as GeoJsonMultiPolygonGeometry,
        progress,
        options,
      );
  }
}

function interpolateLineStringGeometry(
  previousGeometry: GeoJsonLineStringGeometry,
  nextGeometry: GeoJsonLineStringGeometry,
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonLineStringGeometry | null {
  const coordinates = interpolateLineCoordinates(
    previousGeometry.coordinates,
    nextGeometry.coordinates,
    progress,
    options,
  );

  return coordinates ? { coordinates, type: "LineString" } : null;
}

function interpolateMultiLineStringGeometry(
  previousGeometry: GeoJsonMultiLineStringGeometry,
  nextGeometry: GeoJsonMultiLineStringGeometry,
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonMultiLineStringGeometry | null {
  if (previousGeometry.coordinates.length !== nextGeometry.coordinates.length) {
    return null;
  }

  const lines = previousGeometry.coordinates.map((line, index) =>
    interpolateLineCoordinates(line, nextGeometry.coordinates[index]!, progress, options),
  );

  if (lines.some((line) => line === null)) {
    return null;
  }

  return {
    coordinates: lines as GeoJsonPosition[][],
    type: "MultiLineString",
  };
}

function interpolatePolygonGeometry(
  previousGeometry: GeoJsonPolygonGeometry,
  nextGeometry: GeoJsonPolygonGeometry,
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonPolygonGeometry | null {
  const coordinates = interpolatePolygonCoordinates(
    previousGeometry.coordinates,
    nextGeometry.coordinates,
    progress,
    options,
  );

  return coordinates ? { coordinates, type: "Polygon" } : null;
}

function interpolateMultiPolygonGeometry(
  previousGeometry: GeoJsonMultiPolygonGeometry,
  nextGeometry: GeoJsonMultiPolygonGeometry,
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonMultiPolygonGeometry | null {
  if (previousGeometry.coordinates.length !== nextGeometry.coordinates.length) {
    return null;
  }

  const polygons = previousGeometry.coordinates.map((polygon, index) =>
    interpolatePolygonCoordinates(polygon, nextGeometry.coordinates[index]!, progress, options),
  );

  if (polygons.some((polygon) => polygon === null)) {
    return null;
  }

  return {
    coordinates: polygons as GeoJsonPosition[][][],
    type: "MultiPolygon",
  };
}

function interpolateLineCoordinates(
  previousCoordinates: GeoJsonPosition[],
  nextCoordinates: GeoJsonPosition[],
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonPosition[] | null {
  if (options.strategy === "compatible") {
    if (previousCoordinates.length !== nextCoordinates.length || previousCoordinates.length < 2) {
      return null;
    }

    return previousCoordinates.map((position, index) =>
      interpolatePosition(position, nextCoordinates[index]!, progress),
    );
  }

  if (options.strategy !== "resample" && options.strategy !== "centroid-radial") {
    return null;
  }

  const coordinateCount = clampInteger(
    Math.max(previousCoordinates.length, nextCoordinates.length, options.minResampleCoordinates, 2),
    2,
    options.maxCoordinatesPerLine,
  );
  const previousLine = resampleLine(previousCoordinates, coordinateCount);
  const nextLine = resampleLine(nextCoordinates, coordinateCount);

  return previousLine.map((position, index) =>
    interpolatePosition(position, nextLine[index]!, progress),
  );
}

function interpolatePolygonCoordinates(
  previousCoordinates: GeoJsonPosition[][],
  nextCoordinates: GeoJsonPosition[][],
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonPosition[][] | null {
  if (previousCoordinates.length !== nextCoordinates.length) {
    return null;
  }

  const rings = previousCoordinates.map((ring, index) => {
    const nextRing = nextCoordinates[index]!;

    if (options.strategy === "compatible") {
      return interpolateCompatibleRing(ring, nextRing, progress);
    }

    if (options.strategy === "resample") {
      return interpolateResampledRing(ring, nextRing, progress, options);
    }

    if (options.strategy === "centroid-radial") {
      return interpolateCentroidRadialRing(ring, nextRing, progress, options);
    }

    return null;
  });

  if (rings.some((ring) => ring === null)) {
    return null;
  }

  return rings as GeoJsonPosition[][];
}

function interpolateCompatibleRing(
  previousRing: GeoJsonPosition[],
  nextRing: GeoJsonPosition[],
  progress: number,
): GeoJsonPosition[] | null {
  const normalizedPreviousRing = normalizeRing(previousRing);
  const normalizedNextRing = normalizeRing(nextRing);

  if (
    !normalizedPreviousRing ||
    !normalizedNextRing ||
    normalizedPreviousRing.length !== normalizedNextRing.length
  ) {
    return null;
  }

  return closeRing(
    normalizedPreviousRing.map((position, index) =>
      interpolatePosition(position, normalizedNextRing[index]!, progress),
    ),
  );
}

function interpolateResampledRing(
  previousRing: GeoJsonPosition[],
  nextRing: GeoJsonPosition[],
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonPosition[] | null {
  const previousOpenRing = getOpenRing(previousRing);
  const nextOpenRing = getOpenRing(nextRing);

  if (!previousOpenRing || !nextOpenRing) {
    return null;
  }

  const orientedNextRing = orientRingLike(nextOpenRing, previousOpenRing);
  const alignedNextRing = alignRingStart(orientedNextRing, previousOpenRing[0]!);
  const coordinateCount = clampInteger(
    Math.max(previousOpenRing.length, alignedNextRing.length, options.minResampleCoordinates, 3),
    3,
    options.maxCoordinatesPerRing,
  );
  const previousSamples = resampleRing(previousOpenRing, coordinateCount);
  const nextSamples = resampleRing(alignedNextRing, coordinateCount);

  return closeRing(
    previousSamples.map((position, index) =>
      interpolatePosition(position, nextSamples[index]!, progress),
    ),
  );
}

function interpolateCentroidRadialRing(
  previousRing: GeoJsonPosition[],
  nextRing: GeoJsonPosition[],
  progress: number,
  options: ResolvedInterpolationOptions,
): GeoJsonPosition[] | null {
  const previousOpenRing = getOpenRing(previousRing);
  const nextOpenRing = getOpenRing(nextRing);

  if (!previousOpenRing || !nextOpenRing) {
    return null;
  }

  const coordinateCount = clampInteger(
    Math.max(previousOpenRing.length, nextOpenRing.length, options.minResampleCoordinates, 3),
    3,
    options.maxCoordinatesPerRing,
  );
  const previousSamples = sampleRingByAngle(previousOpenRing, coordinateCount);
  const nextSamples = sampleRingByAngle(nextOpenRing, coordinateCount);

  return closeRing(
    previousSamples.map((position, index) =>
      interpolatePosition(position, nextSamples[index]!, progress),
    ),
  );
}

function resolveInterpolationOptions(
  options: TemporalGeoJsonInterpolationOptions,
): ResolvedInterpolationOptions {
  return {
    fallback: options.fallback ?? DEFAULT_INTERPOLATION_OPTIONS.fallback,
    maxCoordinatesPerLine: sanitizePositiveInteger(
      options.maxCoordinatesPerLine,
      DEFAULT_INTERPOLATION_OPTIONS.maxCoordinatesPerLine,
    ),
    maxCoordinatesPerRing: sanitizePositiveInteger(
      options.maxCoordinatesPerRing,
      DEFAULT_INTERPOLATION_OPTIONS.maxCoordinatesPerRing,
    ),
    minResampleCoordinates: sanitizePositiveInteger(
      options.minResampleCoordinates,
      DEFAULT_INTERPOLATION_OPTIONS.minResampleCoordinates,
    ),
    strategy: options.strategy ?? DEFAULT_INTERPOLATION_OPTIONS.strategy,
  };
}

export function resolvePlaybackIndexOptions(
  options: TemporalGeoJsonPlaybackIndexOptions,
): ResolvedPlaybackIndexOptions {
  const interpolationOptions = resolveInterpolationOptions(options);

  return {
    ...interpolationOptions,
    denseGeometryBehavior: options.denseGeometryBehavior === "preserve" ? "preserve" : "resample",
    denseLineThreshold: sanitizePositiveInteger(
      options.denseLineThreshold,
      interpolationOptions.maxCoordinatesPerLine,
    ),
    denseRingThreshold: sanitizePositiveInteger(
      options.denseRingThreshold,
      interpolationOptions.maxCoordinatesPerRing,
    ),
  };
}

function applyInterpolationFallback(
  previousGeometry: TemporalGeoJsonSupportedGeometry,
  options: ResolvedInterpolationOptions,
) {
  return options.fallback === "hide" ? null : cloneGeometry(previousGeometry);
}

function interpolatePosition(
  previousPosition: GeoJsonPosition,
  nextPosition: GeoJsonPosition,
  progress: number,
): GeoJsonPosition {
  return [
    interpolate(previousPosition[0], nextPosition[0], progress),
    interpolate(previousPosition[1], nextPosition[1], progress),
  ];
}

function resampleLine(
  coordinates: readonly GeoJsonPosition[],
  coordinateCount: number,
): GeoJsonPosition[] {
  return flatCoordinatesToPositions(
    getMapsKernelRuntime().resampleLineFlat(positionsToFlatCoordinates(coordinates), coordinateCount),
  );
}

function resampleRing(
  openRing: readonly GeoJsonPosition[],
  coordinateCount: number,
): GeoJsonPosition[] {
  return flatCoordinatesToPositions(
    getMapsKernelRuntime().resampleRingFlat(positionsToFlatCoordinates(openRing), coordinateCount),
  );
}

function positionsToFlatCoordinates(coordinates: readonly GeoJsonPosition[]) {
  const flatCoordinates = new Float64Array(coordinates.length * 2);

  for (let index = 0; index < coordinates.length; index += 1) {
    const offset = index * 2;
    const coordinate = coordinates[index]!;

    flatCoordinates[offset] = coordinate[0];
    flatCoordinates[offset + 1] = coordinate[1];
  }

  return flatCoordinates;
}

function flatCoordinatesToPositions(coordinates: Float64Array): GeoJsonPosition[] {
  const positions = new Array<GeoJsonPosition>(coordinates.length / 2);

  for (let index = 0; index < positions.length; index += 1) {
    const offset = index * 2;

    positions[index] = [coordinates[offset]!, coordinates[offset + 1]!];
  }

  return positions;
}

function sampleRingByAngle(
  openRing: readonly GeoJsonPosition[],
  coordinateCount: number,
): GeoJsonPosition[] {
  const center = getRingCentroid(openRing);

  return Array.from({ length: coordinateCount }, (_, index) => {
    const angle = (index / coordinateCount) * Math.PI * 2;
    const ray = [Math.cos(angle), Math.sin(angle)] as const;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPosition: GeoJsonPosition | null = null;

    for (let ringIndex = 0; ringIndex < openRing.length; ringIndex += 1) {
      const start = openRing[ringIndex]!;
      const end = openRing[(ringIndex + 1) % openRing.length]!;
      const intersection = getRaySegmentIntersection(center, ray, start, end);

      if (!intersection || intersection.distance >= bestDistance) {
        continue;
      }

      bestDistance = intersection.distance;
      bestPosition = intersection.position;
    }

    return bestPosition ?? getNearestPositionByAngle(openRing, center, angle);
  });
}

function getRingCentroid(openRing: readonly GeoJsonPosition[]): GeoJsonPosition {
  try {
    const ring = closeRing(openRing);
    const center = centroid(createTurfPolygon([ring])).geometry.coordinates;

    if (Number.isFinite(center[0]) && Number.isFinite(center[1])) {
      return [center[0], center[1]];
    }
  } catch {
    // Fall through to the deterministic average below.
  }

  const total = openRing.reduce(
    (sum, position) => [sum[0] + position[0], sum[1] + position[1]] as GeoJsonPosition,
    [0, 0],
  );

  return [total[0] / openRing.length, total[1] / openRing.length];
}

function getRaySegmentIntersection(
  origin: GeoJsonPosition,
  ray: readonly [number, number],
  start: GeoJsonPosition,
  end: GeoJsonPosition,
): { distance: number; position: GeoJsonPosition } | null {
  const segment = [end[0] - start[0], end[1] - start[1]] as const;
  const denominator = cross(ray, segment);

  if (Math.abs(denominator) < 1e-12) {
    return null;
  }

  const delta = [start[0] - origin[0], start[1] - origin[1]] as const;
  const rayDistance = cross(delta, segment) / denominator;
  const segmentProgress = cross(delta, ray) / denominator;

  if (rayDistance < 0 || segmentProgress < 0 || segmentProgress > 1) {
    return null;
  }

  return {
    distance: rayDistance,
    position: [origin[0] + ray[0] * rayDistance, origin[1] + ray[1] * rayDistance],
  };
}

function getNearestPositionByAngle(
  coordinates: readonly GeoJsonPosition[],
  center: GeoJsonPosition,
  angle: number,
) {
  let bestPosition = coordinates[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const position of coordinates) {
    const positionAngle = Math.atan2(position[1] - center[1], position[0] - center[0]);
    const angleDistance = Math.abs(normalizeAngle(positionAngle - angle));

    if (angleDistance >= bestDistance) {
      continue;
    }

    bestDistance = angleDistance;
    bestPosition = position;
  }

  return clonePosition(bestPosition);
}

function cross(left: readonly [number, number], right: readonly [number, number]) {
  return left[0] * right[1] - left[1] * right[0];
}

function normalizeAngle(value: number) {
  let angle = value;

  while (angle <= -Math.PI) {
    angle += Math.PI * 2;
  }

  while (angle > Math.PI) {
    angle -= Math.PI * 2;
  }

  return angle;
}

export function clampProgress(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function sanitizePositiveInteger(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return fallback;
  }

  return Math.floor(value!);
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
