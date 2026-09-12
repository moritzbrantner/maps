"use client";

import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  startTransition,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type PointAggregationIndex,
  type ViewportAggregationQuery,
  type VisibleAggregationSummary,
} from "./aggregation";
import {
  createCanvasMapScene,
  drawCanvasMapScene,
  hitTestCanvasMapScene,
  type CanvasMapScene,
  type MapScreenPoint,
} from "./canvas-map-renderer";
import { ClusterLayer, type ClusterLayerProps } from "./cluster-layer";
import {
  GeoJsonLayer,
  createGeoJsonLayerFeatures,
  type GeoJsonLayerProps,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import { getGeometryCenter } from "./geojson-rendering";
import type { MapFeatureInteractionProps } from "./map-interaction";
import {
  createCircleVectorRenderFrame,
  createGeoJsonVectorRenderFrame,
  createPointClusterVectorRenderFrame,
  type MapVectorRenderFrame,
  type MapVectorRenderPrimitive,
} from "./map-render-frame";
import type { MapSurfaceContextValue } from "./map-surface-context";
import { createPointClusterRenderFrame } from "./point-cluster-render-frame";
import { PointLayer, createPointLayerFeatures, type PointLayerProps } from "./point-layer";

export type MapsProjectCoordinate = (
  coordinates: [longitude: number, latitude: number],
) => { x: number; y: number } | null;

export type MapsOverlayPick = {
  featureId: string;
  primitiveId: string;
};

export type MapsOverlayLayersController = {
  clearHover(): void;
  handleClickAtClientPoint(clientX: number, clientY: number): boolean;
  handleContextMenuAtClientPoint(clientX: number, clientY: number): boolean;
  handleHoverAtClientPoint(clientX: number, clientY: number): MapsOverlayPick | null;
  pickAtClientPoint(clientX: number, clientY: number): MapsOverlayPick | null;
};

type AnyRecord = Record<string, unknown>;
type MapsOverlayInteractionSurface = Pick<
  MapSurfaceContextValue,
  | "handleFeatureClick"
  | "handleFeatureContextMenu"
  | "handleFeatureHover"
  | "isFeatureHovered"
  | "isFeatureSelected"
  | "setViewState"
>;

type MapsOverlayLayersProps = {
  children: ReactNode;
  getViewport: (width: number, height: number) => ViewportAggregationQuery | null;
  project: MapsProjectCoordinate;
  surface: MapsOverlayInteractionSurface;
};

type MapsFeatureInteractionOptions<TFeature> = MapFeatureInteractionProps<TFeature> & {
  onFeatureSelect?: (feature: TFeature | null) => void;
};

type MapsOverlayInteraction = {
  clearHover(): void;
  click(position: MapScreenPoint): void;
  contextMenu(position: MapScreenPoint): void;
  featureId: string;
  hover(position: MapScreenPoint): void;
  key: string;
};

type MapsOverlaySnapshot = {
  frame: MapVectorRenderFrame<unknown>;
  hoveredPrimitiveIds: Set<string>;
  interactions: Map<string, MapsOverlayInteraction>;
  selectedPrimitiveIds: Set<string>;
};

type MutableMapsOverlaySnapshot = MapsOverlaySnapshot & {
  primitiveIds: Set<string>;
};

type MapsOverlayEntry =
  | {
      kind: "cluster";
      prefix: string;
      props: ClusterLayerProps<AnyRecord>;
      runtimeKey: string;
    }
  | {
      kind: "geojson";
      prefix: string;
      props: GeoJsonLayerProps<AnyRecord>;
    }
  | {
      kind: "point";
      prefix: string;
      props: PointLayerProps<AnyRecord>;
    };

type MapsClusterRuntime = {
  clusterRadius: ClusterLayerProps<AnyRecord>["clusterRadius"];
  filterPoint: ClusterLayerProps<AnyRecord>["filterPoint"];
  index: PointAggregationIndex<AnyRecord>;
  lastViewportSummaryKey: string | null;
  maxZoom: ClusterLayerProps<AnyRecord>["maxZoom"];
  minZoom: ClusterLayerProps<AnyRecord>["minZoom"];
  points: ClusterLayerProps<AnyRecord>["points"];
};

type InternalPick = {
  interaction: MapsOverlayInteraction;
  pick: MapsOverlayPick;
  position: MapScreenPoint;
};

export const MapsOverlayLayers = forwardRef<MapsOverlayLayersController, MapsOverlayLayersProps>(
  function MapsOverlayLayers({ children, getViewport, project, surface }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<CanvasMapScene<unknown> | null>(null);
    const renderedSnapshotRef = useRef<MapsOverlaySnapshot | null>(null);
    const lastHoveredInteractionRef = useRef<MapsOverlayInteraction | null>(null);
    const lastHoveredKeyRef = useRef<string | null>(null);
    const clusterRuntimesRef = useRef<Map<string, MapsClusterRuntime>>(new Map());
    const entries = useMemo(() => collectOverlayEntries(children), [children]);

    useEffect(() => {
      const previous = clusterRuntimesRef.current;
      const next = new Map<string, MapsClusterRuntime>();

      for (const entry of entries) {
        if (entry.kind !== "cluster") continue;
        const current = previous.get(entry.runtimeKey);
        if (current && clusterRuntimeMatches(current, entry.props)) {
          next.set(entry.runtimeKey, current);
          continue;
        }

        current?.index.dispose();
        next.set(entry.runtimeKey, createClusterRuntime(entry.props));
      }

      for (const [key, runtime] of previous) {
        if (!next.has(key)) runtime.index.dispose();
      }

      clusterRuntimesRef.current = next;
    }, [entries]);

    useEffect(() => {
      return () => {
        for (const runtime of clusterRuntimesRef.current.values()) runtime.index.dispose();
        clusterRuntimesRef.current.clear();
      };
    }, []);

    const clearHover = () => {
      const interaction = lastHoveredInteractionRef.current;
      if (interaction) interaction.clearHover();
      lastHoveredInteractionRef.current = null;
      lastHoveredKeyRef.current = null;
    };

    const pickInternal = (clientX: number, clientY: number): InternalPick | null => {
      const canvas = canvasRef.current;
      const scene = sceneRef.current;
      const renderedSnapshot = renderedSnapshotRef.current;
      if (!canvas || !scene || !renderedSnapshot) return null;

      const position = getClientCanvasPosition(canvas, clientX, clientY);
      const hit = hitTestCanvasMapScene(scene, position);
      if (!hit) return null;
      const primitive = hit.renderPrimitive;
      const interaction = renderedSnapshot.interactions.get(primitive.primitiveId);
      if (!interaction) return null;

      return {
        interaction,
        pick: {
          featureId: primitive.featureId,
          primitiveId: primitive.primitiveId,
        },
        position,
      };
    };

    useImperativeHandle(
      ref,
      () => ({
        clearHover,
        handleClickAtClientPoint(clientX, clientY) {
          const hit = pickInternal(clientX, clientY);
          if (!hit) return false;
          hit.interaction.click(hit.position);
          return true;
        },
        handleContextMenuAtClientPoint(clientX, clientY) {
          const hit = pickInternal(clientX, clientY);
          if (!hit) return false;
          hit.interaction.contextMenu(hit.position);
          return true;
        },
        handleHoverAtClientPoint(clientX, clientY) {
          const hit = pickInternal(clientX, clientY);
          if (!hit) {
            clearHover();
            return null;
          }

          const previousKey = lastHoveredKeyRef.current;
          if (previousKey && previousKey !== hit.interaction.key) {
            lastHoveredInteractionRef.current?.clearHover();
          }

          lastHoveredKeyRef.current = hit.interaction.key;
          lastHoveredInteractionRef.current = hit.interaction;
          hit.interaction.hover(hit.position);
          return hit.pick;
        },
        pickAtClientPoint(clientX, clientY) {
          return pickInternal(clientX, clientY)?.pick ?? null;
        },
      }),
      [],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        sceneRef.current = null;
        renderedSnapshotRef.current = null;
        return;
      }

      const draw = () => {
        const size = resizeCanvasBackingStore(canvas);
        const snapshot = createOverlaySnapshot(
          entries,
          surface,
          clusterRuntimesRef.current,
          getViewport(size.width, size.height),
        );
        const scene = createCanvasMapScene(snapshot.frame, project, size);
        sceneRef.current = scene;
        renderedSnapshotRef.current = snapshot;
        canvas.dataset.mapOverlayPrimitives = String(snapshot.frame.primitives.length);

        const context = getCanvasContext(canvas);
        if (!context) return;

        const ratio = Math.max(1, window.devicePixelRatio || 1);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawCanvasMapScene(context, scene, {
          hoveredPrimitiveIds: snapshot.hoveredPrimitiveIds,
          selectedPrimitiveIds: snapshot.selectedPrimitiveIds,
        });
      };

      draw();

      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(draw);
      observer.observe(canvas);
      return () => observer.disconnect();
    }, [entries, getViewport, project, surface]);

    useEffect(() => {
      return () => {
        const interaction = lastHoveredInteractionRef.current;
        lastHoveredInteractionRef.current = null;
        lastHoveredKeyRef.current = null;
        interaction?.clearHover();
      };
    }, []);

    if (entries.length === 0) return null;

    return (
      <canvas
        aria-hidden="true"
        data-map-overlay-backend="canvas2d"
        data-map-overlay-primitives="0"
        data-map-overlay-runtime="maps"
        ref={canvasRef}
        style={{
          height: "100%",
          inset: 0,
          pointerEvents: "none",
          position: "absolute",
          width: "100%",
          zIndex: 1,
        }}
      />
    );
  },
);

