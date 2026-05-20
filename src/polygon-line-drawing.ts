import {
  closeRing,
  cloneGeometry,
  clonePosition,
  normalizeRing,
} from "./temporal-geojson-geometry";
import type {
  GeoJsonLineStringGeometry,
  GeoJsonMultiPolygonGeometry,
  GeoJsonPolygonGeometry,
  GeoJsonPosition,
} from "./temporal-geojson-types";

export type PolygonLineDrawingMode = "auto" | "hole" | "split";

export type PolygonLineDrawingOperation = "hole" | "none" | "split";

export type PolygonLineDrawingOptions = {
  mode?: PolygonLineDrawingMode;
  tolerance?: number;
};

export type PolygonLineDrawingResult = {
  geometry: GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry;
  operation: PolygonLineDrawingOperation;
  polygonIndex?: number;
};

type PolygonCoordinates = GeoJsonPosition[][];

type SegmentIntersection = {
  lineSegmentIndex: number;
  lineT: number;
  point: GeoJsonPosition;
  ringSegmentIndex: number;
  ringT: number;
};

const DEFAULT_TOLERANCE = 1e-9;

/**
 * Applies a drawn line to a Polygon or MultiPolygon.
 *
 * In auto mode, closed lines create holes and open lines with exactly two shell
 * crossings split the affected polygon. Use mode: "hole" to close an open drawn
 * line into a hole, or mode: "split" to skip hole creation.
 */
export function drawLineOnPolygonGeometry(
  geometry: GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry,
  line: GeoJsonLineStringGeometry | readonly GeoJsonPosition[],
  options: PolygonLineDrawingOptions = {},
): PolygonLineDrawingResult {
  const tolerance = resolveTolerance(options.tolerance);
  const coordinates = normalizeDrawnLine(line);
  const mode = options.mode ?? "auto";

  if (!coordinates || coordinates.length < 2) {
    return {
      geometry: clonePolygonalGeometry(geometry),
      operation: "none",
    };
  }

  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  if (mode !== "split" && isClosedLine(coordinates, tolerance)) {
    const holeResult = drawHole(polygons, coordinates, tolerance);

    if (holeResult) {
      return materializeResult(geometry, holeResult.polygons, "hole", holeResult.polygonIndex);
    }
  }

  if (mode !== "hole") {
    const splitResult = splitPolygons(polygons, coordinates, tolerance);

    if (splitResult) {
      return materializeResult(geometry, splitResult.polygons, "split", splitResult.polygonIndex);
    }
  }

  if (mode === "hole") {
    const holeResult = drawHole(polygons, closeRing(coordinates), tolerance);

    if (holeResult) {
      return materializeResult(geometry, holeResult.polygons, "hole", holeResult.polygonIndex);
    }
  }

  return {
    geometry: clonePolygonalGeometry(geometry),
    operation: "none",
  };
}

function drawHole(
  polygons: readonly PolygonCoordinates[],
  coordinates: readonly GeoJsonPosition[],
  tolerance: number,
) {
  const ring = normalizeRing(coordinates);

  if (!ring || Math.abs(getSignedArea(ring)) <= tolerance) {
    return null;
  }

  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    const polygon = polygons[polygonIndex]!;

    if (!isPathInsidePolygon(ring, polygon, tolerance)) {
      continue;
    }

    return {
      polygonIndex,
      polygons: polygons.map((candidate, index) =>
        index === polygonIndex
          ? [...clonePolygon(candidate), ring.map(clonePosition)]
          : clonePolygon(candidate),
      ),
    };
  }

  return null;
}

function splitPolygons(
  polygons: readonly PolygonCoordinates[],
  line: readonly GeoJsonPosition[],
  tolerance: number,
) {
  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    const splitPolygon = splitPolygonWithLine(polygons[polygonIndex]!, line, tolerance);

    if (!splitPolygon) {
      continue;
    }

    return {
      polygonIndex,
      polygons: [
        ...polygons.slice(0, polygonIndex).map(clonePolygon),
        ...splitPolygon,
        ...polygons.slice(polygonIndex + 1).map(clonePolygon),
      ],
    };
  }

  return null;
}

