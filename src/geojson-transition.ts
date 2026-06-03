import { cloneGeometry, closeRing, normalizeSupportedGeometry } from "./temporal-geojson-geometry";
import { interpolateTemporalGeoJsonGeometry } from "./temporal-geojson-interpolation";
import {
  clipPolygonLikeToVoronoiCell,
  createExpandedTopologyBounds,
  createVoronoiCellRings,
  differencePolygonLike,
  getPolygonLikeArea,
  getPolygonLikeCentroid,
  intersectPolygonLike,
  unionPolygonLikes,
  type PolygonLikeGeometry,
  type TopologyOverlapEdge,
  type TopologyPolygonEntry,
} from "./geojson-topology";
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

export type GeoJsonTopologyStrategy = "bounds" | "area-overlap" | "voronoi-partition";

export type GeoJsonTransitionOptions = {
  algorithm?: GeoJsonTransitionAlgorithm;
  coordinateSpace?: "lonlat" | "web-mercator" | "identity";
  fallback?: GeoJsonTransitionFallback;
  maxCoordinatesPerLine?: number;
  maxCoordinatesPerRing?: number;
  minCoordinatesPerLine?: number;
  minCoordinatesPerRing?: number;
  topologyMinOverlapRatio?: number;
  topologyStrategy?: GeoJsonTopologyStrategy;
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
  overlapArea?: number;
  overlapRatio?: number;
  sourceIds: Array<string | number>;
  targetIds: Array<string | number>;
  toFeature?: TemporalGeoJsonGeometryFeature<TProperties>;
  toGeometry?: TemporalGeoJsonSupportedGeometry;
};

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
  topologyMinOverlapRatio: 0.005,
  topologyStrategy: "area-overlap",
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
          resolvedOptions,
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
  options: ResolvedGeoJsonTransitionOptions,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  switch (options.topologyStrategy) {
    case "bounds":
      return createBoundsTopologyPlanFragments(from, to);
    case "voronoi-partition":
      return createAreaOverlapTopologyPlanFragments(from, to, options);
    case "area-overlap":
      return createAreaOverlapTopologyPlanFragments(from, to, options);
  }
}

