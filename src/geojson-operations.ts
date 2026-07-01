import { flattenGeoJsonFeatures, type GeoJsonMapSource } from "./geojson-source";
import {
  differencePolygonLike,
  getGeoJsonRingGeodesicLengthMeters,
  getGeoJsonRingPlanarLength,
  getPolygonLikeArea,
  getPolygonLikeGeodesicAreaSquareMeters,
  getPolygonLikePerimeterMeters,
  intersectPolygonLike,
  simplifyPolygonLike,
  unionPolygonLikes,
  type PolygonLikeGeometry,
} from "./geojson-topology";
import { cloneGeometry, clonePosition } from "./temporal-geojson-geometry";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonBooleanOperation = "intersection" | "union" | "difference" | "clip";

export type GeoJsonOperationIssueCode =
  | "invalid-geometry"
  | "operation-failed"
  | "skipped-non-polygon";

export type GeoJsonOperationIssue = {
  code: GeoJsonOperationIssueCode;
  featureId?: string;
  featureIndex?: number;
  message: string;
  partIndex?: number;
};

export type GeoJsonOperationFeatureProperties = {
  area: number;
  operation: GeoJsonBooleanOperation;
  ratioOfSource?: number;
  ratioOfTarget?: number;
  sourceIds: string[];
  sourceIndexes: number[];
  targetIds: string[];
  targetIndexes: number[];
};

export type GeoJsonOperationPropertiesContext<
  TInputProperties extends Record<string, unknown>,
> = {
  defaultProperties: GeoJsonOperationFeatureProperties;
  geometry: PolygonLikeGeometry;
  operation: GeoJsonBooleanOperation;
  sourceFeatures: Array<TemporalGeoJsonGeometryFeature<TInputProperties>>;
  targetFeatures: Array<TemporalGeoJsonGeometryFeature<TInputProperties>>;
};

export type GeoJsonOperationOptions<
  TInputProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = GeoJsonOperationFeatureProperties,
> = {
  areaEpsilon?: number;
  getFeatureId?: (
    feature: TemporalGeoJsonGeometryFeature<TInputProperties>,
    index: number,
    partIndex?: number,
  ) => string | number | undefined;
  getProperties?: (
    context: GeoJsonOperationPropertiesContext<TInputProperties>,
  ) => TOutputProperties;
  includeEmptyResults?: boolean;
};

export type GeoJsonOperationResult<TProperties extends Record<string, unknown>> = {
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  issues: GeoJsonOperationIssue[];
};

export type GeoJsonIntersectionRecord = {
  area: number;
  geometry: PolygonLikeGeometry;
  leftId: string;
  leftIndex: number;
  leftPartIndex?: number;
  ratioOfLeft: number;
  ratioOfRight: number;
  rightId: string;
  rightIndex: number;
  rightPartIndex?: number;
};

export type GeoJsonContainmentRecord = {
  point: GeoJsonPosition;
  pointFeatureId: string;
  pointFeatureIndex: number;
  pointIndex?: number;
  polygonFeatureId: string;
  polygonFeatureIndex: number;
  polygonPartIndex?: number;
};

export type GeoJsonOverlapRecord = {
  area: number;
  geometry: PolygonLikeGeometry;
  leftId: string;
  leftIndex: number;
  leftPartIndex?: number;
  ratioOfLeft: number;
  ratioOfRight: number;
  rightId: string;
  rightIndex: number;
  rightPartIndex?: number;
};

export type GeoJsonRelationshipOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  areaEpsilon?: number;
  getFeatureId?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
    partIndex?: number,
  ) => string | number | undefined;
  includeBoundary?: boolean;
};

export type GeoJsonPolygonMeasurementOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = GeoJsonRelationshipOptions<TProperties> & {
  earthRadiusMeters?: number;
};

export type GeoJsonPolygonMeasurementRecord = {
  areaSquareMeters: number;
  featureId: string;
  featureIndex: number;
  partIndex?: number;
  perimeterMeters: number;
  planarArea: number;
};

export type GeoJsonPolygonOutlineRingRole = "shell" | "hole";

export type GeoJsonPolygonOutlineProperties = {
  featureId: string;
  featureIndex: number;
  lengthMeters: number;
  partIndex?: number;
  planarLength: number;
  polygonIndex: number;
  ringIndex: number;
  role: GeoJsonPolygonOutlineRingRole;
};

