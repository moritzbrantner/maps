"use client";

import { useEffect, useRef } from "react";

import {
  normalizeMapMaxZoom,
  resolveTileLayerOptions,
  type MapBounds,
  type MapFitBoundsOptions,
  type MapViewState,
  type MapViewStateChangeReason,
  type RasterMapStyle,
} from "./map-display";
import {
  loadMapsFlatRasterRuntime,
  type MapsFlatRasterFrame,
  type MapsFlatRasterRuntime,
  type MapsRasterTileId,
} from "./flat-runtime-wasm";

const DEFAULT_TILE_SIZE = 256;
const DEFAULT_SOURCE_MAX_ZOOM = 19;
const MAX_MAP_ZOOM = 22;

type MapsCanvasFitBoundsOptions = MapFitBoundsOptions & {
  reason?: MapViewStateChangeReason;
};

export type MapsCanvasFlatRuntimeController = {
  fitBounds(bounds: MapBounds, options?: MapsCanvasFitBoundsOptions): void;
  project(coordinates: [longitude: number, latitude: number]): { x: number; y: number };
  setViewState(viewState: MapViewState, reason?: MapViewStateChangeReason): void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
};

type MapsCanvasFlatRuntimeProps = {
  mapStyle: RasterMapStyle;
  maxBounds?: MapBounds;
  maxZoom?: number;
  onContextMenu?: (context: {
    coordinates: [longitude: number, latitude: number];
    position: { x: number; y: number };
  }) => void;
  onControllerReady?: (controller: MapsCanvasFlatRuntimeController | null) => void;
  onError?: (error: unknown) => void;
  onReady?: () => void;
  onViewStateChange: (viewState: MapViewState, reason: MapViewStateChangeReason) => void;
  viewState: MapViewState;
  wasmPackage?: string;
};

type ActiveTileLoad = {
  abort: AbortController;
  tile: MapsRasterTileId;
};

