"use client";

import { useMemo } from "react";

import {
  TimelineEditor,
  getTimelineEditorItemTransformValuesAt,
  normalizeTimelineEditorDocument,
  setTimelineEditorItemTransform,
  type TimelineEditorDocument,
  type TimelineEditorItem,
  type TimelineEditorSelection,
  type TimelineEditorSnapOptions,
  type TimelineEditorTrack,
  type TimelineEditorTransform,
  type TimelineEditorTransformValues,
  type TimelineEditorViewport,
} from "@moritzbrantner/timeline-editor";

import { joinClassNames } from "./map-display";
import {
  createGeoJsonTransitionPlan,
  interpolateGeoJsonTransitionPlan,
  type GeoJsonTransitionAlgorithm,
  type GeoJsonTransitionOptions,
} from "./geojson-transition";
import { cloneGeometry, normalizeSupportedGeometry } from "./temporal-geojson-geometry";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonTimelineTransformValues = TimelineEditorTransformValues & {
  latitudeOffset: number;
  longitudeOffset: number;
  originLatitude: number;
  originLongitude: number;
  rotateDegrees: number;
  scale: number;
  scaleX: number;
  scaleY: number;
};

export type GeoJsonTimelineTrackData = {
  featureId?: string;
  kind: "geojson-feature" | "geojson-features";
};

export type GeoJsonTimelineItemData<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  featureId: string;
  featureIndex: number;
  kind: "geojson-feature";
  properties?: TProperties | null;
};

export type GeoJsonTimelineDocument<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = TimelineEditorDocument<
  GeoJsonTimelineTrackData,
  GeoJsonTimelineItemData<TProperties>,
  Record<string, unknown>,
  GeoJsonTimelineTransformValues
>;

export type GeoJsonTimelineOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  currentTimeMs?: number;
  durationMs?: number;
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string;
  getFeatureLabel?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => string | undefined;
  getFeatureTransform?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => TimelineEditorTransform<GeoJsonTimelineTransformValues> | undefined;
  getTimelineTrackId?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => string | undefined;
  getItemDurationMs?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => number | undefined;
  getItemStartMs?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => number | undefined;
  itemDurationMs?: number;
  trackMode?: "per-feature" | "single";
};

export type GeoJsonTimelineApplyOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string;
  outsideItemBehavior?: "none" | "hold";
};

export type GeoJsonTimelineTransitionSpec = GeoJsonTransitionOptions & {
  durationMs?: number;
};

export type GeoJsonTimelineSceneOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = GeoJsonTimelineApplyOptions<TProperties> & {
  defaultTransition?: GeoJsonTimelineTransitionSpec;
  getSceneTransition?: (
    previous: Array<
      TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
    >,
    next: Array<
      TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
    >,
  ) => GeoJsonTimelineTransitionSpec | undefined;
  getTransition?: (
    previous: TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>,
    next: TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>,
  ) => GeoJsonTimelineTransitionSpec | undefined;
};

type GeoJsonTimelineScene<TProperties extends Record<string, unknown>> = {
  endMs: number;
  items: Array<
    TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
  >;
  startMs: number;
};

export type GeoJsonTimelineEditorProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  className?: string;
  document: GeoJsonTimelineDocument<TProperties>;
  frameRate?: number;
  onCurrentTimeChange?: (timeMs: number) => void;
  onDocumentChange?: (document: GeoJsonTimelineDocument<TProperties>) => void;
  onSelectionChange?: (selection: TimelineEditorSelection) => void;
  onViewportChange?: (viewport: TimelineEditorViewport) => void;
  readOnly?: boolean;
  selectedFeatureId?: string | null;
  selection?: TimelineEditorSelection;
  snap?: Partial<TimelineEditorSnapOptions>;
  viewport?: TimelineEditorViewport;
};

const SINGLE_TRACK_ID = "geojson-features";
const DEFAULT_DURATION_MS = 10_000;

