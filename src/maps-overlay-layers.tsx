"use client";

import {
  Children,
  Fragment,
  Suspense,
  forwardRef,
  isValidElement,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type PointAggregationIndex,
  type ViewportAggregation,
  type ViewportAggregationQuery,
  type VisibleAggregationSummary,
} from "./aggregation";
import {
  createCanvasMapSceneProjector,
  drawCanvasMapLabels,
  drawCanvasMapPrimitive,
  hitTestCanvasMapScene,
  type CanvasMapScene,
  type MapScreenPoint,
} from "./canvas-map-renderer";
import { ClusterLayer, type ClusterLayerProps } from "./cluster-layer";
import { FlowLayer, type FlowLayerProps } from "./flow-layer";
import {
  GeoJsonLayer,
  createGeoJsonLayerFeatures,
  type GeoJsonLayerFeature,
  type GeoJsonLayerProps,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import { getGeometryCenter } from "./geojson-rendering";
import { formatHeatLayerFeatureValue } from "./heat-layer-data";
import type { HeatLayerFeature, HeatLayerProps } from "./heat-layer-types";
import { MAP_LAYER_COMPONENT_KIND, type MapLayerComponent } from "./map-layer-component";
import type { MapFeatureInteractionProps } from "./map-interaction";
import {
  createGeoJsonVectorRenderFrame,
  createPointClusterVectorRenderFrame,
  type MapVectorRenderFrame,
  type MapVectorRenderPrimitive,
} from "./map-render-frame";
import type { MapScreenInteractionState } from "./map-screen-render-frame";
import type { MapSurfaceContextValue } from "./map-surface-context";
import type { MapsHeatLayerDescriptor } from "./maps-heat-layer-registration";
import type {
  MapsHeatLayerRenderState,
  MapsHeatLayerViewport,
  MapsHeatRasterRenderStep,
} from "./maps-heat-layer-rendering";
import { createPointClusterRenderFrame } from "./point-cluster-render-frame";
import { PointLayer, type PointLayerProps } from "./point-layer";

import { createMapsNativeLayerRuntime } from "./maps-native-layer-runtime";

export type MapsProjectCoordinate = (
  coordinates: [longitude: number, latitude: number],
) => { x: number; y: number } | null;

export type MapsUnprojectCoordinate = (
  x: number,
  y: number,
) => [longitude: number, latitude: number] | null;

export type MapsOverlayPick = {
  featureId: string;
  primitiveId: string;
};

export type MapsOverlayLayersController = {
  /** Refresh screen coordinates and picking against the current Rust camera. */
  redraw(): void;
  clearHover(): void;
  handleClickAtClientPoint(clientX: number, clientY: number): boolean;
  handleContextMenuAtClientPoint(clientX: number, clientY: number): boolean;
  handleHoverAtClientPoint(clientX: number, clientY: number): MapsOverlayPick | null;
  pickAtClientPoint(clientX: number, clientY: number): MapsOverlayPick | null;
};

type AnyRecord = Record<string, unknown>;
type MapsHeatLayerRuntime = Pick<
  typeof import("./maps-heat-layer-rendering"),
  | "createMapsHeatLayerRenderState"
  | "drawMapsHeatRaster"
  | "prepareMapsHeatLayerRender"
  | "resetMapsHeatLayerRenderState"
>;
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
  renderApplicationFrame?: (
    frame: CanvasMapScene<unknown>,
    interaction: MapScreenInteractionState,
  ) => boolean;
  surface: MapsOverlayInteractionSurface;
  unproject: MapsUnprojectCoordinate;
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

type MapsOverlayRenderStep =
  | {
      kind: "primitive";
      primitiveId: string;
    }
  | {
      kind: "raster";
      raster: MapsHeatRasterRenderStep;
    };

type MapsOverlaySnapshot = {
  frame: MapVectorRenderFrame<unknown>;
  hoveredPrimitiveIds: Set<string>;
  interactions: Map<string, MapsOverlayInteraction>;
  renderSteps: MapsOverlayRenderStep[];
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
      kind: "flow";
      prefix: string;
      props: FlowLayerProps<AnyRecord>;
    }
  | {
      kind: "geojson";
      prefix: string;
      props: GeoJsonLayerProps<AnyRecord>;
    }
  | {
      kind: "heat";
      props: HeatLayerProps<AnyRecord>;
      runtimeKey: string;
    }
  | {
      kind: "point";
      prefix: string;
      props: PointLayerProps<AnyRecord>;
    };

type MapsGeoJsonRuntime = {
  featureCollection: GeoJsonLayerProps<AnyRecord>["featureCollection"];
  features: GeoJsonLayerFeature<AnyRecord>[];
  frame?: MapVectorRenderFrame<GeoJsonLayerFeature<AnyRecord>>;
  frameInputs?: readonly unknown[];
  anchors: WeakMap<GeoJsonLayerFeature<AnyRecord>, ReturnType<typeof getGeometryCenter>>;
};

type MapsClusterRuntime = {
  viewport?: ViewportAggregationQuery;
  aggregation?: ViewportAggregation<AnyRecord>;
  frame?: MapVectorRenderFrame<AggregatedMapFeature<AnyRecord>>;
  frameGetId?: ClusterLayerProps<AnyRecord>["getFeatureId"];
  framePrefix?: string;

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

const LazyMapsHeatLayerMount = lazy(async () => {
  const module = await import("./maps-heat-layer-mount");
  return { default: module.MapsHeatLayerMount };
});

export const MapsOverlayLayers = forwardRef<MapsOverlayLayersController, MapsOverlayLayersProps>(
  function MapsOverlayLayers(
    { children, getViewport, project, renderApplicationFrame, surface, unproject },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const lastDrawRef = useRef<{
      scene: CanvasMapScene<unknown>;
      snapshot: MapsOverlaySnapshot;
      renderer: MapsOverlayLayersProps["renderApplicationFrame"];
      ratio: number;
    } | null>(null);
    const sceneRef = useRef<CanvasMapScene<unknown> | null>(null);
    const [nativeRuntime] = useState(() => createMapsNativeLayerRuntime());
    const [projectScene] = useState(() => createCanvasMapSceneProjector());
    const projectionRevisionRef = useRef(0);
    const drawRef = useRef<(() => void) | null>(null);
    const clearApplicationFrameRef = useRef<(() => void) | null>(null);
    const renderedSnapshotRef = useRef<MapsOverlaySnapshot | null>(null);
    const applicationFrameVisibleRef = useRef(false);
    const lastHoveredInteractionRef = useRef<MapsOverlayInteraction | null>(null);
    const lastHoveredKeyRef = useRef<string | null>(null);
    const clusterRuntimesRef = useRef<Map<string, MapsClusterRuntime>>(new Map());
    const geoJsonRuntimesRef = useRef<Map<string, MapsGeoJsonRuntime>>(new Map());
    const heatDescriptorsRef = useRef<Map<string, MapsHeatLayerDescriptor>>(new Map());
    const heatRuntimesRef = useRef<Map<string, MapsHeatLayerRenderState>>(new Map());
    const [heatRevision, setHeatRevision] = useState(0);
    const entries = useMemo(() => collectOverlayEntries(children), [children]);
    const hasHeatEntries = entries.some((entry) => entry.kind === "heat");
    const [heatRuntime, setHeatRuntime] = useState<MapsHeatLayerRuntime | null>(null);
    const [heatRuntimeError, setHeatRuntimeError] = useState<unknown>(null);
    const heatRuntimeRef = useRef<MapsHeatLayerRuntime | null>(heatRuntime);
    useLayoutEffect(() => {
      heatRuntimeRef.current = heatRuntime;
    });

    useEffect(() => {
      if (!hasHeatEntries || heatRuntime) return;

      let active = true;
      import("./maps-heat-layer-rendering").then(
        (runtime) => {
          if (active) setHeatRuntime(runtime);
        },
        (error: unknown) => {
          if (active) setHeatRuntimeError(error);
        },
      );

      return () => {
        active = false;
      };
    }, [hasHeatEntries, heatRuntime]);

    const requestHeatRender = useCallback(() => {
      setHeatRevision((revision) => revision + 1);
    }, []);

    const publishHeatLayer = useCallback(
      (layerKey: string, descriptor: MapsHeatLayerDescriptor | null) => {
        if (descriptor) {
          heatDescriptorsRef.current.set(layerKey, descriptor);
        } else {
          heatDescriptorsRef.current.delete(layerKey);
        }
        requestHeatRender();
      },
      [requestHeatRender],
    );

    useLayoutEffect(() => {
      const geoJsonRuntimes = geoJsonRuntimesRef.current;
      const activeGeoJsonPrefixes = new Set<string>();
      const activeNativePrefixes = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === "geojson") activeGeoJsonPrefixes.add(entry.prefix);
        if (entry.kind === "point" || entry.kind === "flow") activeNativePrefixes.add(entry.prefix);
      }
      for (const prefix of geoJsonRuntimes.keys()) {
        if (!activeGeoJsonPrefixes.has(prefix)) geoJsonRuntimes.delete(prefix);
      }
      nativeRuntime.retain(activeNativePrefixes);

      const previousClusters = clusterRuntimesRef.current;
      const nextClusters = new Map<string, MapsClusterRuntime>();
      const activeHeatKeys = new Set<string>();

      for (const entry of entries) {
        if (entry.kind === "cluster") {
          const current = previousClusters.get(entry.runtimeKey);
          if (current && clusterRuntimeMatches(current, entry.props)) {
            nextClusters.set(entry.runtimeKey, current);
          } else {
            current?.index.dispose();
            nextClusters.set(entry.runtimeKey, createClusterRuntime(entry.props));
          }
        }

        if (entry.kind === "heat") {
          activeHeatKeys.add(entry.runtimeKey);
          if (heatRuntime && !heatRuntimesRef.current.has(entry.runtimeKey)) {
            heatRuntimesRef.current.set(
              entry.runtimeKey,
              heatRuntime.createMapsHeatLayerRenderState(),
            );
          }
        }
      }

      for (const [key, runtime] of previousClusters) {
        if (!nextClusters.has(key)) runtime.index.dispose();
      }
      clusterRuntimesRef.current = nextClusters;

      for (const [key, runtime] of heatRuntimesRef.current) {
        if (activeHeatKeys.has(key)) continue;
        heatRuntime?.resetMapsHeatLayerRenderState(runtime);
        heatRuntimesRef.current.delete(key);
        heatDescriptorsRef.current.delete(key);
      }
    }, [entries, heatRuntime]);

    useEffect(() => {
      return () => {
        for (const runtime of clusterRuntimesRef.current.values()) runtime.index.dispose();
        clusterRuntimesRef.current.clear();
        geoJsonRuntimesRef.current.clear();
        nativeRuntime.clear();
        for (const runtime of heatRuntimesRef.current.values()) {
          heatRuntimeRef.current?.resetMapsHeatLayerRenderState(runtime);
        }
        heatRuntimesRef.current.clear();
        heatDescriptorsRef.current.clear();
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
        redraw() {
          projectionRevisionRef.current += 1;
          drawRef.current?.();
        },
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

    useLayoutEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        clearApplicationFrameRef.current?.();
        sceneRef.current = null;
        renderedSnapshotRef.current = null;
        lastDrawRef.current = null;
        return;
      }

      const clearApplicationFrame = () => {
        if (!applicationFrameVisibleRef.current) return;
        const scene = sceneRef.current;
        if (scene && renderApplicationFrame) {
          renderApplicationFrame({ ...scene, primitives: [] }, {});
        }
        applicationFrameVisibleRef.current = false;
      };
      clearApplicationFrameRef.current = clearApplicationFrame;

      const draw = (force = false) => {
        const size = resizeCanvasBackingStore(canvas);
        const viewportQuery = getViewport(size.width, size.height);
        const heatViewport: MapsHeatLayerViewport | null = viewportQuery
          ? {
              bounds: viewportQuery.bounds,
              height: size.height,
              project,
              unproject,
              width: size.width,
              zoom: viewportQuery.zoom,
            }
          : null;
        const snapshot = createOverlaySnapshot(
          entries,
          nativeRuntime,
          surface,
          clusterRuntimesRef.current,
          geoJsonRuntimesRef.current,
          viewportQuery,
          heatDescriptorsRef.current,
          heatRuntimesRef.current,
          heatViewport,
          heatRuntime,
          requestHeatRender,
        );
        const scene = projectScene(snapshot.frame, project, size, projectionRevisionRef.current);
        const interaction: MapScreenInteractionState = {
          hoveredPrimitiveIds: snapshot.hoveredPrimitiveIds,
          selectedPrimitiveIds: snapshot.selectedPrimitiveIds,
        };
        sceneRef.current = scene;
        renderedSnapshotRef.current = snapshot;
        canvas.dataset.mapOverlayPrimitives = String(snapshot.frame.primitives.length);
        canvas.dataset.mapOverlayHeatLayers = String(
          snapshot.renderSteps.filter((step) => step.kind === "raster").length,
        );

        const hasRaster = snapshot.renderSteps.some((step) => step.kind === "raster");
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const previous = lastDrawRef.current;
        const hadRaster = previous?.snapshot.renderSteps.some((step) => step.kind === "raster");
        if (
          !force &&
          !hasRaster &&
          !hadRaster &&
          previous &&
          previous.renderer === renderApplicationFrame &&
          previous.ratio === ratio &&
          sameScreenFrame(previous.scene, scene) &&
          sameIds(previous.snapshot.hoveredPrimitiveIds, snapshot.hoveredPrimitiveIds) &&
          sameIds(previous.snapshot.selectedPrimitiveIds, snapshot.selectedPrimitiveIds)
        )
          return;
        lastDrawRef.current = { scene, snapshot, renderer: renderApplicationFrame, ratio };

        const renderedByWgpu =
          !hasRaster && (renderApplicationFrame?.(scene, interaction) ?? false);
        if (renderedByWgpu) {
          applicationFrameVisibleRef.current = true;
        } else {
          clearApplicationFrame();
        }
        canvas.dataset.mapOverlayBackend = renderedByWgpu ? "wgpu" : "canvas2d";

        const context = getCanvasContext(canvas);
        if (!context) return;

        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (renderedByWgpu) {
          drawCanvasMapLabels(context, scene);
          return;
        }

        context.clearRect(0, 0, scene.width, scene.height);
        const screenPrimitives = new Map(
          scene.primitives.map((primitive) => [primitive.renderPrimitive.primitiveId, primitive]),
        );

        for (const step of snapshot.renderSteps) {
          if (step.kind === "raster") {
            if (heatViewport) {
              heatRuntime?.drawMapsHeatRaster(context, step.raster, heatViewport, ratio);
            }
            continue;
          }

          const primitive = screenPrimitives.get(step.primitiveId);
          if (primitive) drawCanvasMapPrimitive(context, primitive, interaction);
        }
      };

      // A restored Canvas context has an empty backing store, even when neither
      // the camera nor the layer data changed while it was unavailable.
      const restore = () => draw(true);
      canvas.addEventListener("contextrestored", restore);
      drawRef.current = draw;
      draw();

      const observer =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => draw());
      observer?.observe(canvas);
      return () => {
        canvas.removeEventListener("contextrestored", restore);
        observer?.disconnect();
        drawRef.current = null;
      };
    }, [
      entries,
      getViewport,
      heatRevision,
      heatRuntime,
      project,
      projectScene,
      renderApplicationFrame,
      requestHeatRender,
      surface,
      unproject,
    ]);

    useLayoutEffect(() => {
      return () => {
        drawRef.current = null;
        clearApplicationFrameRef.current?.();
      };
    }, []);

    useEffect(() => {
      return () => {
        const interaction = lastHoveredInteractionRef.current;
        lastHoveredInteractionRef.current = null;
        lastHoveredKeyRef.current = null;
        interaction?.clearHover();
      };
    }, []);

    if (heatRuntimeError) throw heatRuntimeError;

    if (entries.length === 0) return null;

    return (
      <>
        <Suspense fallback={null}>
          {entries.map((entry) =>
            entry.kind === "heat" ? (
              <LazyMapsHeatLayerMount
                key={entry.runtimeKey}
                layerKey={entry.runtimeKey}
                props={entry.props}
                publish={publishHeatLayer}
              />
            ) : null,
          )}
        </Suspense>
        <canvas
          aria-hidden="true"
          data-map-overlay-backend="canvas2d"
          data-map-overlay-heat-layers="0"
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
      </>
    );
  },
);

