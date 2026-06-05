import { Delaunay } from "d3-delaunay";
import {
  difference,
  intersection,
  union,
  type MultiPolygon as ClippingMultiPolygon,
  type Ring as ClippingRing,
} from "polygon-clipping";

import { cloneGeometry, closeRing } from "./temporal-geojson-geometry";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type PolygonLikeGeometry =
  | Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>
  | Extract<TemporalGeoJsonSupportedGeometry, { type: "MultiPolygon" }>;

export type TopologyPolygonEntry<TProperties extends Record<string, unknown>> = {
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  geometry: PolygonLikeGeometry;
  index: number;
  key: string;
  partIndex?: number;
  partPath?: string;
};

export type TopologyOverlapEdge<TProperties extends Record<string, unknown>> = {
  area: number;
  ratioOfSource: number;
  ratioOfTarget: number;
  source: TopologyPolygonEntry<TProperties>;
  target: TopologyPolygonEntry<TProperties>;
  overlapGeometry: PolygonLikeGeometry;
};

export type TopologyBounds = {
  east: number;
  north: number;
  south: number;
  west: number;
};

const AREA_EPSILON = 1e-9;

export function intersectPolygonLike(
  left: PolygonLikeGeometry,
  right: PolygonLikeGeometry,
): PolygonLikeGeometry | null {
  return runBooleanOperation(() =>
    fromClippingMultiPolygon(intersection(toClippingMultiPolygon(left), toClippingMultiPolygon(right))),
  );
}

export function differencePolygonLike(
  left: PolygonLikeGeometry,
  ...right: PolygonLikeGeometry[]
): PolygonLikeGeometry | null {
  if (right.length === 0) {
    return cloneGeometry(left) as PolygonLikeGeometry;
  }

  return runBooleanOperation(() =>
    fromClippingMultiPolygon(
      difference(toClippingMultiPolygon(left), ...right.map(toClippingMultiPolygon)),
    ),
  );
}

export function unionPolygonLikes(items: PolygonLikeGeometry[]): PolygonLikeGeometry | null {
  if (items.length === 0) {
    return null;
  }

  if (items.length === 1) {
    return cloneGeometry(items[0]!) as PolygonLikeGeometry;
  }

  return runBooleanOperation(() =>
    fromClippingMultiPolygon(union(toClippingMultiPolygon(items[0]!), ...items.slice(1).map(toClippingMultiPolygon))),
  );
}

export function clipPolygonLikeToVoronoiCell(
  subject: PolygonLikeGeometry,
  cellRing: GeoJsonPosition[],
): PolygonLikeGeometry | null {
  const cell = fromClippingMultiPolygon([[normalizeClippingRing(cellRing)]]);

  return cell ? intersectPolygonLike(subject, cell) : null;
}

export function getPolygonLikeArea(geometry: PolygonLikeGeometry): number {
  if (geometry.type === "Polygon") {
    return getPolygonArea(geometry.coordinates);
  }

  return geometry.coordinates.reduce((sum, polygon) => sum + getPolygonArea(polygon), 0);
}

export function getPolygonLikeCentroid(geometry: PolygonLikeGeometry): GeoJsonPosition {
  const weighted = getPolygonCentroidParts(geometry).reduce(
    (sum, part) => ({
      area: sum.area + part.area,
      x: sum.x + part.centroid[0] * part.area,
      y: sum.y + part.centroid[1] * part.area,
    }),
    { area: 0, x: 0, y: 0 },
  );

  if (weighted.area > AREA_EPSILON) {
    return [weighted.x / weighted.area, weighted.y / weighted.area];
  }

  const positions = getPolygonLikePositions(geometry);
  const totals = positions.reduce(
    (sum, position) => [sum[0] + position[0], sum[1] + position[1]] as GeoJsonPosition,
    [0, 0],
  );

  return positions.length === 0
    ? [0, 0]
    : [totals[0] / positions.length, totals[1] / positions.length];
}