export type GeoJsonPolygonOverlapResolutionStrategy = "later-wins" | "earlier-wins";

export type GeoJsonPolygonOverlapResolutionOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = GeoJsonRelationshipOptions<TProperties> & {
  strategy?: GeoJsonPolygonOverlapResolutionStrategy;
};

export type GeoJsonPolygonOverlapResolutionResult<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  issues: GeoJsonOperationIssue[];
  overlaps: GeoJsonOverlapRecord[];
};

export type GeoJsonPolygonSimplifyOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = GeoJsonRelationshipOptions<TProperties> & {
  tolerance: number;
};

type GeoJsonFeatureInput<TProperties extends Record<string, unknown>> =
  | GeoJsonMapSource<TProperties>
  | TemporalGeoJsonGeometryFeature<TProperties>
  | readonly TemporalGeoJsonGeometryFeature<TProperties>[];

type PolygonEntry<TProperties extends Record<string, unknown>> = {
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  geometry: PolygonLikeGeometry;
  id: string;
  index: number;
  partIndex?: number;
};

type PointEntry<TProperties extends Record<string, unknown>> = {
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  id: string;
  index: number;
  point: GeoJsonPosition;
  pointIndex?: number;
};

const DEFAULT_AREA_EPSILON = 1e-9;

export function intersectGeoJsonFeatures<
  TInputProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = GeoJsonOperationFeatureProperties,
>(
  left: GeoJsonMapSource<TInputProperties> | TemporalGeoJsonGeometryFeature<TInputProperties>,
  right: GeoJsonMapSource<TInputProperties> | TemporalGeoJsonGeometryFeature<TInputProperties>,
  options: GeoJsonOperationOptions<TInputProperties, TOutputProperties> = {},
): GeoJsonOperationResult<TOutputProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const leftEntries = collectPolygonEntries(toFeatureCollection(left), options, issues);
  const rightEntries = collectPolygonEntries(toFeatureCollection(right), options, issues);
  const features: Array<TemporalGeoJsonGeometryFeature<TOutputProperties>> = [];

  for (const leftEntry of leftEntries) {
    for (const rightEntry of rightEntries) {
      const geometry = runPolygonOperation(
        () => intersectPolygonLike(leftEntry.geometry, rightEntry.geometry),
        issues,
        "intersection failed.",
      );
      const area = geometry ? getPolygonLikeArea(geometry) : 0;

      if (!geometry || (area <= areaEpsilon && !options.includeEmptyResults)) {
        continue;
      }

      features.push(
        createOperationFeature(
          "intersection",
          geometry,
          [leftEntry],
          [rightEntry],
          area,
          features.length,
          options,
        ),
      );
    }
  }

  return { collection: { features, type: "FeatureCollection" }, issues };
}

export function unionGeoJsonFeatures<
  TInputProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = GeoJsonOperationFeatureProperties,
>(
  featuresInput: GeoJsonMapSource<TInputProperties> | readonly TemporalGeoJsonGeometryFeature<TInputProperties>[],
  options: GeoJsonOperationOptions<TInputProperties, TOutputProperties> = {},
): GeoJsonOperationResult<TOutputProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const entries = collectPolygonEntries(toFeatureCollection(featuresInput), options, issues);
  const geometry = runPolygonOperation(
    () => unionPolygonLikes(entries.map((entry) => entry.geometry)),
    issues,
    "union failed.",
  );
  const area = geometry ? getPolygonLikeArea(geometry) : 0;
  const outputFeatures =
    geometry && (area > (options.areaEpsilon ?? DEFAULT_AREA_EPSILON) || options.includeEmptyResults)
      ? [createOperationFeature("union", geometry, entries, [], area, 0, options)]
      : [];

  return { collection: { features: outputFeatures, type: "FeatureCollection" }, issues };
}

export function differenceGeoJsonFeatures<
  TInputProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = GeoJsonOperationFeatureProperties,
