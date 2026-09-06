"use client";

import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type VisibleAggregationSummary,
} from "./aggregation";
import {
  createCanvasPointClusterScene,
  drawCanvasPointClusterScene,
  hitTestCanvasPointClusterScene,
  type CanvasPointClusterScene,
} from "./canvas-point-cluster-renderer";
import type {
  MapFeatureContextMenuContext,
  MapFeatureInteractionProps,
} from "./map-interaction";
import { MapSurfaceContext } from "./map-surface-context";
import {
  createPointClusterRenderFrame,
  createPointOnlyRenderFrame,
} from "./point-cluster-render-frame";

export type CanvasPointClusterLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<AggregatedMapFeature<TProperties>> & {
    clusterRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    filterPoint?: MapPointFilter<TProperties>;
    maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    mode?: "clusters" | "points";
    onFeatureSelect?: (feature: AggregatedMapFeature<TProperties> | null) => void;
    onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void;
    points: readonly MapPoint<TProperties>[];
  };

type CanvasMapEvent = {
  originalEvent?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
  point: { x: number; y: number };
};

type CanvasEventMap = {
  off(type: "click" | "contextmenu" | "mousemove", listener: (event: CanvasMapEvent) => void): void;
  on(type: "click" | "contextmenu" | "mousemove", listener: (event: CanvasMapEvent) => void): void;
};

/**
 * Private Canvas2D reference backend for the Maps point/cluster render frame.
 * It is intentionally not exported from package entrypoints. MapLibre remains
 * the camera/basemap owner; Canvas2D only paints and hit-tests frame features.
 */
export function CanvasPointClusterLayer<TProperties = Record<string, unknown>>({
  clusterRadius,
  filterPoint,
  getFeatureId,
  hoveredFeatureId,
  maxZoom,
  minZoom,
  mode = "clusters",
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onHoveredFeatureIdChange,
  onSelectedFeatureIdChange,
  onViewportAggregationChange,
  points,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: CanvasPointClusterLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<CanvasPointClusterScene<TProperties> | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const [resizeVersion, setResizeVersion] = useState(0);
  const index = useMemo(
    () =>
      mode === "clusters"
        ? createPointAggregationIndex(points, {
            filterPoint,
            maxZoom,
            minZoom,
            radius: clusterRadius,
          })
        : null,
    [clusterRadius, filterPoint, maxZoom, minZoom, mode, points],
  );

  useEffect(() => () => index?.dispose(), [index]);

  useEffect(() => {
    const container = surface?.maplibreMap?.getContainer();
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => setResizeVersion((value) => value + 1));
    observer.observe(container);
    return () => observer.disconnect();
  }, [surface?.maplibreMap]);

  useEffect(() => {
    const map = surface?.maplibreMap;
    const canvas = canvasRef.current;
    if (!map || !canvas || !surface || surface.display === "globe") return;

    const bounds = map.getBounds();
    const query = {
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] as [
        number,
        number,
        number,
        number,
      ],
      zoom: map.getZoom(),
    };
    const frame =
      mode === "clusters" && index
        ? createPointClusterRenderFrame(index.getViewportAggregation(query), getFeatureId)
        : createPointOnlyRenderFrame(points, query, getFeatureId);
    const container = map.getContainer();
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scene = createCanvasPointClusterScene(
      frame,
      (coordinates) => {
        const projected = map.project(coordinates);
        return { x: projected.x, y: projected.y };
      },
      { height, width },
    );
    sceneRef.current = scene;
    drawCanvasPointClusterScene(context, scene, {
      hoveredFeatureId: hoveredFeatureId ?? hoveredIdRef.current,
      selectedFeatureId,
    });
    onViewportAggregationChange?.(frame.summary);
  }, [
    getFeatureId,
    hoveredFeatureId,
    index,
    mode,
    onViewportAggregationChange,
    points,
    resizeVersion,
    selectedFeatureId,
    surface,
    surface?.viewState.center[0],
    surface?.viewState.center[1],
    surface?.viewState.zoom,
  ]);

  useEffect(() => {
    const map = surface?.maplibreMap;
    if (!map || !surface || surface.display === "globe") return;

    const eventMap = map as unknown as CanvasEventMap;
    const findHit = (event: CanvasMapEvent) =>
      sceneRef.current
        ? hitTestCanvasPointClusterScene(sceneRef.current, event.point)
        : null;
    const preventMapBackgroundAction = (event: CanvasMapEvent) => {
      event.originalEvent?.preventDefault?.();
      event.originalEvent?.stopPropagation?.();
    };
    const handleClick = (event: CanvasMapEvent) => {
      const hit = findHit(event);
      if (!hit) return;
      preventMapBackgroundAction(event);
      const { renderFeature } = hit;

      if (renderFeature.kind === "cluster") {
        map.easeTo({ center: renderFeature.coordinates, zoom: renderFeature.expansionZoom });
        surface.setViewState(
          { center: renderFeature.coordinates, zoom: renderFeature.expansionZoom },
          "cluster-expand",
        );
      }

      surface.handleFeatureClick(renderFeature.feature, event.point, {
        getFeatureId,
        onFeatureSelect,
        onSelectedFeatureIdChange,
        renderFeaturePopup,
      });
    };
    const handleContextMenu = (event: CanvasMapEvent) => {
      const hit = findHit(event);
      if (!hit) return;
      preventMapBackgroundAction(event);
      const { renderFeature } = hit;
      surface.handleFeatureContextMenu(renderFeature.feature, event.point, {
        coordinates: renderFeature.coordinates,
        getFeatureId,
        onFeatureContextMenu,
        onFeatureSelect,
        onSelectedFeatureIdChange,
        renderFeatureContextMenu: renderFeatureContextMenu as
          | ((
              feature: AggregatedMapFeature<TProperties>,
              context: MapFeatureContextMenuContext<AggregatedMapFeature<TProperties>>,
            ) => ReactNode)
          | undefined,
        renderFeaturePopup,
      });
    };
    const handleMouseMove = (event: CanvasMapEvent) => {
      const hit = findHit(event);
      const nextId = hit?.renderFeature.id ?? null;
      if (hoveredIdRef.current === nextId) return;
      hoveredIdRef.current = nextId;
      map.getCanvas().style.cursor = hit ? "pointer" : "";

      if (!hit) {
        surface.handleFeatureHover(null, null, {
          getFeatureId,
          onFeatureHover,
          onHoveredFeatureIdChange,
          renderFeatureTooltip,
        });
        surface.requestRender();
        return;
      }

      surface.handleFeatureHover(hit.renderFeature.feature, event.point, {
        getFeatureId,
        onFeatureHover,
        onHoveredFeatureIdChange,
        renderFeatureTooltip,
      });
      surface.requestRender();
    };

    eventMap.on("click", handleClick);
    eventMap.on("contextmenu", handleContextMenu);
    eventMap.on("mousemove", handleMouseMove);
    return () => {
      eventMap.off("click", handleClick);
      eventMap.off("contextmenu", handleContextMenu);
      eventMap.off("mousemove", handleMouseMove);
      map.getCanvas().style.cursor = "";
    };
  }, [
    getFeatureId,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    renderFeatureContextMenu,
    renderFeaturePopup,
    renderFeatureTooltip,
    surface,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-map-renderer="canvas2d"
      style={{
        inset: 0,
        pointerEvents: "none",
        position: "absolute",
        zIndex: 2,
      }}
    />
  );
}
