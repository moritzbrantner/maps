import {
  moveGeoJsonGeometry,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

import type { DemoGeoJsonProperties } from "../types";

const DEMO_SUPPORTED_GEOMETRY_TYPES: ReadonlySet<string> = new Set<
  TemporalGeoJsonSupportedGeometry["type"]
>(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

/**
 * Narrows a GeoJSON Feature geometry to the geometry types the demo renders
 * and edits. The demo fixtures only contain these types.
 */
export function isDemoSupportedGeometry(
  geometry: TemporalGeoJsonGeometryFeature["geometry"] | undefined,
): geometry is TemporalGeoJsonSupportedGeometry {
  return geometry != null && DEMO_SUPPORTED_GEOMETRY_TYPES.has(geometry.type);
}

export function getDemoGeoJsonFeature(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  featureId: string | null,
) {
  if (!featureId) {
    return null;
  }

  return (
    collection.features.find((feature, index) => getDemoFeatureId(feature, index) === featureId) ??
    null
  );
}

export function getDemoFeatureId(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  index: number,
) {
  return String(feature.id ?? `feature-${index}`);
}

export function getDemoGeoJsonLabel(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
) {
  return String(feature.properties?.label ?? feature.id ?? feature.geometry?.type);
}

export function getDemoGroupId(feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>) {
  return feature.properties?.groupId ?? null;
}

export function setDemoGroupId(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  groupId: string | null,
): TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties> {
  if (!feature.properties) {
    return feature;
  }

  const properties: DemoGeoJsonProperties = {
    ...feature.properties,
  };

  if (groupId) {
    properties.groupId = groupId;
  } else {
    delete properties.groupId;
  }

  return {
    ...feature,
    properties,
  };
}

export function updateDemoGeoJsonFeature(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  featureId: string,
  update: (
    feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  ) => TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
) {
  return {
    ...collection,
    features: collection.features.map((feature, index) =>
      getDemoFeatureId(feature, index) === featureId ? update(feature) : feature,
    ),
  };
}

export function createDemoGeoJsonDuplicate(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  id: string,
  groupId: string | null = null,
): TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties> {
  return {
    ...feature,
    geometry: isDemoSupportedGeometry(feature.geometry)
      ? moveGeoJsonGeometry(feature.geometry, 0.45, 0.28)
      : feature.geometry,
    id,
    properties: feature.properties
      ? {
          ...feature.properties,
          groupId: groupId ?? undefined,
          label: `${getDemoGeoJsonLabel(feature)} copy`,
          trackId: id,
        }
      : feature.properties,
  };
}

export function countDemoGeometryPositions(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): number | undefined {
  if (!isDemoSupportedGeometry(geometry)) {
    return undefined;
  }

  switch (geometry.type) {
    case "Point":
      return 1;
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates.length;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.reduce((total, line) => total + line.length, 0);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (total, polygon) => total + polygon.reduce((ringTotal, ring) => ringTotal + ring.length, 0),
        0,
      );
  }
}

export function countDemoGeometryParts(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): number | undefined {
  if (!isDemoSupportedGeometry(geometry)) {
    return undefined;
  }

  switch (geometry.type) {
    case "Point":
    case "LineString":
    case "Polygon":
      return 1;
    case "MultiPoint":
      return geometry.coordinates.length;
    case "MultiLineString":
      return geometry.coordinates.length;
    case "MultiPolygon":
      return geometry.coordinates.length;
  }
}