>(
  subject: GeoJsonFeatureInput<TInputProperties>,
  masks: GeoJsonFeatureInput<TInputProperties>,
  options: GeoJsonOperationOptions<TInputProperties, TOutputProperties> = {},
): GeoJsonOperationResult<TOutputProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const subjectEntries = collectPolygonEntries(toFeatureCollection(subject), options, issues);
  const maskEntries = collectPolygonEntries(toFeatureCollection(masks), options, issues);
  const maskUnion = runPolygonOperation(
    () => unionPolygonLikes(maskEntries.map((entry) => entry.geometry)),
    issues,
    "mask union failed.",
  );
  const outputFeatures: Array<TemporalGeoJsonGeometryFeature<TOutputProperties>> = [];

  for (const subjectEntry of subjectEntries) {
    const geometry = runPolygonOperation(
      () =>
        maskUnion
          ? differencePolygonLike(subjectEntry.geometry, maskUnion)
          : (cloneGeometry(subjectEntry.geometry) as PolygonLikeGeometry),
      issues,
      "difference failed.",
    );
    const area = geometry ? getPolygonLikeArea(geometry) : 0;

    if (!geometry || (area <= areaEpsilon && !options.includeEmptyResults)) {
      continue;
    }

    outputFeatures.push(
      createOperationFeature(
        "difference",
        geometry,
        [subjectEntry],
        maskEntries,
        area,
        outputFeatures.length,
        options,
      ),
    );
  }

  return { collection: { features: outputFeatures, type: "FeatureCollection" }, issues };
}

export function clipGeoJsonToPolygon<
  TInputProperties extends Record<string, unknown> = Record<string, unknown>,
  TOutputProperties extends Record<string, unknown> = GeoJsonOperationFeatureProperties,
>(
  source: GeoJsonFeatureInput<TInputProperties>,
  mask: GeoJsonFeatureInput<TInputProperties>,
  options: GeoJsonOperationOptions<TInputProperties, TOutputProperties> = {},
): GeoJsonOperationResult<TOutputProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const sourceEntries = collectPolygonEntries(toFeatureCollection(source), options, issues);
  const maskEntries = collectPolygonEntries(toFeatureCollection(mask), options, issues);
  const maskUnion = runPolygonOperation(
    () => unionPolygonLikes(maskEntries.map((entry) => entry.geometry)),
    issues,
    "clip mask union failed.",
  );
  const outputFeatures: Array<TemporalGeoJsonGeometryFeature<TOutputProperties>> = [];

  if (!maskUnion) {
    return { collection: { features: [], type: "FeatureCollection" }, issues };
  }

  for (const sourceEntry of sourceEntries) {
    const geometry = runPolygonOperation(
      () => intersectPolygonLike(sourceEntry.geometry, maskUnion),
      issues,
      "clip failed.",
    );
    const area = geometry ? getPolygonLikeArea(geometry) : 0;

    if (!geometry || (area <= areaEpsilon && !options.includeEmptyResults)) {
      continue;
    }

    outputFeatures.push(
      createOperationFeature(
        "clip",
        geometry,
        [sourceEntry],
        maskEntries,
        area,
        outputFeatures.length,
        options,
      ),
    );
  }

  return { collection: { features: outputFeatures, type: "FeatureCollection" }, issues };
}

export function getGeoJsonIntersections<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  leftCollection: GeoJsonMapSource<TProperties>,
  rightCollection: GeoJsonMapSource<TProperties>,
  options: GeoJsonRelationshipOptions<TProperties> = {},
): GeoJsonIntersectionRecord[] {
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const leftEntries = collectPolygonEntries(leftCollection, options);
  const rightEntries = collectPolygonEntries(rightCollection, options);
  const records: GeoJsonIntersectionRecord[] = [];

  for (const left of leftEntries) {
    for (const right of rightEntries) {
      const geometry = runPolygonOperation(() => intersectPolygonLike(left.geometry, right.geometry));
      const area = geometry ? getPolygonLikeArea(geometry) : 0;

      if (!geometry || area <= areaEpsilon) {
        continue;
      }

      records.push({
        area,
        geometry,
        leftId: left.id,
        leftIndex: left.index,
        leftPartIndex: left.partIndex,
        ratioOfLeft: area / getPolygonLikeArea(left.geometry),
        ratioOfRight: area / getPolygonLikeArea(right.geometry),
        rightId: right.id,
        rightIndex: right.index,
        rightPartIndex: right.partIndex,
      });
    }
  }

  return records;
}