function createBoundsTopologyPlanFragments<TProperties extends Record<string, unknown>>(
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

function createAreaOverlapTopologyPlanFragments<TProperties extends Record<string, unknown>>(
  from: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  to: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  options: ResolvedGeoJsonTransitionOptions,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const fromEntries = createTransitionFeatureEntries(from);
  const toEntries = createTransitionFeatureEntries(to);
  const sourceEntries = createTopologyPolygonEntries(fromEntries);
  const targetEntries = createTopologyPolygonEntries(toEntries);
  const pairedNonPolygonFragments = createPairedPlanFragmentsFromEntries(
    fromEntries.filter((entry) => !isPolygonLikeFeatureEntry(entry)),
    toEntries.filter((entry) => !isPolygonLikeFeatureEntry(entry)),
  );

  if (sourceEntries.length === 0 || targetEntries.length === 0) {
    return [
      ...sourceEntries.map((entry) => createDisappearFragment(entry)),
      ...targetEntries.map((entry) => createAppearFragment(entry)),
      ...pairedNonPolygonFragments,
    ];
  }

  const sourceAreas = new Map(sourceEntries.map((entry) => [entry.key, getPolygonLikeArea(entry.geometry)]));
  const targetAreas = new Map(targetEntries.map((entry) => [entry.key, getPolygonLikeArea(entry.geometry)]));
  const edges = createTopologyOverlapEdges(
    sourceEntries,
    targetEntries,
    sourceAreas,
    targetAreas,
    options.topologyMinOverlapRatio,
  );

  if (sourceEntries.length === 1 && targetEntries.length > 1) {
    return [
      ...createSplitAreaOverlapFragments(sourceEntries[0]!, targetEntries, edges),
      ...pairedNonPolygonFragments,
    ];
  }

  if (sourceEntries.length > 1 && targetEntries.length === 1) {
    return [
      ...createMergeAreaOverlapFragments(sourceEntries, targetEntries[0]!, edges),
      ...pairedNonPolygonFragments,
    ];
  }

  return [
    ...createFragmentsForTopologyComponents(
      sourceEntries,
      targetEntries,
      edges,
      sourceAreas,
      targetAreas,
    ),
    ...pairedNonPolygonFragments,
  ];
}

function createTopologyPolygonEntries<TProperties extends Record<string, unknown>>(
  entries: Array<GeoJsonTransitionFeatureEntry<TProperties>>,
): Array<TopologyPolygonEntry<TProperties>> {
  return entries.filter(isPolygonLikeFeatureEntry).map((entry) => ({
    feature: entry.feature,
    geometry: entry.geometry,
    index: entry.index,
    key: getFeatureKey(entry.feature, entry.index),
  }));
}

function createTopologyOverlapEdges<TProperties extends Record<string, unknown>>(
  sources: Array<TopologyPolygonEntry<TProperties>>,
  targets: Array<TopologyPolygonEntry<TProperties>>,
  sourceAreas: Map<string, number>,
  targetAreas: Map<string, number>,
  minOverlapRatio: number,
): Array<TopologyOverlapEdge<TProperties>> {
  const edges: Array<TopologyOverlapEdge<TProperties>> = [];

  for (const source of sources) {
    for (const target of targets) {
      const overlapGeometry = intersectPolygonLike(source.geometry, target.geometry);
      if (!overlapGeometry) {
        continue;
      }

      const area = getPolygonLikeArea(overlapGeometry);
      const ratioOfSource = area / Math.max(sourceAreas.get(source.key) ?? 0, Number.EPSILON);
      const ratioOfTarget = area / Math.max(targetAreas.get(target.key) ?? 0, Number.EPSILON);

      if (area > 0 && (ratioOfSource >= minOverlapRatio || ratioOfTarget >= minOverlapRatio)) {
        edges.push({
          area,
          overlapGeometry,
          ratioOfSource,
          ratioOfTarget,
          source,
          target,
        });
      }
    }
  }

  return edges.sort((left, right) => right.area - left.area || left.source.key.localeCompare(right.source.key));
}

function createFragmentsForTopologyComponents<TProperties extends Record<string, unknown>>(
  sources: Array<TopologyPolygonEntry<TProperties>>,
  targets: Array<TopologyPolygonEntry<TProperties>>,
  edges: Array<TopologyOverlapEdge<TProperties>>,
  sourceAreas: Map<string, number>,
  targetAreas: Map<string, number>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const sourceByKey = new Map(sources.map((entry) => [entry.key, entry]));
  const targetByKey = new Map(targets.map((entry) => [entry.key, entry]));
  const edgesBySource = groupEdgesByKey(edges, (edge) => edge.source.key);
  const edgesByTarget = groupEdgesByKey(edges, (edge) => edge.target.key);
  const visitedSources = new Set<string>();
  const visitedTargets = new Set<string>();
  const fragments: Array<GeoJsonTransitionPlanFragment<TProperties>> = [];

  for (const source of sources) {
    if (visitedSources.has(source.key)) {
      continue;
    }

    const component = collectTopologyComponent(source.key, true, edgesBySource, edgesByTarget);

    component.sourceKeys.forEach((key) => visitedSources.add(key));
    component.targetKeys.forEach((key) => visitedTargets.add(key));
    fragments.push(
      ...createFragmentsForTopologyComponent(
        [...component.sourceKeys].flatMap((key) => {
          const entry = sourceByKey.get(key);

          return entry ? [entry] : [];
        }),
        [...component.targetKeys].flatMap((key) => {
          const entry = targetByKey.get(key);

          return entry ? [entry] : [];
        }),
        edges.filter(
          (edge) =>
            component.sourceKeys.has(edge.source.key) && component.targetKeys.has(edge.target.key),
        ),
        sourceAreas,
        targetAreas,
      ),
    );
  }

  for (const target of targets) {
    if (visitedTargets.has(target.key)) {
      continue;
    }

    visitedTargets.add(target.key);
    fragments.push(createAppearFragment(target));
  }

  return fragments;
}

function createFragmentsForTopologyComponent<TProperties extends Record<string, unknown>>(
  sources: Array<TopologyPolygonEntry<TProperties>>,
  targets: Array<TopologyPolygonEntry<TProperties>>,
  edges: Array<TopologyOverlapEdge<TProperties>>,
  sourceAreas: Map<string, number>,
  targetAreas: Map<string, number>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  if (sources.length === 1 && targets.length === 0) {
    return [createDisappearFragment(sources[0]!)];
  }

  if (sources.length === 0 && targets.length === 1) {
    return [createAppearFragment(targets[0]!)];
  }

  if (sources.length === 1 && targets.length === 1) {
    return createOneToOneAreaOverlapFragments(sources[0]!, targets[0]!, edges[0] ?? null);
  }

  if (sources.length === 1 && targets.length > 1) {
    return createSplitAreaOverlapFragments(sources[0]!, targets, edges);
  }

  if (sources.length > 1 && targets.length === 1) {
    return createMergeAreaOverlapFragments(sources, targets[0]!, edges);
  }

  return createManyToManyAreaOverlapFragments(sources, targets, edges, sourceAreas, targetAreas);
}

function createOneToOneAreaOverlapFragments<TProperties extends Record<string, unknown>>(
  source: TopologyPolygonEntry<TProperties>,
  target: TopologyPolygonEntry<TProperties>,
  edge: TopologyOverlapEdge<TProperties> | null,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  if (!edge) {
    return [
      {
        fromFeature: source.feature,
        fromGeometry: source.geometry,
        id: `morph:${source.key}:${target.key}`,
        kind: "morph",
        sourceIds: [getEntryId(source)],
        targetIds: [getEntryId(target)],
        toFeature: target.feature,
        toGeometry: target.geometry,
      },
    ];
  }

  const fragments: Array<GeoJsonTransitionPlanFragment<TProperties>> = [
    createPreserveFragment(edge),
  ];
  const disappearing = differencePolygonLike(source.geometry, target.geometry);
  const appearing = differencePolygonLike(target.geometry, source.geometry);

  if (disappearing && getPolygonLikeArea(disappearing) > 0) {
    fragments.push(createDisappearFragment(source, disappearing, `disappear:${source.key}:${target.key}`));
  }

  if (appearing && getPolygonLikeArea(appearing) > 0) {
    fragments.push(createAppearFragment(target, appearing, `appear:${source.key}:${target.key}`));
  }

  return fragments;
}

function createSplitAreaOverlapFragments<TProperties extends Record<string, unknown>>(
  source: TopologyPolygonEntry<TProperties>,
  targets: Array<TopologyPolygonEntry<TProperties>>,
  edges: Array<TopologyOverlapEdge<TProperties>>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const partitions = createSplitGuidedPartitions(source, targets);

  return targets.map((target) => {
    const edge = edges.find((item) => item.target.key === target.key);
    const fromGeometry =
      partitions.get(target.key) ??
      edge?.overlapGeometry ??
      createCollapsedPolygonGeometry(getPolygonLikeCentroid(source.geometry));

    return {
      fromFeature: source.feature,
      fromGeometry,
      id: `split:${source.key}:${target.key}`,
      kind: "split" as const,
      overlapArea: edge?.area,
      overlapRatio: edge ? Math.max(edge.ratioOfSource, edge.ratioOfTarget) : undefined,
      sourceIds: [getEntryId(source)],
      targetIds: [getEntryId(target)],
      toFeature: target.feature,
      toGeometry: target.geometry,
    };
  });
}

function createMergeAreaOverlapFragments<TProperties extends Record<string, unknown>>(
  sources: Array<TopologyPolygonEntry<TProperties>>,
  target: TopologyPolygonEntry<TProperties>,
  edges: Array<TopologyOverlapEdge<TProperties>>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const partitions = createMergeGuidedPartitions(sources, target);

  return sources.map((source) => {
    const edge = edges.find((item) => item.source.key === source.key);
    const toGeometry =
      partitions.get(source.key) ??
      edge?.overlapGeometry ??
      createCollapsedPolygonGeometry(getPolygonLikeCentroid(target.geometry));

    return {
      fromFeature: source.feature,
      fromGeometry: source.geometry,
      id: `merge:${source.key}:${target.key}`,
      kind: "merge" as const,
      overlapArea: edge?.area,
      overlapRatio: edge ? Math.max(edge.ratioOfSource, edge.ratioOfTarget) : undefined,
      sourceIds: [getEntryId(source)],
      targetIds: [getEntryId(target)],
      toFeature: target.feature,
      toGeometry,
    };
  });
}

function createManyToManyAreaOverlapFragments<TProperties extends Record<string, unknown>>(
  sources: Array<TopologyPolygonEntry<TProperties>>,
  targets: Array<TopologyPolygonEntry<TProperties>>,
  edges: Array<TopologyOverlapEdge<TProperties>>,
  _sourceAreas: Map<string, number>,
  _targetAreas: Map<string, number>,
): Array<GeoJsonTransitionPlanFragment<TProperties>> {
  const selectedEdges: Array<TopologyOverlapEdge<TProperties>> = [];
  const selectedSourceKeys = new Set<string>();
  const selectedTargetKeys = new Set<string>();

  for (const edge of edges) {
    if (!selectedSourceKeys.has(edge.source.key) && !selectedTargetKeys.has(edge.target.key)) {
      selectedEdges.push(edge);
      selectedSourceKeys.add(edge.source.key);
      selectedTargetKeys.add(edge.target.key);
    }
  }

  const fragments: Array<GeoJsonTransitionPlanFragment<TProperties>> =
    selectedEdges.map(createPreserveFragment);

  for (const source of sources) {
    const selectedForSource = selectedEdges
      .filter((edge) => edge.source.key === source.key)
      .map((edge) => edge.overlapGeometry);
    const selectedUnion = unionPolygonLikes(selectedForSource);
    const residual = selectedUnion
      ? differencePolygonLike(source.geometry, selectedUnion)
      : source.geometry;

    if (residual && getPolygonLikeArea(residual) > 0) {
      fragments.push(createDisappearFragment(source, residual, `disappear:${source.key}:residual`));
    }
  }

  for (const target of targets) {
    const selectedForTarget = selectedEdges
      .filter((edge) => edge.target.key === target.key)
      .map((edge) => edge.overlapGeometry);
    const selectedUnion = unionPolygonLikes(selectedForTarget);
    const residual = selectedUnion
      ? differencePolygonLike(target.geometry, selectedUnion)
      : target.geometry;

    if (residual && getPolygonLikeArea(residual) > 0) {
      fragments.push(createAppearFragment(target, residual, `appear:${target.key}:residual`));
    }
  }

  return fragments;
}

function createPreserveFragment<TProperties extends Record<string, unknown>>(
  edge: TopologyOverlapEdge<TProperties>,
): GeoJsonTransitionPlanFragment<TProperties> {
  return {
    fromFeature: edge.source.feature,
    fromGeometry: edge.overlapGeometry,
    id: `preserve:${edge.source.key}:${edge.target.key}`,
    kind: "preserve",
    overlapArea: edge.area,
    overlapRatio: Math.max(edge.ratioOfSource, edge.ratioOfTarget),
    sourceIds: [getEntryId(edge.source)],
    targetIds: [getEntryId(edge.target)],
    toFeature: edge.target.feature,
    toGeometry: edge.overlapGeometry,
  };
}

function createAppearFragment<TProperties extends Record<string, unknown>>(
  target: TopologyPolygonEntry<TProperties>,
  geometry = target.geometry,
  id = `appear:${target.key}`,
): GeoJsonTransitionPlanFragment<TProperties> {
  return {
    fromGeometry: createCollapsedPolygonGeometry(getPolygonLikeCentroid(geometry)),
    id,
    kind: "appear",
    sourceIds: [],
    targetIds: [getEntryId(target)],
    toFeature: target.feature,
    toGeometry: geometry,
  };
}

function createDisappearFragment<TProperties extends Record<string, unknown>>(
  source: TopologyPolygonEntry<TProperties>,
  geometry = source.geometry,
  id = `disappear:${source.key}`,
): GeoJsonTransitionPlanFragment<TProperties> {
  return {
    fromFeature: source.feature,
    fromGeometry: geometry,
    id,
    kind: "disappear",
    sourceIds: [getEntryId(source)],
    targetIds: [],
    toGeometry: createCollapsedPolygonGeometry(getPolygonLikeCentroid(geometry)),
  };
}

function createSplitGuidedPartitions<TProperties extends Record<string, unknown>>(
  source: TopologyPolygonEntry<TProperties>,
  targets: Array<TopologyPolygonEntry<TProperties>>,
) {
  return createGuidedVoronoiPartitions(
    source.geometry,
    targets,
    [source.geometry, ...targets.map((target) => target.geometry)],
  );
}

function createMergeGuidedPartitions<TProperties extends Record<string, unknown>>(
  sources: Array<TopologyPolygonEntry<TProperties>>,
  target: TopologyPolygonEntry<TProperties>,
) {
  return createGuidedVoronoiPartitions(
    target.geometry,
    sources,
    [target.geometry, ...sources.map((source) => source.geometry)],
  );
}

function createGuidedVoronoiPartitions<TProperties extends Record<string, unknown>>(
  subject: PolygonLikeGeometry,
  seeds: Array<TopologyPolygonEntry<TProperties>>,
  guideItems: PolygonLikeGeometry[],
) {
  const guide = createConvexHullGuideGeometry(guideItems);
  const bounds = createExpandedTopologyBounds(
    guide ? [guide] : [subject, ...seeds.map((seed) => seed.geometry)],
  );
  const cells = createVoronoiCellRings(
    seeds.map((seed) => getPolygonLikeCentroid(seed.geometry)),
    bounds,
  );

  return new Map(
    seeds.flatMap((seed, index) => {
      const cell = cells[index];
      const partition = cell ? clipPolygonLikeToVoronoiCell(subject, cell) : null;

      return partition && getPolygonLikeArea(partition) > 0 ? [[seed.key, partition] as const] : [];
    }),
  );
}

function createConvexHullGuideGeometry(items: PolygonLikeGeometry[]): PolygonLikeGeometry | null {
  const positionsByKey = new Map<string, GeoJsonPosition>();

  for (const position of items.flatMap(getPolygonLikePositions)) {
    if (Number.isFinite(position[0]) && Number.isFinite(position[1])) {
      positionsByKey.set(`${position[0]}:${position[1]}`, [position[0], position[1]]);
    }
  }

  const positions = [...positionsByKey.values()].sort(
    (left, right) => left[0] - right[0] || left[1] - right[1],
  );

  if (positions.length < 3) {
    return unionPolygonLikes(items);
  }

  const lower: GeoJsonPosition[] = [];
  for (const position of positions) {
    while (
      lower.length >= 2 &&
      getCrossProduct(lower[lower.length - 2]!, lower[lower.length - 1]!, position) <= 0
    ) {
      lower.pop();
    }
    lower.push(position);
  }

  const upper: GeoJsonPosition[] = [];
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const position = positions[index]!;
    while (
      upper.length >= 2 &&
      getCrossProduct(upper[upper.length - 2]!, upper[upper.length - 1]!, position) <= 0
    ) {
      upper.pop();
    }
    upper.push(position);
  }

  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];

  return hull.length >= 3
    ? {
        coordinates: [closeRing(hull)],
        type: "Polygon",
      }
    : unionPolygonLikes(items);
}

