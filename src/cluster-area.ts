import { Delaunay } from "d3-delaunay";

type Coordinate = [longitude: number, latitude: number];
type Bounds = [west: number, south: number, east: number, north: number];
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

export type ClusterVoronoiInput = {
  clusterId: number | string;
  coordinates: Coordinate;
  boundary?: readonly Coordinate[];
};

export type ClusterVoronoiBoundarySegment = {
  clusterIds: [number | string, number | string | null];
  coordinates: Coordinate[];
};

export type ClusterVoronoiRegion = {
  clusterId: number | string;
  polygons: Coordinate[][][];
};

type ProjectedSegment = {
  coordinates: [Coordinate, Coordinate];
  endKey: string;
  id: string;
  startKey: string;
};

type ProjectedUndirectedSegment = {
  coordinates: [Coordinate, Coordinate];
  endKey: string;
  id: string;
  startKey: string;
};

const DEFAULT_VORONOI_VIEWPORT_PADDING = 24;
const SEGMENT_EPSILON = 1e-4;
const DUPLICATE_POINT_OFFSET = 1e-3;

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

export function createClusterVoronoiCells(
  clusters: readonly ClusterVoronoiInput[],
  bounds: Bounds,
) {
  const projection = createScreenProjectionFromBounds(bounds);
  const cells = new Map<ClusterVoronoiInput["clusterId"], Coordinate[]>();
  const geometry = createProjectedClusterVoronoiGeometry(clusters, {
    project: projection.project,
    unproject: projection.unproject,
    viewportBounds: projectBoundsToViewport(bounds, projection),
  });

  for (const region of geometry.regions) {
    const polygon = selectLargestPolygon(region.polygons);

    if (!polygon) {
      continue;
    }

    cells.set(region.clusterId, polygon[0]!);
  }

  return cells;
}

export function createClusterVoronoiBoundarySegments(
  clusters: readonly ClusterVoronoiInput[],
  bounds: Bounds,
  options: {
    includeOuterEdges?: boolean;
  } = {},
) {
  const projection = createScreenProjectionFromBounds(bounds);

  return createProjectedClusterVoronoiGeometry(clusters, {
    includeOuterEdges: options.includeOuterEdges,
    project: projection.project,
    unproject: projection.unproject,
    viewportBounds: projectBoundsToViewport(bounds, projection),
  }).boundarySegments;
}

export function createProjectedClusterVoronoiGeometry(
  clusters: readonly ClusterVoronoiInput[],
  options: {
    includeOuterEdges?: boolean;
    project(coordinate: Coordinate): Coordinate;
    unproject(coordinate: Coordinate): Coordinate;
    viewportBounds: [minX: number, minY: number, maxX: number, maxY: number];
  },
) {
  if (clusters.length === 0) {
    return {
      boundarySegments: [] as ClusterVoronoiBoundarySegment[],
      regions: [] as ClusterVoronoiRegion[],
    };
  }

  const context = createProjectedVoronoiContext(clusters, options);
  const cells = createProjectedVoronoiCells(context);

  return dissolveProjectedClusterCells(context, cells, {
    includeOuterEdges: options.includeOuterEdges ?? true,
  });
}

function createProjectedVoronoiContext(
  clusters: readonly ClusterVoronoiInput[],
  options: {
    project(coordinate: Coordinate): Coordinate;
    unproject(coordinate: Coordinate): Coordinate;
    viewportBounds: [minX: number, minY: number, maxX: number, maxY: number];
  },
) {
  const projectedClusters = stabilizeProjectedClusters(
    [...clusters]
      .map((cluster, sourceIndex) => ({
        clusterId: cluster.clusterId,
        coordinates: cluster.coordinates,
        projected: options.project(cluster.coordinates),
        sourceIndex,
      }))
      .sort(compareProjectedClusters),
  );
  const delaunay = Delaunay.from(
    projectedClusters,
    (cluster) => cluster.projected[0],
    (cluster) => cluster.projected[1],
  );

  return {
    delaunay,
    projectedClusters,
    unproject: options.unproject,
    viewportBounds: options.viewportBounds,
  };
}

