import { cloneGeometry, closeRing, normalizeSupportedGeometry } from "./temporal-geojson-geometry";
import { interpolateTemporalGeoJsonGeometry } from "./temporal-geojson-interpolation";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonInterpolationStrategy,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonTransitionAlgorithm =
  | "hold"
  | "compatible"
  | "resample"
  | "vertex-union"
  | "centroid-radial"
  | "topology-plan";

export type GeoJsonTransitionFallback = "hold" | "hide";

export type GeoJsonTransitionOptions = {
  algorithm?: GeoJsonTransitionAlgorithm;
  coordinateSpace?: "lonlat" | "web-mercator" | "identity";
  fallback?: GeoJsonTransitionFallback;
  maxCoordinatesPerLine?: number;
  maxCoordinatesPerRing?: number;
  minCoordinatesPerLine?: number;
  minCoordinatesPerRing?: number;
};

export type GeoJsonTransitionFragmentKind =
  | "preserve"
  | "split"
  | "merge"
  | "appear"
  | "disappear"
  | "morph";

export type GeoJsonTransitionPlan<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly algorithm: GeoJsonTransitionAlgorithm;
  readonly fallback: GeoJsonTransitionFallback;
  readonly fragments: readonly GeoJsonTransitionPlanFragment<TProperties>[];
  readonly options: ResolvedGeoJsonTransitionOptions;
  readonly type: "GeoJsonTransitionPlan";
};

export type ResolvedGeoJsonTransitionOptions = Required<GeoJsonTransitionOptions>;

type GeoJsonTransitionPlanFragment<TProperties extends Record<string, unknown>> = {
  fromFeature?: TemporalGeoJsonGeometryFeature<TProperties>;
  fromGeometry?: TemporalGeoJsonSupportedGeometry;
  id: string;
  kind: GeoJsonTransitionFragmentKind;
  sourceIds: Array<string | number>;
  targetIds: Array<string | number>;
  toFeature?: TemporalGeoJsonGeometryFeature<TProperties>;
  toGeometry?: TemporalGeoJsonSupportedGeometry;
};

type PolygonLikeGeometry =
  | Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>
  | Extract<TemporalGeoJsonSupportedGeometry, { type: "MultiPolygon" }>;

type GeoJsonTransitionFeatureEntry<TProperties extends Record<string, unknown>> = {
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  geometry: TemporalGeoJsonSupportedGeometry | null;
  index: number;
};

type PolygonLikeFeatureEntry<TProperties extends Record<string, unknown>> = {
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  geometry: PolygonLikeGeometry;
  index: number;
};

const DEFAULT_TRANSITION_OPTIONS: ResolvedGeoJsonTransitionOptions = {
  algorithm: "vertex-union",
  coordinateSpace: "lonlat",
  fallback: "hold",
  maxCoordinatesPerLine: 512,
  maxCoordinatesPerRing: 512,
  minCoordinatesPerLine: 16,
  minCoordinatesPerRing: 16,
};

export function createGeoJsonTransitionPlan<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  from: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  to: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  options: GeoJsonTransitionOptions = {},
): GeoJsonTransitionPlan<TProperties> {
  const resolvedOptions = resolveTransitionOptions(options);
  const fragments =
    resolvedOptions.algorithm === "topology-plan"
      ? createTopologyPlanFragments(
          projectFeatureCollectionForPlanning(from, resolvedOptions),
          projectFeatureCollectionForPlanning(to, resolvedOptions),
        )
      : createPairedPlanFragments(from, to);

  return {
    algorithm: resolvedOptions.algorithm,
    fallback: resolvedOptions.fallback,
    fragments,
    options: resolvedOptions,
    type: "GeoJsonTransitionPlan",
  };
}

export function interpolateGeoJsonTransitionPlan<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  plan: GeoJsonTransitionPlan<TProperties>,
  progress: number,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  const normalizedProgress = clamp(progress, 0, 1);

  return {
    features: plan.fragments.flatMap((fragment) =>
      interpolatePlanFragment(fragment, normalizedProgress, plan),
    ),
    type: "FeatureCollection",
  };
}

function createPairedPlanFragments<TProperties extends Record<string, unknown>>(
  from: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  to: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  return createPairedPlanFragmentsFromEntries(
    createTransitionFeatureEntries(from),
    createTransitionFeatureEntries(to),
  );
}

