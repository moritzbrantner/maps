import { Delaunay } from "d3-delaunay";

import type { Coordinate } from "./cluster-area-types";

type ProjectedPoint = {
  coordinate: Coordinate;
  x: number;
  y: number;
};

type Edge = {
  from: number;
  to: number;
};

const DEFAULT_SEGMENTS = 24;
const ALPHA_MULTIPLIERS = [2.2, 3, 4.2, 6];

export function createClusterAreaRing(
  points: readonly Coordinate[],
  center: Coordinate,
): Coordinate[] | null {
  if (points.length === 0) {
    return null;
  }

  const deduped = dedupeCoordinates(points);

  if (deduped.length === 1) {
    return createEllipseRing(center, 0.08, 0.06);
  }

  if (deduped.length === 2) {
    return createBoundsRing(deduped, center, 0.12);
  }

  const projectedPoints = projectPoints(deduped, center);
  const delaunay = Delaunay.from(
    projectedPoints,
    (point: ProjectedPoint) => point.x,
    (point: ProjectedPoint) => point.y,
  );
  const alphaLoops = buildAlphaLoops(projectedPoints, delaunay);

  if (alphaLoops.length > 0) {
    const selectedLoop =
      selectLoopContainingCenter(alphaLoops, center) ?? selectLargestLoop(alphaLoops);

    if (selectedLoop) {
      return closeRing(selectedLoop);
    }
  }

  return closeRing(buildConvexHull(deduped));
}

