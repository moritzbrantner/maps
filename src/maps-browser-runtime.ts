import { createMapsPointerGesture } from "./canvas-flat-gesture";
import {
  advanceMapsKineticPan,
  createMapsKineticPanState,
  createMapsPanVelocityTracker,
  type MapsKineticPanState,
  type MapsPanVelocity,
} from "./canvas-flat-inertia";
import { drawCanvasRasterTile } from "./canvas-raster-projective";
import {
  areMapsViewStatesEqual,
  createMapsViewStateEchoTracker,
} from "./canvas-flat-view-state-sync";
import {
  normalizeMapMaxZoom,
  resolveTileLayerOptions,
  type MapBounds,
  type MapFitBoundsOptions,
  type MapViewState,
  type MapViewStateChangeReason,
  type RasterMapStyle,
} from "./map-display";
import type { MapScreenInteractionState, MapScreenRenderFrame } from "./map-screen-render-frame";
import {
  loadMapsFlatRasterRuntime,
  type MapsFlatRasterFrame,
  type MapsFlatRasterRuntime,
  type MapsRasterTileId,
} from "./flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "./wgpu-application-frame";
import { loadMapsWgpuBaseMapRenderer, type MapsWgpuBaseMapRenderer } from "./wgpu-base-map-wasm";

const DEFAULT_TILE_SIZE = 256;
const DEFAULT_SOURCE_MAX_ZOOM = 19;
const MAX_MAP_ZOOM = 22;
const DEVICE_LOSS_POLL_MS = 250;
const CANVAS_PROJECTIVE_SUBDIVISIONS = 8;
const MAP_BACKGROUND = "#f9f4ee";
const RASTER_TILE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

type MapsCanvasFitBoundsOptions = MapFitBoundsOptions & {
  reason?: MapViewStateChangeReason;
};

type ScreenPoint = {
  x: number;
  y: number;
};

type MapsWgpuApplicationFrameFactory = (
  frame: MapScreenRenderFrame<unknown>,
  interaction: MapScreenInteractionState,
) => MapsWgpuApplicationFrame | null;

export type MapsCanvasFlatRuntimeController = {
  fitBounds(bounds: MapBounds, options?: MapsCanvasFitBoundsOptions): void;
  getViewState(): MapViewState;
  getVisibleBounds(): MapBounds;
  getVisibleTiles(): MapsRasterTileId[];
  project(coordinates: [longitude: number, latitude: number]): { x: number; y: number };
  projectPacked(coordinates: Float64Array): Float64Array;
  renderApplicationFrame(
    frame: MapScreenRenderFrame<unknown>,
    interaction?: MapScreenInteractionState,
  ): boolean;
  setViewState(viewState: MapViewState, reason?: MapViewStateChangeReason): void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
};