export function GeoJsonTimelineEditor<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  className,
  document,
  frameRate,
  onCurrentTimeChange,
  onDocumentChange,
  onSelectionChange,
  onViewportChange,
  readOnly,
  selectedFeatureId,
  selection,
  snap,
  viewport,
}: GeoJsonTimelineEditorProps<TProperties>) {
  const resolvedSelection = useMemo(
    () =>
      selection ??
      (selectedFeatureId
        ? { itemIds: [getGeoJsonTimelineItemId(selectedFeatureId)] }
        : { itemIds: [] }),
    [selectedFeatureId, selection],
  );

  return (
    <div className={joinClassNames("mb-geojson-timeline", className)}>
      <TimelineEditor
        className="mb-geojson-timeline__editor"
        document={document}
        frameRate={frameRate}
        readOnly={readOnly}
        selection={resolvedSelection}
        snap={snap}
        viewport={viewport}
        onCurrentTimeChange={onCurrentTimeChange}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        onViewportChange={onViewportChange}
        renderItem={({ item }) => (
          <span className="mb-geojson-timeline__item-label">{item.label}</span>
        )}
      />
    </div>
  );
}

export function createGeoJsonTimelineDocument<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  options: GeoJsonTimelineOptions<TProperties> = {},
): GeoJsonTimelineDocument<TProperties> {
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const itemDurationMs = Math.max(100, options.itemDurationMs ?? durationMs);
  const trackMode = options.trackMode ?? "per-feature";
  const items: Array<
    TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
  > = collection.features.map((feature, index) => {
    const featureId = resolveTimelineFeatureId(feature, index, options.getFeatureId);
    const startMs =
      options.getItemStartMs?.(feature, index) ?? readNumericProperty(feature, "startMs") ?? 0;
    const duration =
      options.getItemDurationMs?.(feature, index) ??
      readNumericProperty(feature, "durationMs") ??
      itemDurationMs;

    return {
      color: readStringProperty(feature, "color") ?? "#0f766e",
      data: {
        featureId,
        featureIndex: index,
        kind: "geojson-feature" as const,
        properties: feature.properties ?? null,
      },
      durationMs: Math.max(100, duration),
      id: getGeoJsonTimelineItemId(featureId),
      kind: "geojson-feature",
      label: options.getFeatureLabel?.(feature, index) ?? readFeatureLabel(feature, featureId),
      startMs,
      trackId:
        trackMode === "single"
          ? SINGLE_TRACK_ID
          : options.getTimelineTrackId?.(feature, index) ?? getGeoJsonTimelineTrackId(featureId),
      transform:
        options.getFeatureTransform?.(feature, index) ??
        readTimelineTransform(feature.properties?.timelineTransform),
    };
  });
  const tracks: Array<
    TimelineEditorTrack<
      GeoJsonTimelineTrackData,
      GeoJsonTimelineItemData<TProperties>,
      GeoJsonTimelineTransformValues
    >
  > =
    trackMode === "single"
      ? [
          {
            data: { kind: "geojson-features" as const },
            id: SINGLE_TRACK_ID,
            items,
            label: "GeoJSON features",
          },
        ]
      : createGeoJsonTimelineTracks(items);

  return normalizeTimelineEditorDocument(
    {
      currentTimeMs: options.currentTimeMs ?? 0,
      durationMs,
      tracks,
    } satisfies GeoJsonTimelineDocument<TProperties>,
    { durationMs },
  );
}

export function setGeoJsonTimelineFeatureTransform<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  document: GeoJsonTimelineDocument<TProperties>,
  featureId: string,
  transform: TimelineEditorTransform<GeoJsonTimelineTransformValues> | undefined,
): GeoJsonTimelineDocument<TProperties> {
  return {
    ...document,
    tracks: setTimelineEditorItemTransform(
      document.tracks,
      getGeoJsonTimelineItemId(featureId),
      transform,
      { durationMs: document.durationMs },
    ),
  };
}

function createGeoJsonTimelineTracks<TProperties extends Record<string, unknown>>(
  items: Array<
    TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
  >,
): Array<
  TimelineEditorTrack<
    GeoJsonTimelineTrackData,
    GeoJsonTimelineItemData<TProperties>,
    GeoJsonTimelineTransformValues
  >
