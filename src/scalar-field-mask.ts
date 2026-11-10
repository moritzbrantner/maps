import { containsPointInPolygon } from "./geojson-point-in-polygon";
import type { GeoJsonPosition } from "./temporal-geojson-types";

/*
 * Scalar-field masks clip an interpolated field to polygonal GeoJSON.
 *
 * Semantics (planar longitude/latitude, no antimeridian wrapping):
 * - The mask is the union of every Polygon found in the GeoJSON (Polygon,
 *   MultiPolygon, GeometryCollection, Feature, FeatureCollection). Other
 *   geometry types contribute no area.
 * - A Polygon is its exterior ring minus its interior rings (holes). Ring
 *   winding order does not matter and unclosed rings are closed.
 * - A position on the exterior boundary is inside; a position on a hole
 *   boundary is outside.
 * - A hole only removes area from its own Polygon: another Polygon of the mask
 *   may cover it again (an island inside a hole).
 * - A mask without any polygonal area contains nothing.
 */

export type ScalarFieldMask = {
  contains(coordinate: readonly [longitude: number, latitude: number]): boolean;
};

type MaskPolygon = {
  east: number;
  north: number;
  rings: GeoJsonPosition[][];
  south: number;
  west: number;
};

export function createScalarFieldMask(maskGeoJson: unknown): ScalarFieldMask | null {
  if (maskGeoJson === null || maskGeoJson === undefined) {
    return null;
  }

  const polygons: MaskPolygon[] = [];
  collectMaskPolygons(maskGeoJson, polygons, 0);

  return {
    contains([longitude, latitude]) {
      for (const polygon of polygons) {
        if (
          longitude >= polygon.west &&
          longitude <= polygon.east &&
          latitude >= polygon.south &&
          latitude <= polygon.north &&
          containsPointInPolygon(polygon.rings, [longitude, latitude], true)
        ) {
          return true;
        }
      }

      return false;
    },
  };
}

function collectMaskPolygons(value: unknown, polygons: MaskPolygon[], depth: number) {
  if (!value || typeof value !== "object" || depth > 8) {
    return;
  }

  const node = value as {
    coordinates?: unknown;
    features?: unknown;
    geometries?: unknown;
    geometry?: unknown;
    type?: unknown;
  };

  switch (node.type) {
    case "FeatureCollection":
      forEachEntry(node.features, (feature) => collectMaskPolygons(feature, polygons, depth + 1));
      break;
    case "Feature":
      collectMaskPolygons(node.geometry, polygons, depth + 1);
      break;
    case "GeometryCollection":
      forEachEntry(node.geometries, (geometry) => collectMaskPolygons(geometry, polygons, depth + 1));
      break;
    case "MultiPolygon":
      forEachEntry(node.coordinates, (polygon) => addMaskPolygon(polygon, polygons));
      break;
    case "Polygon":
      addMaskPolygon(node.coordinates, polygons);
      break;
    default:
      break;
  }
}

function addMaskPolygon(coordinates: unknown, polygons: MaskPolygon[]) {
  if (!Array.isArray(coordinates)) {
    return;
  }

  const exterior = normalizeMaskRing(coordinates[0]);

  if (!exterior) {
    return;
  }

  const rings = [exterior];

  for (let index = 1; index < coordinates.length; index += 1) {
    const hole = normalizeMaskRing(coordinates[index]);

    if (hole) {
      rings.push(hole);
    }
  }

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const [longitude, latitude] of exterior) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  polygons.push({ east, north, rings, south, west });
}

// Keeps finite positions, closes the ring, and rejects rings that cannot enclose area.
function normalizeMaskRing(ring: unknown): GeoJsonPosition[] | null {
  if (!Array.isArray(ring)) {
    return null;
  }

  const positions: GeoJsonPosition[] = [];

  for (const position of ring) {
    if (
      Array.isArray(position) &&
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1])
    ) {
      positions.push([position[0] as number, position[1] as number]);
    }
  }

  const first = positions[0];
  const last = positions[positions.length - 1];

  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    positions.push([first[0], first[1]]);
  }

  return positions.length >= 4 ? positions : null;
}

function forEachEntry(value: unknown, visit: (entry: unknown) => void) {
  if (Array.isArray(value)) {
    value.forEach(visit);
  }
}
