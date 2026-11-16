import {
  assertGeoJsonGeographicFeature,
  GeoJsonGeographicOperationError,
  mapGeoJsonGeometryPositions,
} from "./geojson-geographic-contract";
import { hasNondegeneratePolygonParts } from "./geojson-topology";
import type {
  GeoJsonPosition,
  TemporalGeoJsonSupportedGeometry,
  TemporalGeoJsonGeometryFeature,
} from "./temporal-geojson-types";

export {
  GeoJsonGeographicOperationError,
  type GeoJsonGeographicOperationIssueCode,
} from "./geojson-geographic-contract";

export type GeoJsonTransformValues = {
  longitudeOffset?: number;
  latitudeOffset?: number;
  originLongitude?: number;
  originLatitude?: number;
  rotateDegrees?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
};
export type GeoJsonTranslation = { longitudeDegrees: number; latitudeDegrees: number };
export type GeoJsonRotation = { degrees: number; pivot?: GeoJsonPosition };
export type GeoJsonScale = {
  factor: number;
  factorX?: number;
  factorY?: number;
  pivot?: GeoJsonPosition;
};

const RADIUS_METERS = 6_371_008.8;
const RADIANS = Math.PI / 180;
/** Rotation/scaling input and output must remain within 1,000 km of the pivot. */
export const GEOJSON_TRANSFORM_MAX_RADIUS_METERS = 1_000_000;

/** Scale → counterclockwise rotation in a spherical azimuthal-equidistant local frame → degree translation. */
export function transformGeoJsonGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
  values: GeoJsonTransformValues,
): TemporalGeoJsonSupportedGeometry {
  assertGeoJsonGeographicFeature({ type: "Feature", geometry });
  if (
    (geometry.type === "Polygon" || geometry.type === "MultiPolygon") &&
    !hasNondegeneratePolygonParts(geometry)
  ) {
    throw new GeoJsonGeographicOperationError(
      "invalid-geometry",
      "Polygon geometry must have positive area.",
    );
  }
  for (const value of Object.values(values)) {
    if (value !== undefined && !Number.isFinite(value)) {
      fail("Transform values must be finite numbers.");
    }
  }
  if ((values.originLongitude === undefined) !== (values.originLatitude === undefined)) {
    fail("A pivot requires both longitude and latitude.");
  }
  const sx = values.scaleX ?? values.scale ?? 1;
  const sy = values.scaleY ?? values.scale ?? 1;
  if (sx <= 0 || sy <= 0) {
    fail("Scale factors must be positive; collapsed or reflected geometry is unsupported.");
  }
  const longitudeOffset = values.longitudeOffset ?? 0;
  const latitudeOffset = values.latitudeOffset ?? 0;
  const rotation = (values.rotateDegrees ?? 0) * RADIANS;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  mapGeoJsonGeometryPositions(geometry, (p) => {
    west = Math.min(west, p[0]);
    east = Math.max(east, p[0]);
    south = Math.min(south, p[1]);
    north = Math.max(north, p[1]);
    return p;
  });
  const origin: GeoJsonPosition =
    values.originLongitude === undefined
      ? [(west + east) / 2, (south + north) / 2]
      : [values.originLongitude, values.originLatitude ?? 0];
  assertGeoJsonGeographicFeature({
    type: "Feature",
    geometry: { type: "Point", coordinates: origin },
  });
  const metric = sx !== 1 || sy !== 1 || rotation !== 0;
  const phi0 = origin[1] * RADIANS;
  const sin0 = Math.sin(phi0);
  const cos0 = Math.cos(phi0);
  const transformed = mapGeoJsonGeometryPositions(geometry, (position) => {
    let longitude = position[0];
    let latitude = position[1];
    if (metric) {
      const phi = latitude * RADIANS;
      const delta = (longitude - origin[0]) * RADIANS;
      const east = Math.cos(phi) * Math.sin(delta);
      const north = cos0 * Math.sin(phi) - sin0 * Math.cos(phi) * Math.cos(delta);
      const c = Math.atan2(
        Math.hypot(east, north),
        sin0 * Math.sin(phi) + cos0 * Math.cos(phi) * Math.cos(delta),
      );
      assertRadius(c * RADIUS_METERS);
      const k = c === 0 ? 1 : c / Math.sin(c);
      const x = RADIUS_METERS * k * east * sx;
      const y = RADIUS_METERS * k * north * sy;
      const rx = x * Math.cos(rotation) - y * Math.sin(rotation);
      const ry = x * Math.sin(rotation) + y * Math.cos(rotation);
      const rho = Math.hypot(rx, ry);
      assertRadius(rho);
      if (rho === 0) {
        longitude = origin[0];
        latitude = origin[1];
      } else {
        const angle = rho / RADIUS_METERS;
        latitude =
          Math.asin(
            Math.max(-1, Math.min(1, Math.cos(angle) * sin0 + (ry * Math.sin(angle) * cos0) / rho)),
          ) / RADIANS;
        longitude =
          origin[0] +
          Math.atan2(
            rx * Math.sin(angle),
            rho * cos0 * Math.cos(angle) - ry * sin0 * Math.sin(angle),
          ) /
            RADIANS;
      }
    }
    longitude += longitudeOffset;
    latitude += latitudeOffset;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new GeoJsonGeographicOperationError(
        "unsupported-antimeridian",
        "Transform output would cross the antimeridian; wrapping is unsupported.",
      );
    }
    return [longitude, latitude];
  });
  assertGeoJsonGeographicFeature({ type: "Feature", geometry: transformed });
  if (
    (transformed.type === "Polygon" || transformed.type === "MultiPolygon") &&
    !hasNondegeneratePolygonParts(transformed)
  ) {
    throw new GeoJsonGeographicOperationError(
      "invalid-geometry",
      "Transform output contains degenerate polygon geometry.",
    );
  }
  return transformed;
}