> {
  const tracksById = new Map<
    string,
    TimelineEditorTrack<
      GeoJsonTimelineTrackData,
      GeoJsonTimelineItemData<TProperties>,
      GeoJsonTimelineTransformValues
    >
  >();

  for (const item of items) {
    const track = tracksById.get(item.trackId);

    if (track) {
      track.items.push(item);
      continue;
    }

    tracksById.set(item.trackId, {
      data: {
        featureId: item.data?.featureId ?? getFeatureIdFromTimelineItemId(item.id),
        kind: "geojson-feature" as const,
      },
      id: item.trackId,
      items: [item],
      label: item.label,
    });
  }

  return [...tracksById.values()];
}

export function getGeoJsonTimelineFeatureCollectionAtTime<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  document: GeoJsonTimelineDocument<TProperties>,
  timeMs: number,
  options: GeoJsonTimelineApplyOptions<TProperties> = {},
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  const itemsByFeatureId = new Map(
    document.tracks
      .flatMap((track) => track.items)
      .map((item) => [item.data?.featureId ?? getFeatureIdFromTimelineItemId(item.id), item]),
  );

  return {
    ...collection,
    features: collection.features.map((feature, index) => {
      const featureId = resolveTimelineFeatureId(feature, index, options.getFeatureId);
      const item = itemsByFeatureId.get(featureId);
      const geometry = normalizeSupportedGeometry(feature.geometry);

      if (!item || !geometry) {
        return cloneTimelineFeature(feature);
      }

      const active = timeMs >= item.startMs && timeMs <= item.startMs + item.durationMs;

      if (!active && options.outsideItemBehavior !== "hold") {
        return cloneTimelineFeature(feature);
      }

      const sampleTime = active
        ? timeMs
        : timeMs < item.startMs
          ? item.startMs
          : item.startMs + item.durationMs;
      const values = getTimelineEditorItemTransformValuesAt(item, sampleTime);

      return {
        ...cloneTimelineFeature(feature),
        geometry: applyGeoJsonTimelineTransform(geometry, values),
      };
    }),
  };
}

export function getGeoJsonTimelineSceneAtTime<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  document: GeoJsonTimelineDocument<TProperties>,
  timeMs: number,
  options: GeoJsonTimelineSceneOptions<TProperties> = {},
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  const outputFeatures = document.tracks.flatMap((track) =>
    getGeoJsonTimelineTrackFeaturesAtTime(collection, track.items, timeMs, options),
  );

  return {
    ...collection,
    features: outputFeatures,
  };
}

function getGeoJsonTimelineTrackFeaturesAtTime<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  items: Array<
    TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
  >,
  timeMs: number,
  options: GeoJsonTimelineSceneOptions<TProperties>,
): Array<TemporalGeoJsonGeometryFeature<TProperties>> {
  const scenes = createTimelineScenes(items);
  const transition = findActiveTimelineTransition(scenes, timeMs, options);

  if (transition) {
    const transitionSpec = transition.spec ?? {};
    const previousFeatures = getTransformedFeaturesForTimelineScene(
      collection,
      transition.previous,
      timeMs,
      options,
    );
    const nextFeatures = getTransformedFeaturesForTimelineScene(
      collection,
      transition.next,
      timeMs,
      options,
    );

    if (previousFeatures.length === 0 && nextFeatures.length === 0) {
      return [];
    }

    return [
      ...interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(
          { features: previousFeatures, type: "FeatureCollection" },
          { features: nextFeatures, type: "FeatureCollection" },
          {
            ...getTransitionOptionsWithoutDuration(transitionSpec),
            algorithm:
              transitionSpec.algorithm ??
              getDefaultSceneTransitionAlgorithm(previousFeatures, nextFeatures),
          },
        ),
        transition.progress,
      ).features,
    ];
  }

  const activeScene = findActiveTimelineScene(scenes, timeMs, options.outsideItemBehavior);

  return activeScene
    ? getTransformedFeaturesForTimelineScene(collection, activeScene, timeMs, options)
    : [];
}