function createPairedPlanFragmentsFromEntries<TProperties extends Record<string, unknown>>(
  fromEntries: Array<GeoJsonTransitionFeatureEntry<TProperties>>,
  toEntries: Array<GeoJsonTransitionFeatureEntry<TProperties>>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  if (fromEntries.length === 1 && toEntries.length === 1) {
    const fromEntry = fromEntries[0]!;
    const toEntry = toEntries[0]!;

    return [
      {
        fromFeature: fromEntry.feature,
        fromGeometry: fromEntry.geometry ?? undefined,
        id: `${getFeatureKey(fromEntry.feature, fromEntry.index)}:${getFeatureKey(toEntry.feature, toEntry.index)}`,
        kind: "morph",
        sourceIds: [fromEntry.feature.id ?? getFeatureKey(fromEntry.feature, fromEntry.index)],
        targetIds: [toEntry.feature.id ?? getFeatureKey(toEntry.feature, toEntry.index)],
        toFeature: toEntry.feature,
        toGeometry: toEntry.geometry ?? undefined,
      },
    ];
  }

  const targetById = new Map(
    toEntries.map((entry) => [getFeatureKey(entry.feature, entry.index), entry]),
  );
  const consumedTargetIds = new Set<string>();
  const fragments: Array<GeoJsonTransitionPlanFragment<TProperties>> = [];

  fromEntries.forEach((fromEntry) => {
    const id = getFeatureKey(fromEntry.feature, fromEntry.index);
    const toEntry = targetById.get(id);

    if (toEntry) {
      consumedTargetIds.add(id);
    }

    fragments.push({
      fromFeature: fromEntry.feature,
      fromGeometry: fromEntry.geometry ?? undefined,
      id,
      kind: toEntry ? "morph" : "disappear",
      sourceIds: [fromEntry.feature.id ?? id],
      targetIds: toEntry ? [toEntry.feature.id ?? id] : [],
      toFeature: toEntry?.feature,
      toGeometry: toEntry?.geometry ?? undefined,
    });
  });

  toEntries.forEach((toEntry) => {
    const id = getFeatureKey(toEntry.feature, toEntry.index);

    if (consumedTargetIds.has(id)) {
      return;
    }

    fragments.push({
      id,
      kind: "appear",
      sourceIds: [],
      targetIds: [toEntry.feature.id ?? id],
      toFeature: toEntry.feature,
      toGeometry: toEntry.geometry ?? undefined,
    });
  });

  return fragments;
}

function createTopologyPlanFragments<TProperties extends Record<string, unknown>>(
  from: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  to: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const fromEntries = createTransitionFeatureEntries(from);
  const toEntries = createTransitionFeatureEntries(to);
  const fromPolygonFeatures = fromEntries.filter(isPolygonLikeFeatureEntry);
  const toPolygonFeatures = toEntries.filter(isPolygonLikeFeatureEntry);
  const pairedNonPolygonFragments = createPairedPlanFragmentsFromEntries(
    fromEntries.filter((entry) => !isPolygonLikeFeatureEntry(entry)),
    toEntries.filter((entry) => !isPolygonLikeFeatureEntry(entry)),
  );

  if (fromPolygonFeatures.length === 1 && toPolygonFeatures.length === 1) {
    return [
      ...createSinglePolygonTopologyFragments(fromPolygonFeatures[0]!, toPolygonFeatures[0]!),
      ...pairedNonPolygonFragments,
    ];
  }

  if (fromPolygonFeatures.length === 1 && toPolygonFeatures.length > 1) {
    const source = fromPolygonFeatures[0]!;

    return [
      ...toPolygonFeatures.map((target) => ({
        fromFeature: source.feature,
        fromGeometry:
          getBoundsIntersectionGeometry(source.geometry, target.geometry) ??
          createCollapsedPolygonGeometry(getGeometryCentroid(source.geometry)),
        id: `split:${getFeatureKey(source.feature, source.index)}:${getFeatureKey(target.feature, target.index)}`,
        kind: "split" as const,
        sourceIds: [source.feature.id ?? source.index],
        targetIds: [target.feature.id ?? target.index],
        toFeature: target.feature,
        toGeometry: target.geometry,
      })),
      ...pairedNonPolygonFragments,
    ];
  }

  if (fromPolygonFeatures.length > 1 && toPolygonFeatures.length === 1) {
    const target = toPolygonFeatures[0]!;

    return [
      ...fromPolygonFeatures.map((source) => ({
        fromFeature: source.feature,
        fromGeometry: source.geometry,
        id: `merge:${getFeatureKey(source.feature, source.index)}:${getFeatureKey(target.feature, target.index)}`,
        kind: "merge" as const,
        sourceIds: [source.feature.id ?? source.index],
        targetIds: [target.feature.id ?? target.index],
        toFeature: target.feature,
        toGeometry:
          getBoundsIntersectionGeometry(source.geometry, target.geometry) ??
          createCollapsedPolygonGeometry(getGeometryCentroid(target.geometry)),
      })),
      ...pairedNonPolygonFragments,
    ];
  }

  return createPairedPlanFragments(from, to).map((fragment) => ({
    ...fragment,
    kind: fragment.kind === "morph" ? "preserve" : fragment.kind,
  }));
}