function createProjectedVoronoiCells(context: ReturnType<typeof createProjectedVoronoiContext>) {
  const voronoi = context.delaunay.voronoi(context.viewportBounds);
  const cells: Array<{
    clusterId: ClusterVoronoiInput["clusterId"];
    ring: Coordinate[];
  } | null> = [];

  for (let clusterIndex = 0; clusterIndex < context.projectedClusters.length; clusterIndex += 1) {
    const polygon = voronoi.cellPolygon(clusterIndex);

    if (!polygon || polygon.length < 3) {
      cells.push(null);
      continue;
    }

    const ring = orientRingForScreenInterior(
      closeRing(
        compactRing(polygon.slice(0, -1).map(([x, y]) => snapCoordinate([x, y] as Coordinate))),
      ),
    );

    cells.push(
      ring.length >= 4
        ? { clusterId: context.projectedClusters[clusterIndex]!.clusterId, ring }
        : null,
    );
  }

  return cells;
}

function dissolveProjectedClusterCells(
  context: ReturnType<typeof createProjectedVoronoiContext>,
  cells: ReturnType<typeof createProjectedVoronoiCells>,
  options: {
    includeOuterEdges: boolean;
  },
) {
  const regionSegments = new Map<ClusterVoronoiInput["clusterId"], ProjectedSegment[]>();
  const boundarySegmentsByPair = new Map<
    string,
    {
      clusterIds: [number | string, number | string | null];
      segments: ProjectedUndirectedSegment[];
    }
  >();
  const edgeMap = new Map<
    string,
    {
      coordinates: [Coordinate, Coordinate];
      owners: Array<{
        clusterId: ClusterVoronoiInput["clusterId"];
        coordinates: [Coordinate, Coordinate];
      }>;
    }
  >();

  for (const cell of cells) {
    if (!cell) {
      continue;
    }

    const ring = removeClosingPoint(cell.ring);

    for (let pointIndex = 0; pointIndex < ring.length; pointIndex += 1) {
      const start = snapCoordinate(ring[pointIndex]!);
      const end = snapCoordinate(ring[(pointIndex + 1) % ring.length]!);

      if (samePointWithTolerance(start, end)) {
        continue;
      }

      const normalized = normalizeEdge(start, end);
      const edge = edgeMap.get(normalized.key);

      if (edge) {
        edge.owners.push({
          clusterId: cell.clusterId,
          coordinates: [start, end],
        });
        continue;
      }

      edgeMap.set(normalized.key, {
        coordinates: normalized.coordinates,
        owners: [
          {
            clusterId: cell.clusterId,
            coordinates: [start, end],
          },
        ],
      });
    }
  }

  for (const edge of edgeMap.values()) {
    const rawDistinctClusterIds = new Map(
      edge.owners.map((owner) => [serializeClusterId(owner.clusterId), owner.clusterId] as const),
    );

    if (rawDistinctClusterIds.size === 1 && edge.owners.length > 1) {
      continue;
    }

    const owners = dedupeEdgeOwners(edge.owners);
    const distinctClusterIds = new Map(
      owners.map((owner) => [serializeClusterId(owner.clusterId), owner.clusterId] as const),
    );

    for (const owner of owners) {
      pushSegment(regionSegments, owner.clusterId, createDirectedSegment(owner.coordinates));
    }

    const sortedClusterIds = [...distinctClusterIds.values()].sort(compareClusterIds);

    if (sortedClusterIds.length === 1) {
      if (!options.includeOuterEdges) {
        continue;
      }

      pushBoundaryPairSegment(
        boundarySegmentsByPair,
        [sortedClusterIds[0]!, null],
        edge.coordinates,
      );
      continue;
    }

    pushBoundaryPairSegment(
      boundarySegmentsByPair,
      [sortedClusterIds[0]!, sortedClusterIds[1]!],
      edge.coordinates,
    );
  }

  const regions = [...regionSegments.entries()]
    .map(([clusterId, segments]) => {
      const loops = stitchDirectedSegmentsToLoops(segments);

      if (loops.length === 0) {
        return null;
      }

      return {
        clusterId,
        polygons: buildDissolvedPolygons(loops).map((polygon) =>
          polygon.map((ring) => ring.map((point) => context.unproject(point))),
        ),
      } satisfies ClusterVoronoiRegion;
    })
    .filter(isDefined)
    .sort((left, right) => compareClusterIds(left.clusterId, right.clusterId));

  const boundarySegments = [...boundarySegmentsByPair.values()]
    .flatMap((boundary) =>
      stitchUndirectedSegments(boundary.segments).map((coordinates) => ({
        clusterIds: boundary.clusterIds,
        coordinates: coordinates.map((point) => context.unproject(point)),
      })),
    )
    .filter((segment) => segment.coordinates.length >= 2);

  return {
    boundarySegments,
    regions,
  };
}