function collectOverlayEntries(children: ReactNode, path = "root", entries: MapsOverlayEntry[] = []) {
  Children.toArray(children).forEach((child, index) => {
    if (!isValidElement(child)) throwUnsupportedMapsLayer();

    const childPath = `${path}.${index}`;
    if (child.type === Fragment) {
      collectOverlayEntries((child.props as { children?: ReactNode }).children, childPath, entries);
      return;
    }

    if (child.type === PointLayer) {
      const props = child.props as PointLayerProps<AnyRecord>;
      entries.push({
        kind: "point",
        prefix: props.layerId ? `point:${props.layerId}` : resolveLayerPrefix("point", child.key, childPath),
        props,
      });
      return;
    }

    if (child.type === GeoJsonLayer) {
      const props = child.props as GeoJsonLayerProps<AnyRecord>;
      entries.push({
        kind: "geojson",
        prefix: props.layerId
          ? `geojson:${props.layerId}`
          : resolveLayerPrefix("geojson", child.key, childPath),
        props,
      });
      return;
    }

    if (child.type === ClusterLayer) {
      const props = child.props as ClusterLayerProps<AnyRecord>;
      entries.push({
        kind: "cluster",
        prefix: props.layerId
          ? `cluster:${props.layerId}`
          : resolveLayerPrefix("cluster", child.key, childPath),
        props,
        runtimeKey: childPath,
      });
      return;
    }

    throwUnsupportedMapsLayer();
  });

  return entries;
}