function findActiveTimelineTransition<TProperties extends Record<string, unknown>>(
  scenes: Array<GeoJsonTimelineScene<TProperties>>,
  timeMs: number,
  options: GeoJsonTimelineSceneOptions<TProperties>,
) {
  for (let index = 0; index < scenes.length - 1; index += 1) {
    const previous = scenes[index]!;
    const next = scenes[index + 1]!;
    const spec = resolveTimelineTransitionSpec(previous, next, options);
    const durationMs = Math.max(0, spec?.durationMs ?? 0);

    if (durationMs <= 0) {
      continue;
    }

    const transitionEndMs = previous.endMs;
    const transitionStartMs = transitionEndMs - durationMs;

    if (timeMs <= transitionStartMs || timeMs >= transitionEndMs) {
      continue;
    }

    return {
      next,
      previous,
      progress: (timeMs - transitionStartMs) / durationMs,
      spec,
    };
  }

  return null;
}

function createTimelineScenes<TProperties extends Record<string, unknown>>(
  items: Array<
    TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>
  >,
): Array<GeoJsonTimelineScene<TProperties>> {
  const scenes: Array<GeoJsonTimelineScene<TProperties>> = [];
  const sortedItems = [...items].sort((left, right) => {
    const leftEndMs = left.startMs + left.durationMs;
    const rightEndMs = right.startMs + right.durationMs;

    return left.startMs - right.startMs || leftEndMs - rightEndMs || left.id.localeCompare(right.id);
  });

  for (const item of sortedItems) {
    const endMs = item.startMs + item.durationMs;
    const activeScene = scenes.at(-1);

    if (activeScene && activeScene.startMs === item.startMs && activeScene.endMs === endMs) {
      activeScene.items.push(item);
      continue;
    }

    scenes.push({
      endMs,
      items: [item],
      startMs: item.startMs,
    });
  }

  return scenes;
}

function resolveTimelineTransitionSpec<TProperties extends Record<string, unknown>>(
  previous: GeoJsonTimelineScene<TProperties>,
  next: GeoJsonTimelineScene<TProperties>,
  options: GeoJsonTimelineSceneOptions<TProperties>,
) {
  const firstPreviousItem = previous.items[0];
  const firstNextItem = next.items[0];

  return (
    options.getSceneTransition?.(previous.items, next.items) ??
    (firstPreviousItem && firstNextItem
      ? options.getTransition?.(firstPreviousItem, firstNextItem)
      : undefined) ??
    options.defaultTransition
  );
}

function findActiveTimelineScene<TProperties extends Record<string, unknown>>(
  scenes: Array<GeoJsonTimelineScene<TProperties>>,
  timeMs: number,
  outsideItemBehavior: "none" | "hold" | undefined,
) {
  const active = scenes.find(
    (scene, index) =>
      timeMs >= scene.startMs && (timeMs < scene.endMs || (index === scenes.length - 1 && timeMs <= scene.endMs)),
  );

  if (active || outsideItemBehavior !== "hold") {
    return active;
  }

  return (
    [...scenes]
      .reverse()
      .find((scene) => scene.endMs < timeMs) ??
    scenes.find((scene) => scene.startMs > timeMs)
  );
}

function getTransformedFeaturesForTimelineScene<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  scene: GeoJsonTimelineScene<TProperties>,
  timeMs: number,
  options: GeoJsonTimelineSceneOptions<TProperties>,
): Array<TemporalGeoJsonGeometryFeature<TProperties>> {
  return scene.items.flatMap((item) => {
    const feature = getTransformedFeatureForTimelineItem(collection, item, timeMs, options);

    return feature ? [feature] : [];
  });
}

