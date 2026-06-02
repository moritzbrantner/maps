"use client";

import {
  cloneGeometry,
  clonePosition,
  closeRing,
  normalizeSupportedGeometry,
} from "./temporal-geojson-geometry";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";
import type {
  GeoJsonEditOperation,
  GeoJsonEditValidationResult,
  GeoJsonVertexHandle,
} from "./geojson-editor";

export function applyGeoJsonEditOperation<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  operation: GeoJsonEditOperation<TProperties>,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  return applyGeoJsonEditOperationWithResolver(collection, operation);
}

export function applyGeoJsonEditOperationWithResolver<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  operation: GeoJsonEditOperation<TProperties>,
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  if (operation.type === "create") {
    return {
      ...collection,
      features: [...collection.features.map(cloneFeature), cloneFeature(operation.feature)],
    };
  }

  if (operation.type === "batch") {
    return operation.operations.reduce(
      (current, childOperation) =>
        applyGeoJsonEditOperationWithResolver(current, childOperation, getFeatureId),
      collection,
    );
  }

  if (operation.type === "delete") {
    return {
      ...collection,
      features: collection.features
        .map(cloneFeature)
        .filter(
          (feature, index) =>
            resolveFeatureIdWithGetter(feature, index, getFeatureId) !== operation.featureId,
        ),
    };
  }

  return {
    ...collection,
    features: collection.features.map((feature, index) =>
      resolveFeatureIdWithGetter(feature, index, getFeatureId) === operation.featureId
        ? cloneFeature(operation.feature)
        : cloneFeature(feature),
    ),
  };
}

export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "Point",
  coordinates: GeoJsonPosition,
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties>;
export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "LineString",
  coordinates: readonly GeoJsonPosition[],
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties>;
export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "Polygon",
  coordinates: readonly (readonly GeoJsonPosition[])[],
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties>;
export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "Point" | "LineString" | "Polygon",
  coordinates:
    | GeoJsonPosition
    | readonly GeoJsonPosition[]
    | readonly (readonly GeoJsonPosition[])[],
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties> {
  if (geometryType === "Point") {
    return {
      geometry: {
        coordinates: clonePosition(coordinates as GeoJsonPosition),
        type: "Point",
      },
      properties: cloneProperties(properties),
      type: "Feature",
    };
  }

  if (geometryType === "LineString") {
    return {
      geometry: {
        coordinates: (coordinates as readonly GeoJsonPosition[]).map(clonePosition),
        type: "LineString",
      },
      properties: cloneProperties(properties),
      type: "Feature",
    };
  }

  return {
    geometry: {
      coordinates: (coordinates as readonly (readonly GeoJsonPosition[])[]).map((ring) =>
        closeRing(ring),
      ),
      type: "Polygon",
    },
    properties: cloneProperties(properties),
    type: "Feature",
  };
}

export function validateGeoJsonEditableGeometry(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): GeoJsonEditValidationResult {
  const normalized = normalizeSupportedGeometry(geometry);

  if (!normalized) {
    return {
      reason: "Unsupported or malformed geometry.",
      valid: false,
    };
  }

  return validateSupportedGeometry(normalized);
}

export function moveGeoJsonGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
  deltaLongitude: number,
  deltaLatitude: number,
): TemporalGeoJsonSupportedGeometry {
  return mapGeometryPositions(geometry, ([longitude, latitude]) => [
    longitude + deltaLongitude,
    latitude + deltaLatitude,
  ]);
}

export function setGeoJsonVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry | null {
  if (handle.kind !== "vertex" || !isValidPosition(coordinates)) {
    return null;
  }

  const next = cloneGeometry(geometry);

  mutateVertex(next, handle, coordinates);

  if (validateSupportedGeometry(next).valid) {
    return next;
  }

  return null;
}

export function insertGeoJsonVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry | null {
  if (handle.kind !== "midpoint" || !isValidPosition(coordinates)) {
    return null;
  }

  const next = cloneGeometry(geometry);

  if (next.type === "LineString") {
    next.coordinates.splice(
      handle.nextVertexIndex ?? handle.vertexIndex + 1,
      0,
      clonePosition(coordinates),
    );
  } else if (next.type === "MultiLineString" && handle.geometryIndex !== undefined) {
    next.coordinates[handle.geometryIndex]?.splice(
      handle.nextVertexIndex ?? handle.vertexIndex + 1,
      0,
      clonePosition(coordinates),
    );
  } else if (next.type === "Polygon" && handle.ringIndex !== undefined) {
    insertRingPosition(next.coordinates[handle.ringIndex], handle, coordinates);
  } else if (
    next.type === "MultiPolygon" &&
    handle.geometryIndex !== undefined &&
    handle.ringIndex !== undefined
  ) {
    insertRingPosition(
      next.coordinates[handle.geometryIndex]?.[handle.ringIndex],
      handle,
      coordinates,
    );
  } else {
    return null;
  }

  if (validateSupportedGeometry(next).valid) {
    return next;
  }

  return null;
}