function buildDissolvedPolygons(loops: readonly Coordinate[][]) {
  const nodes = [...loops]
    .map((loop) => ({
      area: Math.abs(getSignedArea(removeClosingPoint(loop))),
      loop,
      parentIndex: -1,
    }))
    .sort((left, right) => {
      if (left.area !== right.area) {
        return right.area - left.area;
      }

      return compareCoordinates(
        removeClosingPoint(left.loop)[0]!,
        removeClosingPoint(right.loop)[0]!,
      );
    });
  const polygonIndexes = new Array<number>(nodes.length).fill(-1);
  const polygons: Coordinate[][][] = [];
  const depths = new Array<number>(nodes.length).fill(0);

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const representative = removeClosingPoint(nodes[nodeIndex]!.loop)[0]!;

    for (let candidateIndex = nodeIndex - 1; candidateIndex >= 0; candidateIndex -= 1) {
      if (pointInPolygon(representative, removeClosingPoint(nodes[candidateIndex]!.loop))) {
        nodes[nodeIndex]!.parentIndex = candidateIndex;
        depths[nodeIndex] = depths[candidateIndex]! + 1;
        break;
      }
    }

    if (depths[nodeIndex]! % 2 === 0) {
      polygonIndexes[nodeIndex] = polygons.length;
      polygons.push([nodes[nodeIndex]!.loop]);
      continue;
    }

    let parentIndex = nodes[nodeIndex]!.parentIndex;

    while (parentIndex >= 0 && depths[parentIndex]! % 2 === 1) {
      parentIndex = nodes[parentIndex]!.parentIndex;
    }

    if (parentIndex >= 0) {
      polygons[polygonIndexes[parentIndex]!]!.push(nodes[nodeIndex]!.loop);
    }
  }

  return polygons;
}

function stitchDirectedSegmentsToLoops(segments: readonly ProjectedSegment[]) {
  const outgoingSegments = new Map<string, ProjectedSegment[]>();
  const visited = new Set<string>();
  const loops: Coordinate[][] = [];

  for (const segment of segments) {
    const existingSegments = outgoingSegments.get(segment.startKey);

    if (existingSegments) {
      existingSegments.push(segment);
      continue;
    }

    outgoingSegments.set(segment.startKey, [segment]);
  }

  const orderedSegments = [...segments].sort((left, right) => left.id.localeCompare(right.id));

  for (const segment of orderedSegments) {
    if (visited.has(segment.id)) {
      continue;
    }

    const loop = traceDirectedLoop(segment, outgoingSegments, visited);

    if (loop) {
      loops.push(loop);
    }
  }

  return loops;
}

function traceDirectedLoop(
  startSegment: ProjectedSegment,
  outgoingSegments: ReadonlyMap<string, readonly ProjectedSegment[]>,
  visited: Set<string>,
) {
  const coordinates: Coordinate[] = [startSegment.coordinates[0]];
  let currentSegment = startSegment;
  let guard = 0;

  while (guard < outgoingSegments.size * 8 + 8) {
    guard += 1;
    visited.add(currentSegment.id);
    coordinates.push(currentSegment.coordinates[1]);

    if (currentSegment.endKey === startSegment.startKey) {
      const compacted = closeRing(compactRing(coordinates));
      return compacted.length >= 4 ? compacted : null;
    }

    const nextSegment = chooseNextDirectedSegment(
      currentSegment,
      outgoingSegments.get(currentSegment.endKey) ?? [],
      visited,
    );

    if (!nextSegment) {
      return null;
    }

    currentSegment = nextSegment;
  }

  return null;
}