function splitPolygonWithLine(
  polygon: PolygonCoordinates,
  line: readonly GeoJsonPosition[],
  tolerance: number,
): PolygonCoordinates[] | null {
  const shell = getOpenRing(polygon[0]);

  if (!shell || shell.length < 3) {
    return null;
  }

  const intersections = getBoundaryIntersections(line, shell, tolerance);

  if (intersections.length !== 2) {
    return null;
  }

  const [start, end] = intersections;
  const splitPath = getLinePathBetween(line, start!, end!, tolerance);

  if (splitPath.length < 2 || !isPathInsidePolygon(splitPath, polygon, tolerance)) {
    return null;
  }

  const firstShell = buildSplitShell(
    getRingPathBetween(shell, start!, end!, tolerance),
    [...splitPath].reverse(),
    tolerance,
  );
  const secondShell = buildSplitShell(
    getRingPathBetween(shell, end!, start!, tolerance),
    splitPath,
    tolerance,
  );

  if (!firstShell || !secondShell) {
    return null;
  }

  const originalArea = getSignedArea(closeRing(shell));
  const firstPolygon: PolygonCoordinates = [orientLike(firstShell, originalArea)];
  const secondPolygon: PolygonCoordinates = [orientLike(secondShell, originalArea)];

  for (const hole of polygon.slice(1)) {
    const normalizedHole = normalizeRing(hole);

    if (!normalizedHole) {
      continue;
    }

    const point = getRingInteriorProbe(normalizedHole);

    if (pointInPolygon(point, firstPolygon, tolerance)) {
      firstPolygon.push(normalizedHole.map(clonePosition));
    } else if (pointInPolygon(point, secondPolygon, tolerance)) {
      secondPolygon.push(normalizedHole.map(clonePosition));
    }
  }

  return [firstPolygon, secondPolygon];
}

function materializeResult(
  sourceGeometry: GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry,
  polygons: PolygonCoordinates[],
  operation: PolygonLineDrawingOperation,
  polygonIndex: number,
): PolygonLineDrawingResult {
  if (sourceGeometry.type === "Polygon" && operation === "hole" && polygons.length === 1) {
    return {
      geometry: {
        coordinates: polygons[0]!,
        type: "Polygon",
      },
      operation,
      polygonIndex,
    };
  }

  return {
    geometry: {
      coordinates: polygons,
      type: "MultiPolygon",
    },
    operation,
    polygonIndex,
  };
}

function clonePolygonalGeometry(
  geometry: GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry,
): GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry {
  return cloneGeometry(geometry) as GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry;
}

function clonePolygon(polygon: readonly (readonly GeoJsonPosition[])[]): PolygonCoordinates {
  return polygon.map((ring) => ring.map(clonePosition));
}

function normalizeDrawnLine(
  line: GeoJsonLineStringGeometry | readonly GeoJsonPosition[],
): GeoJsonPosition[] | null {
  const coordinates = "coordinates" in line ? line.coordinates : line;

  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const normalized = coordinates.map((position) => {
    if (!Array.isArray(position)) {
      return null;
    }

    const [longitude, latitude] = position;

    return Number.isFinite(longitude) && Number.isFinite(latitude)
      ? ([longitude, latitude] as GeoJsonPosition)
      : null;
  });

  return normalized.some((position) => position === null)
    ? null
    : (normalized as GeoJsonPosition[]);
}

function getOpenRing(ring: readonly GeoJsonPosition[] | undefined) {
  const normalized = normalizeRing(ring);

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, -1);
}

function getBoundaryIntersections(
  line: readonly GeoJsonPosition[],
  shell: readonly GeoJsonPosition[],
  tolerance: number,
) {
  const intersections: SegmentIntersection[] = [];

  for (let lineIndex = 0; lineIndex < line.length - 1; lineIndex += 1) {
    const lineStart = line[lineIndex]!;
    const lineEnd = line[lineIndex + 1]!;

    for (let ringIndex = 0; ringIndex < shell.length; ringIndex += 1) {
      const ringStart = shell[ringIndex]!;
      const ringEnd = shell[(ringIndex + 1) % shell.length]!;
      const intersection = intersectSegments(lineStart, lineEnd, ringStart, ringEnd, tolerance);

      if (!intersection) {
        continue;
      }

      intersections.push(
        normalizeIntersection(intersection, lineIndex, ringIndex, line, shell, tolerance),
      );
    }
  }

  return dedupeIntersections(intersections, tolerance).sort(
    (left, right) => getLinePosition(left) - getLinePosition(right),
  );
}

function intersectSegments(
  lineStart: GeoJsonPosition,
  lineEnd: GeoJsonPosition,
  ringStart: GeoJsonPosition,
  ringEnd: GeoJsonPosition,
  tolerance: number,
) {
  const lineVector = subtract(lineEnd, lineStart);
  const ringVector = subtract(ringEnd, ringStart);
  const denominator = cross(lineVector, ringVector);

  if (Math.abs(denominator) <= tolerance) {
    return null;
  }

  const difference = subtract(ringStart, lineStart);
  const lineT = cross(difference, ringVector) / denominator;
  const ringT = cross(difference, lineVector) / denominator;

  if (
    lineT < -tolerance ||
    lineT > 1 + tolerance ||
    ringT < -tolerance ||
    ringT > 1 + tolerance
  ) {
    return null;
  }

  const clampedLineT = clamp(lineT, 0, 1);

  return {
    lineT: clampedLineT,
    point: [
      lineStart[0] + (lineEnd[0] - lineStart[0]) * clampedLineT,
      lineStart[1] + (lineEnd[1] - lineStart[1]) * clampedLineT,
    ] as GeoJsonPosition,
    ringT: clamp(ringT, 0, 1),
  };
}