function dedupeCoordinates(points: readonly Coordinate[]) {
  const seen = new Set<string>();
  const result: Coordinate[] = [];

  for (const point of points) {
    const key = `${point[0].toFixed(6)}:${point[1].toFixed(6)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(point);
  }

  return result;
}

function projectPoints(points: readonly Coordinate[], center: Coordinate) {
  const scale = Math.cos((center[1] * Math.PI) / 180);

  return points.map((coordinate) => ({
    coordinate,
    x: (coordinate[0] - center[0]) * scale,
    y: coordinate[1] - center[1],
  }));
}

function buildAlphaLoops(points: readonly ProjectedPoint[], delaunay: Delaunay<ProjectedPoint>) {
  const nearestNeighborDistance = getNearestNeighborDistance(points, delaunay);

  for (const multiplier of ALPHA_MULTIPLIERS) {
    const loops = extractAlphaLoops(points, delaunay, nearestNeighborDistance * multiplier);

    if (loops.length > 0) {
      return loops;
    }
  }

  return [];
}

function getNearestNeighborDistance(
  points: readonly ProjectedPoint[],
  delaunay: Delaunay<ProjectedPoint>,
) {
  const distances: number[] = [];

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    let minimumDistance = Number.POSITIVE_INFINITY;

    for (const neighborIndex of delaunay.neighbors(pointIndex)) {
      minimumDistance = Math.min(
        minimumDistance,
        distance(points[pointIndex]!, points[neighborIndex]!),
      );
    }

    if (Number.isFinite(minimumDistance)) {
      distances.push(minimumDistance);
    }
  }

  distances.sort((left, right) => left - right);

  return distances[Math.floor(distances.length / 2)] ?? 0.05;
}

function extractAlphaLoops(
  points: readonly ProjectedPoint[],
  delaunay: Delaunay<ProjectedPoint>,
  alphaRadius: number,
) {
  const boundaryEdges = new Map<string, Edge>();
  const triangles = delaunay.triangles;

  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 3) {
    const a = triangles[triangleIndex]!;
    const b = triangles[triangleIndex + 1]!;
    const c = triangles[triangleIndex + 2]!;

    if (getCircumradius(points[a]!, points[b]!, points[c]!) > alphaRadius) {
      continue;
    }

    toggleBoundaryEdge(boundaryEdges, a, b);
    toggleBoundaryEdge(boundaryEdges, b, c);
    toggleBoundaryEdge(boundaryEdges, c, a);
  }

  if (boundaryEdges.size === 0) {
    return [];
  }

  return buildLoopsFromEdges(boundaryEdges, points);
}

function getCircumradius(first: ProjectedPoint, second: ProjectedPoint, third: ProjectedPoint) {
  const sideA = distance(second, third);
  const sideB = distance(first, third);
  const sideC = distance(first, second);
  const area = Math.abs(cross(first, second, third)) / 2;

  if (area <= Number.EPSILON) {
    return Number.POSITIVE_INFINITY;
  }

  return (sideA * sideB * sideC) / (4 * area);
}

function toggleBoundaryEdge(
  boundaryEdges: Map<string, Edge>,
  startIndex: number,
  endIndex: number,
) {
  const normalizedKey =
    startIndex < endIndex ? `${startIndex}:${endIndex}` : `${endIndex}:${startIndex}`;

  if (boundaryEdges.has(normalizedKey)) {
    boundaryEdges.delete(normalizedKey);
    return;
  }

  boundaryEdges.set(normalizedKey, { from: startIndex, to: endIndex });
}

function buildLoopsFromEdges(boundaryEdges: Map<string, Edge>, points: readonly ProjectedPoint[]) {
  const outgoingEdges = new Map<number, Edge[]>();

  for (const edge of boundaryEdges.values()) {
    pushEdge(outgoingEdges, edge.from, edge);
    pushEdge(outgoingEdges, edge.to, {
      from: edge.to,
      to: edge.from,
    });
  }

  const visitedEdges = new Set<string>();
  const loops: Coordinate[][] = [];

  for (const edge of boundaryEdges.values()) {
    const edgeKey = `${edge.from}:${edge.to}`;

    if (visitedEdges.has(edgeKey)) {
      continue;
    }

    const loop = traceLoop(edge, outgoingEdges, visitedEdges, points);

    if (loop.length >= 3) {
      loops.push(ensureCounterClockwise(loop));
    }
  }

  return loops;
}

function pushEdge(edgeMap: Map<number, Edge[]>, pointIndex: number, edge: Edge) {
  const edges = edgeMap.get(pointIndex);

  if (edges) {
    edges.push(edge);
    return;
  }

  edgeMap.set(pointIndex, [edge]);
}

function traceLoop(
  startEdge: Edge,
  outgoingEdges: Map<number, Edge[]>,
  visitedEdges: Set<string>,
  points: readonly ProjectedPoint[],
) {
  const loop: Coordinate[] = [];
  let previousIndex = startEdge.from;
  let currentIndex = startEdge.to;

  loop.push(points[startEdge.from]!.coordinate);
  visitedEdges.add(`${startEdge.from}:${startEdge.to}`);

  while (true) {
    loop.push(points[currentIndex]!.coordinate);

    const nextEdge = chooseNextEdge(
      previousIndex,
      currentIndex,
      outgoingEdges.get(currentIndex) ?? [],
      points,
      visitedEdges,
      startEdge.from,
    );

    if (!nextEdge) {
      return [];
    }

    const nextEdgeKey = `${nextEdge.from}:${nextEdge.to}`;

    if (visitedEdges.has(nextEdgeKey)) {
      return [];
    }

    visitedEdges.add(nextEdgeKey);
    previousIndex = currentIndex;
    currentIndex = nextEdge.to;

    if (currentIndex === startEdge.from) {
      return loop;
    }
  }
}

function chooseNextEdge(
  previousIndex: number,
  currentIndex: number,
  candidateEdges: readonly Edge[],
  points: readonly ProjectedPoint[],
  visitedEdges: Set<string>,
  startIndex: number,
) {
  const currentPoint = points[currentIndex]!;
  const previousPoint = points[previousIndex]!;
  const incomingAngle = Math.atan2(
    currentPoint.y - previousPoint.y,
    currentPoint.x - previousPoint.x,
  );
  let bestEdge: Edge | null = null;
  let bestTurn = Number.POSITIVE_INFINITY;

  for (const edge of candidateEdges) {
    const edgeKey = `${edge.from}:${edge.to}`;

    if (visitedEdges.has(edgeKey)) {
      continue;
    }

    if (edge.to === previousIndex) {
      continue;
    }

    if (edge.to === startIndex && candidateEdges.length > 1) {
      const remainingUnvisited = candidateEdges.some((candidate) => {
        if (candidate.to === previousIndex || candidate.to === startIndex) {
          return false;
        }

        return !visitedEdges.has(`${candidate.from}:${candidate.to}`);
      });

      if (remainingUnvisited) {
        continue;
      }
    }

    const nextPoint = points[edge.to]!;
    const outgoingAngle = Math.atan2(nextPoint.y - currentPoint.y, nextPoint.x - currentPoint.x);
    const rightTurn = normalizeAngle(incomingAngle - outgoingAngle);

    if (rightTurn < bestTurn) {
      bestTurn = rightTurn;
      bestEdge = edge;
    }
  }

  return bestEdge;
}

function selectLoopContainingCenter(loops: readonly Coordinate[][], center: Coordinate) {
  const containingLoops = loops.filter((loop) => pointInPolygon(center, loop));

  if (containingLoops.length === 0) {
    return null;
  }

  return selectLargestLoop(containingLoops);
}

function selectLargestLoop(loops: readonly Coordinate[][]) {
  let largestLoop: Coordinate[] | null = null;
  let largestArea = Number.NEGATIVE_INFINITY;

  for (const loop of loops) {
    const area = Math.abs(getSignedArea(loop));

    if (area > largestArea) {
      largestArea = area;
      largestLoop = loop;
    }
  }

  return largestLoop;
}

function pointInPolygon(point: Coordinate, polygon: readonly Coordinate[]) {
  let isInside = false;

  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex]!;
    const previous = polygon[previousIndex]!;
    const intersects =
      current[1] > point[1] !== previous[1] > point[1] &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1] || Number.EPSILON) +
          current[0];

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function ensureCounterClockwise(loop: readonly Coordinate[]) {
  return getSignedArea(loop) >= 0 ? [...loop] : [...loop].reverse();
}

function getSignedArea(loop: readonly Coordinate[]) {
  let area = 0;

  for (let index = 0; index < loop.length; index += 1) {
    const current = loop[index]!;
    const next = loop[(index + 1) % loop.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

function buildConvexHull(points: readonly Coordinate[]) {
  const sorted = [...points].sort((left, right) =>
    left[0] === right[0] ? left[1] - right[1] : left[0] - right[0],
  );
  const lower: Coordinate[] = [];

  for (const point of sorted) {
    while (lower.length >= 2 && crossCoordinates(lower.at(-2)!, lower.at(-1)!, point) <= 0) {
      lower.pop();
    }

    lower.push(point);
  }

  const upper: Coordinate[] = [];

  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && crossCoordinates(upper.at(-2)!, upper.at(-1)!, point) <= 0) {
      upper.pop();
    }

    upper.push(point);
  }

  lower.pop();
  upper.pop();

  return [...lower, ...upper];
}

function createBoundsRing(
  points: readonly Coordinate[],
  center: Coordinate,
  minimumPadding: number,
) {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const [longitude, latitude] of points) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  const padding = Math.max(getPaddingDegrees(points), minimumPadding);

  return closeRing([
    [Math.min(west, center[0]) - padding, Math.min(south, center[1]) - padding],
    [Math.max(east, center[0]) + padding, Math.min(south, center[1]) - padding],
    [Math.max(east, center[0]) + padding, Math.max(north, center[1]) + padding],
    [Math.min(west, center[0]) - padding, Math.max(north, center[1]) + padding],
  ]);
}

function getPaddingDegrees(points: readonly Coordinate[]) {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const [longitude, latitude] of points) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  const longitudeSpan = Math.max(east - west, 0.01);
  const latitudeSpan = Math.max(north - south, 0.01);

  return Math.max(longitudeSpan, latitudeSpan) * 0.14;
}

function createEllipseRing(center: Coordinate, radiusLongitude: number, radiusLatitude: number) {
  const ring: Coordinate[] = [];

  for (let index = 0; index < DEFAULT_SEGMENTS; index += 1) {
    const angle = (index / DEFAULT_SEGMENTS) * Math.PI * 2;
    ring.push([
      center[0] + Math.cos(angle) * radiusLongitude,
      center[1] + Math.sin(angle) * radiusLatitude,
    ]);
  }

  return closeRing(ring);
}

function closeRing(points: readonly Coordinate[]) {
  if (points.length === 0) {
    return [];
  }

  return [...points, points[0]!];
}

function distance(first: ProjectedPoint, second: ProjectedPoint) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function cross(first: ProjectedPoint, second: ProjectedPoint, third: ProjectedPoint) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function crossCoordinates(first: Coordinate, second: Coordinate, third: Coordinate) {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])
  );
}

function normalizeAngle(angle: number) {
  const fullTurn = Math.PI * 2;
  let normalized = angle % fullTurn;

  if (normalized < 0) {
    normalized += fullTurn;
  }

  return normalized;
}