function chooseNextDirectedSegment(
  currentSegment: ProjectedSegment,
  candidateSegments: readonly ProjectedSegment[],
  visited: ReadonlySet<string>,
) {
  const currentStart = currentSegment.coordinates[0];
  const currentEnd = currentSegment.coordinates[1];
  const incomingAngle = getScreenAngle(currentStart, currentEnd);
  let bestSegment: ProjectedSegment | null = null;
  let bestTurn = Number.POSITIVE_INFINITY;

  for (const candidate of candidateSegments) {
    if (visited.has(candidate.id)) {
      continue;
    }

    const turn = normalizeAngle(
      getScreenAngle(candidate.coordinates[0], candidate.coordinates[1]) - incomingAngle,
    );

    if (turn < bestTurn || (turn === bestTurn && candidate.id < (bestSegment?.id ?? ""))) {
      bestTurn = turn;
      bestSegment = candidate;
    }
  }

  return bestSegment;
}

function stitchUndirectedSegments(segments: readonly ProjectedUndirectedSegment[]) {
  const segmentsByVertex = new Map<string, ProjectedUndirectedSegment[]>();
  const visited = new Set<string>();
  const polylines: Coordinate[][] = [];

  for (const segment of segments) {
    pushUndirectedSegment(segmentsByVertex, segment.startKey, segment);
    pushUndirectedSegment(segmentsByVertex, segment.endKey, segment);
  }

  const orderedVertices = [...segmentsByVertex.keys()].sort();

  for (const vertexKey of orderedVertices) {
    const degree = segmentsByVertex.get(vertexKey)?.length ?? 0;

    if (degree === 2) {
      continue;
    }

    for (const segment of segmentsByVertex.get(vertexKey) ?? []) {
      if (visited.has(segment.id)) {
        continue;
      }

      const path = traceUndirectedPath(vertexKey, segment, segmentsByVertex, visited);

      if (path.length >= 2) {
        polylines.push(path);
      }
    }
  }

  for (const segment of [...segments].sort((left, right) => left.id.localeCompare(right.id))) {
    if (visited.has(segment.id)) {
      continue;
    }

    const path = traceUndirectedPath(segment.startKey, segment, segmentsByVertex, visited);

    if (path.length >= 2) {
      polylines.push(path);
    }
  }

  return polylines;
}

function traceUndirectedPath(
  startKey: string,
  startSegment: ProjectedUndirectedSegment,
  segmentsByVertex: ReadonlyMap<string, readonly ProjectedUndirectedSegment[]>,
  visited: Set<string>,
) {
  const path: Coordinate[] = [coordinateFromKey(startKey)];
  let currentKey = startKey;
  let previousKey: string | null = null;
  let currentSegment: ProjectedUndirectedSegment | null = startSegment;
  let guard = 0;

  while (currentSegment && guard < segmentsByVertex.size * 8 + 8) {
    guard += 1;
    visited.add(currentSegment.id);
    const nextKey =
      currentSegment.startKey === currentKey ? currentSegment.endKey : currentSegment.startKey;
    path.push(coordinateFromKey(nextKey));

    const nextSegment = chooseNextUndirectedSegment(
      currentKey,
      nextKey,
      previousKey,
      segmentsByVertex.get(nextKey) ?? [],
      visited,
    );

    previousKey = currentKey;
    currentKey = nextKey;
    currentSegment = nextSegment;

    if (currentKey === startKey && currentSegment) {
      continue;
    }
  }

  return compactRing(path);
}

function chooseNextUndirectedSegment(
  currentKey: string,
  nextKey: string,
  previousKey: string | null,
  candidateSegments: readonly ProjectedUndirectedSegment[],
  visited: ReadonlySet<string>,
) {
  const currentPoint = coordinateFromKey(currentKey);
  const nextPoint = coordinateFromKey(nextKey);
  const incomingAngle = getScreenAngle(currentPoint, nextPoint);
  let bestSegment: ProjectedUndirectedSegment | null = null;
  let bestTurn = Number.POSITIVE_INFINITY;

  for (const candidate of candidateSegments) {
    if (visited.has(candidate.id)) {
      continue;
    }

    const candidateKey = candidate.startKey === nextKey ? candidate.endKey : candidate.startKey;

    if (previousKey && candidateKey === previousKey && candidateSegments.length > 1) {
      continue;
    }

    const turn = normalizeAngle(
      getScreenAngle(nextPoint, coordinateFromKey(candidateKey)) - incomingAngle,
    );

    if (turn < bestTurn || (turn === bestTurn && candidate.id < (bestSegment?.id ?? ""))) {
      bestTurn = turn;
      bestSegment = candidate;
    }
  }

  return bestSegment;
}