function collectOverlayEntries(
  children: ReactNode,
  path = "root",
  entries: MapsOverlayEntry[] = [],
) {
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
        prefix: props.layerId
          ? `point:${props.layerId}`
          : resolveLayerPrefix("point", child.key, childPath),
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

    if (child.type === FlowLayer) {
      const props = child.props as FlowLayerProps<AnyRecord>;
      entries.push({
        kind: "flow",
        prefix: props.layerId
          ? `flow:${props.layerId}`
          : resolveLayerPrefix("flow", child.key, childPath),
        props,
      });
      return;
    }

    if (isHeatLayerComponent(child.type)) {
      entries.push({
        kind: "heat",
        props: child.props as HeatLayerProps<AnyRecord>,
        runtimeKey: childPath,
      });
      return;
    }

    throwUnsupportedMapsLayer();
  });

  return entries;
}

function isHeatLayerComponent(type: unknown) {
  return (
    (typeof type === "function" || (typeof type === "object" && type !== null)) &&
    (type as MapLayerComponent)[MAP_LAYER_COMPONENT_KIND] === "heat"
  );
}

function createOverlaySnapshot(
  entries: readonly MapsOverlayEntry[],
  nativeRuntime: ReturnType<typeof createMapsNativeLayerRuntime<AnyRecord>>,
  surface: MapsOverlayInteractionSurface,
  clusterRuntimes: ReadonlyMap<string, MapsClusterRuntime>,
  geoJsonRuntimes: Map<string, MapsGeoJsonRuntime>,
  viewport: ViewportAggregationQuery | null,
  heatDescriptors: ReadonlyMap<string, MapsHeatLayerDescriptor>,
  heatRuntimes: ReadonlyMap<string, MapsHeatLayerRenderState>,
  heatViewport: MapsHeatLayerViewport | null,
  heatRuntime: MapsHeatLayerRuntime | null,
  requestHeatRender: () => void,
): MapsOverlaySnapshot {
  const mutable: MutableMapsOverlaySnapshot = {
    frame: { kind: "vector", primitives: [] },
    hoveredPrimitiveIds: new Set(),
    interactions: new Map(),
    primitiveIds: new Set(),
    renderSteps: [],
    selectedPrimitiveIds: new Set(),
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case "point":
        appendPointLayer(entry.props, surface, mutable, entry.prefix, nativeRuntime);
        break;
      case "geojson":
        appendGeoJsonLayer(entry.props, surface, mutable, entry.prefix, geoJsonRuntimes);
        break;
      case "cluster": {
        const runtime = clusterRuntimes.get(entry.runtimeKey);
        if (runtime && viewport) {
          appendClusterLayer(entry.props, surface, mutable, entry.prefix, runtime, viewport);
        }
        break;
      }
      case "flow":
        appendFlowLayer(entry.props, surface, mutable, entry.prefix, nativeRuntime);
        break;
      case "heat": {
        const descriptor = heatDescriptors.get(entry.runtimeKey);
        const runtime = heatRuntimes.get(entry.runtimeKey);
        if (!descriptor || !runtime || !heatViewport || !heatRuntime) break;
        const prepared = heatRuntime.prepareMapsHeatLayerRender({
          descriptor,
          requestRender: requestHeatRender,
          state: runtime,
          viewport: heatViewport,
        });
        if (prepared.raster) {
          mutable.renderSteps.push({ kind: "raster", raster: prepared.raster });
        }
        for (const primitive of prepared.primitives) {
          if (!primitive.interactive) {
            appendPrimitive(mutable, primitive, null, false, false);
            continue;
          }

          const feature = primitive.feature as HeatLayerFeature;
          const resolveFeatureId = () => primitive.featureId;
          const hovered = surface.isFeatureHovered(
            feature,
            entry.props.hoveredFeatureId,
            resolveFeatureId,
          );
          const selected = surface.isFeatureSelected(
            feature,
            entry.props.selectedFeatureId,
            resolveFeatureId,
          );
          const interaction = createFeatureInteraction(
            `${entry.runtimeKey}|${primitive.featureId}`,
            feature,
            primitive.featureId,
            feature.geometry.coordinates,
            {
              ...entry.props,
              renderFeatureTooltip:
                entry.props.renderFeatureTooltip ??
                ((candidate) =>
                  formatHeatLayerFeatureValue(candidate, entry.props.dataPointValueFormat)),
            },
            surface,
          );
          appendPrimitive(mutable, primitive, interaction, hovered, selected);
        }
        break;
      }
    }
  }

  return {
    frame: mutable.frame,
    hoveredPrimitiveIds: mutable.hoveredPrimitiveIds,
    interactions: mutable.interactions,
    renderSteps: mutable.renderSteps,
    selectedPrimitiveIds: mutable.selectedPrimitiveIds,
  };
}