function normalizeIntersection(
  intersection: Pick<SegmentIntersection, "lineT" | "point" | "ringT">,
  lineSegmentIndex: number,
  ringSegmentIndex: number,
  line: readonly GeoJsonPosition[],
  shell: readonly GeoJsonPosition[],
  tolerance: number,
): SegmentIntersection {
  let normalizedLineSegmentIndex = lineSegmentIndex;
  let normalizedLineT = intersection.lineT;
  let normalizedRingSegmentIndex = ringSegmentIndex;
  let normalizedRingT = intersection.ringT;

  if (1 - normalizedLineT <= tolerance && lineSegmentIndex + 1 < line.length - 1) {
    normalizedLineSegmentIndex += 1;
    normalizedLineT = 0;
  } else if (normalizedLineT <= tolerance) {
    normalizedLineT = 0;
  }

  if (1 - normalizedRingT <= tolerance) {
    normalizedRingSegmentIndex = (ringSegmentIndex + 1) % shell.length;
    normalizedRingT = 0;
  } else if (normalizedRingT <= tolerance) {
    normalizedRingT = 0;
  }

  return {
    lineSegmentIndex: normalizedLineSegmentIndex,
    lineT: normalizedLineT,
    point: clonePosition(intersection.point),
    ringSegmentIndex: normalizedRingSegmentIndex,
    ringT: normalizedRingT,
  };
}

function dedupeIntersections(
  intersections: readonly SegmentIntersection[],
  tolerance: number,
): SegmentIntersection[] {
  const unique: SegmentIntersection[] = [];

  for (const intersection of intersections) {
    if (
      unique.some(
        (candidate) =>
          distance(candidate.point, intersection.point) <= tolerance &&
          Math.abs(getLinePosition(candidate) - getLinePosition(intersection)) <= tolerance,
      )
    ) {
      continue;
    }

    unique.push(intersection);
  }

  return unique;
}

function getLinePathBetween(
  line: readonly GeoJsonPosition[],
  start: SegmentIntersection,
  end: SegmentIntersection,
  tolerance: number,
) {
  const startPosition = getLinePosition(start);
  const endPosition = getLinePosition(end);
  const path = [clonePosition(start.point)];

  for (
    let position = Math.floor(startPosition) + 1;
    position < endPosition - tolerance;
    position += 1
  ) {
    path.push(clonePosition(line[position]!));
  }

  pushDistinct(path, end.point, tolerance);

  return path;
}

function getRingPathBetween(
  shell: readonly GeoJsonPosition[],
  start: SegmentIntersection,
  end: SegmentIntersection,
  tolerance: number,
) {
  const ringLength = shell.length;
  const startPosition = getRingPosition(start);
  let endPosition = getRingPosition(end);
  const path = [clonePosition(start.point)];

  while (endPosition <= startPosition + tolerance) {
    endPosition += ringLength;
  }

  for (
    let position = Math.floor(startPosition) + 1;
    position < endPosition - tolerance;
    position += 1
  ) {
    path.push(clonePosition(shell[position % ringLength]!));
  }

  pushDistinct(path, end.point, tolerance);

  return path;
}

function buildSplitShell(
  boundaryPath: readonly GeoJsonPosition[],
  splitPath: readonly GeoJsonPosition[],
  tolerance: number,
) {
  const shell: GeoJsonPosition[] = [];

  for (const point of boundaryPath) {
    pushDistinct(shell, point, tolerance);
  }

  for (const point of splitPath) {
    pushDistinct(shell, point, tolerance);
  }

  const normalized = normalizeRing(shell);

  if (!normalized || Math.abs(getSignedArea(normalized)) <= tolerance) {
    return null;
  }

  return normalized;
}

function orientLike(ring: GeoJsonPosition[], signedArea: number) {
  if (Math.sign(getSignedArea(ring)) === Math.sign(signedArea)) {
    return ring;
  }

  return closeRing([...ring].reverse());
}