function selectLargestPolygon(polygons: readonly Coordinate[][][]) {
  let largestPolygon: Coordinate[][] | null = null;
  let largestArea = Number.NEGATIVE_INFINITY;

  for (const polygon of polygons) {
    const area = Math.abs(getSignedArea(removeClosingPoint(polygon[0]!)));

    if (area > largestArea) {
      largestArea = area;
      largestPolygon = polygon;
    }
  }

  return largestPolygon;
}

function orientRingForScreenInterior(ring: readonly Coordinate[]) {
  const openRing = removeClosingPoint(ring);

  if (openRing.length < 3) {
    return closeRing(openRing);
  }

  return getSignedArea(openRing) <= 0 ? closeRing(openRing) : closeRing([...openRing].reverse());
}

function createDirectedSegment(coordinates: [Coordinate, Coordinate]): ProjectedSegment {
  const start = snapCoordinate(coordinates[0]);
  const end = snapCoordinate(coordinates[1]);

  return {
    coordinates: [start, end],
    endKey: formatCoordinateKey(end),
    id: `${formatCoordinateKey(start)}->${formatCoordinateKey(end)}`,
    startKey: formatCoordinateKey(start),
  };
}

function createUndirectedSegment(
  coordinates: [Coordinate, Coordinate],
): ProjectedUndirectedSegment {
  const normalized = normalizeEdge(coordinates[0], coordinates[1]);

  return {
    coordinates: normalized.coordinates,
    endKey: formatCoordinateKey(normalized.coordinates[1]),
    id: normalized.key,
    startKey: formatCoordinateKey(normalized.coordinates[0]),
  };
}

function dedupeEdgeOwners(
  owners: ReadonlyArray<{
    clusterId: ClusterVoronoiInput["clusterId"];
    coordinates: [Coordinate, Coordinate];
  }>,
) {
  const ownerMap = new Map<
    string,
    {
      clusterId: ClusterVoronoiInput["clusterId"];
      coordinates: [Coordinate, Coordinate];
    }
  >();

  for (const owner of owners) {
    const serializedClusterId = serializeClusterId(owner.clusterId);

    if (!ownerMap.has(serializedClusterId)) {
      ownerMap.set(serializedClusterId, owner);
    }
  }

  return [...ownerMap.values()].sort((left, right) =>
    compareClusterIds(left.clusterId, right.clusterId),
  );
}

function pushSegment(
  segmentMap: Map<ClusterVoronoiInput["clusterId"], ProjectedSegment[]>,
  clusterId: ClusterVoronoiInput["clusterId"],
  segment: ProjectedSegment,
) {
  const segments = segmentMap.get(clusterId);

  if (segments) {
    segments.push(segment);
    return;
  }

  segmentMap.set(clusterId, [segment]);
}

function pushBoundaryPairSegment(
  boundarySegmentsByPair: Map<
    string,
    {
      clusterIds: [number | string, number | string | null];
      segments: ProjectedUndirectedSegment[];
    }
  >,
  clusterIds: [number | string, number | string | null],
  coordinates: [Coordinate, Coordinate],
) {
  const pairKey = `${serializeClusterId(clusterIds[0])}|${
    clusterIds[1] === null ? "null" : serializeClusterId(clusterIds[1])
  }`;
  const boundary = boundarySegmentsByPair.get(pairKey);
  const segment = createUndirectedSegment(coordinates);

  if (boundary) {
    boundary.segments.push(segment);
    return;
  }

  boundarySegmentsByPair.set(pairKey, {
    clusterIds,
    segments: [segment],
  });
}

function pushUndirectedSegment(
  segmentMap: Map<string, ProjectedUndirectedSegment[]>,
  vertexKey: string,
  segment: ProjectedUndirectedSegment,
) {
  const segments = segmentMap.get(vertexKey);

  if (segments) {
    segments.push(segment);
    return;
  }

  segmentMap.set(vertexKey, [segment]);
}

function compareProjectedClusters(
  left: {
    clusterId: ClusterVoronoiInput["clusterId"];
    coordinates: Coordinate;
    sourceIndex: number;
  },
  right: {
    clusterId: ClusterVoronoiInput["clusterId"];
    coordinates: Coordinate;
    sourceIndex: number;
  },
) {
  const clusterIdOrder = compareClusterIds(left.clusterId, right.clusterId);

  if (clusterIdOrder !== 0) {
    return clusterIdOrder;
  }

  const coordinateOrder = compareCoordinates(left.coordinates, right.coordinates);

  if (coordinateOrder !== 0) {
    return coordinateOrder;
  }

  return left.sourceIndex - right.sourceIndex;
}

