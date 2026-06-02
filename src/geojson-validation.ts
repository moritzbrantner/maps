import { isRecord } from "./temporal-core";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonValidationSeverity = "error" | "warning";

export type GeoJsonValidationIssue = {
  code:
    | "invalid-collection"
    | "invalid-feature"
    | "invalid-geometry"
    | "invalid-coordinate"
    | "missing-feature-id"
    | "nonnumeric-metric";
  featureIndex?: number;
  geometryPath?: string;
  message: string;
  metricKey?: string;
  severity: GeoJsonValidationSeverity;
};

export type GeoJsonValidationResult = {
  errorCount: number;
  issues: GeoJsonValidationIssue[];
  valid: boolean;
  warningCount: number;
};

export type GeoJsonValidationOptions = {
  maxIssues?: number;
  metricKeys?: readonly string[];
  requireFeatureIds?: boolean;
  supportedGeometryTypes?: readonly TemporalGeoJsonSupportedGeometry["type"][];
};

const defaultSupportedGeometryTypes = new Set<TemporalGeoJsonSupportedGeometry["type"]>([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

export function validateGeoJsonMapSource(
  source: unknown,
  options: GeoJsonValidationOptions = {},
): GeoJsonValidationResult {
  const issues: GeoJsonValidationIssue[] = [];
  const maxIssues = options.maxIssues ?? Number.POSITIVE_INFINITY;
  const supportedGeometryTypes = new Set(options.supportedGeometryTypes ?? defaultSupportedGeometryTypes);
  const addIssue = (issue: GeoJsonValidationIssue) => {
    if (issues.length < maxIssues) {
      issues.push(issue);
    }
  };

  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
    addIssue({
      code: "invalid-collection",
      message: "GeoJSON source must be a FeatureCollection with a features array.",
      severity: "error",
    });

    return createValidationResult(issues);
  }

  const collection = source as TemporalGeoJsonGeometryFeatureCollection;

  collection.features.forEach((feature, featureIndex) => {
    validateFeature(feature, featureIndex, {
      addIssue,
      metricKeys: options.metricKeys ?? [],
      requireFeatureIds: options.requireFeatureIds ?? false,
      supportedGeometryTypes,
    });
  });

  return createValidationResult(issues);
}

function validateFeature(
  feature: TemporalGeoJsonGeometryFeature,
  featureIndex: number,
  context: {
    addIssue: (issue: GeoJsonValidationIssue) => void;
    metricKeys: readonly string[];
    requireFeatureIds: boolean;
    supportedGeometryTypes: Set<TemporalGeoJsonSupportedGeometry["type"]>;
  },
) {
  if (!isRecord(feature) || feature.type !== "Feature") {
    context.addIssue({
      code: "invalid-feature",
      featureIndex,
      message: "Feature must be a GeoJSON Feature object.",
      severity: "error",
    });
    return;
  }

  if (
    context.requireFeatureIds &&
    feature.id === undefined &&
    !isStringOrNumber(feature.properties?.id) &&
    !isStringOrNumber(feature.properties?.trackId)
  ) {
    context.addIssue({
      code: "missing-feature-id",
      featureIndex,
      message: "Feature is missing id, properties.id, or properties.trackId.",
      severity: "warning",
    });
  }

  validateMetrics(feature, featureIndex, context);
  validateGeometry(feature.geometry, featureIndex, "geometry", context);
}

function validateMetrics(
  feature: TemporalGeoJsonGeometryFeature,
  featureIndex: number,
  context: {
    addIssue: (issue: GeoJsonValidationIssue) => void;
    metricKeys: readonly string[];
  },
) {
  const properties = feature.properties;
  const metricSources: Array<[string, unknown]> = [];

  if (isRecord(properties?.metrics)) {
    metricSources.push(...Object.entries(properties.metrics));
  }

  for (const metricKey of context.metricKeys) {
    metricSources.push([metricKey, properties?.[metricKey]]);
  }

  for (const [metricKey, value] of metricSources) {
    if (value === undefined) {
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      context.addIssue({
        code: "nonnumeric-metric",
        featureIndex,
        message: `Metric "${metricKey}" must be a finite number.`,
        metricKey,
        severity: "warning",
      });
    }
  }
}

function validateGeometry(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
  featureIndex: number,
  geometryPath: string,
  context: {
    addIssue: (issue: GeoJsonValidationIssue) => void;
    supportedGeometryTypes: Set<TemporalGeoJsonSupportedGeometry["type"]>;
  },
) {
  if (!isRecord(geometry) || typeof geometry.type !== "string") {
    context.addIssue({
      code: "invalid-geometry",
      featureIndex,
      geometryPath,
      message: "Feature geometry must be a supported GeoJSON geometry object.",
      severity: "error",
    });
    return;
  }

  if (geometry.type === "GeometryCollection") {
    const geometries = (geometry as { geometries?: unknown }).geometries;

    if (!Array.isArray(geometries)) {
      context.addIssue({
        code: "invalid-geometry",
        featureIndex,
        geometryPath,
        message: "GeometryCollection must contain a geometries array.",
        severity: "error",
      });
      return;
    }

    geometries.forEach((child, childIndex) =>
      validateGeometry(
        child as TemporalGeoJsonGeometryFeature["geometry"],
        featureIndex,
        `${geometryPath}.geometries[${childIndex}]`,
        context,
      ),
    );
    return;
  }

  if (!defaultSupportedGeometryTypes.has(geometry.type as TemporalGeoJsonSupportedGeometry["type"])) {
    context.addIssue({
      code: "invalid-geometry",
      featureIndex,
      geometryPath,
      message: `Geometry type "${geometry.type}" is not supported by map source helpers.`,
      severity: "error",
    });
    return;
  }

  if (!context.supportedGeometryTypes.has(geometry.type as TemporalGeoJsonSupportedGeometry["type"])) {
    context.addIssue({
      code: "invalid-geometry",
      featureIndex,
      geometryPath,
      message: `Geometry type "${geometry.type}" is disabled for this map source.`,
      severity: "error",
    });
    return;
  }

  validateGeometryCoordinates(
    geometry.type as TemporalGeoJsonSupportedGeometry["type"],
    (geometry as { coordinates?: unknown }).coordinates,
    featureIndex,
    `${geometryPath}.coordinates`,
    context.addIssue,
  );
}

function validateGeometryCoordinates(
  geometryType: TemporalGeoJsonSupportedGeometry["type"],
  coordinates: unknown,
  featureIndex: number,
  geometryPath: string,
  addIssue: (issue: GeoJsonValidationIssue) => void,
) {
  switch (geometryType) {
    case "Point":
      validatePosition(coordinates, featureIndex, geometryPath, addIssue);
      return;
    case "MultiPoint":
    case "LineString":
      validatePositionArray(coordinates, featureIndex, geometryPath, addIssue);
      return;
    case "MultiLineString":
    case "Polygon":
      validateNestedPositionArray(coordinates, 1, featureIndex, geometryPath, addIssue);
      return;
    case "MultiPolygon":
      validateNestedPositionArray(coordinates, 2, featureIndex, geometryPath, addIssue);
      return;
  }
}

function validateNestedPositionArray(
  coordinates: unknown,
  depth: number,
  featureIndex: number,
  geometryPath: string,
  addIssue: (issue: GeoJsonValidationIssue) => void,
) {
  if (!Array.isArray(coordinates)) {
    addIssue({
      code: "invalid-coordinate",
      featureIndex,
      geometryPath,
      message: "Geometry coordinates must be an array.",
      severity: "error",
    });
    return;
  }

  coordinates.forEach((entry, index) => {
    const entryPath = `${geometryPath}[${index}]`;

    if (depth === 1) {
      validatePositionArray(entry, featureIndex, entryPath, addIssue);
      return;
    }

    validateNestedPositionArray(entry, depth - 1, featureIndex, entryPath, addIssue);
  });
}

function validatePositionArray(
  coordinates: unknown,
  featureIndex: number,
  geometryPath: string,
  addIssue: (issue: GeoJsonValidationIssue) => void,
) {
  if (!Array.isArray(coordinates)) {
    addIssue({
      code: "invalid-coordinate",
      featureIndex,
      geometryPath,
      message: "Geometry coordinates must be an array of positions.",
      severity: "error",
    });
    return;
  }

  coordinates.forEach((position, index) =>
    validatePosition(position, featureIndex, `${geometryPath}[${index}]`, addIssue),
  );
}

function validatePosition(
  position: unknown,
  featureIndex: number,
  geometryPath: string,
  addIssue: (issue: GeoJsonValidationIssue) => void,
) {
  if (
    !Array.isArray(position) ||
    position.length < 2 ||
    !isFiniteCoordinate(position[0]) ||
    !isFiniteCoordinate(position[1])
  ) {
    addIssue({
      code: "invalid-coordinate",
      featureIndex,
      geometryPath,
      message: "Position must contain finite longitude and latitude numbers.",
      severity: "error",
    });
    return;
  }

  const [longitude, latitude] = position as GeoJsonPosition;

  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    addIssue({
      code: "invalid-coordinate",
      featureIndex,
      geometryPath,
      message: "Position longitude/latitude is outside the valid geographic range.",
      severity: "error",
    });
  }
}

function createValidationResult(issues: GeoJsonValidationIssue[]): GeoJsonValidationResult {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;

  return {
    errorCount,
    issues,
    valid: errorCount === 0,
    warningCount,
  };
}

function isFiniteCoordinate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringOrNumber(value: unknown) {
  return typeof value === "string" || typeof value === "number";
}