function createTransitionFeatureEntries<TProperties extends Record<string, unknown>>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): Array<GeoJsonTransitionFeatureEntry<TProperties>> {
  return collection.features.map((feature, index) => ({
    feature,
    geometry: normalizeSupportedGeometry(feature.geometry),
    index,
  }));
}

function isPolygonLikeFeatureEntry<TProperties extends Record<string, unknown>>(
  entry: GeoJsonTransitionFeatureEntry<TProperties>,
): entry is PolygonLikeFeatureEntry<TProperties> {
  return entry.geometry?.type === "Polygon" || entry.geometry?.type === "MultiPolygon";
}

function createSinglePolygonTopologyFragments<TProperties extends Record<string, unknown>>(
  source: {
    feature: TemporalGeoJsonGeometryFeature<TProperties>;
    geometry: PolygonLikeGeometry;
    index: number;
  },
  target: {
    feature: TemporalGeoJsonGeometryFeature<TProperties>;
    geometry: PolygonLikeGeometry;
    index: number;
  },
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const sourceId = source.feature.id ?? source.index;
  const targetId = target.feature.id ?? target.index;
  const overlap = getBoundsIntersectionGeometry(source.geometry, target.geometry);
  const baseId = `${getFeatureKey(source.feature, source.index)}:${getFeatureKey(target.feature, target.index)}`;

  if (!overlap) {
    return [
      {
        fromFeature: source.feature,
        fromGeometry: source.geometry,
        id: `morph:${baseId}`,
        kind: "morph",
        sourceIds: [sourceId],
        targetIds: [targetId],
        toFeature: target.feature,
        toGeometry: target.geometry,
      },
    ];
  }

  const sourceCollapse = createCollapsedPolygonGeometry(getGeometryCentroid(source.geometry));
  const targetCollapse = createCollapsedPolygonGeometry(getGeometryCentroid(target.geometry));

  return [
    {
      fromFeature: source.feature,
      fromGeometry: overlap,
      id: `preserve:${baseId}`,
      kind: "preserve",
      sourceIds: [sourceId],
      targetIds: [targetId],
      toFeature: target.feature,
      toGeometry: overlap,
    },
    {
      fromFeature: source.feature,
      fromGeometry: source.geometry,
      id: `disappear:${baseId}`,
      kind: "disappear",
      sourceIds: [sourceId],
      targetIds: [],
      toGeometry: sourceCollapse,
    },
    {
      fromGeometry: targetCollapse,
      id: `appear:${baseId}`,
      kind: "appear",
      sourceIds: [],
      targetIds: [targetId],
      toFeature: target.feature,
      toGeometry: target.geometry,
    },
  ];
}