function compareClusterIds(
  left: ClusterVoronoiInput["clusterId"],
  right: ClusterVoronoiInput["clusterId"],
) {
  return serializeClusterId(left).localeCompare(serializeClusterId(right));
}

function stabilizeProjectedClusters<
  TCluster extends {
    projected: Coordinate;
  },
>(clusters: readonly TCluster[]) {
  const collisionCounts = new Map<string, number>();

  return clusters.map((cluster) => {
    const pointKey = formatCoordinateKey(cluster.projected);
    const collisionCount = collisionCounts.get(pointKey) ?? 0;

    collisionCounts.set(pointKey, collisionCount + 1);

    if (collisionCount === 0) {
      return cluster;
    }

    const angle = collisionCount * ((Math.PI * 2) / DEFAULT_SEGMENTS);
    const radius = DUPLICATE_POINT_OFFSET * (1 + Math.floor(collisionCount / DEFAULT_SEGMENTS));

    return {
      ...cluster,
      projected: [
        cluster.projected[0] + Math.cos(angle) * radius,
        cluster.projected[1] + Math.sin(angle) * radius,
      ] as Coordinate,
    };
  });
}

function createScreenProjectionFromBounds(bounds: Bounds) {
  const projection = createProjectionFromBounds(bounds);

  return {
    project(coordinate: Coordinate) {
      const [x, y] = projection.project(coordinate);
      return [x, -y] as Coordinate;
    },
    unproject(coordinate: Coordinate) {
      return projection.unproject([coordinate[0], -coordinate[1]]);
    },
  };
}

function projectBoundsToViewport(
  bounds: Bounds,
  projection: ReturnType<typeof createScreenProjectionFromBounds>,
  padding = DEFAULT_VORONOI_VIEWPORT_PADDING,
): [number, number, number, number] {
  const topLeft = projection.project([bounds[0], bounds[3]]);
  const bottomRight = projection.project([bounds[2], bounds[1]]);

  return [
    topLeft[0] - padding,
    topLeft[1] - padding,
    bottomRight[0] + padding,
    bottomRight[1] + padding,
  ];
}

function snapCoordinate(point: Coordinate): Coordinate {
  return [
    Math.round(point[0] / SEGMENT_EPSILON) * SEGMENT_EPSILON,
    Math.round(point[1] / SEGMENT_EPSILON) * SEGMENT_EPSILON,
  ];
}

function coordinateFromKey(key: string): Coordinate {
  const [x, y] = key.split(":");
  return [Number(x), Number(y)];
}