export function removeGeoJsonVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
): TemporalGeoJsonSupportedGeometry | null {
  if (handle.kind !== "vertex") {
    return null;
  }

  const next = cloneGeometry(geometry);

  if (next.type === "MultiPoint" && handle.geometryIndex !== undefined) {
    next.coordinates.splice(handle.geometryIndex, 1);
  } else if (next.type === "LineString") {
    next.coordinates.splice(handle.vertexIndex, 1);
  } else if (next.type === "MultiLineString" && handle.geometryIndex !== undefined) {
    next.coordinates[handle.geometryIndex]?.splice(handle.vertexIndex, 1);
  } else if (next.type === "Polygon" && handle.ringIndex !== undefined) {
    removeRingPosition(next.coordinates[handle.ringIndex], handle.vertexIndex);
  } else if (
    next.type === "MultiPolygon" &&
    handle.geometryIndex !== undefined &&
    handle.ringIndex !== undefined
  ) {
    removeRingPosition(
      next.coordinates[handle.geometryIndex]?.[handle.ringIndex],
      handle.vertexIndex,
    );
  } else {
    return null;
  }

  if (validateSupportedGeometry(next).valid) {
    return next;
  }

  return null;
}

export function validateEditOperation<TProperties extends Record<string, unknown>>(
  operation: GeoJsonEditOperation<TProperties>,
  validateEdit:
    | ((
        nextFeature: TemporalGeoJsonGeometryFeature<TProperties>,
        operation: GeoJsonEditOperation<TProperties>,
      ) => GeoJsonEditValidationResult)
    | undefined,
): GeoJsonEditValidationResult {
  if (operation.type === "delete") {
    return { valid: true };
  }

  if (operation.type === "batch") {
    for (const childOperation of operation.operations) {
      const validation = validateEditOperation(childOperation, validateEdit);

      if (!validation.valid) {
        return validation;
      }
    }

    return { valid: true };
  }

  const baseValidation = validateGeoJsonEditableGeometry(operation.feature.geometry);

  if (!baseValidation.valid) {
    return baseValidation;
  }

  return validateEdit?.(operation.feature, operation) ?? baseValidation;
}

export function validateSupportedGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
): GeoJsonEditValidationResult {
  const positionsValid = getAllPositions(geometry).every(isValidPosition);

  if (!positionsValid) {
    return {
      reason: "Geometry contains non-finite coordinates.",
      valid: false,
    };
  }

  switch (geometry.type) {
    case "Point":
      return { valid: true };
    case "MultiPoint":
      return geometry.coordinates.length > 0
        ? { valid: true }
        : { reason: "MultiPoint must contain at least one point.", valid: false };
    case "LineString":
      return geometry.coordinates.length >= 2
        ? { valid: true }
        : { reason: "LineString must contain at least two coordinates.", valid: false };
    case "MultiLineString":
      return geometry.coordinates.length > 0 &&
        geometry.coordinates.every((line) => line.length >= 2)
        ? { valid: true }
        : { reason: "MultiLineString lines must contain at least two coordinates.", valid: false };
    case "Polygon":
      return validatePolygonCoordinates(geometry.coordinates);
    case "MultiPolygon":
      if (geometry.coordinates.length === 0) {
        return { reason: "MultiPolygon must contain at least one polygon.", valid: false };
      }

      for (const polygon of geometry.coordinates) {
        const validation = validatePolygonCoordinates(polygon);

        if (!validation.valid) {
          return validation;
        }
      }

      return { valid: true };
  }
}

export function arePositionsEqual(
  left: GeoJsonPosition | null | undefined,
  right: GeoJsonPosition | null | undefined,
) {
  return left?.[0] === right?.[0] && left?.[1] === right?.[1];
}

export function resolveFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
) {
  return String(
    feature.id ?? feature.properties?.id ?? feature.properties?.trackId ?? `feature-${index}`,
  );
}

export function cloneFeature<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
): TemporalGeoJsonGeometryFeature<TProperties> {
  const normalized = normalizeSupportedGeometry(feature.geometry);

  return {
    ...feature,
    geometry: normalized ? cloneGeometry(normalized) : feature.geometry,
    properties: feature.properties ? cloneProperties(feature.properties) : feature.properties,
  };
}