export function MapsCanvasFlatRuntime({
  mapStyle,
  maxBounds,
  maxZoom,
  onContextMenu,
  onControllerReady,
  onError,
  onReady,
  onViewStateChange,
  viewState,
  wasmPackage,
}: MapsCanvasFlatRuntimeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<MapsFlatRasterRuntime | null>(null);
  const imagesRef = useRef<Map<string, ImageBitmap>>(new Map());
  const loadsRef = useRef<Map<string, ActiveTileLoad>>(new Map());
  const syncFrameRef = useRef<(() => MapsFlatRasterFrame) | null>(null);
  const emitViewStateRef = useRef<
    ((frame: MapsFlatRasterFrame, reason: MapViewStateChangeReason) => void) | null
  >(null);
  const source = resolveTileLayerOptions(mapStyle);
  const sourceKey = source
    ? [source.url, source.options.minZoom, source.options.maxZoom, source.options.tileSize].join(":")
    : "no-raster-source";
  const boundsKey = maxBounds?.join(":") ?? "unbounded";
  const sourceRef = useRef(source);
  const maxZoomRef = useRef(maxZoom);
  const viewStateRef = useRef(viewState);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const onContextMenuRef = useRef(onContextMenu);
  const onControllerReadyRef = useRef(onControllerReady);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  sourceRef.current = source;
  maxZoomRef.current = maxZoom;
  viewStateRef.current = viewState;
  onViewStateChangeRef.current = onViewStateChange;
  onContextMenuRef.current = onContextMenu;
  onControllerReadyRef.current = onControllerReady;
  onErrorRef.current = onError;
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    async function initialize() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const size = getCanvasCssSize(canvas);
      const currentSource = sourceRef.current;
      const runtime = await loadMapsFlatRasterRuntime(
        {
          center: viewStateRef.current.center,
          height: size.height,
          maxBounds,
          source: {
            maxZoom: Math.round(currentSource?.options.maxZoom ?? DEFAULT_SOURCE_MAX_ZOOM),
            minZoom: Math.round(currentSource?.options.minZoom ?? 0),
            tileSize: Math.round(currentSource?.options.tileSize ?? DEFAULT_TILE_SIZE),
          },
          width: size.width,
          zoom: viewStateRef.current.zoom,
        },
        wasmPackage,
      );

      if (cancelled) {
        runtime.dispose();
        return;
      }

      runtimeRef.current = runtime;
      resizeCanvasBackingStore(canvas);

      const syncFrame = createFrameSynchronizer({
        canvas,
        images: imagesRef.current,
        loads: loadsRef.current,
        runtime,
        source: () => sourceRef.current,
        onError: (error) => onErrorRef.current?.(error),
      });
      const emitViewState = (frame: MapsFlatRasterFrame, reason: MapViewStateChangeReason) => {
        onViewStateChangeRef.current(frameViewState(frame), reason);
      };
      const emitConstraintCorrection = (
        frame: MapsFlatRasterFrame,
        reason: MapViewStateChangeReason,
      ) => {
        if (!areViewStatesEqual(frameViewState(frame), viewStateRef.current)) {
          emitViewState(frame, reason);
        }
      };

      syncFrameRef.current = syncFrame;
      emitViewStateRef.current = emitViewState;

      const controller: MapsCanvasFlatRuntimeController = {
        fitBounds(bounds, options = {}) {
          const effectiveMaxZoom =
            options.maxZoom ?? normalizeMapMaxZoom(maxZoomRef.current) ?? MAX_MAP_ZOOM;
          runtime.fitBounds(bounds, options.padding ?? 0, effectiveMaxZoom);
          emitViewState(syncFrame(), options.reason ?? "fit-bounds");
        },
        project(coordinates) {
          const [x, y] = runtime.project(coordinates[0], coordinates[1]);
          return { x, y };
        },
        setViewState(next, reason = "programmatic") {
          runtime.setViewState(next);
          emitViewState(syncFrame(), reason);
        },
        unproject(x, y) {
          return runtime.unproject(x, y);
        },
      };

      resizeObserver = new ResizeObserver(() => {
        const nextSize = getCanvasCssSize(canvas);
        resizeCanvasBackingStore(canvas);
        runtime.resize(nextSize.width, nextSize.height);
        emitConstraintCorrection(syncFrame(), "prop-change");
      });
      resizeObserver.observe(canvas);

      emitConstraintCorrection(syncFrame(), "initial");
      onControllerReadyRef.current?.(controller);
      onReadyRef.current?.();
    }

    initialize().catch((error) => {
      if (!cancelled) onErrorRef.current?.(error);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      onControllerReadyRef.current?.(null);
      syncFrameRef.current = null;
      emitViewStateRef.current = null;
      for (const load of loadsRef.current.values()) load.abort.abort();
      loadsRef.current.clear();
      for (const image of imagesRef.current.values()) image.close();
      imagesRef.current.clear();
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [boundsKey, sourceKey, wasmPackage]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const syncFrame = syncFrameRef.current;
    if (!runtime || !syncFrame) return;

    runtime.setViewState(viewState);
    const frame = syncFrame();
    if (!areViewStatesEqual(frameViewState(frame), viewState)) {
      emitViewStateRef.current?.(frame, "prop-change");
    }
  }, [viewState.center[0], viewState.center[1], viewState.zoom]);

  return (
    <canvas
      className="mb-maps__canvas mb-maps__canvas-flat"
      data-flat-runtime="maps"
      ref={canvasRef}
      onContextMenu={(event) => {
        event.preventDefault();
        const runtime = runtimeRef.current;
        if (!runtime) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const position = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };

        onContextMenuRef.current?.({
          coordinates: runtime.unproject(position.x, position.y),
          position,
        });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !runtimeRef.current) return;
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        const runtime = runtimeRef.current;
        const syncFrame = syncFrameRef.current;
        if (!runtime || !drag || drag.pointerId !== event.pointerId || !syncFrame) return;

        const deltaX = event.clientX - drag.x;
        const deltaY = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        runtime.panBy(deltaX, deltaY);
        emitViewStateRef.current?.(syncFrame(), "pan");
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      }}
      onWheel={(event) => {
        event.preventDefault();
        const runtime = runtimeRef.current;
        const syncFrame = syncFrameRef.current;
        if (!runtime || !syncFrame) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const effectiveMaxZoom = normalizeMapMaxZoom(maxZoomRef.current) ?? MAX_MAP_ZOOM;

        runtime.zoomAbout(
          -event.deltaY * 0.0025,
          event.clientX - rect.left,
          event.clientY - rect.top,
          0,
          effectiveMaxZoom,
        );
        emitViewStateRef.current?.(syncFrame(), "zoom");
      }}
    />
  );
}