function createOverlaySnapshot(
  entries: readonly MapsOverlayEntry[],
  surface: MapsOverlayInteractionSurface,
  clusterRuntimes: ReadonlyMap<string, MapsClusterRuntime>,
  viewport: ViewportAggregationQuery | null,
): MapsOverlaySnapshot {
  const mutable: MutableMapsOverlaySnapshot = {
    frame: { kind: "vector", primitives: [] },
    hoveredPrimitiveIds: new Set(),
    interactions: new Map(),
    primitiveIds: new Set(),
    selectedPrimitiveIds: new Set(),
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case "point":
        appendPointLayer(entry.props, surface, mutable, entry.prefix);
        break;
      case "geojson":
        appendGeoJsonLayer(entry.props, surface, mutable, entry.prefix);
        break;
      case "cluster": {
        const runtime = clusterRuntimes.get(entry.runtimeKey);
        if (runtime && viewport) {
          appendClusterLayer(entry.props, surface, mutable, entry.prefix, runtime, viewport);
        }
        break;
      }
    }
  }

  return {
    frame: mutable.frame,
    hoveredPrimitiveIds: mutable.hoveredPrimitiveIds,
    interactions: mutable.interactions,
    selectedPrimitiveIds: mutable.selectedPrimitiveIds,
  };
}