function appendPointLayer(
  props: PointLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  prefix: string,
  runtime: ReturnType<typeof createMapsNativeLayerRuntime<AnyRecord>>,
) {
  assertNoUnsupportedPointDrag(props);
  const frame = runtime.pointFrame(props, prefix);

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
  runtimes: Map<string, MapsGeoJsonRuntime>,
) {
  const runtime = resolveGeoJsonLayerRuntime(props, prefix, runtimes);
  const frame = resolveGeoJsonLayerFrame(props, prefix, runtime);

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
          resolveGeoJsonLayerAnchor(runtime, feature),
          props,
          surface,
        )
      : null;

    appendPrimitive(snapshot, primitive, interaction, hovered, selected);
  }
}

function resolveGeoJsonLayerRuntime(
  props: GeoJsonLayerProps<AnyRecord>,
  prefix: string,
  runtimes: Map<string, MapsGeoJsonRuntime>,
): MapsGeoJsonRuntime {
  const current = runtimes.get(prefix);
  if (current?.featureCollection === props.featureCollection) return current;

  const runtime: MapsGeoJsonRuntime = {
    featureCollection: props.featureCollection,
    features: createGeoJsonLayerFeatures(props.featureCollection),
    anchors: new WeakMap(),
  };
  runtimes.set(prefix, runtime);
  return runtime;
}