export function getGeoJsonPolygonMeasurements<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  source: GeoJsonMapSource<TProperties>,
  options: GeoJsonPolygonMeasurementOptions<TProperties> = {},
): GeoJsonPolygonMeasurementRecord[] {
  return collectPolygonEntries(source, options).map((entry) => ({
    areaSquareMeters: getPolygonLikeGeodesicAreaSquareMeters(
      entry.geometry,
      options.earthRadiusMeters,
    ),
    featureId: entry.id,
    featureIndex: entry.index,
    partIndex: entry.partIndex,
    perimeterMeters: getPolygonLikePerimeterMeters(entry.geometry, options.earthRadiusMeters),
    planarArea: getPolygonLikeArea(entry.geometry),
  }));
}

export function createGeoJsonPolygonOutlines<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  source: GeoJsonMapSource<TProperties>,
  options: GeoJsonPolygonMeasurementOptions<TProperties> = {},
): GeoJsonOperationResult<GeoJsonPolygonOutlineProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const entries = collectPolygonEntries(source, options, issues);
  const features = entries.flatMap((entry) => {
    const polygons = entry.geometry.type === "Polygon" ? [entry.geometry.coordinates] : entry.geometry.coordinates;

    return polygons.flatMap((polygon, polygonIndex) =>
      polygon.map((ring, ringIndex) => {
        const properties: GeoJsonPolygonOutlineProperties = {
          featureId: entry.id,
          featureIndex: entry.index,
          lengthMeters: getGeoJsonRingGeodesicLengthMeters(ring, options.earthRadiusMeters),
          partIndex: entry.partIndex,
          planarLength: getGeoJsonRingPlanarLength(ring),
          polygonIndex,
          ringIndex,
          role: ringIndex === 0 ? "shell" : "hole",
        };

        return {
          geometry: {
            coordinates: ring.map(clonePosition),
            type: "LineString" as const,
          },
          id: `${entry.id}-outline-${polygonIndex}-${ringIndex}`,
          properties,
          type: "Feature" as const,
        };
      }),
    );
  });

  return { collection: { features, type: "FeatureCollection" }, issues };
}

export function findContainingGeoJsonFeatures<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  points: GeoJsonMapSource<TProperties>,
  polygons: GeoJsonMapSource<TProperties>,
  options: GeoJsonRelationshipOptions<TProperties> = {},
): GeoJsonContainmentRecord[] {
  const pointEntries = collectPointEntries(points, options);
  const polygonEntries = collectPolygonEntries(polygons, options);
  const includeBoundary = options.includeBoundary ?? true;
  const records: GeoJsonContainmentRecord[] = [];

  for (const point of pointEntries) {
    for (const polygon of polygonEntries) {
      if (!containsPoint(polygon.geometry, point.point, includeBoundary)) {
        continue;
      }

      records.push({
        point: clonePosition(point.point),
        pointFeatureId: point.id,
        pointFeatureIndex: point.index,
        pointIndex: point.pointIndex,
        polygonFeatureId: polygon.id,
        polygonFeatureIndex: polygon.index,
        polygonPartIndex: polygon.partIndex,
      });
    }
  }

  return records;
}

export function findOverlappingGeoJsonFeatures<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: GeoJsonMapSource<TProperties>,
  options: GeoJsonRelationshipOptions<TProperties> = {},
): GeoJsonOverlapRecord[] {
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const entries = collectPolygonEntries(collection, options);
  const records: GeoJsonOverlapRecord[] = [];

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      const geometry = runPolygonOperation(() => intersectPolygonLike(left.geometry, right.geometry));
      const area = geometry ? getPolygonLikeArea(geometry) : 0;

      if (!geometry || area <= areaEpsilon) {
        continue;
      }

      records.push({
        area,
        geometry,
        leftId: left.id,
        leftIndex: left.index,
        leftPartIndex: left.partIndex,
        ratioOfLeft: area / getPolygonLikeArea(left.geometry),
        ratioOfRight: area / getPolygonLikeArea(right.geometry),
        rightId: right.id,
        rightIndex: right.index,
        rightPartIndex: right.partIndex,
      });
    }
  }

  return records;
}

