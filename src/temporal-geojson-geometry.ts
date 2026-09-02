import { booleanClockwise } from "@turf/boolean-clockwise";

import { isRecord } from "./temporal-core";
import type {
  GeoJsonLineStringGeometry,
  GeoJsonMultiLineStringGeometry,
  GeoJsonMultiPointGeometry,
  GeoJsonMultiPolygonGeometry,
  GeoJsonPointGeometry,
  GeoJsonPolygonGeometry,
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type NormalizedGeometryPart = {
  geometry: TemporalGeoJsonSupportedGeometry;
  partIndex: number;
  partPath: string;
};

export function normalizeSupportedGeometry(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): TemporalGeoJsonSupportedGeometry | null {
  if (!geometry || !isRecord(geometry)) {
    return null;
  }

  switch (geometry.type) {
    case "Point":
      return normalizePointGeometry(geometry);
    case "MultiPoint":
      return normalizeMultiPointGeometry(geometry);
    case "LineString":
      return normalizeLineStringGeometry(geometry);
    case "MultiLineString":
      return normalizeMultiLineStringGeometry(geometry);
    case "Polygon":
      return normalizePolygonGeometry(geometry);
    case "MultiPolygon":
      return normalizeMultiPolygonGeometry(geometry);
    default:
      return null;
  }
}

export function normalizeGeometryCollection(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): TemporalGeoJsonSupportedGeometry[] {
  return normalizeGeometryParts(geometry).map((part) => part.geometry);
}

export function normalizeGeometryParts(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
  options: {
    decomposeMultiGeometries?: boolean;
  } = {},
): NormalizedGeometryPart[] {
  return normalizeGeometryPartsAtPath(geometry, "geometry", options).map((part, partIndex) => ({
    ...part,
    partIndex,
  }));
}

function normalizeGeometryPartsAtPath(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
  partPath: string,
  options: {
    decomposeMultiGeometries?: boolean;
  },
): Omit<NormalizedGeometryPart, "partIndex">[] {
  if (!geometry || !isRecord(geometry)) {
    return [];
  }

  if (geometry.type !== "GeometryCollection") {
    const normalized = normalizeSupportedGeometry(geometry);

    if (!normalized) {
      return [];
    }

    return decomposeGeometryPart(normalized, partPath, options);
  }

  const collection = geometry as { geometries?: unknown; type: "GeometryCollection" };

  if (!Array.isArray(collection.geometries)) {
    return [];
  }

  return collection.geometries.flatMap((item: unknown, index) =>
    normalizeGeometryPartsAtPath(
      item as TemporalGeoJsonGeometryFeature["geometry"],
      `${partPath}.geometries[${index}]`,
      options,
    ),
  );
}

function decomposeGeometryPart(
  geometry: TemporalGeoJsonSupportedGeometry,
  partPath: string,
  options: {
    decomposeMultiGeometries?: boolean;
  },
): Omit<NormalizedGeometryPart, "partIndex">[] {
  if (!options.decomposeMultiGeometries) {
    return [{ geometry, partPath }];
  }

  switch (geometry.type) {
    case "MultiPoint":
      return geometry.coordinates.map((coordinates, index) => ({
        geometry: { coordinates: clonePosition(coordinates), type: "Point" as const },
        partPath: `${partPath}.coordinates[${index}]`,
      }));
    case "MultiLineString":
      return geometry.coordinates.map((coordinates, index) => ({
        geometry: { coordinates: coordinates.map(clonePosition), type: "LineString" as const },
        partPath: `${partPath}.coordinates[${index}]`,
      }));
    case "MultiPolygon":
      return geometry.coordinates.map((coordinates, index) => ({
        geometry: {
          coordinates: coordinates.map((ring) => ring.map(clonePosition)),
          type: "Polygon" as const,
        },
        partPath: `${partPath}.coordinates[${index}]`,
      }));
    case "LineString":
    case "Point":
    case "Polygon":
      return [{ geometry, partPath }];
  }
}

function normalizePointGeometry(geometry: {
  coordinates?: unknown;
  type: string;
}): GeoJsonPointGeometry | null {
  const position = normalizePosition(geometry.coordinates);

  return position ? { coordinates: position, type: "Point" } : null;
}

function normalizeMultiPointGeometry(geometry: {
  coordinates?: unknown;
  type: string;
}): GeoJsonMultiPointGeometry | null {
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    return null;
  }

  const coordinates = geometry.coordinates.map(normalizePosition);

  if (coordinates.some((position) => position === null)) {
    return null;
  }

  return {
    coordinates: coordinates as GeoJsonPosition[],
    type: "MultiPoint",
  };
}

function normalizeLineStringGeometry(geometry: {
  coordinates?: unknown;
  type: string;
}): GeoJsonLineStringGeometry | null {
  const coordinates = normalizeLineCoordinates(geometry.coordinates);

  return coordinates ? { coordinates, type: "LineString" } : null;
}

