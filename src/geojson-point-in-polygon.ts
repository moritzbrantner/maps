import type { GeoJsonPosition } from "./temporal-geojson-types";

/*
 * Planar point-in-polygon test shared by GeoJSON operations and scalar-field
 * masks. A Polygon is its exterior ring minus its interior rings (holes); each
 * ring is tested with the even-odd crossing rule, so ring winding order does
 * not matter. Points on a hole boundary are outside the polygon; points on the
 * exterior boundary are inside only when `includeBoundary` is set. Rings are
 * expected to be closed (first position repeated last), as GeoJSON requires.
 */

const POINT_ON_SEGMENT_EPSILON = 1e-9;

export function containsPointInPolygon(
  polygon: GeoJsonPosition[][],
  point: GeoJsonPosition,
  includeBoundary: boolean,
) {
  const shell = polygon[0];

  if (!shell || !pointInRing(shell, point, includeBoundary)) {
    return false;
  }

  return polygon.slice(1).every((hole) => !pointInRing(hole, point, true));
}

function pointInRing(ring: readonly GeoJsonPosition[], point: GeoJsonPosition, includeBoundary: boolean) {
  if (isPointOnRing(ring, point)) {
    return includeBoundary;
  }

  let inside = false;
  const [x, y] = point;

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const [xi, yi] = ring[index]!;
    const [xj, yj] = ring[previousIndex]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function isPointOnRing(ring: readonly GeoJsonPosition[], point: GeoJsonPosition) {
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (isPointOnSegment(point, ring[index]!, ring[index + 1]!)) {
      return true;
    }
  }

  return false;
}

function isPointOnSegment(point: GeoJsonPosition, start: GeoJsonPosition, end: GeoJsonPosition) {
  const cross =
    (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1]);

  if (Math.abs(cross) > POINT_ON_SEGMENT_EPSILON) {
    return false;
  }

  const dot =
    (point[0] - start[0]) * (end[0] - start[0]) +
    (point[1] - start[1]) * (end[1] - start[1]);

  if (dot < 0) {
    return false;
  }

  const squaredLength =
    (end[0] - start[0]) * (end[0] - start[0]) +
    (end[1] - start[1]) * (end[1] - start[1]);

  return dot <= squaredLength;
}