export function resolveGeoJsonPolygonOverlaps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  source: GeoJsonMapSource<TProperties>,
  options: GeoJsonPolygonOverlapResolutionOptions<TProperties> = {},
): GeoJsonPolygonOverlapResolutionResult<TProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const strategy = options.strategy ?? "later-wins";
  const entries = collectPolygonEntries(source, options, issues);
  const overlaps = findOverlappingGeoJsonFeatures(source, options);
  const features: Array<TemporalGeoJsonGeometryFeature<TProperties>> = [];

  entries.forEach((entry, entryIndex) => {
    const maskEntries =
      strategy === "later-wins"
        ? entries.slice(entryIndex + 1)
        : entries.slice(0, entryIndex);
    const maskUnion = runPolygonOperation(
      () => unionPolygonLikes(maskEntries.map((mask) => mask.geometry)),
      issues,
      "overlap resolution mask union failed.",
    );
    const geometry = runPolygonOperation(
      () =>
        maskUnion
          ? differencePolygonLike(entry.geometry, maskUnion)
          : (cloneGeometry(entry.geometry) as PolygonLikeGeometry),
      issues,
      "overlap resolution failed.",
    );
    const area = geometry ? getPolygonLikeArea(geometry) : 0;

    if (!geometry || area <= areaEpsilon) {
      return;
    }

    features.push({
      geometry,
      id: entry.feature.id,
      properties: cloneProperties(entry.feature.properties),
      type: "Feature",
    });
  });

  return { collection: { features, type: "FeatureCollection" }, issues, overlaps };
}

export function simplifyGeoJsonPolygons<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  source: GeoJsonMapSource<TProperties>,
  options: GeoJsonPolygonSimplifyOptions<TProperties>,
): GeoJsonOperationResult<TProperties> {
  const issues: GeoJsonOperationIssue[] = [];
  const areaEpsilon = options.areaEpsilon ?? DEFAULT_AREA_EPSILON;
  const entries = collectPolygonEntries(source, options, issues);
  const features = entries.flatMap((entry) => {
    const geometry = simplifyPolygonLike(entry.geometry, options.tolerance);
    const area = geometry ? getPolygonLikeArea(geometry) : 0;

    if (!geometry || area <= areaEpsilon) {
      return [];
    }

    return [
      {
        geometry,
        id: entry.feature.id,
        properties: cloneProperties(entry.feature.properties),
        type: "Feature" as const,
      },
    ];
  });

  return { collection: { features, type: "FeatureCollection" }, issues };
}

function toFeatureCollection<TProperties extends Record<string, unknown>>(
  input: GeoJsonFeatureInput<TProperties>,
): GeoJsonMapSource<TProperties> {
  if ("type" in input && input.type === "FeatureCollection") {
    return input;
  }

  if ("type" in input && input.type === "Feature") {
    return { features: [input], type: "FeatureCollection" };
  }

  return { features: [...input], type: "FeatureCollection" };
}

function collectPolygonEntries<TProperties extends Record<string, unknown>>(
  collection: GeoJsonMapSource<TProperties>,
  options:
    | GeoJsonOperationOptions<TProperties, Record<string, unknown>>
    | GeoJsonRelationshipOptions<TProperties>,
  issues: GeoJsonOperationIssue[] = [],
): Array<PolygonEntry<TProperties>> {
  const entries: Array<PolygonEntry<TProperties>> = [];
  const flattened = flattenGeoJsonFeatures(collection);
  const featureParts = new Map<number, number>();

  for (const entry of flattened) {
    const id = createFeatureId(entry.feature, entry.index, entry.partIndex, options.getFeatureId);

    featureParts.set(entry.index, (featureParts.get(entry.index) ?? 0) + 1);

    if (!isPolygonLikeGeometry(entry.geometry)) {
      issues.push({
        code: "skipped-non-polygon",
        featureId: id,
        featureIndex: entry.index,
        message: `Skipped ${entry.geometry.type} geometry because polygon overlay operations only support Polygon and MultiPolygon.`,
        partIndex: entry.partIndex,
      });
      continue;
    }

    entries.push({
      feature: entry.feature,
      geometry: cloneGeometry(entry.geometry) as PolygonLikeGeometry,
      id,
      index: entry.index,
      partIndex: entry.partIndex,
    });
  }

  collection.features.forEach((feature, index) => {
    if (!featureParts.has(index)) {
      issues.push({
        code: "invalid-geometry",
        featureId: createFeatureId(feature, index, undefined, options.getFeatureId),
        featureIndex: index,
        message: "Skipped feature because its geometry could not be normalized.",
      });
    }
  });

  return entries;
}