function getScreenAngle(start: Coordinate, end: Coordinate) {
  return Math.atan2(-(end[1] - start[1]), end[0] - start[0]);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function compactRing(points: readonly Coordinate[]) {
  const compacted: Coordinate[] = [];

  for (const point of points) {
    if (!samePointWithTolerance(point, compacted.at(-1))) {
      compacted.push(point);
    }
  }

  if (samePointWithTolerance(compacted[0], compacted.at(-1))) {
    compacted.pop();
  }

  return compacted;
}

function samePointWithTolerance(left: Coordinate | undefined, right: Coordinate | undefined) {
  if (!left || !right) {
    return false;
  }

  return (
    Math.abs(left[0] - right[0]) <= SEGMENT_EPSILON &&
    Math.abs(left[1] - right[1]) <= SEGMENT_EPSILON
  );
}

function normalizeEdge(start: Coordinate, end: Coordinate) {
  const snappedStart = snapCoordinate(start);
  const snappedEnd = snapCoordinate(end);
  const coordinates =
    compareCoordinates(snappedStart, snappedEnd) <= 0
      ? ([snappedStart, snappedEnd] as [Coordinate, Coordinate])
      : ([snappedEnd, snappedStart] as [Coordinate, Coordinate]);

  return {
    coordinates,
    key: `${formatCoordinateKey(coordinates[0])}:${formatCoordinateKey(coordinates[1])}`,
  };
}

function compareCoordinates(left: Coordinate, right: Coordinate) {
  if (left[0] === right[0]) {
    return left[1] - right[1];
  }

  return left[0] - right[0];
}

function formatCoordinateKey(point: Coordinate) {
  const snappedPoint = snapCoordinate(point);
  return `${snappedPoint[0].toFixed(4)}:${snappedPoint[1].toFixed(4)}`;
}

function serializeClusterId(clusterId: ClusterVoronoiInput["clusterId"]) {
  return `${typeof clusterId}:${String(clusterId)}`;
}

export function clipRingToPolygon(
  subjectRing: readonly Coordinate[],
  clipRing: readonly Coordinate[],
) {
  const subject = removeClosingPoint(subjectRing);
  const clip = removeClosingPoint(clipRing);

  if (subject.length < 3 || clip.length < 3) {
    return null;
  }

  let output = [...subject];
  const clipOrientation = Math.sign(getSignedArea(clip)) || 1;

  for (let index = 0; index < clip.length; index += 1) {
    const clipStart = clip[index]!;
    const clipEnd = clip[(index + 1) % clip.length]!;
    const input = output;

    output = [];

    if (input.length === 0) {
      break;
    }

    let previousPoint = input.at(-1)!;

    for (const currentPoint of input) {
      const currentInside = isInsideClipEdge(currentPoint, clipStart, clipEnd, clipOrientation);
      const previousInside = isInsideClipEdge(previousPoint, clipStart, clipEnd, clipOrientation);

      if (currentInside) {
        if (!previousInside) {
          const intersection = getIntersection(previousPoint, currentPoint, clipStart, clipEnd);

          if (intersection) {
            output.push(intersection);
          }
        }

        output.push(currentPoint);
      } else if (previousInside) {
        const intersection = getIntersection(previousPoint, currentPoint, clipStart, clipEnd);

        if (intersection) {
          output.push(intersection);
        }
      }

      previousPoint = currentPoint;
    }
  }

  if (output.length < 3) {
    return null;
  }

  return closeRing(output);
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

function createProjectionFromBounds(bounds: Bounds) {
  const centerLongitude = (bounds[0] + bounds[2]) / 2;
  const centerLatitude = (bounds[1] + bounds[3]) / 2;
  const scale = Math.cos((centerLatitude * Math.PI) / 180);

  return {
    project(coordinate: Coordinate): Coordinate {
      return [(coordinate[0] - centerLongitude) * scale, coordinate[1] - centerLatitude];
    },
    unproject(coordinate: Coordinate): Coordinate {
      return [
        coordinate[0] / (scale || Number.EPSILON) + centerLongitude,
        coordinate[1] + centerLatitude,
      ];
    },
  };
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

function removeClosingPoint(points: readonly Coordinate[]) {
  if (points.length >= 2 && samePoint(points[0]!, points.at(-1)!)) {
    return points.slice(0, -1);
  }

  return [...points];
}

function samePoint(left: Coordinate, right: Coordinate) {
  return left[0] === right[0] && left[1] === right[1];
}

function isInsideClipEdge(
  point: Coordinate,
  clipStart: Coordinate,
  clipEnd: Coordinate,
  clipOrientation: number,
) {
  const side = crossCoordinates(clipStart, clipEnd, point);

  return clipOrientation >= 0 ? side >= -1e-9 : side <= 1e-9;
}

function getIntersection(
  segmentStart: Coordinate,
  segmentEnd: Coordinate,
  clipStart: Coordinate,
  clipEnd: Coordinate,
): Coordinate | null {
  const segmentDirection: Coordinate = [
    segmentEnd[0] - segmentStart[0],
    segmentEnd[1] - segmentStart[1],
  ];
  const clipDirection: Coordinate = [clipEnd[0] - clipStart[0], clipEnd[1] - clipStart[1]];
  const denominator =
    segmentDirection[0] * clipDirection[1] - segmentDirection[1] * clipDirection[0];

  if (Math.abs(denominator) <= 1e-12) {
    return null;
  }

  const difference: Coordinate = [clipStart[0] - segmentStart[0], clipStart[1] - segmentStart[1]];
  const t = (difference[0] * clipDirection[1] - difference[1] * clipDirection[0]) / denominator;

  return [segmentStart[0] + segmentDirection[0] * t, segmentStart[1] + segmentDirection[1] * t];
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