export function getPolygonLikeBounds(items: PolygonLikeGeometry[]): TopologyBounds {
  const positions = items.flatMap(getPolygonLikePositions);
  const bounds = positions.reduce(
    (current, position) => ({
      east: Math.max(current.east, position[0]),
      north: Math.max(current.north, position[1]),
      south: Math.min(current.south, position[1]),
      west: Math.min(current.west, position[0]),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );

  if (!Number.isFinite(bounds.west + bounds.south + bounds.east + bounds.north)) {
    return { east: 1, north: 1, south: -1, west: -1 };
  }

  return bounds;
}

export function createExpandedTopologyBounds(items: PolygonLikeGeometry[]): TopologyBounds {
  const bounds = getPolygonLikeBounds(items);
  const width = Math.max(bounds.east - bounds.west, 1);
  const height = Math.max(bounds.north - bounds.south, 1);
  const padding = Math.max(width, height) * 0.25;

  return {
    east: bounds.east + padding,
    north: bounds.north + padding,
    south: bounds.south - padding,
    west: bounds.west - padding,
  };
}

export function createVoronoiCellRings(
  points: GeoJsonPosition[],
  bounds: TopologyBounds,
): Array<GeoJsonPosition[] | null> {
  if (points.length === 0) {
    return [];
  }

  try {
    const delaunay = Delaunay.from(points);
    const voronoi = delaunay.voronoi([bounds.west, bounds.south, bounds.east, bounds.north]);

    return points.map((_, index) => {
      const cell = voronoi.cellPolygon(index);

      return cell && cell.length >= 4
        ? closeRing(cell.map((position) => [position[0], position[1]] as GeoJsonPosition))
        : null;
    });
  } catch {
    return points.map(() => null);
  }
}

function toClippingMultiPolygon(geometry: PolygonLikeGeometry): ClippingMultiPolygon {
  if (geometry.type === "Polygon") {
    return [geometry.coordinates.map(normalizeClippingRing)];
  }

  return geometry.coordinates.map((polygon) => polygon.map(normalizeClippingRing));
}

function fromClippingMultiPolygon(output: ClippingMultiPolygon): PolygonLikeGeometry | null {
  const polygons = output
    .map((polygon) =>
      polygon
        .map((ring) => normalizeGeoJsonRing(ring))
        .filter((ring, index) => index === 0 || Math.abs(getRingSignedArea(ring)) > AREA_EPSILON),
    )
    .filter((polygon) => polygon.length > 0 && Math.abs(getRingSignedArea(polygon[0]!)) > AREA_EPSILON);

  if (polygons.length === 0) {
    return null;
  }

  return polygons.length === 1
    ? { coordinates: polygons[0]!, type: "Polygon" }
    : { coordinates: polygons, type: "MultiPolygon" };
}

function normalizeClippingRing(ring: readonly GeoJsonPosition[]): ClippingRing {
  return closeRing(ring.map((position) => [position[0], position[1]] as GeoJsonPosition)).map(
    (position) => [position[0], position[1]],
  );
}

function normalizeGeoJsonRing(ring: readonly GeoJsonPosition[] | ClippingRing): GeoJsonPosition[] {
  const positions = closeRing(
    ring
      .map((position) => [position[0], position[1]] as GeoJsonPosition)
      .filter((position) => Number.isFinite(position[0]) && Number.isFinite(position[1])),
  );

  return positions.length >= 4 ? positions : [];
}

function getPolygonLikePositions(geometry: PolygonLikeGeometry): GeoJsonPosition[] {
  return geometry.type === "Polygon" ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
}

function getPolygonArea(polygon: GeoJsonPosition[][]) {
  return Math.abs(
    polygon.reduce((total, ring, ringIndex) => {
      const area = Math.abs(getRingSignedArea(ring));

      return ringIndex === 0 ? total + area : total - area;
    }, 0),
  );
}

function getRingSignedArea(ring: readonly GeoJsonPosition[]) {
  if (ring.length < 3) {
    return 0;
  }

  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const left = ring[index]!;
    const right = ring[index + 1]!;

    area += left[0] * right[1] - right[0] * left[1];
  }

  return area / 2;
}

function getPolygonCentroidParts(geometry: PolygonLikeGeometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  return polygons.flatMap((polygon) => {
    const shell = polygon[0];

    if (!shell) {
      return [];
    }

    const area = Math.abs(getRingSignedArea(shell));
    const centroid = getRingCentroid(shell);

    return area > AREA_EPSILON ? [{ area, centroid }] : [];
  });
}

function getRingCentroid(ring: readonly GeoJsonPosition[]): GeoJsonPosition {
  const signedArea = getRingSignedArea(ring);

  if (Math.abs(signedArea) <= AREA_EPSILON) {
    const totals = ring.reduce(
      (sum, position) => [sum[0] + position[0], sum[1] + position[1]] as GeoJsonPosition,
      [0, 0],
    );

    return ring.length === 0 ? [0, 0] : [totals[0] / ring.length, totals[1] / ring.length];
  }

  let x = 0;
  let y = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const left = ring[index]!;
    const right = ring[index + 1]!;
    const cross = left[0] * right[1] - right[0] * left[1];

    x += (left[0] + right[0]) * cross;
    y += (left[1] + right[1]) * cross;
  }

  return [x / (6 * signedArea), y / (6 * signedArea)];
}

function runBooleanOperation(operation: () => PolygonLikeGeometry | null): PolygonLikeGeometry | null {
  try {
    return operation();
  } catch {
    return null;
  }
}