function collectPointEntries<TProperties extends Record<string, unknown>>(
  collection: GeoJsonMapSource<TProperties>,
  options: GeoJsonRelationshipOptions<TProperties>,
): Array<PointEntry<TProperties>> {
  return flattenGeoJsonFeatures(collection).flatMap((entry) => {
    const id = createFeatureId(entry.feature, entry.index, entry.partIndex, options.getFeatureId);

    if (entry.geometry.type === "Point") {
      return [
        {
          feature: entry.feature,
          id,
          index: entry.index,
          point: clonePosition(entry.geometry.coordinates),
        },
      ];
    }

    if (entry.geometry.type === "MultiPoint") {
      return entry.geometry.coordinates.map((point, pointIndex) => ({
        feature: entry.feature,
        id,
        index: entry.index,
        point: clonePosition(point),
        pointIndex,
      }));
    }

    return [];
  });
}

function createOperationFeature<
  TInputProperties extends Record<string, unknown>,
  TOutputProperties extends Record<string, unknown>,
>(
  operation: GeoJsonBooleanOperation,
  geometry: PolygonLikeGeometry,
  sourceEntries: Array<PolygonEntry<TInputProperties>>,
  targetEntries: Array<PolygonEntry<TInputProperties>>,
  area: number,
  outputIndex: number,
  options: GeoJsonOperationOptions<TInputProperties, TOutputProperties>,
): TemporalGeoJsonGeometryFeature<TOutputProperties> {
  const firstSourceArea = sourceEntries[0] ? getPolygonLikeArea(sourceEntries[0].geometry) : 0;
  const targetArea = targetEntries.reduce((sum, entry) => sum + getPolygonLikeArea(entry.geometry), 0);
  const defaultProperties: GeoJsonOperationFeatureProperties = {
    area,
    operation,
    ratioOfSource: firstSourceArea > 0 ? area / firstSourceArea : undefined,
    ratioOfTarget: targetArea > 0 ? area / targetArea : undefined,
    sourceIds: sourceEntries.map((entry) => entry.id),
    sourceIndexes: sourceEntries.map((entry) => entry.index),
    targetIds: targetEntries.map((entry) => entry.id),
    targetIndexes: targetEntries.map((entry) => entry.index),
  };
  const properties =
    options.getProperties?.({
      defaultProperties,
      geometry,
      operation,
      sourceFeatures: sourceEntries.map((entry) => entry.feature),
      targetFeatures: targetEntries.map((entry) => entry.feature),
    }) ?? (defaultProperties as unknown as TOutputProperties);

  return {
    geometry,
    id: `${operation}-${outputIndex}`,
    properties,
    type: "Feature",
  };
}

function runPolygonOperation<T>(
  operation: () => T,
  issues?: GeoJsonOperationIssue[],
  message = "polygon operation failed.",
): T | null {
  try {
    return operation();
  } catch {
    issues?.push({
      code: "operation-failed",
      message,
    });
    return null;
  }
}

function createFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  partIndex: number | undefined,
  getFeatureId:
    | ((
        feature: TemporalGeoJsonGeometryFeature<TProperties>,
        index: number,
        partIndex?: number,
      ) => string | number | undefined)
    | undefined,
) {
  const base = getFeatureId?.(feature, index, partIndex) ?? feature.id ?? `feature-${index}`;

  return partIndex === undefined ? String(base) : `${base}-part-${partIndex}`;
}

function isPolygonLikeGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
): geometry is PolygonLikeGeometry {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

function cloneProperties<TProperties extends Record<string, unknown>>(
  properties: TProperties | null | undefined,
): TProperties | null | undefined {
  return properties ? ({ ...properties } as TProperties) : properties;
}

function containsPoint(
  geometry: PolygonLikeGeometry,
  point: GeoJsonPosition,
  includeBoundary: boolean,
) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  return polygons.some((polygon) => containsPointInPolygon(polygon, point, includeBoundary));
}

function containsPointInPolygon(
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

  if (Math.abs(cross) > DEFAULT_AREA_EPSILON) {
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
