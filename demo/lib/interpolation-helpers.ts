import {
  constrainGeoJsonGeometryToPolygon,
  type GeoJsonLayerFeature,
  type GeoJsonPolygonConstraint,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

import type {
  DemoGeoJsonProperties,
  DemoInterpolationGeometryType,
  DemoInterpolationHandle,
} from "../types";

export function createDemoInterpolationFeatureCollection(
  kind: string,
  label: string,
  geometry: TemporalGeoJsonSupportedGeometry,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  return {
    features: [
      {
        geometry,
        properties: {
          kind,
          label,
          time: 0,
          trackId: kind,
        },
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };
}

export function getDemoInterpolationLayerStyle(
  layer: "end" | "preview" | "start",
  geometryType: DemoInterpolationGeometryType,
) {
  const color = layer === "start" ? "#475569" : layer === "end" ? "#d97706" : "#be123c";
  const fillOpacity = layer === "preview" ? 0.3 : 0.11;
  const width = layer === "preview" ? 5 : 3;

  if (geometryType === "Point" || geometryType === "MultiPoint") {
    return {
      pointColor: color,
      pointRadius: layer === "preview" ? 8 : 6,
    };
  }

  if (geometryType === "LineString" || geometryType === "MultiLineString") {
    return {
      lineColor: color,
      lineOpacity: layer === "preview" ? 0.92 : 0.56,
      lineWidth: width,
    };
  }

  return {
    polygonFillColor: color,
    polygonFillOpacity: fillOpacity,
    polygonStrokeColor: color,
    polygonStrokeWidth: layer === "preview" ? 3 : 2,
  };
}

export function getDemoInterpolationConstraintLayerStyle() {
  return {
    polygonFillColor: "#0f766e",
    polygonFillOpacity: 0.08,
    polygonStrokeColor: "#0f766e",
    polygonStrokeWidth: 2,
  };
}

export function getDemoInterpolationPreviewLayerStyle(
  feature: GeoJsonLayerFeature<DemoGeoJsonProperties>,
  geometryType: DemoInterpolationGeometryType,
) {
  const transitionKind = readDemoTransitionKind(feature.properties);

  if (transitionKind === "split") {
    return {
      polygonFillColor: "#14b8a6",
      polygonFillOpacity: 0.24,
      polygonStrokeColor: "#0f766e",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "merge") {
    return {
      polygonFillColor: "#f59e0b",
      polygonFillOpacity: 0.24,
      polygonStrokeColor: "#b45309",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "preserve") {
    return {
      polygonFillColor: "#64748b",
      polygonFillOpacity: 0.2,
      polygonStrokeColor: "#475569",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "appear") {
    return {
      polygonFillColor: "#22c55e",
      polygonFillOpacity: 0.22,
      polygonStrokeColor: "#15803d",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "disappear") {
    return {
      polygonFillColor: "#f43f5e",
      polygonFillOpacity: 0.22,
      polygonStrokeColor: "#be123c",
      polygonStrokeWidth: 3,
    };
  }

  return getDemoInterpolationLayerStyle("preview", geometryType);
}

export function constrainDemoInterpolationCollection(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  constraint: GeoJsonPolygonConstraint,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  return {
    ...collection,
    features: collection.features.flatMap((feature) => {
      const constrainedGeometry = constrainGeoJsonGeometryToPolygon(feature.geometry, constraint);

      return constrainedGeometry
        ? [
            {
              ...feature,
              geometry: constrainedGeometry,
            },
          ]
        : [];
    }),
  };
}

export function isDemoPolygonLikeGeometryType(geometryType: DemoInterpolationGeometryType) {
  return geometryType === "Polygon" || geometryType === "MultiPolygon";
}

export function readDemoTransitionKind(properties: unknown) {
  return isDemoRecord(properties) ? properties.transitionKind : undefined;
}

export function readDemoNumericProperty(properties: unknown, key: string) {
  const value = isDemoRecord(properties) ? properties[key] : undefined;

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isDemoRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getDemoInterpolationHandles(
  geometry: TemporalGeoJsonSupportedGeometry,
): DemoInterpolationHandle[] {
  switch (geometry.type) {
    case "Point":
      return [{ label: "Point", path: [] }];
    case "MultiPoint":
      return geometry.coordinates.map((_coordinate, index) => ({
        label: `Point ${index + 1}`,
        path: [index],
      }));
    case "LineString":
      return geometry.coordinates.map((_coordinate, index) => ({
        label:
          index === 0
            ? "Start"
            : index === geometry.coordinates.length - 1
              ? "End"
              : `Point ${index + 1}`,
        path: [index],
      }));
    case "MultiLineString":
      return geometry.coordinates.flatMap((line, lineIndex) =>
        line.map((_coordinate, coordinateIndex) => ({
          label: `Line ${lineIndex + 1} point ${coordinateIndex + 1}`,
          path: [lineIndex, coordinateIndex],
        })),
      );
    case "Polygon":
      return geometry.coordinates.flatMap((ring, ringIndex) =>
        ring.slice(0, -1).map((_coordinate, coordinateIndex) => ({
          label: `${ringIndex === 0 ? "Outer" : `Hole ${ringIndex}`} point ${coordinateIndex + 1}`,
          path: [ringIndex, coordinateIndex],
        })),
      );
    case "MultiPolygon":
      return geometry.coordinates.flatMap((polygon, polygonIndex) =>
        polygon.flatMap((ring, ringIndex) =>
          ring.slice(0, -1).map((_coordinate, coordinateIndex) => ({
            label: `Area ${polygonIndex + 1} ${
              ringIndex === 0 ? "outer" : `hole ${ringIndex}`
            } point ${coordinateIndex + 1}`,
            path: [polygonIndex, ringIndex, coordinateIndex],
          })),
        ),
      );
  }
}

export function getDemoInterpolationPosition(
  geometry: TemporalGeoJsonSupportedGeometry,
  path: number[],
): [number, number] {
  switch (geometry.type) {
    case "Point":
      return geometry.coordinates;
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates[path[0] ?? 0] ?? geometry.coordinates[0]!;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates[path[0] ?? 0]?.[path[1] ?? 0] ?? geometry.coordinates[0]![0]!;
    case "MultiPolygon":
      return (
        geometry.coordinates[path[0] ?? 0]?.[path[1] ?? 0]?.[path[2] ?? 0] ??
        geometry.coordinates[0]![0]![0]!
      );
  }
}

export function setDemoInterpolationPosition(
  geometry: TemporalGeoJsonSupportedGeometry,
  path: number[],
  position: [number, number],
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return { coordinates: position, type: "Point" };
    case "MultiPoint":
      return {
        coordinates: geometry.coordinates.map((coordinate, index) =>
          index === (path[0] ?? 0) ? position : coordinate,
        ),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: geometry.coordinates.map((coordinate, index) =>
          index === (path[0] ?? 0) ? position : coordinate,
        ),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line, lineIndex) =>
          lineIndex === (path[0] ?? 0)
            ? line.map((coordinate, coordinateIndex) =>
                coordinateIndex === (path[1] ?? 0) ? position : coordinate,
              )
            : line,
        ),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring, ringIndex) =>
          ringIndex === (path[0] ?? 0)
            ? setDemoInterpolationRingPosition(ring, path[1] ?? 0, position)
            : ring,
        ),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon, polygonIndex) =>
          polygonIndex === (path[0] ?? 0)
            ? polygon.map((ring, ringIndex) =>
                ringIndex === (path[1] ?? 0)
                  ? setDemoInterpolationRingPosition(ring, path[2] ?? 0, position)
                  : ring,
              )
            : polygon,
        ),
        type: "MultiPolygon",
      };
  }
}

function setDemoInterpolationRingPosition(
  ring: [number, number][],
  index: number,
  position: [number, number],
) {
  return ring.map((coordinate, coordinateIndex) => {
    if (
      coordinateIndex === index ||
      (index === 0 && coordinateIndex === ring.length - 1) ||
      (index === ring.length - 1 && coordinateIndex === 0)
    ) {
      return position;
    }

    return coordinate;
  });
}
