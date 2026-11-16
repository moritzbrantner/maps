import { validateGeoJsonMapSource } from "./geojson-validation";
import type {
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonSupportedGeometry,
  GeoJsonPosition,
} from "./temporal-geojson-types";

export type GeoJsonGeographicOperationIssueCode =
  | "operation-failed"
  | "invalid-geometry"
  | "invalid-transform"
  | "unsupported-antimeridian"
  | "unsupported-extent";

/** Data-only operations throw this diagnostic before exposing any partial result. */
export class GeoJsonGeographicOperationError extends Error {
  constructor(
    public readonly code: GeoJsonGeographicOperationIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "GeoJsonGeographicOperationError";
  }
}

export function assertGeoJsonGeographicFeature(feature: TemporalGeoJsonGeometryFeature): void {
  const validation = validateGeoJsonMapSource({ type: "FeatureCollection", features: [feature] });
  if (!validation.valid) {
    throw new GeoJsonGeographicOperationError(
      "invalid-geometry",
      validation.issues[0]?.message ?? "Invalid geographic geometry.",
    );
  }
  assertGeometryCoordinates(feature.geometry);
}

function assertGeometryCoordinates(geometry: TemporalGeoJsonGeometryFeature["geometry"]): void {
  if (!geometry) {
    return;
  }
  if (
    geometry.type === "GeometryCollection" &&
    "geometries" in geometry &&
    Array.isArray(geometry.geometries)
  ) {
    for (const child of geometry.geometries) {
      assertGeometryCoordinates(child);
    }
    return;
  }
  if (!("coordinates" in geometry)) {
    return;
  }
  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) {
      return;
    }
    if (typeof coordinates[0] === "number") {
      return;
    }
    let previous: number | undefined;
    for (const child of coordinates) {
      if (Array.isArray(child) && typeof child[0] === "number") {
        if (previous !== undefined && Math.abs(child[0] - previous) > 180) {
          throw new GeoJsonGeographicOperationError(
            "unsupported-antimeridian",
            "Geographic operations across the antimeridian are unsupported.",
          );
        }
        previous = child[0];
      }
      visit(child);
    }
  };
  if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
    for (const position of geometry.coordinates) {
      visit(position);
    }
  } else {
    visit(geometry.coordinates);
  }
  const assertLine = (line: GeoJsonPosition[], ring: boolean): void => {
    const distinct = new Set(line.map((p) => `${p[0]},${p[1]}`));
    const first = line[0];
    const last = line.at(-1);
    if (
      distinct.size < (ring ? 3 : 2) ||
      (ring && (line.length < 4 || first?.[0] !== last?.[0] || first?.[1] !== last?.[1]))
    ) {
      throw new GeoJsonGeographicOperationError(
        "invalid-geometry",
        "Lines require two distinct positions; polygon rings require three distinct vertices and exact closure.",
      );
    }
  };
  // Coordinate structure and finite ranges were established at the validation boundary.
  const supported = geometry as TemporalGeoJsonSupportedGeometry;
  switch (supported.type) {
    case "Point":
    case "MultiPoint":
      break;
    case "LineString":
      assertLine(supported.coordinates, false);
      break;
    case "MultiLineString":
      for (const line of supported.coordinates) {
        assertLine(line, false);
      }
      break;
    case "Polygon":
      for (const ring of supported.coordinates) {
        assertLine(ring, true);
      }
      break;
    case "MultiPolygon":
      for (const polygon of supported.coordinates) {
        for (const ring of polygon) {
          assertLine(ring, true);
        }
      }
      break;
  }
}

export function mapGeoJsonGeometryPositions(
  geometry: TemporalGeoJsonSupportedGeometry,
  transform: (position: GeoJsonPosition) => GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return { type: geometry.type, coordinates: transform(geometry.coordinates) };
    case "MultiPoint":
    case "LineString":
      return { type: geometry.type, coordinates: geometry.coordinates.map(transform) };
    case "MultiLineString":
    case "Polygon":
      return {
        type: geometry.type,
        coordinates: geometry.coordinates.map((line) => line.map(transform)),
      };
    case "MultiPolygon":
      return {
        type: geometry.type,
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(transform)),
        ),
      };
  }
}