function createFrameSynchronizer({
  canvas,
  images,
  loads,
  runtime,
  source,
  onError,
}: {
  canvas: HTMLCanvasElement;
  images: Map<string, ImageBitmap>;
  loads: Map<string, ActiveTileLoad>;
  runtime: MapsFlatRasterRuntime;
  source: () => ReturnType<typeof resolveTileLayerOptions>;
  onError: (error: unknown) => void;
}) {
  function syncFrame(): MapsFlatRasterFrame {
    let frame = runtime.frame();

    for (const tile of frame.cancellations) {
      loads.get(tile.key)?.abort.abort();
      loads.delete(tile.key);
    }
    for (const tile of frame.evictions) {
      images.get(tile.key)?.close();
      images.delete(tile.key);
    }

    const currentSource = source();
    if (!currentSource) {
      while (frame.requests.length > 0) {
        for (const tile of frame.requests) runtime.markLoaded(tile);
        frame = runtime.frame();
      }
      drawFrame(canvas, images, frame);
      return frame;
    }

    drawFrame(canvas, images, frame);

    for (const tile of frame.requests) {
      if (loads.has(tile.key) || images.has(tile.key)) continue;
      const abort = new AbortController();
      loads.set(tile.key, { abort, tile });

      loadRasterTile(buildRasterTileUrl(currentSource.url, tile), abort.signal)
        .then((image) => {
          loads.delete(tile.key);
          if (abort.signal.aborted) {
            image.close();
            return;
          }
          images.set(tile.key, image);
          runtime.markLoaded(tile);
          syncFrame();
        })
        .catch((error) => {
          loads.delete(tile.key);
          if (abort.signal.aborted) return;
          runtime.markFailed(tile);
          onError(error);
        });
    }

    return frame;
  }

  return syncFrame;
}

function frameViewState(frame: MapsFlatRasterFrame): MapViewState {
  return {
    center: frame.camera.center,
    zoom: frame.camera.zoom,
  };
}

function areViewStatesEqual(left: MapViewState, right: MapViewState) {
  return (
    Math.abs(left.center[0] - right.center[0]) < 1e-10 &&
    Math.abs(left.center[1] - right.center[1]) < 1e-10 &&
    Math.abs(left.zoom - right.zoom) < 1e-10
  );
}

async function loadRasterTile(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`raster tile request failed with HTTP ${response.status}: ${url}`);
  }

  return createImageBitmap(await response.blob());
}

function buildRasterTileUrl(url: string, tile: MapsRasterTileId) {
  return url
    .replaceAll("{z}", String(tile.z))
    .replaceAll("{x}", String(tile.x))
    .replaceAll("{y}", String(tile.y))
    .replaceAll("{s}", "a");
}

function drawFrame(
  canvas: HTMLCanvasElement,
  images: Map<string, ImageBitmap>,
  frame: MapsFlatRasterFrame,
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = Math.max(1, window.devicePixelRatio || 1);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, frame.camera.width, frame.camera.height);

  for (const placement of frame.placements) {
    const image = images.get(placement.tile.key);
    if (!image) continue;
    context.drawImage(
      image,
      placement.screenX,
      placement.screenY,
      placement.screenWidth,
      placement.screenHeight,
    );
  }
}

function resizeCanvasBackingStore(canvas: HTMLCanvasElement) {
  const size = getCanvasCssSize(canvas);
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(size.width * ratio));
  canvas.height = Math.max(1, Math.round(size.height * ratio));
}

function getCanvasCssSize(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    height: Math.max(1, Math.round(rect.height || canvas.clientHeight || 1)),
    width: Math.max(1, Math.round(rect.width || canvas.clientWidth || 1)),
  };
}