function normalizeMultiLineStringGeometry(geometry: {
  coordinates?: unknown;
  type: string;
}): GeoJsonMultiLineStringGeometry | null {
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    return null;
  }

  const lines = geometry.coordinates.map(normalizeLineCoordinates);

  if (lines.some((line) => line === null)) {
    return null;
  }

  return {
    coordinates: lines as GeoJsonPosition[][],
    type: "MultiLineString",
  };
}

function normalizePolygonGeometry(geometry: {
  coordinates?: unknown;
  type: string;
}): GeoJsonPolygonGeometry | null {
  const coordinates = normalizePolygonCoordinates(geometry.coordinates);

  return coordinates ? { coordinates, type: "Polygon" } : null;
}

function normalizeMultiPolygonGeometry(geometry: {
  coordinates?: unknown;
  type: string;
}): GeoJsonMultiPolygonGeometry | null {
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    return null;
  }

  const polygons = geometry.coordinates.map(normalizePolygonCoordinates);

  if (polygons.some((polygon) => polygon === null)) {
    return null;
  }

  return {
    coordinates: polygons as GeoJsonPosition[][][],
    type: "MultiPolygon",
  };
}

function normalizeLineCoordinates(value: unknown): GeoJsonPosition[] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const coordinates = value.map(normalizePosition);

  if (coordinates.some((position) => position === null)) {
    return null;
  }

  return coordinates as GeoJsonPosition[];
}

function normalizePolygonCoordinates(value: unknown): GeoJsonPosition[][] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const rings = value.map(normalizeRing);

  if (rings.some((ring) => ring === null)) {
    return null;
  }

  return rings as GeoJsonPosition[][];
}

export function normalizeRing(value: unknown): GeoJsonPosition[] | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }

  const coordinates = value.map(normalizePosition);

  if (coordinates.some((position) => position === null)) {
    return null;
  }

  const openRing = removeClosingPosition(coordinates as GeoJsonPosition[]);

  if (openRing.length < 3) {
    return null;
  }

  return closeRing(openRing);
}

function normalizePosition(value: unknown): GeoJsonPosition | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const longitude = value[0];
  const latitude = value[1];

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  return [longitude, latitude];
}

export function orientRingLike(
  ring: readonly GeoJsonPosition[],
  referenceRing: readonly GeoJsonPosition[],
) {
  const normalizedRing = closeRing(ring);
  const normalizedReferenceRing = closeRing(referenceRing);
  const ringIsClockwise = booleanClockwise(normalizedRing);
  const referenceRingIsClockwise = booleanClockwise(normalizedReferenceRing);

  return ringIsClockwise === referenceRingIsClockwise ? [...ring] : [...ring].reverse();
}

export function alignRingStart(ring: readonly GeoJsonPosition[], targetPosition: GeoJsonPosition) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < ring.length; index += 1) {
    const candidateDistance = distance(ring[index]!, targetPosition);

    if (candidateDistance >= bestDistance) {
      continue;
    }

    bestDistance = candidateDistance;
    bestIndex = index;
  }

  return [...ring.slice(bestIndex), ...ring.slice(0, bestIndex)];
}

export function getOpenRing(ring: readonly GeoJsonPosition[]) {
  const normalizedRing = normalizeRing(ring);

  return normalizedRing ? removeClosingPosition(normalizedRing) : null;
}

export function closeRing(coordinates: readonly GeoJsonPosition[]): GeoJsonPosition[] {
  if (coordinates.length === 0) {
    return [];
  }

  const closed = coordinates.map(clonePosition);

  if (!samePosition(closed[0]!, closed.at(-1)!)) {
    closed.push(clonePosition(closed[0]!));
  }

  return closed;
}

function removeClosingPosition(coordinates: readonly GeoJsonPosition[]) {
  if (coordinates.length >= 2 && samePosition(coordinates[0]!, coordinates.at(-1)!)) {
    return coordinates.slice(0, -1).map(clonePosition);
  }

  return coordinates.map(clonePosition);
}

export function cloneGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return {
        coordinates: clonePosition(geometry.coordinates),
        type: "Point",
      };
    case "MultiPoint":
      return {
        coordinates: geometry.coordinates.map(clonePosition),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: geometry.coordinates.map(clonePosition),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line) => line.map(clonePosition)),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring) => ring.map(clonePosition)),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(clonePosition)),
        ),
        type: "MultiPolygon",
      };
  }
}

export function clonePosition(position: GeoJsonPosition): GeoJsonPosition {
  return [position[0], position[1]];
}

function samePosition(left: GeoJsonPosition, right: GeoJsonPosition) {
  return left[0] === right[0] && left[1] === right[1];
}

function distance(left: GeoJsonPosition, right: GeoJsonPosition) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}