function getCrossProduct(origin: GeoJsonPosition, left: GeoJsonPosition, right: GeoJsonPosition) {
  return (
    (left[0] - origin[0]) * (right[1] - origin[1]) -
    (left[1] - origin[1]) * (right[0] - origin[0])
  );
}

function groupEdgesByKey<TProperties extends Record<string, unknown>>(
  edges: Array<TopologyOverlapEdge<TProperties>>,
  getKey: (edge: TopologyOverlapEdge<TProperties>) => string,
) {
  const groups = new Map<string, Array<TopologyOverlapEdge<TProperties>>>();

  for (const edge of edges) {
    const key = getKey(edge);
    const group = groups.get(key);

    if (group) {
      group.push(edge);
    } else {
      groups.set(key, [edge]);
    }
  }

  return groups;
}

function collectTopologyComponent<TProperties extends Record<string, unknown>>(
  startKey: string,
  startIsSource: boolean,
  edgesBySource: Map<string, Array<TopologyOverlapEdge<TProperties>>>,
  edgesByTarget: Map<string, Array<TopologyOverlapEdge<TProperties>>>,
) {
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  const queue: Array<{ isSource: boolean; key: string }> = [{ isSource: startIsSource, key: startKey }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const seen = current.isSource ? sourceKeys : targetKeys;

    if (seen.has(current.key)) {
      continue;
    }

    seen.add(current.key);

    const edges = current.isSource
      ? edgesBySource.get(current.key) ?? []
      : edgesByTarget.get(current.key) ?? [];

    for (const edge of edges) {
      queue.push({ isSource: true, key: edge.source.key });
      queue.push({ isSource: false, key: edge.target.key });
    }
  }

  return { sourceKeys, targetKeys };
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
        ...(fragment.overlapArea === undefined ? {} : { overlapArea: fragment.overlapArea }),
        ...(fragment.overlapRatio === undefined ? {} : { overlapRatio: fragment.overlapRatio }),
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

function getEntryId<TProperties extends Record<string, unknown>>(
  entry: Pick<TopologyPolygonEntry<TProperties>, "feature" | "index" | "key">,
) {
  return entry.feature.id ?? entry.key ?? entry.index;
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
    topologyMinOverlapRatio:
      sanitizePositiveNumber(options.topologyMinOverlapRatio) ??
      DEFAULT_TRANSITION_OPTIONS.topologyMinOverlapRatio,
    topologyStrategy: options.topologyStrategy ?? DEFAULT_TRANSITION_OPTIONS.topologyStrategy,
  };
}

function sanitizePositiveInteger(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : undefined;
}

function sanitizePositiveNumber(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) >= 0 ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