export type MapsBrowserRuntimeOptions = {
  /** Source, bounds and WASM identity are fixed for this host lifetime. */
  mapStyle: RasterMapStyle;
  maxBounds?: MapBounds;
  maxZoom?: number;
  /** Prepare Map Layers before presenting a changed Rust camera. */
  onCameraFrame?: () => void;
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

/** Browser resource/input owner. React is an optional lifecycle adapter. */
export function createMapsBrowserRuntime(
  canvas: HTMLCanvasElement,
  fallbackCanvas: HTMLCanvasElement,
  options: MapsBrowserRuntimeOptions,
) {
  let config = { ...options, viewState: copyViewState(options.viewState) };
  const identity = runtimeIdentity(config);
  const source = resolveTileLayerOptions(config.mapStyle);
  const maxBounds = config.maxBounds ? ([...config.maxBounds] as MapBounds) : undefined;
  const wasmPackage = config.wasmPackage;
  let cancelled = false;
  let resizeObserver: ResizeObserver | null = null;
  let disposeFrameSynchronizer: (() => void) | null = null;
  let activeRuntime: MapsFlatRasterRuntime | null = null;
  let activeRenderer: MapsWgpuBaseMapRenderer | null = null;
  let activeController: MapsCanvasFlatRuntimeController | null = null;
  let synchronize: (() => MapsFlatRasterFrame) | null = null;
  let emitViewState:
    | ((frame: MapsFlatRasterFrame, reason: MapViewStateChangeReason) => void)
    | null = null;
  const images = new Map<string, ImageBitmap>();
  const loads = new Map<string, ActiveTileLoad>();
  const gesture = createMapsPointerGesture();
  const velocityTracker = createMapsPanVelocityTracker();
  const pointerTimes = new Map<number, number>();
  const viewStateEchoTracker = createMapsViewStateEchoTracker();
  let kineticState: MapsKineticPanState | null = null;
  let kineticFrame: number | null = null;
  let kineticLastFrameTime: number | null = null;
  let kineticAnchor: ScreenPoint | null = null;
  let cameraFrame: number | null = null;
  let cameraReason: MapViewStateChangeReason | null = null;
  let cameraCommands: Array<() => void> = [];
  const wheelCanvas = canvas;

  function assertActive() {
    if (cancelled) throw new Error("Maps browser runtime is disposed.");
  }

  function setBaseRenderer(backend: "pending" | "wgpu" | "canvas2d") {
    canvas.dataset.mapBaseRenderer = backend;
    fallbackCanvas.style.visibility = backend === "canvas2d" ? "visible" : "hidden";
  }
  canvas.dataset.flatRuntime = "maps";
  canvas.dataset.mapBaseTiles = "0";
  canvas.style.touchAction = "none";
  fallbackCanvas.style.pointerEvents = "none";
  setBaseRenderer("pending");
  function cancelCameraFrame(preserveCommands = false) {
    if (cameraFrame !== null) cancelAnimationFrame(cameraFrame);
    cameraFrame = null;
    if (!preserveCommands) {
      cameraReason = null;
      cameraCommands = [];
    }
  }

  function applyCameraCommands() {
    const commands = cameraCommands;
    cameraCommands = [];
    for (const command of commands) {
      try {
        command();
      } catch (error) {
        config.onError?.(error);
      }
    }
  }

  function scheduleCameraFrame(reason: MapViewStateChangeReason, command?: () => void) {
    // Queue commands, never a second camera. Until this frame runs, data/hover
    // redraws still project against the camera used by the retained base frame.
    if (command) cameraCommands.push(command);
    cameraReason = reason;
    if (cameraFrame !== null) return;
    cameraFrame = requestAnimationFrame(() => {
      cameraFrame = null;
      const nextReason = cameraReason;
      cameraReason = null;
      const syncFrame = synchronize;
      if (!syncFrame || !nextReason) return;
      try {
        applyCameraCommands();
        emitViewState?.(syncFrame(), nextReason);
      } catch (error) {
        config.onError?.(error);
      }
    });
  }

  function cancelKineticPan() {
    if (kineticFrame !== null) {
      cancelAnimationFrame(kineticFrame);
    }
    kineticFrame = null;
    kineticState = null;
    kineticLastFrameTime = null;
    kineticAnchor = null;
    // A new gesture may interrupt inertia before its first tick drains the last
    // drag commands. Return those commands to the normal presentation queue.
    if (cameraCommands.length > 0 && cameraFrame === null) {
      scheduleCameraFrame(cameraReason ?? "pan");
    }
  }

  function startKineticPan(velocity: MapsPanVelocity, anchor: ScreenPoint) {
    cancelKineticPan();
    const initial = createMapsKineticPanState(velocity);
    if (!initial) return;
    // The first kinetic frame drains the final drag commands before inertia.
    cancelCameraFrame(true);

    kineticState = initial;
    kineticLastFrameTime = performance.now();
    kineticAnchor = anchor;

    const tick = (now: number) => {
      kineticFrame = null;
      const state = kineticState;
      const lastFrameTime = kineticLastFrameTime;
      const previousAnchor = kineticAnchor;
      const runtime = activeRuntime;
      const syncFrame = synchronize;
      if (!state || lastFrameTime === null || !previousAnchor || !runtime || !syncFrame) {
        cancelKineticPan();
        return;
      }

      const hadCommands = cameraCommands.length > 0;
      applyCameraCommands();
      cameraReason = null;
      const step = advanceMapsKineticPan(state, now - lastFrameTime);
      kineticState = step.next;
      kineticLastFrameTime = now;

      if (step.deltaX !== 0 || step.deltaY !== 0) {
        const currentAnchor = {
          x: previousAnchor.x + step.deltaX,
          y: previousAnchor.y + step.deltaY,
        };
        try {
          runtime.panBetween(previousAnchor.x, previousAnchor.y, currentAnchor.x, currentAnchor.y);
        } catch (error) {
          cancelKineticPan();
          config.onError?.(error);
          return;
        }
        kineticAnchor = currentAnchor;
      }
      if (hadCommands || step.deltaX !== 0 || step.deltaY !== 0) {
        emitViewState?.(syncFrame(), "pan");
      }

      if (step.next) {
        kineticFrame = requestAnimationFrame(tick);
      } else {
        kineticLastFrameTime = null;
        kineticAnchor = null;
      }
    };

    kineticFrame = requestAnimationFrame(tick);
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    cancelKineticPan();
    velocityTracker.clear();
    const runtime = activeRuntime;
    const syncFrame = synchronize;
    if (!runtime || !syncFrame || !wheelCanvas) return;
    const position = pointerPosition(wheelCanvas, event.clientX, event.clientY);
    const effectiveMaxZoom = normalizeMapMaxZoom(config.maxZoom) ?? MAX_MAP_ZOOM;

    try {
      const deltaZoom = -event.deltaY * 0.0025;
      scheduleCameraFrame("zoom", () => {
        runtime.zoomAbout(deltaZoom, position.x, position.y, 0, effectiveMaxZoom);
      });
    } catch (error) {
      config.onError?.(error);
    }
  }

  async function initialize() {
    resizeCanvasBackingStore(canvas);
    resizeCanvasBackingStore(fallbackCanvas);
    const size = getCanvasCssSize(canvas);
    const initialViewState = copyViewState(config.viewState);
    const currentSource = source;
    const runtime = await loadMapsFlatRasterRuntime(
      {
        bearing: config.viewState.bearing ?? 0,
        center: config.viewState.center,
        height: size.height,
        maxBounds,
        pitch: config.viewState.pitch ?? 0,
        source: {
          maxZoom: Math.round(currentSource?.options.maxZoom ?? DEFAULT_SOURCE_MAX_ZOOM),
          minZoom: Math.round(currentSource?.options.minZoom ?? 0),
          tileSize: Math.round(currentSource?.options.tileSize ?? DEFAULT_TILE_SIZE),
        },
        width: size.width,
        zoom: config.viewState.zoom,
      },
      wasmPackage,
    );

    if (cancelled) {
      runtime.dispose();
      return;
    }

    activeRuntime = runtime;
    let renderer: MapsWgpuBaseMapRenderer | null = null;
    let packApplicationFrame: MapsWgpuApplicationFrameFactory | null = null;
    try {
      renderer = await loadMapsWgpuBaseMapRenderer(canvas, wasmPackage);
      packApplicationFrame = (await import("./wgpu-application-frame"))
        .createMapsWgpuApplicationFrame;
      delete canvas.dataset.mapBaseRendererError;
    } catch (error) {
      canvas.dataset.mapBaseRendererError = error instanceof Error ? error.message : String(error);
      renderer?.dispose();
      renderer = null;
      packApplicationFrame = null;
    }

    if (cancelled) {
      renderer?.dispose();
      return;
    }

    activeRuntime = runtime;
    activeRenderer = renderer;

    // Loading can span committed configuration and layout changes. Apply the
    // latest request before the first frame/ready notification, not in a
    // React effect that may already have returned while loading.
    if (!areMapsViewStatesEqual(initialViewState, config.viewState)) {
      runtime.setViewState(config.viewState);
    }
    const latestSize = getCanvasCssSize(canvas);
    if (latestSize.width !== size.width || latestSize.height !== size.height) {
      resizeCanvasBackingStore(canvas);
      resizeCanvasBackingStore(fallbackCanvas);
      renderer?.resize(canvas.width, canvas.height);
      runtime.resize(latestSize.width, latestSize.height);
    }
    setBaseRenderer(renderer ? "wgpu" : "canvas2d");

    const activateCanvasFallback = () => {
      activeRenderer?.dispose();
      activeRenderer = null;
      setBaseRenderer("canvas2d");
    };

    const frameSynchronizer = createFrameSynchronizer({
      canvas,
      fallbackCanvas,
      images: images,
      loads: loads,
      packApplicationFrame,
      renderer: () => activeRenderer,
      runtime,
      source: () => source,
      onError: (error) => config.onError?.(error),
      onRendererFailure: activateCanvasFallback,
      onCameraFrame: () => config.onCameraFrame?.(),
    });
    const syncFrame = frameSynchronizer.syncFrame;
    disposeFrameSynchronizer = frameSynchronizer.dispose;
    const notifyViewState = (frame: MapsFlatRasterFrame, reason: MapViewStateChangeReason) => {
      const nextViewState = frameViewState(frame);
      viewStateEchoTracker.record(nextViewState);
      config.onViewStateChange(nextViewState, reason);
    };
    const emitConstraintCorrection = (
      frame: MapsFlatRasterFrame,
      reason: MapViewStateChangeReason,
    ) => {
      if (!areMapsViewStatesEqual(frameViewState(frame), config.viewState)) {
        notifyViewState(frame, reason);
      }
    };

    synchronize = syncFrame;
    emitViewState = notifyViewState;

    const controller: MapsCanvasFlatRuntimeController = {
      fitBounds(bounds, options = {}) {
        assertActive();
        cancelKineticPan();
        cancelCameraFrame();
        const effectiveMaxZoom =
          options.maxZoom ?? normalizeMapMaxZoom(config.maxZoom) ?? MAX_MAP_ZOOM;
        runtime.fitBounds(bounds, options.padding ?? 0, effectiveMaxZoom);
        notifyViewState(syncFrame(), options.reason ?? "fit-bounds");
      },
      getViewState() {
        assertActive();
        return frameSynchronizer.getViewState();
      },
      getVisibleBounds() {
        assertActive();
        const bounds = frameSynchronizer.getVisibleBounds();
        return [bounds.west, bounds.south, bounds.east, bounds.north];
      },
      getVisibleTiles() {
        assertActive();
        return frameSynchronizer.getVisibleTiles();
      },
      project(coordinates) {
        assertActive();
        const [x, y] = runtime.project(coordinates[0], coordinates[1]);
        return { x, y };
      },
      projectPacked(coordinates) {
        assertActive();
        return runtime.projectPacked(coordinates);
      },
      renderApplicationFrame(frame, interaction = {}) {
        if (cancelled) return false;
        return frameSynchronizer.setApplicationFrame(frame, interaction);
      },
      setViewState(next, reason = "programmatic") {
        assertActive();
        cancelKineticPan();
        cancelCameraFrame();
        runtime.setViewState(next);
        notifyViewState(syncFrame(), reason);
      },
      unproject(x, y) {
        assertActive();
        return runtime.unproject(x, y);
      },
    };

    activeController = controller;
    resizeObserver = new ResizeObserver(() => {
      cancelKineticPan();
      cancelCameraFrame();
      const nextSize = getCanvasCssSize(canvas);
      resizeCanvasBackingStore(canvas);
      resizeCanvasBackingStore(fallbackCanvas);
      try {
        activeRenderer?.resize(canvas.width, canvas.height);
      } catch {
        activateCanvasFallback();
      }
      runtime.resize(nextSize.width, nextSize.height);
      emitConstraintCorrection(syncFrame(), "prop-change");
    });
    resizeObserver.observe(canvas);

    emitConstraintCorrection(syncFrame(), "initial");
    config.onControllerReady?.(controller);
    config.onReady?.();
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    cancelKineticPan();
    const runtime = activeRuntime;
    if (!runtime) return;
    const position = pointerPosition(canvas, event.clientX, event.clientY);

    config.onContextMenu?.({
      coordinates: runtime.unproject(position.x, position.y),
      position,
    });
  }
  function handlePointerDown(event: PointerEvent) {
    if (!activeRuntime || (event.pointerType === "mouse" && event.button !== 0)) return;
    cancelKineticPan();
    velocityTracker.clear();
    pointerTimes.set(event.pointerId, event.timeStamp);
    gesture.pointerDown(event.pointerId, pointerPosition(canvas, event.clientX, event.clientY));
    canvas.setPointerCapture(event.pointerId);
  }
  function handlePointerMove(event: PointerEvent) {
    if (!pointerTimes.has(event.pointerId)) return;
    const runtime = activeRuntime;
    const syncFrame = synchronize;
    if (!runtime || !syncFrame) return;

    const previousTime = pointerTimes.get(event.pointerId);
    pointerTimes.set(event.pointerId, event.timeStamp);
    const delta = gesture.pointerMove(
      event.pointerId,
      pointerPosition(canvas, event.clientX, event.clientY),
    );
    if (!delta) return;

    try {
      if (delta.type === "pan") {
        if (previousTime !== undefined) {
          velocityTracker.record(delta.deltaX, delta.deltaY, event.timeStamp - previousTime);
        }
        scheduleCameraFrame("pan", () => {
          runtime.panBetween(delta.previousX, delta.previousY, delta.x, delta.y);
        });
        return;
      }

      velocityTracker.clear();
      const effectiveMaxZoom = normalizeMapMaxZoom(config.maxZoom) ?? MAX_MAP_ZOOM;
      scheduleCameraFrame(delta.deltaZoom === 0 ? "pan" : "zoom", () => {
        if (delta.deltaX !== 0 || delta.deltaY !== 0) {
          runtime.panBetween(delta.previousX, delta.previousY, delta.x, delta.y);
        }
        if (delta.deltaZoom !== 0) {
          runtime.zoomAbout(delta.deltaZoom, delta.x, delta.y, 0, effectiveMaxZoom);
        }
      });
    } catch (error) {
      velocityTracker.clear();
      config.onError?.(error);
    }
  }
  function handlePointerUp(event: PointerEvent) {
    if (!pointerTimes.has(event.pointerId)) return;
    const lastMoveTime = pointerTimes.get(event.pointerId);
    pointerTimes.delete(event.pointerId);
    gesture.pointerUp(event.pointerId);

    if (gesture.pointerCount() === 0) {
      const velocity = velocityTracker.release(
        lastMoveTime === undefined ? Number.POSITIVE_INFINITY : event.timeStamp - lastMoveTime,
      );
      if (velocity) {
        startKineticPan(velocity, pointerPosition(canvas, event.clientX, event.clientY));
      }
    } else {
      velocityTracker.clear();
    }
  }
  function handlePointerCancel(event: PointerEvent) {
    if (!pointerTimes.has(event.pointerId)) return;
    pointerTimes.delete(event.pointerId);
    gesture.pointerUp(event.pointerId);
    velocityTracker.clear();
    cancelKineticPan();
  }
  function update(next: MapsBrowserRuntimeOptions) {
    if (cancelled) return;
    if (runtimeIdentity(next) !== identity) {
      throw new Error(
        "Source, bounds or WASM changed: dispose and recreate the Maps browser runtime.",
      );
    }
    const previous = config.viewState;
    config = { ...next, viewState: copyViewState(next.viewState) };
    if (
      !activeController ||
      !activeRuntime ||
      !synchronize ||
      areMapsViewStatesEqual(previous, config.viewState)
    )
      return;
    if (viewStateEchoTracker.acknowledge(config.viewState)) return;
    viewStateEchoTracker.clear();
    cancelKineticPan();
    cancelCameraFrame();
    activeRuntime.setViewState(config.viewState);
    const frame = synchronize();
    if (!areMapsViewStatesEqual(frameViewState(frame), config.viewState)) {
      emitViewState?.(frame, "prop-change");
    }
  }
  function dispose() {
    if (cancelled) return;
    cancelled = true;
    activeController = null;
    canvas.removeEventListener("wheel", handleWheel);
    resizeObserver?.disconnect();
    disposeFrameSynchronizer?.();
    cancelKineticPan();
    cancelCameraFrame();
    config.onControllerReady?.(null);
    synchronize = null;
    emitViewState = null;
    gesture.clear();
    velocityTracker.clear();
    pointerTimes.clear();
    viewStateEchoTracker.clear();
    for (const load of loads.values()) load.abort.abort();
    loads.clear();
    for (const image of images.values()) image.close();
    images.clear();
    activeRenderer?.dispose();
    activeRenderer = null;
    activeRuntime?.dispose();
    activeRuntime = null;
    canvas.removeEventListener("contextmenu", handleContextMenu);
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", handlePointerUp);
    canvas.removeEventListener("pointercancel", handlePointerCancel);
  }
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  canvas.addEventListener("contextmenu", handleContextMenu);
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerCancel);
  const ready = initialize().catch((error: unknown) => {
    if (!cancelled) {
      const onError = config.onError;
      dispose();
      onError?.(error);
    }
  });
  return {
    ready,
    update,
    dispose,
    get controller() {
      return activeController;
    },
  };
}