function appendPointLayer(
  props: PointLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  prefix: string,
) {
  assertNoUnsupportedPointDrag(props);
  const features = createPointLayerFeatures(props.points, { filterPoint: props.filterPoint });
  const frame = createCircleVectorRenderFrame(features, {
    getCoordinates: (feature) => feature.coordinates,
    getFeatureId: (feature) => props.getFeatureId?.(feature) || feature.point.id,
    getFillColor: (feature) => props.getPointColor?.(feature) ?? props.pointColor ?? "#0f172a",
    getRadius: (feature) => props.getPointRadius?.(feature) ?? props.pointRadius ?? 6,
    primitivePrefix: prefix,
  });

  for (const primitive of frame.primitives) {
    const feature = primitive.feature;
    const resolveFeatureId = () => primitive.featureId;
    const hovered = surface.isFeatureHovered(feature, props.hoveredFeatureId, resolveFeatureId);
    const selected = surface.isFeatureSelected(feature, props.selectedFeatureId, resolveFeatureId);
    const interaction = createFeatureInteraction(
      `${prefix}|${primitive.featureId}`,
      feature,
      primitive.featureId,
      feature.coordinates,
      props,
      surface,
    );

    appendPrimitive(snapshot, primitive, interaction, hovered, selected);
  }
}

function appendGeoJsonLayer(
  props: GeoJsonLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  prefix: string,
) {
  const features = createGeoJsonLayerFeatures(props.featureCollection);
  const frame = createGeoJsonVectorRenderFrame(features, {
    getFeatureId: props.getFeatureId,
    getFeatureStyle: props.getFeatureStyle,
    isFeatureInteractive: props.isFeatureInteractive,
    primitivePrefix: prefix,
    style: compactStyle({
      lineColor: props.lineColor,
      lineOpacity: props.lineOpacity,
      lineWidth: props.lineWidth,
      pointColor: props.pointColor,
      pointRadius: props.pointRadius,
      polygonFillColor: props.polygonFillColor,
      polygonFillOpacity: props.polygonFillOpacity,
      polygonStrokeColor: props.polygonStrokeColor,
      polygonStrokeWidth: props.polygonStrokeWidth,
    }),
  });

  for (const primitive of frame.primitives) {
    const feature = primitive.feature;
    const resolveFeatureId = () => primitive.featureId;
    const hovered = surface.isFeatureHovered(feature, props.hoveredFeatureId, resolveFeatureId);
    const selected = surface.isFeatureSelected(feature, props.selectedFeatureId, resolveFeatureId);
    const interaction = primitive.interactive
      ? createFeatureInteraction(
          `${prefix}|${primitive.featureId}`,
          feature,
          primitive.featureId,
          getGeometryCenter(feature.geometry),
          props,
          surface,
        )
      : null;

    appendPrimitive(snapshot, primitive, interaction, hovered, selected);
  }
}

function appendClusterLayer(
  props: ClusterLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  prefix: string,
  runtime: MapsClusterRuntime,
  viewport: ViewportAggregationQuery,
) {
  const aggregation = runtime.index.getViewportAggregation(viewport);
  emitClusterViewportSummary(runtime, aggregation.summary, props.onViewportAggregationChange);
  const pointClusterFrame = createPointClusterRenderFrame(aggregation, props.getFeatureId);
  const frame = createPointClusterVectorRenderFrame(pointClusterFrame, { primitivePrefix: prefix });

  for (const primitive of frame.primitives) {
    const feature = primitive.feature;
    const hovered = surface.isFeatureHovered(feature, props.hoveredFeatureId, props.getFeatureId);
    const selected = surface.isFeatureSelected(feature, props.selectedFeatureId, props.getFeatureId);
    const interaction = createClusterFeatureInteraction(
      `${prefix}|${primitive.featureId}`,
      feature,
      primitive.featureId,
      props,
      surface,
    );

    appendPrimitive(snapshot, primitive, interaction, hovered, selected);
  }
}