function getTransformedFeatureForTimelineItem<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  item: TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>,
  timeMs: number,
  options: GeoJsonTimelineSceneOptions<TProperties>,
): TemporalGeoJsonGeometryFeature<TProperties> | null {
  const feature = getFeatureForTimelineItem(collection, item, options);
  const geometry = feature ? normalizeSupportedGeometry(feature.geometry) : null;

  if (!feature || !geometry) {
    return null;
  }

  const sampleTime = Math.min(Math.max(timeMs, item.startMs), item.startMs + item.durationMs);
  const values = getTimelineEditorItemTransformValuesAt(item, sampleTime);

  return {
    ...cloneTimelineFeature(feature),
    geometry: applyGeoJsonTimelineTransform(geometry, values),
  };
}

function getFeatureForTimelineItem<TProperties extends Record<string, unknown>>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  item: TimelineEditorItem<GeoJsonTimelineItemData<TProperties>, GeoJsonTimelineTransformValues>,
  options: GeoJsonTimelineSceneOptions<TProperties>,
) {
  if (typeof item.data?.featureIndex === "number") {
    const feature = collection.features[item.data.featureIndex];

    if (feature) {
      return feature;
    }
  }

  const itemFeatureId = item.data?.featureId ?? getFeatureIdFromTimelineItemId(item.id);

  return collection.features.find(
    (feature, index) => resolveTimelineFeatureId(feature, index, options.getFeatureId) === itemFeatureId,
  );
}

function getDefaultSceneTransitionAlgorithm<TProperties extends Record<string, unknown>>(
  previousFeatures: Array<TemporalGeoJsonGeometryFeature<TProperties>>,
  nextFeatures: Array<TemporalGeoJsonGeometryFeature<TProperties>>,
): GeoJsonTransitionAlgorithm {
  const previousPolygonCount = countPolygonLikeFeatures(previousFeatures);
  const nextPolygonCount = countPolygonLikeFeatures(nextFeatures);

  if (
    (previousPolygonCount > 0 || nextPolygonCount > 0) &&
    previousPolygonCount !== nextPolygonCount
  ) {
    return "topology-plan";
  }

  return getDefaultTransitionAlgorithm(previousFeatures[0]?.geometry ?? nextFeatures[0]?.geometry ?? null);
}

function countPolygonLikeFeatures<TProperties extends Record<string, unknown>>(
  features: Array<TemporalGeoJsonGeometryFeature<TProperties>>,
) {
  return features.filter((feature) => {
    const geometry = normalizeSupportedGeometry(feature.geometry);

    return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
  }).length;
}

function getDefaultTransitionAlgorithm(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): GeoJsonTransitionAlgorithm {
  const normalized = normalizeSupportedGeometry(geometry);

  if (!normalized) {
    return "hold";
  }

  return normalized.type === "Polygon" || normalized.type === "MultiPolygon"
    ? "vertex-union"
    : "resample";
}

function getTransitionOptionsWithoutDuration(
  spec: GeoJsonTimelineTransitionSpec,
): GeoJsonTransitionOptions {
  const { durationMs: _durationMs, ...options } = spec;

  return options;
}

export function applyGeoJsonTimelineTransform(
  geometry: TemporalGeoJsonSupportedGeometry,
  values: Partial<GeoJsonTimelineTransformValues>,
): TemporalGeoJsonSupportedGeometry {
  if (!hasTimelineTransform(values)) {
    return cloneGeometry(geometry);
  }

  const origin = getTransformOrigin(geometry, values);

  switch (geometry.type) {
    case "Point":
      return {
        coordinates: transformPosition(geometry.coordinates, values, origin),
        type: "Point",
      };
    case "MultiPoint":
      return {
        coordinates: geometry.coordinates.map((position) =>
          transformPosition(position, values, origin),
        ),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: geometry.coordinates.map((position) =>
          transformPosition(position, values, origin),
        ),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line) =>
          line.map((position) => transformPosition(position, values, origin)),
        ),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring) =>
          ring.map((position) => transformPosition(position, values, origin)),
        ),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) =>
            ring.map((position) => transformPosition(position, values, origin)),
          ),
        ),
        type: "MultiPolygon",
      };
  }
}

export function getGeoJsonTimelineItemId(featureId: string) {
  return `geojson-feature:${featureId}`;
}