function interpolatePlanFragment<TProperties extends Record<string, unknown>>(
  fragment: GeoJsonTransitionPlanFragment<TProperties>,
  progress: number,
  plan: GeoJsonTransitionPlan<TProperties>,
): Array<TemporalGeoJsonGeometryFeature<TProperties>> {
  if (plan.algorithm === "hold") {
    return fragment.fromFeature && fragment.fromGeometry
      ? [{ ...cloneFeature(fragment.fromFeature), geometry: cloneGeometry(fragment.fromGeometry) }]
      : [];
  }

  if (!fragment.fromGeometry && !fragment.toGeometry) {
    return [];
  }

  if (!fragment.fromGeometry) {
    return progress >= 1 && fragment.toFeature && fragment.toGeometry
      ? [{ ...cloneFeature(fragment.toFeature), geometry: cloneGeometry(fragment.toGeometry) }]
      : [];
  }

  if (!fragment.toGeometry) {
    return plan.fallback === "hide" && progress > 0
      ? []
      : [
          {
            ...cloneFeature(fragment.fromFeature),
            geometry: cloneGeometry(fragment.fromGeometry),
          },
        ];
  }

  const interpolatedGeometry = interpolateTemporalGeoJsonGeometry(
    fragment.fromGeometry,
    fragment.toGeometry,
    progress,
    {
      fallback: plan.fallback,
      maxCoordinatesPerLine: plan.options.maxCoordinatesPerLine,
      maxCoordinatesPerRing: plan.options.maxCoordinatesPerRing,
      minResampleCoordinates: Math.max(
        plan.options.minCoordinatesPerLine,
        plan.options.minCoordinatesPerRing,
      ),
      strategy: getGeometryInterpolationStrategy(plan.algorithm),
    },
  );

  if (!interpolatedGeometry) {
    return [];
  }
  const outputGeometry =
    plan.algorithm === "topology-plan"
      ? unprojectGeometryFromPlanning(interpolatedGeometry, plan.options)
      : interpolatedGeometry;

  return [
    {
      ...cloneFeature(fragment.fromFeature ?? fragment.toFeature),
      geometry: outputGeometry,
      id: fragment.id,
      properties: {
        ...((fragment.fromFeature?.properties ?? fragment.toFeature?.properties ?? {}) as TProperties),
        flowArea: getGeometryArea(fragment.fromGeometry),
        sourceIds: fragment.sourceIds,
        targetIds: fragment.targetIds,
        transitionKind: fragment.kind,
      },
      type: "Feature",
    },
  ];
}

function getGeometryInterpolationStrategy(
  algorithm: GeoJsonTransitionAlgorithm,
): TemporalGeoJsonInterpolationStrategy {
  return algorithm === "topology-plan" ? "vertex-union" : algorithm;
}

function getFeatureKey<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
) {
  return String(feature.id ?? feature.properties?.trackId ?? feature.properties?.id ?? `feature-${index}`);
}

function cloneFeature<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties> | undefined,
): TemporalGeoJsonGeometryFeature<TProperties> {
  return {
    geometry: null,
    ...(feature ?? { type: "Feature" as const }),
    properties: feature?.properties ? { ...feature.properties } : feature?.properties,
    type: "Feature",
  };
}

function getBoundsIntersectionGeometry(
  left: PolygonLikeGeometry,
  right: PolygonLikeGeometry,
): Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }> | null {
  const leftBounds = getGeometryBounds(left);
  const rightBounds = getGeometryBounds(right);
  const west = Math.max(leftBounds.west, rightBounds.west);
  const south = Math.max(leftBounds.south, rightBounds.south);
  const east = Math.min(leftBounds.east, rightBounds.east);
  const north = Math.min(leftBounds.north, rightBounds.north);

  if (west >= east || south >= north) {
    return null;
  }

  return {
    coordinates: [
      closeRing([
        [west, south],
        [east, south],
        [east, north],
        [west, north],
      ]),
    ],
    type: "Polygon",
  };
}

function createCollapsedPolygonGeometry(
  point: GeoJsonPosition,
): Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }> {
  return {
    coordinates: [[point, point, point, point].map(clonePosition)],
    type: "Polygon",
  };
}