export function removeClosingPosition(ring: readonly GeoJsonPosition[]) {
  if (ring.length >= 2 && samePosition(ring[0]!, ring.at(-1)!)) {
    return ring.slice(0, -1).map(clonePosition);
  }

  return ring.map(clonePosition);
}

function resolveFeatureIdWithGetter<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string,
) {
  return getFeatureId?.(feature, index) ?? resolveFeatureId(feature, index);
}

function mutateVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
) {
  if (geometry.type === "Point") {
    geometry.coordinates = clonePosition(coordinates);
  } else if (geometry.type === "MultiPoint" && handle.geometryIndex !== undefined) {
    geometry.coordinates[handle.geometryIndex] = clonePosition(coordinates);
  } else if (geometry.type === "LineString") {
    geometry.coordinates[handle.vertexIndex] = clonePosition(coordinates);
  } else if (geometry.type === "MultiLineString" && handle.geometryIndex !== undefined) {
    geometry.coordinates[handle.geometryIndex]![handle.vertexIndex] = clonePosition(coordinates);
  } else if (geometry.type === "Polygon" && handle.ringIndex !== undefined) {
    setRingPosition(geometry.coordinates[handle.ringIndex], handle.vertexIndex, coordinates);
  } else if (
    geometry.type === "MultiPolygon" &&
    handle.geometryIndex !== undefined &&
    handle.ringIndex !== undefined
  ) {
    setRingPosition(
      geometry.coordinates[handle.geometryIndex]?.[handle.ringIndex],
      handle.vertexIndex,
      coordinates,
    );
  }
}

function setRingPosition(
  ring: GeoJsonPosition[] | undefined,
  vertexIndex: number,
  coordinates: GeoJsonPosition,
) {
  if (!ring) {
    return;
  }

  const openRing = removeClosingPosition(ring);

  openRing[vertexIndex] = clonePosition(coordinates);
  ring.splice(0, ring.length, ...closeRing(openRing));
}

function insertRingPosition(
  ring: GeoJsonPosition[] | undefined,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
) {
  if (!ring) {
    return;
  }

  const openRing = removeClosingPosition(ring);
  const insertIndex = Math.min(openRing.length, handle.nextVertexIndex ?? handle.vertexIndex + 1);

  openRing.splice(insertIndex, 0, clonePosition(coordinates));
  ring.splice(0, ring.length, ...closeRing(openRing));
}

function removeRingPosition(ring: GeoJsonPosition[] | undefined, vertexIndex: number) {
  if (!ring) {
    return;
  }

  const openRing = removeClosingPosition(ring);

  openRing.splice(vertexIndex, 1);
  ring.splice(0, ring.length, ...closeRing(openRing));
}

function mapGeometryPositions(
  geometry: TemporalGeoJsonSupportedGeometry,
  transform: (position: GeoJsonPosition) => GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return {
        coordinates: transform(geometry.coordinates),
        type: "Point",
      };
    case "MultiPoint":
      return {
        coordinates: geometry.coordinates.map(transform),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: geometry.coordinates.map(transform),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line) => line.map(transform)),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring) => ring.map(transform)),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(transform)),
        ),
        type: "MultiPolygon",
      };
  }
}

function validatePolygonCoordinates(coordinates: readonly (readonly GeoJsonPosition[])[]) {
  if (coordinates.length === 0) {
    return {
      reason: "Polygon must contain at least one ring.",
      valid: false,
    };
  }

  for (const ring of coordinates) {
    if (countDistinctPositions(removeClosingPosition(ring)) < 3) {
      return {
        reason: "Polygon rings must contain at least three distinct coordinates.",
        valid: false,
      };
    }

    if (!isClosedRing(ring)) {
      return {
        reason: "Polygon rings must be closed.",
        valid: false,
      };
    }
  }

  return { valid: true };
}

function getAllPositions(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
      return geometry.coordinates;
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
      return geometry.coordinates.flat();
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
}

function cloneProperties<TProperties extends Record<string, unknown>>(
  properties: TProperties,
): TProperties {
  return { ...properties };
}

function countDistinctPositions(coordinates: readonly GeoJsonPosition[]) {
  return new Set(coordinates.map((coordinate) => `${coordinate[0]}:${coordinate[1]}`)).size;
}

function isClosedRing(ring: readonly GeoJsonPosition[]) {
  return ring.length >= 4 && samePosition(ring[0]!, ring.at(-1)!);
}

function samePosition(left: GeoJsonPosition, right: GeoJsonPosition) {
  return left[0] === right[0] && left[1] === right[1];
}

function isValidPosition(position: readonly number[]) {
  return Number.isFinite(position[0]) && Number.isFinite(position[1]);
}
