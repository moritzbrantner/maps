import {
  moveGeoJsonGeometry,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

import type { DemoGeoJsonProperties } from "../types";

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
  return String(feature.properties?.label ?? feature.id ?? feature.geometry.type);
}

export function getDemoGroupId(feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>) {
  return feature.properties?.groupId ?? null;
}

export function setDemoGroupId(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  groupId: string | null,
): TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties> {
  const properties = {
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
    geometry: moveGeoJsonGeometry(feature.geometry, 0.45, 0.28),
    id,
    properties: {
      ...feature.properties,
      groupId: groupId ?? undefined,
      label: `${getDemoGeoJsonLabel(feature)} copy`,
      trackId: id,
    },
  };
}

export function countDemoGeometryPositions(geometry: TemporalGeoJsonSupportedGeometry) {
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

export function countDemoGeometryParts(geometry: TemporalGeoJsonSupportedGeometry) {
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