function appendPrimitive<TFeature>(
  snapshot: MutableMapsOverlaySnapshot,
  primitive: MapVectorRenderPrimitive<TFeature>,
  interaction: MapsOverlayInteraction | null,
  hovered: boolean,
  selected: boolean,
) {
  if (snapshot.primitiveIds.has(primitive.primitiveId)) {
    throw new Error(`Duplicate Maps render primitive identity: ${primitive.primitiveId}`);
  }

  snapshot.primitiveIds.add(primitive.primitiveId);
  snapshot.frame.primitives.push(primitive as MapVectorRenderPrimitive<unknown>);
  if (interaction) snapshot.interactions.set(primitive.primitiveId, interaction);
  if (hovered) snapshot.hoveredPrimitiveIds.add(primitive.primitiveId);
  if (selected) snapshot.selectedPrimitiveIds.add(primitive.primitiveId);
}

function createFeatureInteraction<TFeature>(
  key: string,
  feature: TFeature,
  featureId: string,
  coordinates: [longitude: number, latitude: number],
  options: MapsFeatureInteractionOptions<TFeature>,
  surface: MapsOverlayInteractionSurface,
): MapsOverlayInteraction {
  const getFeatureId = () => featureId;

  return {
    clearHover() {
      surface.handleFeatureHover(null, null, {
        getFeatureId,
        onFeatureHover: options.onFeatureHover,
        onHoveredFeatureIdChange: options.onHoveredFeatureIdChange,
        renderFeatureTooltip: options.renderFeatureTooltip,
      });
    },
    click(position) {
      surface.handleFeatureClick(feature, position, {
        getFeatureId,
        onFeatureSelect: options.onFeatureSelect,
        onSelectedFeatureIdChange: options.onSelectedFeatureIdChange,
        renderFeaturePopup: options.renderFeaturePopup,
      });
    },
    contextMenu(position) {
      surface.handleFeatureContextMenu(feature, position, {
        coordinates,
        getFeatureId,
        onFeatureContextMenu: options.onFeatureContextMenu,
        onFeatureSelect: options.onFeatureSelect,
        onSelectedFeatureIdChange: options.onSelectedFeatureIdChange,
        renderFeatureContextMenu: options.renderFeatureContextMenu,
        renderFeaturePopup: options.renderFeaturePopup,
      });
    },
    featureId,
    hover(position) {
      surface.handleFeatureHover(feature, position, {
        getFeatureId,
        onFeatureHover: options.onFeatureHover,
        onHoveredFeatureIdChange: options.onHoveredFeatureIdChange,
        renderFeatureTooltip: options.renderFeatureTooltip,
      });
    },
    key,
  };
}

function createClusterFeatureInteraction(
  key: string,
  feature: AggregatedMapFeature<AnyRecord>,
  rendererFeatureId: string,
  options: ClusterLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
): MapsOverlayInteraction {
  const interactionOptions = {
    getFeatureId: options.getFeatureId,
    onFeatureContextMenu: options.onFeatureContextMenu,
    onFeatureHover: options.onFeatureHover,
    onFeatureSelect: options.onFeatureSelect,
    onHoveredFeatureIdChange: options.onHoveredFeatureIdChange,
    onSelectedFeatureIdChange: options.onSelectedFeatureIdChange,
    renderFeatureContextMenu: options.renderFeatureContextMenu,
    renderFeaturePopup: options.renderFeaturePopup,
    renderFeatureTooltip: options.renderFeatureTooltip,
  };

  return {
    clearHover() {
      surface.handleFeatureHover(null, null, interactionOptions);
    },
    click(position) {
      if (feature.kind === "cluster") {
        surface.setViewState(
          { center: feature.coordinates, zoom: feature.expansionZoom },
          "cluster-expand",
        );
      }
      surface.handleFeatureClick(feature, position, interactionOptions);
    },
    contextMenu(position) {
      surface.handleFeatureContextMenu(feature, position, {
        ...interactionOptions,
        coordinates: feature.coordinates,
      });
    },
    featureId: rendererFeatureId,
    hover(position) {
      surface.handleFeatureHover(feature, position, interactionOptions);
    },
    key,
  };
}

