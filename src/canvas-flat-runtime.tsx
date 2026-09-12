"use client";

import { useEffect, useRef } from "react";

import type { ViewportAggregationQuery } from "./aggregation";
import { createMapsPointerGesture } from "./canvas-flat-gesture";
import {
  advanceMapsKineticPan,
  createMapsKineticPanState,
  createMapsPanVelocityTracker,
  type MapsKineticPanState,
  type MapsPanVelocity,
} from "./canvas-flat-inertia";
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
  getViewportAggregationQuery(): ViewportAggregationQuery;
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
  const lastFrameRef = useRef<MapsFlatRasterFrame | null>(null);
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
  const gestureRef = useRef(createMapsPointerGesture());
  const velocityTrackerRef = useRef(createMapsPanVelocityTracker());
  const pointerTimesRef = useRef<Map<number, number>>(new Map());
  const kineticStateRef = useRef<MapsKineticPanState | null>(null);
  const kineticFrameRef = useRef<number | null>(null);
  const kineticLastFrameTimeRef = useRef<number | null>(null);
  const lastEmittedViewStateRef = useRef<MapViewState | null>(null);

  sourceRef.current = source;
  maxZoomRef.current = maxZoom;
  viewStateRef.current = viewState;
  onViewStateChangeRef.current = onViewStateChange;
  onContextMenuRef.current = onContextMenu;
  onControllerReadyRef.current = onControllerReady;
  onErrorRef.current = onError;
  onReadyRef.current = onReady;

  function cancelKineticPan() {
    if (kineticFrameRef.current !== null) {
      cancelAnimationFrame(kineticFrameRef.current);
    }
    kineticFrameRef.current = null;
    kineticStateRef.current = null;
    kineticLastFrameTimeRef.current = null;
  }

  function startKineticPan(velocity: MapsPanVelocity) {
    cancelKineticPan();
    const initial = createMapsKineticPanState(velocity);
    if (!initial) return;

    kineticStateRef.current = initial;
    kineticLastFrameTimeRef.current = performance.now();

    const tick = (now: number) => {
      kineticFrameRef.current = null;
      const state = kineticStateRef.current;
      const lastFrameTime = kineticLastFrameTimeRef.current;
      const runtime = runtimeRef.current;
      const syncFrame = syncFrameRef.current;
      if (!state || lastFrameTime === null || !runtime || !syncFrame) {
        cancelKineticPan();
        return;
      }

      const step = advanceMapsKineticPan(state, now - lastFrameTime);
      kineticStateRef.current = step.next;
      kineticLastFrameTimeRef.current = now;

      if (step.deltaX !== 0 || step.deltaY !== 0) {
        runtime.panBy(step.deltaX, step.deltaY);
        emitViewStateRef.current?.(syncFrame(), "pan");
      }

      if (step.next) {
        kineticFrameRef.current = requestAnimationFrame(tick);
      } else {
        kineticLastFrameTimeRef.current = null;
      }
    };

    kineticFrameRef.current = requestAnimationFrame(tick);
  }

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

      const rawSyncFrame = createFrameSynchronizer({
        canvas,
        images: imagesRef.current,
        loads: loadsRef.current,
        runtime,
        source: () => sourceRef.current,
        onError: (error) => onErrorRef.current?.(error),
      });
      const syncFrame = () => {
        const frame = rawSyncFrame();
        lastFrameRef.current = frame;
        return frame;
      };
      const emitViewState = (frame: MapsFlatRasterFrame, reason: MapViewStateChangeReason) => {
        const nextViewState = frameViewState(frame);
        lastEmittedViewStateRef.current = nextViewState;
        onViewStateChangeRef.current(nextViewState, reason);
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
          cancelKineticPan();
          const effectiveMaxZoom =
            options.maxZoom ?? normalizeMapMaxZoom(maxZoomRef.current) ?? MAX_MAP_ZOOM;
          runtime.fitBounds(bounds, options.padding ?? 0, effectiveMaxZoom);
          emitViewState(syncFrame(), options.reason ?? "fit-bounds");
        },
        getViewportAggregationQuery() {
          const frame = lastFrameRef.current ?? syncFrame();
          const bounds = frame.visibleBounds;
          return {
            bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
            zoom: frame.camera.zoom,
          };
        },
        project(coordinates) {
          const [x, y] = runtime.project(coordinates[0], coordinates[1]);
          return { x, y };
        },
        setViewState(next, reason = "programmatic") {
          cancelKineticPan();
          runtime.setViewState(next);
          emitViewState(syncFrame(), reason);
        },
        unproject(x, y) {
          return runtime.unproject(x, y);
        },
      };

      resizeObserver = new ResizeObserver(() => {
        cancelKineticPan();
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
      cancelKineticPan();
      onControllerReadyRef.current?.(null);
      syncFrameRef.current = null;
      lastFrameRef.current = null;
      emitViewStateRef.current = null;
      gestureRef.current.clear();
      velocityTrackerRef.current.clear();
      pointerTimesRef.current.clear();
      lastEmittedViewStateRef.current = null;
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

    const lastEmitted = lastEmittedViewStateRef.current;
    if (lastEmitted && areViewStatesEqual(lastEmitted, viewState)) {
      lastEmittedViewStateRef.current = null;
    } else {
      cancelKineticPan();
    }

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
      style={{ touchAction: "none" }}
      onContextMenu={(event) => {
        event.preventDefault();
        cancelKineticPan();
        const runtime = runtimeRef.current;
        if (!runtime) return;
        const position = pointerPosition(event.currentTarget, event.clientX, event.clientY);

        onContextMenuRef.current?.({
          coordinates: runtime.unproject(position.x, position.y),
          position,
        });
      }}
      onPointerDown={(event) => {
        if (!runtimeRef.current || (event.pointerType === "mouse" && event.button !== 0)) return;
        cancelKineticPan();
        velocityTrackerRef.current.clear();
        pointerTimesRef.current.set(event.pointerId, event.timeStamp);
        gestureRef.current.pointerDown(
          event.pointerId,
          pointerPosition(event.currentTarget, event.clientX, event.clientY),
        );
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const runtime = runtimeRef.current;
        const syncFrame = syncFrameRef.current;
        if (!runtime || !syncFrame) return;

        const previousTime = pointerTimesRef.current.get(event.pointerId);
        pointerTimesRef.current.set(event.pointerId, event.timeStamp);
        const delta = gestureRef.current.pointerMove(
          event.pointerId,
          pointerPosition(event.currentTarget, event.clientX, event.clientY),
        );
        if (!delta) return;

        if (delta.type === "pan") {
          if (previousTime !== undefined) {
            velocityTrackerRef.current.record(
              delta.deltaX,
              delta.deltaY,
              event.timeStamp - previousTime,
            );
          }
          runtime.panBy(delta.deltaX, delta.deltaY);
          emitViewStateRef.current?.(syncFrame(), "pan");
          return;
        }

        velocityTrackerRef.current.clear();
        if (delta.deltaX !== 0 || delta.deltaY !== 0) {
          runtime.panBy(delta.deltaX, delta.deltaY);
        }
        if (delta.deltaZoom !== 0) {
          const effectiveMaxZoom = normalizeMapMaxZoom(maxZoomRef.current) ?? MAX_MAP_ZOOM;
          runtime.zoomAbout(delta.deltaZoom, delta.x, delta.y, 0, effectiveMaxZoom);
        }
        emitViewStateRef.current?.(syncFrame(), delta.deltaZoom === 0 ? "pan" : "zoom");
      }}
      onPointerUp={(event) => {
        const lastMoveTime = pointerTimesRef.current.get(event.pointerId);
        pointerTimesRef.current.delete(event.pointerId);
        gestureRef.current.pointerUp(event.pointerId);

        if (gestureRef.current.pointerCount() === 0) {
          const velocity = velocityTrackerRef.current.release(
            lastMoveTime === undefined ? Number.POSITIVE_INFINITY : event.timeStamp - lastMoveTime,
          );
          if (velocity) startKineticPan(velocity);
        } else {
          velocityTrackerRef.current.clear();
        }
      }}
      onPointerCancel={(event) => {
        pointerTimesRef.current.delete(event.pointerId);
        gestureRef.current.pointerUp(event.pointerId);
        velocityTrackerRef.current.clear();
        cancelKineticPan();
      }}
      onWheel={(event) => {
        event.preventDefault();
        cancelKineticPan();
        velocityTrackerRef.current.clear();
        const runtime = runtimeRef.current;
        const syncFrame = syncFrameRef.current;
        if (!runtime || !syncFrame) return;
        const position = pointerPosition(event.currentTarget, event.clientX, event.clientY);
        const effectiveMaxZoom = normalizeMapMaxZoom(maxZoomRef.current) ?? MAX_MAP_ZOOM;

        runtime.zoomAbout(-event.deltaY * 0.0025, position.x, position.y, 0, effectiveMaxZoom);
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

function pointerPosition(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}
