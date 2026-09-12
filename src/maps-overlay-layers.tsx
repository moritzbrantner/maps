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
  useState,
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
import {
  createPointClusterRenderFrame,
  type MapPointClusterRenderFrame,
} from "./point-cluster-render-frame";
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
  | "viewState"
>;

type MapsOverlayLayersProps = {
  children: ReactNode;
  getViewportAggregationQuery: () => ViewportAggregationQuery | null;
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

type PointLayerDescriptor = {
  kind: "point";
  prefix: string;
  props: PointLayerProps<AnyRecord>;
};

type GeoJsonLayerDescriptor = {
  kind: "geojson";
  prefix: string;
  props: GeoJsonLayerProps<AnyRecord>;
};

type ClusterLayerDescriptor = {
  kind: "cluster";
  prefix: string;
  props: ClusterLayerProps<AnyRecord>;
};

type MapsLayerDescriptor = PointLayerDescriptor | GeoJsonLayerDescriptor | ClusterLayerDescriptor;

type ClusterIndexEntry = {
  clusterRadius: ClusterLayerProps<AnyRecord>["clusterRadius"];
  filterPoint: ClusterLayerProps<AnyRecord>["filterPoint"];
  index: PointAggregationIndex<AnyRecord>;
  lastSummaryKey: string | null;
  maxZoom: ClusterLayerProps<AnyRecord>["maxZoom"];
  minZoom: ClusterLayerProps<AnyRecord>["minZoom"];
  onViewportAggregationChange: ClusterLayerProps<AnyRecord>["onViewportAggregationChange"];
  points: ClusterLayerProps<AnyRecord>["points"];
};

type InternalPick = {
  interaction: MapsOverlayInteraction;
  pick: MapsOverlayPick;
  position: MapScreenPoint;
};

export const MapsOverlayLayers = forwardRef<MapsOverlayLayersController, MapsOverlayLayersProps>(
  function MapsOverlayLayers(
    { children, getViewportAggregationQuery, project, surface },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<CanvasMapScene<unknown> | null>(null);
    const renderedSnapshotRef = useRef<MapsOverlaySnapshot | null>(null);
    const lastHoveredInteractionRef = useRef<MapsOverlayInteraction | null>(null);
    const lastHoveredKeyRef = useRef<string | null>(null);
    const [resizeVersion, setResizeVersion] = useState(0);
    const descriptors = useMemo(() => describeChildren(children), [children]);
    const clusterDescriptors = useMemo(
      () => descriptors.filter(isClusterLayerDescriptor),
      [descriptors],
    );
    const clusterFrames = useClusterRenderFrames(
      clusterDescriptors,
      getViewportAggregationQuery,
      resizeVersion,
      surface.viewState,
    );
    const snapshot = useMemo(
      () => createOverlaySnapshot(descriptors, clusterFrames, surface),
      [clusterFrames, descriptors, surface],
    );

    const clearHover = () => {
      const interaction = lastHoveredInteractionRef.current;
      if (interaction) {
        interaction.clearHover();
      }
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

      const size = resizeCanvasBackingStore(canvas);
      const scene = createCanvasMapScene(snapshot.frame, project, size);
      sceneRef.current = scene;
      renderedSnapshotRef.current = snapshot;

      const context = getCanvasContext(canvas);
      if (!context) return;

      const ratio = Math.max(1, window.devicePixelRatio || 1);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawCanvasMapScene(context, scene, {
        hoveredPrimitiveIds: snapshot.hoveredPrimitiveIds,
        selectedPrimitiveIds: snapshot.selectedPrimitiveIds,
      });
    }, [project, snapshot]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || typeof ResizeObserver === "undefined") return;

      let animationFrame: number | null = null;
      const observer = new ResizeObserver(() => {
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(() => {
          animationFrame = null;
          setResizeVersion((value) => value + 1);
        });
      });
      observer.observe(canvas);

      return () => {
        observer.disconnect();
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      };
    }, [descriptors.length > 0]);

    useEffect(() => {
      return () => {
        const interaction = lastHoveredInteractionRef.current;
        lastHoveredInteractionRef.current = null;
        lastHoveredKeyRef.current = null;
        interaction?.clearHover();
      };
    }, []);

    if (descriptors.length === 0) {
      return null;
    }

    return (
      <canvas
        aria-hidden="true"
        data-map-overlay-backend="canvas2d"
        data-map-overlay-primitives={snapshot.frame.primitives.length}
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

function describeChildren(children: ReactNode): MapsLayerDescriptor[] {
  const descriptors: MapsLayerDescriptor[] = [];
  collectDescriptors(children, descriptors, "root");
  return descriptors;
}

function collectDescriptors(
  children: ReactNode,
  descriptors: MapsLayerDescriptor[],
  path: string,
) {
  Children.toArray(children).forEach((child, index) => {
    if (!isValidElement(child)) {
      throwUnsupportedMapsLayer();
    }

    const childPath = `${path}.${index}`;
    if (child.type === Fragment) {
      collectDescriptors(
        (child.props as { children?: ReactNode }).children,
        descriptors,
        childPath,
      );
      return;
    }

    if (child.type === PointLayer) {
      const props = child.props as PointLayerProps<AnyRecord>;
      descriptors.push({
        kind: "point",
        prefix: props.layerId ? `point:${props.layerId}` : resolveLayerPrefix("point", child.key, childPath),
        props,
      });
      return;
    }

    if (child.type === GeoJsonLayer) {
      const props = child.props as GeoJsonLayerProps<AnyRecord>;
      descriptors.push({
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
      descriptors.push({
        kind: "cluster",
        prefix: props.layerId
          ? `cluster:${props.layerId}`
          : resolveLayerPrefix("cluster", child.key, childPath),
        props,
      });
      return;
    }

    throwUnsupportedMapsLayer();
  });
}

function createOverlaySnapshot(
  descriptors: readonly MapsLayerDescriptor[],
  clusterFrames: ReadonlyMap<string, MapPointClusterRenderFrame<AnyRecord>>,
  surface: MapsOverlayInteractionSurface,
): MapsOverlaySnapshot {
  const mutable: MutableMapsOverlaySnapshot = {
    frame: { kind: "vector", primitives: [] },
    hoveredPrimitiveIds: new Set(),
    interactions: new Map(),
    primitiveIds: new Set(),
    selectedPrimitiveIds: new Set(),
  };

  for (const descriptor of descriptors) {
    switch (descriptor.kind) {
      case "point":
        appendPointLayer(descriptor, surface, mutable);
        break;
      case "geojson":
        appendGeoJsonLayer(descriptor, surface, mutable);
        break;
      case "cluster": {
        const frame = clusterFrames.get(descriptor.prefix);
        if (frame) appendClusterLayer(descriptor, frame, surface, mutable);
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
  descriptor: PointLayerDescriptor,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
) {
  const { prefix, props } = descriptor;
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
  descriptor: GeoJsonLayerDescriptor,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
) {
  const { prefix, props } = descriptor;
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
  descriptor: ClusterLayerDescriptor,
  frame: MapPointClusterRenderFrame<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
) {
  const { prefix, props } = descriptor;
  const vectorFrame = createPointClusterVectorRenderFrame(frame, { primitivePrefix: prefix });

  for (const primitive of vectorFrame.primitives) {
    const feature = primitive.feature;
    const resolveFeatureId = () => primitive.featureId;
    const hovered = surface.isFeatureHovered(feature, props.hoveredFeatureId, resolveFeatureId);
    const selected = surface.isFeatureSelected(feature, props.selectedFeatureId, resolveFeatureId);
    const interaction = createFeatureInteraction(
      `${prefix}|${primitive.featureId}`,
      feature,
      primitive.featureId,
      primitive.center,
      props,
      surface,
      feature.kind === "cluster"
        ? () => {
            surface.setViewState(
              { center: primitive.center, zoom: feature.expansionZoom },
              "cluster-expand",
            );
          }
        : undefined,
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
  beforeClick?: () => void,
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
      beforeClick?.();
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

function useClusterRenderFrames(
  descriptors: readonly ClusterLayerDescriptor[],
  getViewportAggregationQuery: () => ViewportAggregationQuery | null,
  resizeVersion: number,
  viewState: MapsOverlayInteractionSurface["viewState"],
) {
  const indexesRef = useRef<Map<string, ClusterIndexEntry>>(new Map());
  const [frames, setFrames] = useState<Map<string, MapPointClusterRenderFrame<AnyRecord>>>(
    () => new Map(),
  );

  useEffect(() => {
    const activePrefixes = new Set(descriptors.map((descriptor) => descriptor.prefix));
    for (const [prefix, entry] of indexesRef.current) {
      if (!activePrefixes.has(prefix)) {
        entry.index.dispose();
        indexesRef.current.delete(prefix);
      }
    }

    if (descriptors.length === 0) {
      setFrames((current) => (current.size === 0 ? current : new Map()));
      return;
    }

    const query = getViewportAggregationQuery();
    const nextFrames = new Map<string, MapPointClusterRenderFrame<AnyRecord>>();

    for (const descriptor of descriptors) {
      const entry = getOrCreateClusterIndex(indexesRef.current, descriptor);
      if (!query) continue;

      const aggregation = entry.index.getViewportAggregation(query);
      const resolveFeatureId = (feature: AggregatedMapFeature<AnyRecord>) =>
        descriptor.props.getFeatureId?.(feature) ?? defaultAggregatedFeatureId(feature);
      const frame = createPointClusterRenderFrame(aggregation, resolveFeatureId);
      nextFrames.set(descriptor.prefix, frame);
      emitViewportSummary(entry, frame.summary, descriptor.props.onViewportAggregationChange);
    }

    setFrames(nextFrames);
  }, [
    descriptors,
    getViewportAggregationQuery,
    resizeVersion,
    viewState.center[0],
    viewState.center[1],
    viewState.zoom,
  ]);

  useEffect(() => {
    return () => {
      for (const entry of indexesRef.current.values()) entry.index.dispose();
      indexesRef.current.clear();
    };
  }, []);

  return frames;
}

function getOrCreateClusterIndex(
  entries: Map<string, ClusterIndexEntry>,
  descriptor: ClusterLayerDescriptor,
) {
  const current = entries.get(descriptor.prefix);
  const { props } = descriptor;
  const unchanged =
    current &&
    current.points === props.points &&
    current.filterPoint === props.filterPoint &&
    current.clusterRadius === props.clusterRadius &&
    current.maxZoom === props.maxZoom &&
    current.minZoom === props.minZoom;

  if (unchanged) {
    if (current.onViewportAggregationChange !== props.onViewportAggregationChange) {
      current.onViewportAggregationChange = props.onViewportAggregationChange;
      current.lastSummaryKey = null;
    }
    return current;
  }

  current?.index.dispose();
  const entry: ClusterIndexEntry = {
    clusterRadius: props.clusterRadius,
    filterPoint: props.filterPoint,
    index: createPointAggregationIndex(props.points, {
      filterPoint: props.filterPoint,
      maxZoom: props.maxZoom,
      minZoom: props.minZoom,
      radius: props.clusterRadius,
    }),
    lastSummaryKey: null,
    maxZoom: props.maxZoom,
    minZoom: props.minZoom,
    onViewportAggregationChange: props.onViewportAggregationChange,
    points: props.points,
  };
  entries.set(descriptor.prefix, entry);
  return entry;
}

function emitViewportSummary(
  entry: ClusterIndexEntry,
  summary: VisibleAggregationSummary,
  callback: ClusterLayerProps<AnyRecord>["onViewportAggregationChange"],
) {
  const key = serializeVisibleAggregationSummary(summary);
  if (entry.lastSummaryKey === key) return;

  entry.lastSummaryKey = key;
  startTransition(() => callback?.(summary));
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

function defaultAggregatedFeatureId(feature: AggregatedMapFeature<AnyRecord>) {
  return feature.kind === "cluster" ? String(feature.clusterId) : feature.point.id;
}

function isClusterLayerDescriptor(
  descriptor: MapsLayerDescriptor,
): descriptor is ClusterLayerDescriptor {
  return descriptor.kind === "cluster";
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
    'flatRuntime="maps" supports PointLayer and GeoJsonLayer only as direct feature layers; ClusterLayer is also supported through the aggregation render path; other map layer types remain explicitly MapLibre-backed.',
  );
}
