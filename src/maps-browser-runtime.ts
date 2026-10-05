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
  type MapsFlatRasterRuntimeConfig,
  type MapsRasterTileId,
} from "./flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "./wgpu-application-frame";
import {
  loadMapsWgpuBaseMapRenderer,
  type MapsWgpuBaseMapRenderer,
  type MapsWgpuFrameStats,
} from "./wgpu-base-map-wasm";

const DEFAULT_TILE_SIZE = 256;
const DEFAULT_SOURCE_MAX_ZOOM = 19;
const MAX_MAP_ZOOM = 22;
const DEVICE_LOSS_POLL_MS = 250;
const CANVAS_PROJECTIVE_SUBDIVISIONS = 8;
const MAP_BACKGROUND = "#f9f4ee";
const RASTER_TILE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
/**
 * Default overscan of the base canvases beyond the viewport, CSS px per side. Pure pans
 * within it are presented by compositor translation of the retained frame.
 */
const DEFAULT_RENDER_MARGIN = 128;
/**
 * Quiet time without camera motion before a translated frame is re-rendered crisply.
 * Pointer input is not frame-aligned, so a single idle frame is not "motion stopped".
 */
const SETTLE_DELAY_MS = 100;
/** Degrees of bearing per CSS pixel of horizontal mouse-rotate drag (MapLibre-compatible). */
const MOUSE_ROTATE_DEGREES_PER_PX = 0.8;
/** Pointer travel before a right-drag counts as rotation instead of a context-menu click. */
const MOUSE_ROTATE_CLICK_TOLERANCE_PX = 3;
/** A contextmenu arriving this soon after a rotate drag belongs to that drag (Windows order). */
const CONTEXT_MENU_AFTER_ROTATE_MS = 250;

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

export type MapsBaseRenderer = "pending" | "wgpu" | "canvas2d";

/**
 * Vector basemap retained on the GPU (WebGPU backend only). Rust decodes and
 * tessellates each tile once; camera frames only update per-tile uniforms. Tiles
 * are drawn above raster tiles and beneath application geometry.
 */
export type MapsRetainedVectorBasemap = {
  evictTile(tile: MapsRasterTileId): void;
  setMaxZoom(maxZoom: number): void;
  /** Style table from `createMapsVectorBasemapStyleTable`. */
  setStyle(table: Float32Array): void;
  /** Retains Shortbread MVT bytes for `tile`; returns the decoded feature count. */
  uploadTile(tile: MapsRasterTileId, bytes: Uint8Array): number;
};

/** Descriptive renderer observations for inspection tooling; not a correctness contract. */
export type MapsRendererStats = Partial<MapsWgpuFrameStats> & {
  backend: MapsBaseRenderer;
  /** Main-thread time of the last base render call (encode + submit), ms. */
  lastRenderMs: number;
  /** Full base renders since the runtime started. */
  renders: number;
  /** Camera frames presented by translating the retained render instead. */
  translatedFrames: number;
};

export type MapsCanvasFlatRuntimeController = {
  fitBounds(bounds: MapBounds, options?: MapsCanvasFitBoundsOptions): void;
  getBaseRenderer(): MapsBaseRenderer;
  getRendererStats(): MapsRendererStats;
  /** The GPU-retained vector basemap, or `null` without the WebGPU backend. */
  getRetainedVectorBasemap(): MapsRetainedVectorBasemap | null;
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
  /** Called when the base renderer changes, e.g. WebGPU device loss falls back to Canvas. */
  subscribeBaseRenderer(listener: (renderer: MapsBaseRenderer) => void): () => void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
};

/** A runtime-owned decoder for tile images; Rust still owns scheduling and tile identity. */
export type MapsTileImageLoader = {
  /** Rust validates and enforces the decoded-image retention and load budgets. */
  limits?: MapsFlatRasterRuntimeConfig["limits"];
  load(url: string, tile: MapsRasterTileId, signal: AbortSignal): Promise<ImageBitmap>;
  dispose(): void;
};