function isPathInsidePolygon(
  path: readonly GeoJsonPosition[],
  polygon: readonly (readonly GeoJsonPosition[])[],
  tolerance: number,
) {
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index]!;

    if (
      !pointInPolygon(point, polygon, tolerance) &&
      !pointOnPolygonBoundary(point, polygon, tolerance)
    ) {
      return false;
    }

    if (index === path.length - 1) {
      continue;
    }

    const nextPoint = path[index + 1]!;
    const midpoint: GeoJsonPosition = [
      (point[0] + nextPoint[0]) / 2,
      (point[1] + nextPoint[1]) / 2,
    ];

    if (!pointInPolygon(midpoint, polygon, tolerance)) {
      return false;
    }
  }

  return true;
}

function pointInPolygon(
  point: GeoJsonPosition,
  polygon: readonly (readonly GeoJsonPosition[])[],
  tolerance: number,
) {
  const shell = polygon[0];

  if (!shell || (!pointInRing(point, shell, tolerance) && !pointOnRing(point, shell, tolerance))) {
    return false;
  }

  return polygon
    .slice(1)
    .every((hole) => !pointInRing(point, hole, tolerance) && !pointOnRing(point, hole, tolerance));
}

function pointOnPolygonBoundary(
  point: GeoJsonPosition,
  polygon: readonly (readonly GeoJsonPosition[])[],
  tolerance: number,
) {
  return polygon.some((ring) => pointOnRing(point, ring, tolerance));
}

function pointInRing(point: GeoJsonPosition, ring: readonly GeoJsonPosition[], tolerance: number) {
  const normalizedRing = closeRing(ring);
  const vertices = normalizedRing.slice(0, -1);

  if (pointOnRing(point, normalizedRing, tolerance)) {
    return true;
  }

  let inside = false;

  for (
    let index = 0, previousIndex = vertices.length - 1;
    index < vertices.length;
    previousIndex = index, index += 1
  ) {
    const current = vertices[index]!;
    const previous = vertices[previousIndex]!;
    const intersects =
      current[1] > point[1] !== previous[1] > point[1] &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1] || tolerance) +
          current[0];

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointOnRing(point: GeoJsonPosition, ring: readonly GeoJsonPosition[], tolerance: number) {
  const normalizedRing = closeRing(ring);

  for (let index = 0; index < normalizedRing.length - 1; index += 1) {
    if (pointOnSegment(point, normalizedRing[index]!, normalizedRing[index + 1]!, tolerance)) {
      return true;
    }
  }

  return false;
}

function pointOnSegment(
  point: GeoJsonPosition,
  start: GeoJsonPosition,
  end: GeoJsonPosition,
  tolerance: number,
) {
  const segment = subtract(end, start);
  const relativePoint = subtract(point, start);
  const area = Math.abs(cross(segment, relativePoint));

  if (area > tolerance) {
    return false;
  }

  const dotProduct = dot(relativePoint, segment);

  if (dotProduct < -tolerance) {
    return false;
  }

  return dotProduct <= dot(segment, segment) + tolerance;
}

function getRingInteriorProbe(ring: readonly GeoJsonPosition[]) {
  const openRing = ring.slice(0, -1);
  const sum = openRing.reduce(
    (total, point) => [total[0] + point[0], total[1] + point[1]] as GeoJsonPosition,
    [0, 0] as GeoJsonPosition,
  );

  return [sum[0] / openRing.length, sum[1] / openRing.length] as GeoJsonPosition;
}

function getLinePosition(intersection: SegmentIntersection) {
  return intersection.lineSegmentIndex + intersection.lineT;
}

function getRingPosition(intersection: SegmentIntersection) {
  return intersection.ringSegmentIndex + intersection.ringT;
}

function isClosedLine(coordinates: readonly GeoJsonPosition[], tolerance: number) {
  return distance(coordinates[0]!, coordinates.at(-1)!) <= tolerance;
}

function getSignedArea(ring: readonly GeoJsonPosition[]) {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]!;
    const next = ring[index + 1]!;
    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

function pushDistinct(
  coordinates: GeoJsonPosition[],
  point: GeoJsonPosition,
  tolerance: number,
) {
  if (coordinates.length === 0 || distance(coordinates.at(-1)!, point) > tolerance) {
    coordinates.push(clonePosition(point));
  }
}

function subtract(left: GeoJsonPosition, right: GeoJsonPosition) {
  return [left[0] - right[0], left[1] - right[1]] as GeoJsonPosition;
}

function cross(left: GeoJsonPosition, right: GeoJsonPosition) {
  return left[0] * right[1] - left[1] * right[0];
}

function dot(left: GeoJsonPosition, right: GeoJsonPosition) {
  return left[0] * right[0] + left[1] * right[1];
}

function distance(left: GeoJsonPosition, right: GeoJsonPosition) {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function resolveTolerance(tolerance: number | undefined): number {
  return typeof tolerance === "number" && Number.isFinite(tolerance) && tolerance > 0
    ? tolerance
    : DEFAULT_TOLERANCE;
}