function getGeometryBounds(geometry: PolygonLikeGeometry) {
  const positions = getPolygonLikePositions(geometry);

  return positions.reduce(
    (bounds, position) => ({
      east: Math.max(bounds.east, position[0]),
      north: Math.max(bounds.north, position[1]),
      south: Math.min(bounds.south, position[1]),
      west: Math.min(bounds.west, position[0]),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
}

function getGeometryCentroid(geometry: PolygonLikeGeometry): GeoJsonPosition {
  const positions = getPolygonLikePositions(geometry);
  const totals = positions.reduce(
    (sum, position) => [sum[0] + position[0], sum[1] + position[1]] as GeoJsonPosition,
    [0, 0],
  );

  return positions.length === 0
    ? [0, 0]
    : [totals[0] / positions.length, totals[1] / positions.length];
}

function getGeometryArea(geometry: TemporalGeoJsonSupportedGeometry) {
  if (geometry.type === "Polygon") {
    return getPolygonArea(geometry.coordinates);
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.reduce((sum, polygon) => sum + getPolygonArea(polygon), 0);
  }

  return 0;
}

function getPolygonLikePositions(geometry: PolygonLikeGeometry): GeoJsonPosition[] {
  return geometry.type === "Polygon" ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
}

function getPolygonArea(polygon: GeoJsonPosition[][]) {
  return Math.abs(
    polygon.reduce((total, ring, ringIndex) => {
      const area = getRingArea(ring);

      return ringIndex === 0 ? total + area : total - area;
    }, 0),
  );
}

function getRingArea(ring: readonly GeoJsonPosition[]) {
  if (ring.length < 3) {
    return 0;
  }

  let area = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const left = ring[index]!;
    const right = ring[(index + 1) % ring.length]!;

    area += left[0] * right[1] - right[0] * left[1];
  }

  return area / 2;
}

function projectFeatureCollectionForPlanning<TProperties extends Record<string, unknown>>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  options: ResolvedGeoJsonTransitionOptions,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  if (options.coordinateSpace !== "lonlat") {
    return collection;
  }

  return {
    ...collection,
    features: collection.features.map((feature) => {
      const geometry = normalizeSupportedGeometry(feature.geometry);

      return {
        ...feature,
        geometry: geometry ? mapGeometryPositions(geometry, projectLonLatToWebMercator) : feature.geometry,
      };
    }),
  };
}

function unprojectGeometryFromPlanning(
  geometry: TemporalGeoJsonSupportedGeometry,
  options: ResolvedGeoJsonTransitionOptions,
) {
  return options.coordinateSpace === "lonlat"
    ? mapGeometryPositions(geometry, unprojectWebMercatorToLonLat)
    : geometry;
}

function mapGeometryPositions(
  geometry: TemporalGeoJsonSupportedGeometry,
  mapPosition: (position: GeoJsonPosition) => GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return { coordinates: mapPosition(geometry.coordinates), type: "Point" };
    case "MultiPoint":
      return { coordinates: geometry.coordinates.map(mapPosition), type: "MultiPoint" };
    case "LineString":
      return { coordinates: geometry.coordinates.map(mapPosition), type: "LineString" };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line) => line.map(mapPosition)),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring) => ring.map(mapPosition)),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(mapPosition)),
        ),
        type: "MultiPolygon",
      };
  }
}

function projectLonLatToWebMercator(position: GeoJsonPosition): GeoJsonPosition {
  const longitude = clamp(position[0], -180, 180);
  const latitude = clamp(position[1], -85.05112878, 85.05112878);
  const scale = 6_378_137;

  return [
    (longitude * Math.PI * scale) / 180,
    Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) * scale,
  ];
}

function unprojectWebMercatorToLonLat(position: GeoJsonPosition): GeoJsonPosition {
  const scale = 6_378_137;

  return [
    (position[0] * 180) / (Math.PI * scale),
    (Math.atan(Math.exp(position[1] / scale)) * 360) / Math.PI - 90,
  ];
}

function clonePosition(position: GeoJsonPosition): GeoJsonPosition {
  return [position[0], position[1]];
}

function resolveTransitionOptions(options: GeoJsonTransitionOptions): ResolvedGeoJsonTransitionOptions {
  const minCoordinatesPerRing =
    sanitizePositiveInteger(options.minCoordinatesPerRing) ??
    sanitizePositiveInteger(options.minCoordinatesPerLine) ??
    DEFAULT_TRANSITION_OPTIONS.minCoordinatesPerRing;

  return {
    algorithm: options.algorithm ?? DEFAULT_TRANSITION_OPTIONS.algorithm,
    coordinateSpace: options.coordinateSpace ?? DEFAULT_TRANSITION_OPTIONS.coordinateSpace,
    fallback: options.fallback ?? DEFAULT_TRANSITION_OPTIONS.fallback,
    maxCoordinatesPerLine:
      sanitizePositiveInteger(options.maxCoordinatesPerLine) ??
      DEFAULT_TRANSITION_OPTIONS.maxCoordinatesPerLine,
    maxCoordinatesPerRing:
      sanitizePositiveInteger(options.maxCoordinatesPerRing) ??
      DEFAULT_TRANSITION_OPTIONS.maxCoordinatesPerRing,
    minCoordinatesPerLine:
      sanitizePositiveInteger(options.minCoordinatesPerLine) ??
      DEFAULT_TRANSITION_OPTIONS.minCoordinatesPerLine,
    minCoordinatesPerRing,
  };
}

function sanitizePositiveInteger(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : undefined;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