function resolveGeoJsonLayerFrame(
  props: GeoJsonLayerProps<AnyRecord>,
  prefix: string,
  runtime: MapsGeoJsonRuntime,
) {
  // These are all inputs consumed by createGeoJsonVectorRenderFrame. Hover,
  // selection, tooltip positions and event callbacks do not change geometry.
  const inputs = [
    props.getFeatureId,
    props.getFeatureStyle,
    props.isFeatureInteractive,
    props.lineColor,
    props.lineOpacity,
    props.lineWidth,
    props.pointColor,
    props.pointRadius,
    props.polygonFillColor,
    props.polygonFillOpacity,
    props.polygonStrokeColor,
    props.polygonStrokeWidth,
  ];
  if (
    runtime.frame &&
    inputs.every((value, index) => Object.is(value, runtime.frameInputs?.[index]))
  ) {
    return runtime.frame;
  }
  const frame = createGeoJsonVectorRenderFrame(runtime.features, {
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
  runtime.frameInputs = inputs;
  runtime.frame = frame;
  return frame;
}

function resolveGeoJsonLayerAnchor(
  runtime: MapsGeoJsonRuntime,
  feature: GeoJsonLayerFeature<AnyRecord>,
) {
  const cached = runtime.anchors.get(feature);
  if (cached) return cached;
  const anchor = getGeometryCenter(feature.geometry);
  runtime.anchors.set(feature, anchor);
  return anchor;
}

function appendClusterLayer(
  props: ClusterLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  prefix: string,
  runtime: MapsClusterRuntime,
  viewport: ViewportAggregationQuery,
) {
  const previous = runtime.viewport;
  if (
    !runtime.aggregation ||
    !previous ||
    previous.zoom !== viewport.zoom ||
    !previous.bounds.every((value, index) => value === viewport.bounds[index])
  ) {
    runtime.aggregation = runtime.index.getViewportAggregation(viewport);
    runtime.viewport = { zoom: viewport.zoom, bounds: [...viewport.bounds] };
    runtime.frame = undefined;
  }
  const aggregation = runtime.aggregation;
  emitClusterViewportSummary(runtime, aggregation.summary, props.onViewportAggregationChange);
  if (
    !runtime.frame ||
    runtime.frameGetId !== props.getFeatureId ||
    runtime.framePrefix !== prefix
  ) {
    runtime.frame = createPointClusterVectorRenderFrame(
      createPointClusterRenderFrame(aggregation, props.getFeatureId),
      { primitivePrefix: prefix },
    );
    runtime.frameGetId = props.getFeatureId;
    runtime.framePrefix = prefix;
  }
  const frame = runtime.frame;

  for (const primitive of frame.primitives) {
    const feature = primitive.feature;
    const hovered = surface.isFeatureHovered(feature, props.hoveredFeatureId, props.getFeatureId);
    const selected = surface.isFeatureSelected(
      feature,
      props.selectedFeatureId,
      props.getFeatureId,
    );
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

function appendFlowLayer(
  props: FlowLayerProps<AnyRecord>,
  surface: MapsOverlayInteractionSurface,
  snapshot: MutableMapsOverlaySnapshot,
  prefix: string,
  runtime: ReturnType<typeof createMapsNativeLayerRuntime<AnyRecord>>,
) {
  const prepared = runtime.flowFeatures(props, prefix);
  const hasHoveredFlow = prepared.some(({ feature, featureId }) =>
    surface.isFeatureHovered(feature, props.hoveredFeatureId, () => featureId),
  );
  const hasActiveFlow = Boolean(props.selectedFeatureId) || hasHoveredFlow;
  for (const entry of prepared) {
    const { feature, featureId } = entry;
    const getId = () => featureId;
    const selected = surface.isFeatureSelected(feature, props.selectedFeatureId, getId);
    const hovered = surface.isFeatureHovered(feature, props.hoveredFeatureId, getId);
    const opacity = hovered
      ? (props.hoveredFlowOpacity ?? 0.95)
      : selected
        ? (props.selectedFlowOpacity ?? 0.95)
        : hasActiveFlow
          ? (props.inactiveFlowOpacity ?? 0.22)
          : 0.72;
    const interaction = createFeatureInteraction(
      `${prefix}|${featureId}`,
      feature,
      featureId,
      entry.center,
      props,
      surface,
    );
    const { line, marker } = entry.paint(opacity, selected);
    appendPrimitive(snapshot, line, interaction, false, false);
    if (marker) appendPrimitive(snapshot, marker, null, false, false);
    for (const endpoint of entry.endpoints) appendPrimitive(snapshot, endpoint, null, false, false);
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
  snapshot.renderSteps.push({ kind: "primitive", primitiveId: primitive.primitiveId });
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
    "The direct-feature Maps runtime supports PointLayer, GeoJsonLayer, FlowLayer, and ClusterLayer, plus HeatLayer, through Maps-owned semantic adapters. Other map layer types remain explicitly MapLibre-backed.",
  );
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}
function sameScreenFrame(left: CanvasMapScene<unknown>, right: CanvasMapScene<unknown>) {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.primitives.length === right.primitives.length &&
    left.primitives.every((primitive, index) => primitive === right.primitives[index])
  );
}