function copyViewState(state: MapViewState): MapViewState {
  return { ...state, center: [state.center[0], state.center[1]] };
}

/** Identity is data-only; evaluating it never mutates a live runtime. */
export function runtimeIdentity(options: MapsBrowserRuntimeOptions) {
  const source = resolveTileLayerOptions(options.mapStyle);
  return JSON.stringify([
    source?.url,
    source?.options.minZoom,
    source?.options.maxZoom,
    source?.options.tileSize,
    options.maxBounds,
    options.wasmPackage,
  ]);
}

function createFrameSynchronizer({
  canvas,
  fallbackCanvas,
  images,
  loads,
  packApplicationFrame,
  renderer,
  runtime,
  source,
  onError,
  onRendererFailure,
  onCameraFrame,
}: {
  canvas: HTMLCanvasElement;
  fallbackCanvas: HTMLCanvasElement;
  images: Map<string, ImageBitmap>;
  loads: Map<string, ActiveTileLoad>;
  packApplicationFrame: MapsWgpuApplicationFrameFactory | null;
  renderer: () => MapsWgpuBaseMapRenderer | null;
  runtime: MapsFlatRasterRuntime;
  source: () => ReturnType<typeof resolveTileLayerOptions>;
  onError: (error: unknown) => void;
  onRendererFailure: () => void;
  onCameraFrame: () => void;
}) {
  let disposed = false;
  let rendererRetryFrame: number | null = null;
  let deviceLossMonitorTimer: number | null = null;
  let lastFrame: MapsFlatRasterFrame | null = null;
  let applicationFrame: MapsWgpuApplicationFrame | null = null;
  let preparingCameraFrame = false;

  function cancelRendererRetry() {
    if (rendererRetryFrame !== null) {
      cancelAnimationFrame(rendererRetryFrame);
      rendererRetryFrame = null;
    }
  }

  function cancelDeviceLossMonitor() {
    if (deviceLossMonitorTimer !== null) {
      window.clearInterval(deviceLossMonitorTimer);
      deviceLossMonitorTimer = null;
    }
  }

  function startDeviceLossMonitor() {
    if (disposed || deviceLossMonitorTimer !== null || !renderer()) return;
    deviceLossMonitorTimer = window.setInterval(() => {
      if (disposed) return;
      const currentRenderer = renderer();
      if (!currentRenderer) {
        cancelDeviceLossMonitor();
        return;
      }
      try {
        if (!currentRenderer.isDeviceLost()) return;
      } catch {
        // Treat an unreadable renderer state as renderer failure below.
      }

      const retainedFrame = lastFrame ?? syncFrame();
      failRenderer();
      canvas.dataset.mapBaseTiles = String(drawCanvasFrame(fallbackCanvas, images, retainedFrame));
    }, DEVICE_LOSS_POLL_MS);
  }

  function scheduleRendererRetry() {
    if (disposed || rendererRetryFrame !== null) return;
    rendererRetryFrame = requestAnimationFrame(() => {
      rendererRetryFrame = null;
      if (!disposed && lastFrame) renderFrame(lastFrame);
    });
  }

  function failRenderer() {
    cancelRendererRetry();
    cancelDeviceLossMonitor();
    if (!renderer()) return;
    onRendererFailure();
    // Device loss also invalidates the layer backend, even on an idle camera.
    prepareCameraLayers();
  }

  startDeviceLossMonitor();
  fallbackCanvas.addEventListener("contextrestored", restoreCanvasFrame);

  function restoreCanvasFrame() {
    if (lastFrame) renderFrame(lastFrame);
  }

  function prepareCameraLayers() {
    preparingCameraFrame = true;
    try {
      onCameraFrame();
    } finally {
      preparingCameraFrame = false;
    }
  }

  function presentFrame(frame: MapsFlatRasterFrame) {
    const previous = lastFrame?.camera;
    const camera = frame.camera;
    const cameraChanged =
      !previous ||
      previous.width !== camera.width ||
      previous.height !== camera.height ||
      previous.center[0] !== camera.center[0] ||
      previous.center[1] !== camera.center[1] ||
      previous.zoom !== camera.zoom ||
      previous.bearing !== camera.bearing ||
      previous.pitch !== camera.pitch;
    // Reads made by layer preparation must see this same Rust snapshot. Packing
    // the application frame here must not recursively submit an older base frame.
    lastFrame = frame;
    if (cameraChanged) prepareCameraLayers();
    renderFrame(frame);
  }

  function renderFrame(frame: MapsFlatRasterFrame) {
    if (disposed) return;
    lastFrame = frame;
    const currentRenderer = renderer();
    if (currentRenderer) {
      try {
        const drawnTiles = currentRenderer.render(
          frame.placements,
          frame.renderCamera,
          applicationFrame,
        );
        const hasDecodedVisibleTile = frame.placements.some((placement) =>
          images.has(placement.tile.key),
        );
        if (drawnTiles === 0 && hasDecodedVisibleTile) {
          scheduleRendererRetry();
          return;
        }
        cancelRendererRetry();
        canvas.dataset.mapBaseTiles = String(drawnTiles);
        return;
      } catch {
        failRenderer();
      }
    }

    cancelRendererRetry();
    canvas.dataset.mapBaseTiles = String(drawCanvasFrame(fallbackCanvas, images, frame));
  }

  function setApplicationFrame(
    frame: MapScreenRenderFrame<unknown>,
    interaction: MapScreenInteractionState,
  ) {
    const currentRenderer = renderer();
    if (!currentRenderer || !packApplicationFrame) {
      applicationFrame = null;
      return false;
    }

    const next = packApplicationFrame(frame, interaction);
    applicationFrame = next;
    if (!preparingCameraFrame) {
      if (lastFrame) renderFrame(lastFrame);
      else syncFrame();
    }
    return next !== null && renderer() !== null;
  }

  function syncFrame(): MapsFlatRasterFrame {
    let frame = runtime.frame();

    for (const tile of frame.cancellations) {
      loads.get(tile.key)?.abort.abort();
      loads.delete(tile.key);
    }
    for (const tile of frame.evictions) {
      const currentRenderer = renderer();
      if (currentRenderer) {
        try {
          currentRenderer.evictTile(tile.key);
        } catch {
          failRenderer();
        }
      }
      images.get(tile.key)?.close();
      images.delete(tile.key);
    }

    const currentSource = source();
    if (!currentSource) {
      while (frame.requests.length > 0) {
        for (const tile of frame.requests) runtime.markLoaded(tile);
        frame = runtime.frame();
      }
      presentFrame(frame);
      return frame;
    }

    presentFrame(frame);

    for (const tile of frame.requests) {
      if (loads.has(tile.key) || images.has(tile.key)) continue;
      const abort = new AbortController();
      const load = { abort, tile };
      loads.set(tile.key, load);

      loadRasterTile(buildRasterTileUrl(currentSource.url, tile), abort.signal)
        .then(
          (image) => {
            // A cancelled fetch/decode may finish after this tile has been
            // requested again, or after the Map View has changed its source.
            if (disposed || abort.signal.aborted || loads.get(tile.key) !== load) {
              image.close();
              return;
            }
            loads.delete(tile.key);

            images.set(tile.key, image);
            delete canvas.dataset.mapBaseTileError;
            const currentRenderer = renderer();
            if (currentRenderer) {
              try {
                currentRenderer.uploadTile(tile.key, image);
              } catch {
                failRenderer();
              }
            }
            runtime.markLoaded(tile);
            syncFrame();
          },
          (error) => {
            if (disposed || abort.signal.aborted || loads.get(tile.key) !== load) return;
            loads.delete(tile.key);
            runtime.markFailed(tile);
            canvas.dataset.mapBaseTileError =
              error instanceof Error ? error.message : String(error);
            syncFrame();
            throw error;
          },
        )
        .catch((error) => {
          if (!disposed) onError(error);
        });
    }

    return frame;
  }

  return {
    dispose() {
      disposed = true;
      fallbackCanvas.removeEventListener("contextrestored", restoreCanvasFrame);
      cancelRendererRetry();
      cancelDeviceLossMonitor();
      lastFrame = null;
      applicationFrame = null;
    },
    getViewState() {
      return frameViewState(lastFrame ?? syncFrame());
    },
    getVisibleBounds() {
      return (lastFrame ?? syncFrame()).visibleBounds;
    },
    getVisibleTiles() {
      const frame = lastFrame ?? syncFrame();
      const unique = new Map<string, MapsRasterTileId>();
      for (const placement of frame.placements) {
        unique.set(placement.tile.key, placement.tile);
      }
      return [...unique.values()];
    },
    setApplicationFrame,
    syncFrame,
  };
}

