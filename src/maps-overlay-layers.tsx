"use client";

import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import {
  createCanvasMapScene,
  drawCanvasMapScene,
  hitTestCanvasMapScene,
  type CanvasMapScene,
  type MapScreenPoint,
} from "./canvas-map-renderer";
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
  type MapVectorRenderFrame,
  type MapVectorRenderPrimitive,
} from "./map-render-frame";
import type { MapSurfaceContextValue } from "./map-surface-context";
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
>;

type MapsOverlayLayersProps = {
  children: ReactNode;
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

type InternalPick = {
  interaction: MapsOverlayInteraction;
  pick: MapsOverlayPick;
  position: MapScreenPoint;
};

export const MapsOverlayLayers = forwardRef<MapsOverlayLayersController, MapsOverlayLayersProps>(
  function MapsOverlayLayers({ children, project, surface }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<CanvasMapScene<unknown> | null>(null);
    const renderedSnapshotRef = useRef<MapsOverlaySnapshot | null>(null);
    const lastHoveredInteractionRef = useRef<MapsOverlayInteraction | null>(null);
    const lastHoveredKeyRef = useRef<string | null>(null);
    const snapshot = useMemo(() => createOverlaySnapshot(children, surface), [children, surface]);

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

      const draw = () => {
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
      };

      draw();

      if (typeof ResizeObserver === "undefined") {
        return;
      }

      const observer = new ResizeObserver(draw);
      observer.observe(canvas);
      return () => {
        observer.disconnect();
      };
    }, [project, snapshot]);

    useEffect(() => {
      return () => {
        const interaction = lastHoveredInteractionRef.current;
        lastHoveredInteractionRef.current = null;
        lastHoveredKeyRef.current = null;
        interaction?.clearHover();
      };
    }, []);

    if (snapshot.frame.primitives.length === 0) {
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

function createOverlaySnapshot(
  children: ReactNode,
  surface: MapsOverlayInteractionSurface,
): MapsOverlaySnapshot {
  const mutable: MutableMapsOverlaySnapshot = {
    frame: { kind: "vector", primitives: [] },
    hoveredPrimitiveIds: new Set(),
    interactions: new Map(),
    primitiveIds: new Set(),
    selectedPrimitiveIds: new Set(),
  };

  collectChildren(children, surface, mutable, "root");

  return {
    frame: mutable.frame,
    hoveredPrimitiveIds: mutable.hoveredPrimitiveIds,
    interactions: mutable.interactions,
    selectedPrimitiveIds: mutable.selectedPrimitiveIds,
  };
}

function collectChildren(
  children: ReactNode,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  path: string,
) {
  Children.toArray(children).forEach((child, index) => {
    if (!isValidElement(child)) {
      throwUnsupportedMapsLayer();
    }

    const childPath = `${path}.${index}`;
    if (child.type === Fragment) {
      collectChildren(
        (child.props as { children?: ReactNode }).children,
        surface,
        snapshot,
        childPath,
      );
      return;
    }

    if (child.type === PointLayer) {
      appendPointLayer(
        child.props as PointLayerProps<AnyRecord>,
        surface,
        snapshot,
        resolveLayerPrefix("point", child.key, childPath),
      );
      return;
    }

    if (child.type === GeoJsonLayer) {
      appendGeoJsonLayer(
        child.props as GeoJsonLayerProps<AnyRecord>,
        surface,
        snapshot,
        resolveLayerPrefix("geojson", child.key, childPath),
      );
      return;
    }

    throwUnsupportedMapsLayer();
  });
}

function appendPointLayer(
  props: PointLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  fallbackPrefix: string,
) {
  assertNoUnsupportedPointDrag(props);
  const features = createPointLayerFeatures(props.points, { filterPoint: props.filterPoint });
  const prefix = props.layerId ? `point:${props.layerId}` : fallbackPrefix;
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
  fallbackPrefix: string,
) {
  const features = createGeoJsonLayerFeatures(props.featureCollection);
  const prefix = props.layerId ? `geojson:${props.layerId}` : fallbackPrefix;
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
    'flatRuntime="maps" currently supports PointLayer and GeoJsonLayer only; other map layer types remain explicitly MapLibre-backed.',
  );
}