export function translateGeoJsonFeature<T extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<T>,
  translation: GeoJsonTranslation,
): TemporalGeoJsonGeometryFeature<T> {
  return transformFeature(feature, {
    longitudeOffset: translation.longitudeDegrees,
    latitudeOffset: translation.latitudeDegrees,
  });
}
export function rotateGeoJsonFeature<T extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<T>,
  rotation: GeoJsonRotation,
): TemporalGeoJsonGeometryFeature<T> {
  return transformFeature(feature, {
    rotateDegrees: rotation.degrees,
    ...pivotValues(rotation.pivot),
  });
}
export function scaleGeoJsonFeature<T extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<T>,
  scale: GeoJsonScale,
): TemporalGeoJsonGeometryFeature<T> {
  return transformFeature(feature, {
    scale: scale.factor,
    scaleX: scale.factorX,
    scaleY: scale.factorY,
    ...pivotValues(scale.pivot),
  });
}
function pivotValues(pivot?: GeoJsonPosition): GeoJsonTransformValues {
  return pivot ? { originLongitude: pivot[0], originLatitude: pivot[1] } : {};
}
function transformFeature<T extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<T>,
  values: GeoJsonTransformValues,
): TemporalGeoJsonGeometryFeature<T> {
  assertGeoJsonGeographicFeature(feature);
  const geometry = feature.geometry;
  if (
    !geometry ||
    !["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(
      geometry.type,
    )
  ) {
    throw new GeoJsonGeographicOperationError(
      "invalid-geometry",
      "Standalone transforms require a supported nonempty geometry.",
    );
  }
  return {
    ...feature,
    geometry: transformGeoJsonGeometry(geometry as TemporalGeoJsonSupportedGeometry, values),
    properties: feature.properties ? { ...feature.properties } : feature.properties,
  };
}
function fail(message: string): never {
  throw new GeoJsonGeographicOperationError("invalid-transform", message);
}
function assertRadius(radius: number): void {
  if (!Number.isFinite(radius) || radius > GEOJSON_TRANSFORM_MAX_RADIUS_METERS) {
    throw new GeoJsonGeographicOperationError(
      "unsupported-extent",
      "Regional rotation/scaling supports input and output within 1,000 km of its pivot.",
    );
  }
}