function createClusterRuntime(props: ClusterLayerProps<AnyRecord>): MapsClusterRuntime {
  return {
    clusterRadius: props.clusterRadius,
    filterPoint: props.filterPoint,
    index: createPointAggregationIndex(props.points, {
      filterPoint: props.filterPoint,
      maxZoom: props.maxZoom,
      minZoom: props.minZoom,
      radius: props.clusterRadius,
    }),
    lastViewportSummaryKey: null,
    maxZoom: props.maxZoom,
    minZoom: props.minZoom,
    points: props.points,
  };
}

function clusterRuntimeMatches(runtime: MapsClusterRuntime, props: ClusterLayerProps<AnyRecord>) {
  return (
    runtime.points === props.points &&
    runtime.filterPoint === props.filterPoint &&
    runtime.clusterRadius === props.clusterRadius &&
    runtime.maxZoom === props.maxZoom &&
    runtime.minZoom === props.minZoom
  );
}

function emitClusterViewportSummary(
  runtime: MapsClusterRuntime,
  summary: VisibleAggregationSummary,
  onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void,
) {
  const key = serializeVisibleAggregationSummary(summary);
  if (runtime.lastViewportSummaryKey === key) return;

  runtime.lastViewportSummaryKey = key;
  startTransition(() => onViewportAggregationChange?.(summary));
}

function serializeVisibleAggregationSummary(summary: VisibleAggregationSummary) {
  return JSON.stringify({
    bounds: summary.bounds.map((value) => Number(value.toFixed(6))),
    metrics: Object.entries(summary.metrics)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, Number(value.toFixed(6))]),
    visibleClusterCount: summary.visibleClusterCount,
    visiblePointCount: summary.visiblePointCount,
    visibleUnclusteredCount: summary.visibleUnclusteredCount,
    zoom: Number(summary.zoom.toFixed(6)),
  });
}

function resolveLayerPrefix(kind: string, key: string | null, path: string) {
  return `${kind}:${key ?? path}`;
}

function getClientCanvasPosition(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: clientX - bounds.left,
    y: clientY - bounds.top,
  };
}

function resizeCanvasBackingStore(canvas: HTMLCanvasElement) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width || canvas.clientWidth || 1));
  const height = Math.max(1, Math.round(bounds.height || canvas.clientHeight || 1));
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.max(1, Math.round(width * ratio));
  const backingHeight = Math.max(1, Math.round(height * ratio));

  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;

  return { height, width };
}

function getCanvasContext(canvas: HTMLCanvasElement) {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

function compactStyle(style: GeoJsonLayerStyle): GeoJsonLayerStyle {
  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined),
  ) as GeoJsonLayerStyle;
}

function assertNoUnsupportedPointDrag(
  props: Pick<PointLayerProps<AnyRecord>, "draggable" | "onFeatureDrag" | "onFeatureDragEnd">,
) {
  if (props.draggable || props.onFeatureDrag || props.onFeatureDragEnd) {
    throw new Error(
      'flatRuntime="maps" does not support draggable PointLayer features yet; drag/edit contracts remain explicit until a Maps-owned editing slice lands.',
    );
  }
}

function throwUnsupportedMapsLayer(): never {
  throw new Error(
    'flatRuntime="maps" currently supports PointLayer, GeoJsonLayer, and ClusterLayer only; other map layer types remain explicitly MapLibre-backed.',
  );
}