function frameViewState(frame: MapsFlatRasterFrame): MapViewState {
  const viewState: MapViewState = {
    center: frame.camera.center,
    zoom: frame.camera.zoom,
  };

  if (frame.camera.bearing !== 0) {
    viewState.bearing = frame.camera.bearing;
  }
  if (frame.camera.pitch !== 0) {
    viewState.pitch = frame.camera.pitch;
  }

  return viewState;
}

async function loadRasterTile(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: {
      Accept: RASTER_TILE_ACCEPT,
    },
    signal,
  });
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

function drawCanvasFrame(
  canvas: HTMLCanvasElement,
  images: Map<string, ImageBitmap>,
  frame: MapsFlatRasterFrame,
) {
  const context = canvas.getContext("2d");
  if (!context) return 0;

  const ratio = Math.max(1, window.devicePixelRatio || 1);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = MAP_BACKGROUND;
  context.fillRect(0, 0, frame.camera.width, frame.camera.height);

  const viewport = { height: frame.camera.height, width: frame.camera.width };
  const subdivisions = frame.camera.pitch === 0 ? 1 : CANVAS_PROJECTIVE_SUBDIVISIONS;
  let drawnTiles = 0;
  for (const placement of frame.placements) {
    const image = images.get(placement.tile.key);
    if (!image) continue;
    if (
      drawCanvasRasterTile(
        context,
        image,
        placement,
        frame.renderCamera,
        viewport,
        ratio,
        subdivisions,
      )
    ) {
      drawnTiles += 1;
    }
  }

  return drawnTiles;
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