export type MapsBrowserRuntimeOptions = {
  /** Source, bounds and WASM identity are fixed for this host lifetime. */
  mapStyle: RasterMapStyle;
  createTileImageLoader?: () => MapsTileImageLoader;
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
  /**
   * CSS px the base canvases extend beyond the viewport on every side (default 128, 0
   * disables). With it, pure pans are presented by translating the retained frame
   * instead of re-rendering. The host positions/sizes the canvases and clips their
   * parent; measure the map container, not the base canvas, for viewport geometry.
   */
  renderMargin?: number;
  viewState: MapViewState;
  wasmPackage?: string;
};

type MouseRotation = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  moved: boolean;
  /** Linux/macOS fire contextmenu on press; deliver it on release unless rotated. */
  pendingContextMenu: ScreenPoint | null;
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
  const tileImageLoader = options.createTileImageLoader?.();
  const maxBounds = config.maxBounds ? ([...config.maxBounds] as MapBounds) : undefined;
  const wasmPackage = config.wasmPackage;
  const renderMargin = normalizeRenderMargin(config.renderMargin);
  const surfaceTranslation = { x: 0, y: 0 };
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
  let mouseRotation: MouseRotation | null = null;
  let lastRotationEnd: { moved: boolean; time: number } | null = null;
  const viewStateEchoTracker = createMapsViewStateEchoTracker();
  let kineticState: MapsKineticPanState | null = null;
  let kineticFrame: number | null = null;
  let kineticLastFrameTime: number | null = null;
  let kineticAnchor: ScreenPoint | null = null;
  let cameraFrame: number | null = null;
  let cameraReason: MapViewStateChangeReason | null = null;
  let cameraCommands: Array<() => void> = [];

  function assertActive() {
    if (cancelled) throw new Error("Maps browser runtime is disposed.");
  }

  let baseRenderer: MapsBaseRenderer = "pending";
  const baseRendererListeners = new Set<(renderer: MapsBaseRenderer) => void>();
  function setBaseRenderer(backend: MapsBaseRenderer) {
    canvas.dataset.mapBaseRenderer = backend;
    fallbackCanvas.style.visibility = backend === "canvas2d" ? "visible" : "hidden";
    if (backend === baseRenderer) return;
    baseRenderer = backend;
    for (const listener of [...baseRendererListeners]) {
      try {
        listener(backend);
      } catch (error) {
        config.onError?.(error);
      }
    }
  }
  canvas.dataset.flatRuntime = "maps";
  canvas.dataset.mapBaseTiles = "0";
  canvas.style.touchAction = "none";
  fallbackCanvas.style.pointerEvents = "none";
  setBaseRenderer("pending");
  const restoreSurfaceGeometry = applySurfaceGeometry([canvas, fallbackCanvas], renderMargin);

  /** Presents the retained base frame shifted by (x, y) CSS px; compositor-only. */
  function setSurfaceTranslation(x: number, y: number) {
    if (surfaceTranslation.x === x && surfaceTranslation.y === y) return;
    surfaceTranslation.x = x;
    surfaceTranslation.y = y;
    const transform = x === 0 && y === 0 ? "" : `translate(${x}px, ${y}px)`;
    canvas.style.transform = transform;
    fallbackCanvas.style.transform = transform;
  }
  function viewportSize() {
    const surface = getCanvasCssSize(canvas);
    return {
      height: Math.max(1, surface.height - 2 * renderMargin),
      width: Math.max(1, surface.width - 2 * renderMargin),
    };
  }
  function pointerPosition(clientX: number, clientY: number) {
    // The canvas box starts `renderMargin` before the viewport and may be translated.
    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left + surfaceTranslation.x - renderMargin,
      y: clientY - rect.top + surfaceTranslation.y - renderMargin,
    };
  }
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
    if (!runtime || !syncFrame) return;
    const position = pointerPosition(event.clientX, event.clientY);
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
    const size = viewportSize();
    const initialViewState = copyViewState(config.viewState);
    const currentSource = source;
    const runtime = await loadMapsFlatRasterRuntime(
      {
        bearing: config.viewState.bearing ?? 0,
        center: config.viewState.center,
        height: size.height,
        maxBounds,
        pitch: config.viewState.pitch ?? 0,
        renderMargin,
        limits: tileImageLoader?.limits,
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
      // One packer per renderer: it reuses its typed transport buffers and paint cache.
      const packer = (await import("./wgpu-application-frame")).createMapsWgpuApplicationFramePacker();
      packApplicationFrame = (frame, interaction) => packer.pack(frame, interaction);
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
    const latestSize = viewportSize();
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
      loadTile: (url, tile, signal) =>
        tileImageLoader ? tileImageLoader.load(url, tile, signal) : loadRasterTile(url, signal),
      canvas,
      fallbackCanvas,
      images: images,
      loads: loads,
      packApplicationFrame,
      renderer: () => activeRenderer,
      renderMargin,
      runtime,
      setSurfaceTranslation,
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

    const retainedVectorBasemap: MapsRetainedVectorBasemap = {
      evictTile(tile) {
        activeRenderer?.evictVectorTile(tile);
        frameSynchronizer.requestRender();
      },
      setMaxZoom(maxZoom) {
        activeRenderer?.setVectorMaxZoom(maxZoom);
        frameSynchronizer.requestRender();
      },
      setStyle(table) {
        activeRenderer?.setVectorStyle(table);
        frameSynchronizer.requestRender();
      },
      uploadTile(tile, bytes) {
        const renderer = activeRenderer;
        if (!renderer) return 0;
        const features = renderer.uploadVectorTile(tile, bytes);
        frameSynchronizer.requestRender();
        return features;
      },
    };

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
      getBaseRenderer() {
        return baseRenderer;
      },
      getRendererStats() {
        assertActive();
        return { backend: baseRenderer, ...frameSynchronizer.getStats() };
      },
      getRetainedVectorBasemap() {
        assertActive();
        return activeRenderer ? retainedVectorBasemap : null;
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
      subscribeBaseRenderer(listener) {
        baseRendererListeners.add(listener);
        return () => baseRendererListeners.delete(listener);
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
      const nextSize = viewportSize();
      // Assigning a canvas size clears it: the retained frame is gone even when
      // the camera is not (the initial observation, a devicePixelRatio change).
      const baseReset = resizeCanvasBackingStore(canvas);
      const fallbackReset = resizeCanvasBackingStore(fallbackCanvas);
      if (baseReset || fallbackReset) frameSynchronizer.invalidatePixels();
      try {
        if (baseReset) activeRenderer?.resize(canvas.width, canvas.height);
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
    const position = pointerPosition(event.clientX, event.clientY);
    if (mouseRotation) {
      mouseRotation.pendingContextMenu = position;
      return;
    }
    if (
      lastRotationEnd?.moved &&
      performance.now() - lastRotationEnd.time <= CONTEXT_MENU_AFTER_ROTATE_MS
    ) {
      return;
    }
    emitContextMenu(position);
  }
  function emitContextMenu(position: ScreenPoint) {
    const runtime = activeRuntime;
    if (!runtime) return;
    try {
      config.onContextMenu?.({
        coordinates: runtime.unproject(position.x, position.y),
        position,
      });
    } catch (error) {
      config.onError?.(error);
    }
  }
  function isMouseRotateStart(event: PointerEvent) {
    return (
      event.pointerType === "mouse" &&
      (event.button === 2 || (event.button === 0 && event.ctrlKey)) &&
      // Bounded cameras are north-up by contract (Rust rejects rotation there).
      !maxBounds
    );
  }
  function handlePointerDown(event: PointerEvent) {
    if (!activeRuntime) return;
    if (isMouseRotateStart(event)) {
      if (mouseRotation || gesture.pointerCount() > 0) return;
      cancelKineticPan();
      velocityTracker.clear();
      const position = pointerPosition(event.clientX, event.clientY);
      mouseRotation = {
        pointerId: event.pointerId,
        startX: position.x,
        startY: position.y,
        lastX: position.x,
        moved: false,
        pendingContextMenu: null,
      };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelKineticPan();
    velocityTracker.clear();
    pointerTimes.set(event.pointerId, event.timeStamp);
    gesture.pointerDown(event.pointerId, pointerPosition(event.clientX, event.clientY));
    canvas.setPointerCapture(event.pointerId);
  }
  function handleMouseRotateMove(rotation: MouseRotation, event: PointerEvent) {
    const runtime = activeRuntime;
    if (!runtime) return;
    const position = pointerPosition(event.clientX, event.clientY);
    if (
      !rotation.moved &&
      Math.hypot(position.x - rotation.startX, position.y - rotation.startY) <
        MOUSE_ROTATE_CLICK_TOLERANCE_PX
    ) {
      return;
    }
    rotation.moved = true;
    const deltaX = position.x - rotation.lastX;
    rotation.lastX = position.x;
    if (deltaX === 0) return;
    const size = viewportSize();
    // Rotate about the viewport center; dragging above it turns the other way,
    // so the map follows the pointer like a turned disc.
    const direction = position.y < size.height / 2 ? -1 : 1;
    const deltaBearing = deltaX * MOUSE_ROTATE_DEGREES_PER_PX * direction;
    scheduleCameraFrame("rotate", () => {
      runtime.rotateAbout(deltaBearing, size.width / 2, size.height / 2);
    });
  }
  function endMouseRotation(event: PointerEvent, cancelled: boolean) {
    // Clock is performance.now(): contextmenu and pointer event timestamps are
    // not guaranteed to share a time origin across synthetic/trusted input.
    const rotation = mouseRotation;
    if (!rotation || rotation.pointerId !== event.pointerId) return false;
    mouseRotation = null;
    lastRotationEnd = { moved: rotation.moved, time: performance.now() };
    if (!cancelled && !rotation.moved && rotation.pendingContextMenu) {
      emitContextMenu(rotation.pendingContextMenu);
    }
    return true;
  }
  function handlePointerMove(event: PointerEvent) {
    if (mouseRotation?.pointerId === event.pointerId) {
      handleMouseRotateMove(mouseRotation, event);
      return;
    }
    if (!pointerTimes.has(event.pointerId)) return;
    const runtime = activeRuntime;
    const syncFrame = synchronize;
    if (!runtime || !syncFrame) return;

    const previousTime = pointerTimes.get(event.pointerId);
    pointerTimes.set(event.pointerId, event.timeStamp);
    const delta = gesture.pointerMove(
      event.pointerId,
      pointerPosition(event.clientX, event.clientY),
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
      const deltaBearing = maxBounds ? 0 : delta.deltaBearing;
      const reason = delta.deltaZoom !== 0 ? "zoom" : deltaBearing !== 0 ? "rotate" : "pan";
      scheduleCameraFrame(reason, () => {
        if (delta.deltaX !== 0 || delta.deltaY !== 0) {
          runtime.panBetween(delta.previousX, delta.previousY, delta.x, delta.y);
        }
        if (delta.deltaZoom !== 0) {
          runtime.zoomAbout(delta.deltaZoom, delta.x, delta.y, 0, effectiveMaxZoom);
        }
        if (deltaBearing !== 0) {
          runtime.rotateAbout(deltaBearing, delta.x, delta.y);
        }
      });
    } catch (error) {
      velocityTracker.clear();
      config.onError?.(error);
    }
  }
  function handlePointerUp(event: PointerEvent) {
    if (endMouseRotation(event, false)) return;
    if (!pointerTimes.has(event.pointerId)) return;
    const lastMoveTime = pointerTimes.get(event.pointerId);
    pointerTimes.delete(event.pointerId);
    gesture.pointerUp(event.pointerId);

    if (gesture.pointerCount() === 0) {
      const velocity = velocityTracker.release(
        lastMoveTime === undefined ? Number.POSITIVE_INFINITY : event.timeStamp - lastMoveTime,
      );
      if (velocity) {
        startKineticPan(velocity, pointerPosition(event.clientX, event.clientY));
      }
    } else {
      velocityTracker.clear();
    }
  }
  function handlePointerCancel(event: PointerEvent) {
    if (endMouseRotation(event, true)) return;
    if (!pointerTimes.has(event.pointerId)) return;
    pointerTimes.delete(event.pointerId);
    gesture.pointerUp(event.pointerId);
    velocityTracker.clear();
    cancelKineticPan();
  }
  function update(next: MapsBrowserRuntimeOptions) {
    if (cancelled) return;
    if (
      runtimeIdentity(next) !== identity ||
      next.createTileImageLoader !== options.createTileImageLoader
    ) {
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
    baseRendererListeners.clear();
    synchronize = null;
    emitViewState = null;
    gesture.clear();
    velocityTracker.clear();
    pointerTimes.clear();
    mouseRotation = null;
    viewStateEchoTracker.clear();
    for (const load of loads.values()) load.abort.abort();
    tileImageLoader?.dispose();
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
    restoreSurfaceGeometry();
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
    normalizeRenderMargin(options.renderMargin),
  ]);
}

function normalizeRenderMargin(margin: number | undefined) {
  if (margin === undefined) return DEFAULT_RENDER_MARGIN;
  if (!Number.isFinite(margin) || margin < 0 || margin > 1024) {
    throw new Error("Maps renderMargin must be a finite CSS-pixel value in [0, 1024].");
  }
  return Math.round(margin);
}

/**
 * Grows the base canvases by `margin` on every side (centered on the viewport) and
 * clips their parent. Returns a function restoring the previous inline styles.
 */
function applySurfaceGeometry(targets: HTMLCanvasElement[], margin: number) {
  if (margin === 0) return () => {};
  const properties = ["position", "left", "top", "right", "bottom", "width", "height"] as const;
  const restores: Array<() => void> = [];
  for (const target of targets) {
    const previous = properties.map((property) => target.style[property]);
    const previousTransform = target.style.transform;
    target.style.position = "absolute";
    target.style.left = `-${margin}px`;
    target.style.top = `-${margin}px`;
    target.style.right = "auto";
    target.style.bottom = "auto";
    target.style.width = `calc(100% + ${2 * margin}px)`;
    target.style.height = `calc(100% + ${2 * margin}px)`;
    restores.push(() => {
      properties.forEach((property, index) => {
        target.style[property] = previous[index]!;
      });
      target.style.transform = previousTransform;
    });
  }
  const parent = targets[0]?.parentElement;
  if (parent && getComputedStyle(parent).overflow === "visible") {
    const previousOverflow = parent.style.overflow;
    parent.style.overflow = "hidden";
    restores.push(() => {
      parent.style.overflow = previousOverflow;
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}

function createFrameSynchronizer({
  loadTile,
  canvas,
  fallbackCanvas,
  images,
  loads,
  packApplicationFrame,
  renderer,
  renderMargin,
  runtime,
  setSurfaceTranslation,
  source,
  onError,
  onRendererFailure,
  onCameraFrame,
}: {
  loadTile: MapsTileImageLoader["load"];
  canvas: HTMLCanvasElement;
  fallbackCanvas: HTMLCanvasElement;
  images: Map<string, ImageBitmap>;
  loads: Map<string, ActiveTileLoad>;
  packApplicationFrame: MapsWgpuApplicationFrameFactory | null;
  renderer: () => MapsWgpuBaseMapRenderer | null;
  renderMargin: number;
  runtime: MapsFlatRasterRuntime;
  setSurfaceTranslation: (x: number, y: number) => void;
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
  // The last full render: its camera, whether its margin holds content (so pure
  // pans can be presented by translation), and the tiles it placed. Pixels are only
  // re-rendered when something it drew changed or the camera change is not a
  // translation inside the margin.
  let rendered: {
    camera: MapsFlatRasterFrame["camera"];
    overscan: boolean;
    tiles: Set<string>;
  } | null = null;
  let renderInvalidated = true;
  let translated = false;
  // The retained render skipped its margin (continuous motion); settle fills it.
  let marginPending = false;
  let lastMotion = 0;
  // When the camera last changed by more than a translation, for motion detection.
  let lastReshape = Number.NEGATIVE_INFINITY;
  let settleHandle: number | null = null;
  let renderRequest: number | null = null;
  let drawnTilesAttribute = "0";
  let pendingTilesAttribute = "0";

  function publishPendingTiles() {
    const value = String(loads.size);
    if (value === pendingTilesAttribute) return;
    pendingTilesAttribute = value;
    canvas.dataset.mapBasePendingTiles = value;
  }
  let vectorTilesAttribute: string | null = null;
  const stats = { lastRenderMs: 0, renders: 0, translatedFrames: 0 };
  let frameStats: MapsWgpuFrameStats | null = null;

  /** Marks rendered pixels stale; a tile only matters if the last render placed it. */
  function invalidateRendered(tileKey?: string) {
    if (tileKey === undefined || !rendered || rendered.tiles.has(tileKey)) {
      renderInvalidated = true;
    }
  }

  function setDrawnTiles(count: number) {
    const value = String(count);
    if (value === drawnTilesAttribute) return;
    drawnTilesAttribute = value;
    canvas.dataset.mapBaseTiles = value;
  }

  function cancelSettle() {
    if (settleHandle !== null) cancelAnimationFrame(settleHandle);
    settleHandle = null;
  }

  function scheduleSettle() {
    lastMotion = performance.now();
    if (settleHandle !== null) return;
    const settle = () => {
      settleHandle = null;
      if (disposed || !(translated || marginPending)) return;
      if (performance.now() - lastMotion < SETTLE_DELAY_MS) {
        settleHandle = requestAnimationFrame(settle);
        return;
      }
      // Motion stopped: replace the resampled translation or the viewport-only
      // render with a pixel-exact render of the whole surface.
      if (lastFrame) renderFrame(lastFrame);
    };
    settleHandle = requestAnimationFrame(settle);
  }

  /**
   * Presents `frame` by translating the retained render when the camera moved by a
   * pure screen translation that stays inside the rendered margin. The offset comes
   * from the authoritative Rust projection of the retained camera center.
   */
  function presentByTranslation(frame: MapsFlatRasterFrame) {
    const base = rendered?.overscan ? rendered.camera : null;
    const camera = frame.camera;
    if (
      !base ||
      renderInvalidated ||
      renderMargin === 0 ||
      !frame.surface?.overscan ||
      camera.pitch !== 0 ||
      base.pitch !== 0 ||
      camera.bearing !== base.bearing ||
      camera.zoom !== base.zoom ||
      camera.width !== base.width ||
      camera.height !== base.height
    ) {
      return false;
    }
    let projected: [number, number];
    try {
      projected = runtime.project(base.center[0], base.center[1]);
    } catch {
      return false;
    }
    const x = projected[0] - camera.width / 2;
    const y = projected[1] - camera.height / 2;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > renderMargin ||
      Math.abs(y) > renderMargin
    ) {
      return false;
    }
    setSurfaceTranslation(x, y);
    translated = true;
    stats.translatedFrames += 1;
    scheduleSettle();
    return true;
  }

  function retainRenderedFrame(frame: MapsFlatRasterFrame | null, viewportOnly = false) {
    const overscan = frame?.surface?.overscan === true;
    rendered = frame
      ? {
          camera: frame.camera,
          overscan: overscan && !viewportOnly,
          tiles: new Set(frame.placements.map((placement) => placement.tile.key)),
        }
      : null;
    renderInvalidated = frame === null;
    translated = false;
    marginPending = overscan && viewportOnly;
    cancelSettle();
    setSurfaceTranslation(0, 0);
    if (marginPending) scheduleSettle();
  }

  /**
   * Continuous motion that is not a translation (zoom, rotate, pitch, flyTo)
   * replaces every frame, so filling the margin would be wasted fill-rate; the first
   * such frame keeps it so a discrete step can still be followed by translated pans.
   */
  function shouldRenderViewportOnly(frame: MapsFlatRasterFrame) {
    if (!rendered || !frame.surface?.overscan) return false;
    const now = performance.now();
    const reshaped = !sameCameraShape(rendered.camera, frame.camera);
    const inMotion = now - lastReshape < SETTLE_DELAY_MS;
    if (reshaped) lastReshape = now;
    // A viewport-only render followed by a translation must fill the margin again.
    return (
      inMotion && (reshaped || (!rendered.overscan && sameCamera(rendered.camera, frame.camera)))
    );
  }

  /** Presents `frame` from the last render when its pixels are still exact. */
  function presentRetained(frame: MapsFlatRasterFrame) {
    if (!rendered || renderInvalidated) return false;
    if (sameCamera(frame.camera, rendered.camera)) {
      if (translated) {
        translated = false;
        cancelSettle();
        setSurfaceTranslation(0, 0);
      }
      return true;
    }
    return presentByTranslation(frame);
  }

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
      renderFrame(retainedFrame);
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
    invalidateRendered();
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
    const cameraChanged = !previous || !sameCamera(previous, frame.camera);
    // Reads made by layer preparation must see this same Rust snapshot. Packing
    // the application frame here must not recursively submit an older base frame.
    lastFrame = frame;
    if (cameraChanged) prepareCameraLayers();
    if (presentRetained(frame)) return;
    renderFrame(frame, shouldRenderViewportOnly(frame));
  }

  function renderFrame(frame: MapsFlatRasterFrame, viewportOnly = false) {
    if (disposed) return;
    lastFrame = frame;
    const margin = frame.surface?.margin ?? 0;
    const viewportClip = viewportOnly
      ? { height: frame.camera.height, width: frame.camera.width }
      : null;
    const currentRenderer = renderer();
    stats.renders += 1;
    if (currentRenderer) {
      try {
        const started = performance.now();
        const drawnTiles = currentRenderer.render(
          frame.placements,
          frame.renderCamera,
          applicationFrame,
          margin,
          viewportClip,
        );
        stats.lastRenderMs = performance.now() - started;
        recordFrameStats(currentRenderer);
        const hasDecodedVisibleTile = frame.placements.some((placement) =>
          images.has(placement.tile.key),
        );
        if (drawnTiles === 0 && hasDecodedVisibleTile) {
          retainRenderedFrame(null);
          scheduleRendererRetry();
          return;
        }
        cancelRendererRetry();
        retainRenderedFrame(frame, viewportOnly);
        setDrawnTiles(drawnTiles);
        return;
      } catch {
        failRenderer();
      }
    }

    cancelRendererRetry();
    frameStats = null;
    const started = performance.now();
    const drawnTiles = drawCanvasFrame(fallbackCanvas, images, frame, margin, viewportOnly);
    stats.lastRenderMs = performance.now() - started;
    retainRenderedFrame(frame, viewportOnly);
    setDrawnTiles(drawnTiles);
  }

  function recordFrameStats(currentRenderer: MapsWgpuBaseMapRenderer) {
    frameStats = currentRenderer.frameStats();
    const vectorTiles =
      frameStats.retainedVectorTiles > 0 || vectorTilesAttribute !== null
        ? String(frameStats.vectorTiles)
        : null;
    if (vectorTiles !== null && vectorTiles !== vectorTilesAttribute) {
      vectorTilesAttribute = vectorTiles;
      canvas.dataset.mapVectorTiles = vectorTiles;
    }
  }

  /** Re-renders the current camera once on the next frame (retained resources changed). */
  function requestRender() {
    invalidateRendered();
    if (disposed || renderRequest !== null) return;
    renderRequest = requestAnimationFrame(() => {
      renderRequest = null;
      if (!disposed && lastFrame && renderInvalidated) renderFrame(lastFrame);
    });
  }

  function isEmptyApplicationFrame(frame: MapsWgpuApplicationFrame | null) {
    return (
      !frame ||
      (frame.circleCount === 0 &&
        frame.lines.length === 0 &&
        frame.polygons.length === 0 &&
        frame.directionMarkers.length === 0)
    );
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
    if (!isEmptyApplicationFrame(applicationFrame) || !isEmptyApplicationFrame(next)) {
      invalidateRendered();
    }
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
      invalidateRendered(tile.key);
      const currentRenderer = renderer();
      if (currentRenderer) {
        try {
          currentRenderer.evictTile(tile);
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
      publishPendingTiles();
      return frame;
    }

    presentFrame(frame);

    for (const tile of frame.requests) {
      if (loads.has(tile.key) || images.has(tile.key)) continue;
      const abort = new AbortController();
      const load = { abort, tile };
      loads.set(tile.key, load);

      loadTile(buildRasterTileUrl(currentSource.url, tile), tile, abort.signal)
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
                currentRenderer.uploadTile(tile, image);
              } catch {
                failRenderer();
              }
            }
            runtime.markLoaded(tile);
            invalidateRendered(tile.key);
            syncFrame();
          },
          (error) => {
            if (disposed || abort.signal.aborted || loads.get(tile.key) !== load) return;
            loads.delete(tile.key);
            runtime.markFailed(tile);
            canvas.dataset.mapBaseTileError =
              error instanceof Error ? error.message : String(error);
            invalidateRendered(tile.key);
            syncFrame();
            throw error;
          },
        )
        .catch((error) => {
          if (!disposed) onError(error);
        });
    }

    publishPendingTiles();
    return frame;
  }

  return {
    /** The canvases lost their pixels (backing-store reset); the next frame renders. */
    invalidatePixels() {
      invalidateRendered();
    },
    dispose() {
      disposed = true;
      fallbackCanvas.removeEventListener("contextrestored", restoreCanvasFrame);
      cancelSettle();
      cancelRendererRetry();
      cancelDeviceLossMonitor();
      if (renderRequest !== null) cancelAnimationFrame(renderRequest);
      renderRequest = null;
      lastFrame = null;
      applicationFrame = null;
    },
    getStats() {
      return { ...stats, ...frameStats };
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
        // Margin-only placements are drawn for translation, not visible.
        if (placement.visible !== false) unique.set(placement.tile.key, placement.tile);
      }
      return [...unique.values()];
    },
    requestRender,
    setApplicationFrame,
    syncFrame,
  };
}

/** Equal apart from the center: the cameras differ at most by a screen translation. */
function sameCameraShape(
  left: MapsFlatRasterFrame["camera"],
  right: MapsFlatRasterFrame["camera"],
) {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.zoom === right.zoom &&
    left.bearing === right.bearing &&
    left.pitch === right.pitch
  );
}

function sameCamera(left: MapsFlatRasterFrame["camera"], right: MapsFlatRasterFrame["camera"]) {
  return (
    left.center[0] === right.center[0] &&
    left.center[1] === right.center[1] &&
    sameCameraShape(left, right)
  );
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
  margin: number,
  viewportOnly: boolean,
) {
  const context = canvas.getContext("2d");
  if (!context) return 0;

  const ratio = Math.max(1, window.devicePixelRatio || 1);
  // The render camera maps into the whole surface: the viewport grown by `margin`.
  const viewport = {
    height: frame.camera.height + 2 * margin,
    width: frame.camera.width + 2 * margin,
  };
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = MAP_BACKGROUND;
  context.fillRect(0, 0, viewport.width, viewport.height);

  const subdivisions = frame.camera.pitch === 0 ? 1 : CANVAS_PROJECTIVE_SUBDIVISIONS;
  let drawnTiles = 0;
  for (const placement of frame.placements) {
    // Margin-only tiles exist for translation; a viewport-only render skips them.
    if (viewportOnly && placement.visible === false) continue;
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

/** Sizes the backing store to the CSS box; returns whether it changed (and was cleared). */
function resizeCanvasBackingStore(canvas: HTMLCanvasElement) {
  const size = getCanvasCssSize(canvas);
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(size.width * ratio));
  const height = Math.max(1, Math.round(size.height * ratio));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function getCanvasCssSize(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    height: Math.max(1, Math.round(rect.height || canvas.clientHeight || 1)),
    width: Math.max(1, Math.round(rect.width || canvas.clientWidth || 1)),
  };
}