export function getGeoJsonTimelineTrackId(featureId: string) {
  return `geojson-feature-track:${featureId}`;
}

function resolveTimelineFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string,
) {
  return String(getFeatureId?.(feature, index) ?? feature.id ?? `feature-${index}`);
}

function getFeatureIdFromTimelineItemId(itemId: string) {
  return itemId.startsWith("geojson-feature:") ? itemId.slice("geojson-feature:".length) : itemId;
}

function readFeatureLabel<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  featureId: string,
) {
  return (
    readStringProperty(feature, "label") ??
    readStringProperty(feature, "name") ??
    String(feature.id ?? featureId)
  );
}

function readStringProperty<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  key: string,
) {
  const value = feature.properties?.[key];

  return typeof value === "string" ? value : undefined;
}

function readNumericProperty<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  key: string,
) {
  const value = feature.properties?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimelineTransform(
  value: unknown,
): TimelineEditorTransform<GeoJsonTimelineTransformValues> | undefined {
  if (!isRecord(value) || !Array.isArray(value.points)) {
    return undefined;
  }

  return {
    data: isRecord(value.data) ? { ...value.data } : undefined,
    points: value.points.flatMap((point) => {
      if (!isRecord(point) || !isRecord(point.values)) {
        return [];
      }

      const offsetMs = point.offsetMs;

      if (typeof offsetMs !== "number" || !Number.isFinite(offsetMs)) {
        return [];
      }

      return [
        {
          easing: typeof point.easing === "string" ? point.easing : undefined,
          offsetMs,
          values: filterNumericValues(point.values),
        },
      ];
    }),
  } as TimelineEditorTransform<GeoJsonTimelineTransformValues>;
}

function filterNumericValues(values: Record<string, unknown>) {
  const numericValues: Record<string, number> = {};

  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numericValues[key] = value;
    }
  }

  return numericValues;
}

function hasTimelineTransform(values: Partial<GeoJsonTimelineTransformValues>) {
  return Object.values(values).some((value) => typeof value === "number" && Number.isFinite(value));
}

function transformPosition(
  position: GeoJsonPosition,
  values: Partial<GeoJsonTimelineTransformValues>,
  origin: GeoJsonPosition,
): GeoJsonPosition {
  const longitudeOffset = values.longitudeOffset ?? 0;
  const latitudeOffset = values.latitudeOffset ?? 0;
  const scale = values.scale ?? 1;
  const scaleX = values.scaleX ?? scale;
  const scaleY = values.scaleY ?? scale;
  const rotation = ((values.rotateDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const x = (position[0] - origin[0]) * scaleX;
  const y = (position[1] - origin[1]) * scaleY;

  return [
    origin[0] + x * cos - y * sin + longitudeOffset,
    origin[1] + x * sin + y * cos + latitudeOffset,
  ];
}

function getTransformOrigin(
  geometry: TemporalGeoJsonSupportedGeometry,
  values: Partial<GeoJsonTimelineTransformValues>,
): GeoJsonPosition {
  if (
    typeof values.originLongitude === "number" &&
    Number.isFinite(values.originLongitude) &&
    typeof values.originLatitude === "number" &&
    Number.isFinite(values.originLatitude)
  ) {
    return [values.originLongitude, values.originLatitude];
  }

  const positions = getGeometryPositions(geometry);
  const bounds = positions.reduce(
    (current, position) => ({
      east: Math.max(current.east, position[0]),
      north: Math.max(current.north, position[1]),
      south: Math.min(current.south, position[1]),
      west: Math.min(current.west, position[0]),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );

  return [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
}

function getGeometryPositions(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return [...geometry.coordinates];
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
}

function cloneTimelineFeature<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
): TemporalGeoJsonGeometryFeature<TProperties> {
  const geometry = normalizeSupportedGeometry(feature.geometry);

  return {
    ...feature,
    geometry: geometry ? cloneGeometry(geometry) : feature.geometry,
    properties: feature.properties ? { ...feature.properties } : feature.properties,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
