// Comparative interaction benchmark host. One engine per page load so engines never
// share a main thread, GPU context or tile cache. Input is driven externally with
// trusted browser events (scripts/benchmark-interactions.mjs); this page only mounts
// the engine against the shared tile source and observes frames/input latency.
import "maplibre-gl/dist/maplibre-gl.css";
import "leaflet/dist/leaflet.css";
import {
  DENSE_POINT_VIEW,
  densePointJourney,
  densePointJourneySteps,
  densePoints,
  type DensePointCamera,
} from "./dense-point-journey";

export type BenchmarkEngine = "maps-wgpu" | "maps-canvas2d" | "maplibre" | "leaflet" | "canvas2d";
type BenchmarkCamera = {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number | null;
  /** Point journeys only; `null` where the engine has no pitch. */
  pitch?: number | null;
};

const params = new URLSearchParams(location.search);
const engine = (params.get("engine") ?? "maps-wgpu") as BenchmarkEngine;
/**
 * `points=N` mounts the dense-point camera journey (#197) instead of a basemap: the same
 * N deterministic points on every engine, no tiles, so the lanes compare application-point
 * work only.
 */
const pointCount = params.has("points") ? Number(params.get("points")) : 0;
if (params.has("points") && !(Number.isInteger(pointCount) && pointCount > 0))
  throw new Error(`invalid points=${params.get("points")}`);
const tileUrl = `${location.origin}/__bench_tiles/{z}/{x}/{y}.png`;
const vectorTileUrl = `${location.origin}/__bench_vector/{z}/{x}/{y}.mvt`;
/** `raster` (deterministic PNG tiles) or `vector` (deterministic Shortbread-like MVT). */
const basemap = params.get("basemap") === "vector" ? "vector" : "raster";
const initial = pointCount
  ? { center: DENSE_POINT_VIEW.center, zoom: DENSE_POINT_VIEW.zoom }
  : { center: [13.405, 52.52] as [number, number], zoom: 11 };
const container = document.getElementById("map")!;

if (engine === "maps-canvas2d") {
  // Same capability probe the browser runtime uses; forces its Canvas2D backend.
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => undefined });
}

// The Shortbread demo style (demo/ShortbreadBasemapLayer.tsx), expressed for MapLibre.
const vectorStyle = {
  version: 8,
  sources: { bench: { type: "vector", tiles: [vectorTileUrl], maxzoom: 14 } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#f9f4ee" } },
    {
      id: "land",
      type: "fill",
      source: "bench",
      "source-layer": "land",
      paint: { "fill-color": ["match", ["get", "kind"], "forest", "#c4d8b4", "#dce4cc"] },
    },
    {
      id: "water",
      type: "fill",
      source: "bench",
      "source-layer": "water_polygons",
      paint: { "fill-color": "#a8cce0" },
    },
    {
      id: "buildings",
      type: "fill",
      source: "bench",
      "source-layer": "buildings",
      paint: { "fill-color": "#d8c8b8" },
    },
    {
      id: "building-outlines",
      type: "line",
      source: "bench",
      "source-layer": "buildings",
      paint: { "line-color": "#b9a895", "line-width": 0.6 },
    },
    {
      id: "water-lines",
      type: "line",
      source: "bench",
      "source-layer": "water_polygons",
      paint: { "line-color": "#6ba9c9", "line-opacity": 0.9, "line-width": 1.2 },
    },
    {
      id: "streets",
      type: "line",
      source: "bench",
      "source-layer": "streets",
      paint: { "line-color": "#9a8c7d", "line-opacity": 0.72, "line-width": 0.9 },
    },
  ],
};

const rasterStyle = {
  version: 8,
  sources: { bench: { type: "raster", tiles: [tileUrl], tileSize: 256, maxzoom: 19 } },
  layers: [{ id: "bench", type: "raster", source: "bench" }],
};

type MountedEngine = {
  camera(): BenchmarkCamera;
  ready: Promise<void>;
  /** Synchronous controlled-camera presentation (Rust frame + backend render). */
  presentCamera?: (state: { center: [number, number]; zoom: number; bearing?: number }) => void;
  /** Point journeys only: what the lane drew the points with. */
  pointRenderer?: () => string | null;
};

/** One dense-point lane: applies journey cameras and reports when a step is fully drawn. */
type PointLane = MountedEngine & {
  /** Camera axes the engine honours; Leaflet has neither bearing nor pitch. */
  cameraAxes: Array<keyof DensePointCamera>;
  applyCamera(camera: DensePointCamera): void;
  /** Resolves once every point for the current camera is drawn (async engines only). */
  settled(): Promise<void>;
  /** Maps lanes only: the renderer's work counters (retained preparation and upload). */
  stats(): PointLaneStats | null;
};

type PointLaneStats = {
  applicationUploadBytes: number;
  retainedPointFrames: number;
  retainedPointPreparations: number;
  retainedPointRebases: number;
  retainedPointUploadBytes: number;
  retainedPoints: number;
};

const POINT_COLOR = "#ff0000";
const POINT_RADIUS = 6;

async function mountEngine(): Promise<MountedEngine> {
  if (pointCount) return mountPointLane();
  switch (engine) {
    case "maps-wgpu":
    case "maps-canvas2d":
      return basemap === "vector" ? mountMapsVector() : mountMaps();
    case "maplibre":
      return mountMapLibre();
    case "leaflet":
      return mountLeaflet();
    case "canvas2d":
      return mountCanvas2dBaseline();
  }
}

async function mountMaps() {
  const { configureMapsWasmPackage } = await import("../../src/aggregation-wasm");
  const { createMapsBrowserRuntime } = await import("../../src/maps-browser-runtime");
  configureMapsWasmPackage("/wasm/maps_wasm.js");
  const base = document.createElement("canvas");
  const fallback = document.createElement("canvas");
  base.className = fallback.className = "maps-layer";
  container.append(base, fallback);
  const host = createMapsBrowserRuntime(base, fallback, {
    mapStyle: rasterStyle as never,
    viewState: initial,
    // A/B evidence: `?margin=0` disables retained-frame overscan.
    ...(params.has("margin") ? { renderMargin: Number(params.get("margin")) } : {}),
    onViewStateChange() {},
    onError(error) {
      container.dataset.error = String(error);
    },
  });
  const ready = host.ready.then(() => waitFor(() => Number(base.dataset.mapBaseTiles) >= 12));
  return {
    ready,
    presentCamera(state: { center: [number, number]; zoom: number; bearing?: number }) {
      host.controller!.setViewState(state);
    },
    camera() {
      const state = host.controller!.getViewState();
      return {
        longitude: state.center[0],
        latitude: state.center[1],
        zoom: state.zoom,
        bearing: state.bearing ?? 0,
      };
    },
  };
}

/**
 * The Pages composition: Map View + Shortbread hook. With WebGPU the basemap is
 * retained on the GPU; without it (maps-canvas2d) it is the Canvas GeoJSON overlay
 * with the motion-transform presentation.
 */
async function mountMapsVector() {
  const { configureMapsWasmPackage } = await import("../../src/aggregation-wasm");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MapView } = await import("../../src/map-view");
  const { GeoJsonLayer } = await import("../../src/geojson-layer");
  const { getShortbreadBasemapStyle, useShortbreadBasemap } =
    await import("../../demo/ShortbreadBasemapLayer");
  configureMapsWasmPackage("/wasm/maps_wasm.js");
  type Controller = Parameters<typeof useShortbreadBasemap>[1] extends infer Options
    ? Options extends { controller?: infer C }
      ? NonNullable<C> & {
          getViewState(): { center: [number, number]; zoom: number; bearing?: number };
          getVisibleTiles(): Parameters<typeof useShortbreadBasemap>[0][number][];
          setViewState(state: { center: [number, number]; zoom: number; bearing?: number }): void;
        }
      : never
    : never;
  let active: Controller | null = null;
  const status = { features: 0, renderer: "pending", state: "idle" };
  function Host() {
    const [controller, setController] = React.useState<Controller | null>(null);
    const [tiles, setTiles] = React.useState<ReturnType<Controller["getVisibleTiles"]>>([]);
    const tileKey = React.useRef("");
    const refresh = React.useCallback(() => {
      const next = active?.getVisibleTiles() ?? [];
      const key = next.map((tile) => tile.key).join("|");
      if (key === tileKey.current) return;
      tileKey.current = key;
      setTiles(next);
    }, []);
    const basemap = useShortbreadBasemap(tiles, { controller, tileUrl: vectorTileUrl });
    status.features = basemap.featureCount;
    status.renderer = basemap.renderer;
    status.state = basemap.state;
    container.dataset.basemapRenderer = basemap.renderer;
    return React.createElement(
      MapView,
      {
        fitToData: false,
        flatRuntime: "maps",
        initialViewState: initial,
        mapLabel: "Benchmark map",
        mapStyle: { attribution: "", tiles: false },
        onMapControllerReady: (next: unknown) => {
          active = next as Controller | null;
          setController(active);
          refresh();
        },
        onViewStateChange: refresh,
        style: { height: "100%", width: "100%" },
      },
      basemap.renderer === "canvas-overlay"
        ? React.createElement(GeoJsonLayer, {
            featureCollection: basemap.featureCollection,
            getFeatureStyle: (feature: { properties: Record<string, unknown> }) =>
              getShortbreadBasemapStyle(
                feature.properties.kind as Parameters<typeof getShortbreadBasemapStyle>[0],
                feature.properties.sourceKind as string | null,
              ),
            isFeatureInteractive: () => false,
            layerId: "shortbread-basemap",
          })
        : null,
    );
  }
  createRoot(container).render(React.createElement(Host));
  let stableSince = performance.now();
  let lastFeatures = -1;
  const ready = waitFor(() => {
    if (status.features !== lastFeatures) {
      lastFeatures = status.features;
      stableSince = performance.now();
    }
    // All visible tiles decoded/uploaded: the feature count stopped growing.
    return (
      status.renderer !== "pending" &&
      status.state === "ready" &&
      status.features > 0 &&
      performance.now() - stableSince > 1500
    );
  }, 60_000);
  return {
    ready,
    presentCamera(state: { center: [number, number]; zoom: number; bearing?: number }) {
      active!.setViewState(state);
    },
    camera() {
      const state = active!.getViewState();
      return {
        longitude: state.center[0],
        latitude: state.center[1],
        zoom: state.zoom,
        bearing: state.bearing ?? 0,
      };
    },
  };
}

async function mountMapLibre() {
  const maplibreModule = await import("maplibre-gl");
  const maplibregl =
    (maplibreModule as { default?: typeof maplibreModule }).default ?? maplibreModule;
  const map = new maplibregl.Map({
    container,
    style: (basemap === "vector" ? vectorStyle : rasterStyle) as never,
    center: initial.center,
    zoom: initial.zoom,
    attributionControl: false,
  });
  const ready = new Promise<void>((resolve) => map.once("idle", () => resolve()));
  return {
    ready,
    camera() {
      const center = map.getCenter();
      return {
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
      };
    },
  };
}

async function mountLeaflet() {
  const leafletModule = await import("leaflet");
  const L = (leafletModule as { default?: typeof leafletModule }).default ?? leafletModule;
  const map = L.map(container, { attributionControl: false, zoomControl: false }).setView(
    [initial.center[1], initial.center[0]],
    initial.zoom,
  );
  const layer = L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(map);
  const ready = new Promise<void>((resolve) => layer.once("load", () => resolve()));
  return {
    ready,
    camera() {
      const center = map.getCenter();
      // Leaflet has no bearing; rotation scenarios are reported as unsupported.
      return { longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: null };
    },
  };
}

/** Minimal hand-written Canvas2D raster map: the lower bound for a JS tile drawer. */
async function mountCanvas2dBaseline() {
  const canvas = document.createElement("canvas");
  canvas.className = "maps-layer";
  canvas.style.touchAction = "none";
  container.append(canvas);
  const ratio = Math.max(1, devicePixelRatio || 1);
  const width = container.clientWidth;
  const height = container.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d")!;
  const tiles = new Map<string, ImageBitmap | null>();
  const worldAt = (zoom: number) => 256 * 2 ** zoom;
  const toWorld = (longitude: number, latitude: number) => {
    const sin = Math.sin((latitude * Math.PI) / 180);
    return [
      (longitude + 180) / 360,
      0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
    ] as const;
  };
  const [initialX, initialY] = toWorld(...initial.center);
  const state = { x: initialX, y: initialY, zoom: initial.zoom, bearing: 0 };
  let scheduled = false;
  let drawn = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(draw);
  };
  function draw() {
    scheduled = false;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#f9f4ee";
    context.fillRect(0, 0, width, height);
    const z = Math.max(0, Math.min(19, Math.round(state.zoom)));
    const tileSize = 256 * 2 ** (state.zoom - z);
    const size = worldAt(state.zoom);
    const radius = Math.hypot(width, height) / 2;
    const cx = state.x * size;
    const cy = state.y * size;
    const minX = Math.floor((cx - radius) / tileSize);
    const maxX = Math.floor((cx + radius) / tileSize);
    const minY = Math.max(0, Math.floor((cy - radius) / tileSize));
    const maxY = Math.min(2 ** z - 1, Math.floor((cy + radius) / tileSize));
    context.translate(width / 2, height / 2);
    context.rotate((-state.bearing * Math.PI) / 180);
    drawn = 0;
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const wrapped = ((tx % 2 ** z) + 2 ** z) % 2 ** z;
        const key = `${z}/${wrapped}/${ty}`;
        const image = tiles.get(key);
        if (image === undefined) {
          tiles.set(key, null);
          void fetch(
            tileUrl
              .replace("{z}", String(z))
              .replace("{x}", String(wrapped))
              .replace("{y}", String(ty)),
          )
            .then((response) => response.blob())
            .then((blob) => createImageBitmap(blob))
            .then((bitmap) => {
              tiles.set(key, bitmap);
              schedule();
            });
          continue;
        }
        if (!image) continue;
        context.drawImage(
          image,
          tx * tileSize - cx,
          ty * tileSize - cy,
          tileSize + 0.5,
          tileSize + 0.5,
        );
        drawn++;
      }
    }
  }
  const pointers = new Map<number, { x: number; y: number; button: number }>();
  canvas.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY, button: event.button });
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const dx = event.offsetX - previous.x;
    const dy = event.offsetY - previous.y;
    previous.x = event.offsetX;
    previous.y = event.offsetY;
    if (previous.button === 2) {
      state.bearing = (state.bearing - dx * 0.8) % 360;
    } else {
      const size = worldAt(state.zoom);
      const angle = (state.bearing * Math.PI) / 180;
      state.x -= (dx * Math.cos(angle) - dy * Math.sin(angle)) / size;
      state.y -= (dx * Math.sin(angle) + dy * Math.cos(angle)) / size;
    }
    schedule();
  });
  const release = (event: PointerEvent) => pointers.delete(event.pointerId);
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const nextZoom = Math.max(0, Math.min(22, state.zoom - event.deltaY * 0.0025));
      const size = worldAt(state.zoom);
      const nextSize = worldAt(nextZoom);
      const angle = (state.bearing * Math.PI) / 180;
      const ox = event.offsetX - width / 2;
      const oy = event.offsetY - height / 2;
      const rx = ox * Math.cos(angle) - oy * Math.sin(angle);
      const ry = ox * Math.sin(angle) + oy * Math.cos(angle);
      state.x += rx / size - rx / nextSize;
      state.y += ry / size - ry / nextSize;
      state.zoom = nextZoom;
      schedule();
    },
    { passive: false },
  );
  schedule();
  return {
    ready: waitFor(() => drawn >= 12),
    camera() {
      const n = Math.PI - 2 * Math.PI * state.y;
      return {
        longitude: state.x * 360 - 180,
        latitude: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
        zoom: state.zoom,
        bearing: state.bearing,
      };
    },
  };
}

let pointLane: PointLane | null = null;

async function mountPointLane(): Promise<PointLane> {
  const points = densePoints(pointCount);
  switch (engine) {
    case "maps-wgpu":
    case "maps-canvas2d":
      return (pointLane = await mountMapsPoints(points));
    case "maplibre":
      return (pointLane = await mountMapLibrePoints(points));
    case "leaflet":
      return (pointLane = await mountLeafletPoints(points));
    case "canvas2d":
      throw new Error("the Canvas2D tile baseline has no point lane");
  }
}

/** The retained-points composition (#155): Map View + Point Layer, no basemap tiles. */
async function mountMapsPoints(points: ReturnType<typeof densePoints>): Promise<PointLane> {
  const { configureMapsWasmPackage } = await import("../../src/aggregation-wasm");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MapView } = await import("../../src/map-view");
  const { PointLayer } = await import("../../src/point-layer");
  configureMapsWasmPackage("/wasm/maps_wasm.js");
  type Controller = {
    getRendererStats(): Partial<PointLaneStats> | null;
    getViewState(): { bearing?: number; center: [number, number]; pitch?: number; zoom: number };
    setViewState(state: DensePointCamera): void;
  };
  let controller: Controller | null = null;
  createRoot(container).render(
    React.createElement(
      MapView,
      {
        defaultViewState: DENSE_POINT_VIEW,
        fitToData: false,
        flatRuntime: "maps",
        mapLabel: "Benchmark map",
        mapStyle: { attribution: "", tiles: false },
        onMapControllerReady: (next: unknown) => {
          controller = next as Controller | null;
        },
        style: { height: "100%", width: "100%" },
      },
      React.createElement(PointLayer, {
        pointColor: POINT_COLOR,
        pointRadius: POINT_RADIUS,
        points,
      }),
    ),
  );
  const overlay = () =>
    container.querySelector<HTMLElement>('[data-map-overlay-runtime="maps"]')?.dataset
      .mapOverlayBackend ?? null;
  const stats = (): PointLaneStats | null => {
    const raw = controller?.getRendererStats();
    if (!raw) return null;
    return {
      applicationUploadBytes: raw.applicationUploadBytes ?? 0,
      retainedPointFrames: raw.retainedPointFrames ?? 0,
      retainedPointPreparations: raw.retainedPointPreparations ?? 0,
      retainedPointRebases: raw.retainedPointRebases ?? 0,
      retainedPointUploadBytes: raw.retainedPointUploadBytes ?? 0,
      retainedPoints: raw.retainedPoints ?? 0,
    };
  };
  const ready = waitFor(() => {
    const map = container.querySelector<HTMLElement>("[data-map-ready]");
    if (map?.dataset.mapReady !== "true" || !controller) return false;
    // WebGPU must hold every point in its retained group before the journey starts;
    // a lost device shows up as the Canvas fallback backend and is reported, not hidden.
    const backend = overlay();
    if (engine === "maps-wgpu" && backend === "wgpu-retained")
      return stats()?.retainedPoints === points.length;
    return backend !== null;
  }, 120_000);
  return {
    applyCamera: (camera) => controller!.setViewState(camera),
    camera() {
      const state = controller!.getViewState();
      return {
        bearing: state.bearing ?? 0,
        latitude: state.center[1],
        longitude: state.center[0],
        pitch: state.pitch ?? 0,
        zoom: state.zoom,
      };
    },
    cameraAxes: ["bearing", "center", "pitch", "zoom"],
    pointRenderer: overlay,
    ready,
    // The retained path and the Canvas fallback draw every point in the camera frame.
    settled: async () => {},
    stats,
  };
}

/** MapLibre reference: an in-memory GeoJSON source and a circle layer, no basemap. */
async function mountMapLibrePoints(points: ReturnType<typeof densePoints>): Promise<PointLane> {
  const maplibreModule = await import("maplibre-gl");
  const maplibregl =
    (maplibreModule as { default?: typeof maplibreModule }).default ?? maplibreModule;
  const map = new maplibregl.Map({
    attributionControl: false,
    bearing: DENSE_POINT_VIEW.bearing,
    center: DENSE_POINT_VIEW.center,
    container,
    pitch: DENSE_POINT_VIEW.pitch,
    style: {
      layers: [
        { id: "background", paint: { "background-color": "#f9f4ee" }, type: "background" },
        {
          id: "points",
          paint: { "circle-color": POINT_COLOR, "circle-radius": POINT_RADIUS },
          source: "points",
          type: "circle",
        },
      ],
      sources: {
        points: {
          data: {
            features: points.map((point) => ({
              geometry: { coordinates: [point.longitude, point.latitude], type: "Point" },
              properties: { id: point.id },
              type: "Feature",
            })),
            type: "FeatureCollection",
          },
          type: "geojson",
        },
      },
      version: 8,
    } as never,
    zoom: DENSE_POINT_VIEW.zoom,
  });
  const idle = () =>
    map.loaded() && !map.isMoving()
      ? Promise.resolve()
      : new Promise<void>((resolve) => map.once("idle", () => resolve()));
  return {
    applyCamera: (camera) => map.jumpTo(camera),
    camera() {
      const center = map.getCenter();
      return {
        bearing: map.getBearing(),
        latitude: center.lat,
        longitude: center.lng,
        pitch: map.getPitch(),
        zoom: map.getZoom(),
      };
    },
    cameraAxes: ["bearing", "center", "pitch", "zoom"],
    pointRenderer: () => "maplibre-circle-layer",
    ready: new Promise<void>((resolve) => map.once("idle", () => resolve())),
    // GeoJSON tiles for a new zoom are cut in workers; the step settles when they are drawn.
    settled: idle,
    stats: () => null,
  };
}

/** Leaflet reference: circle markers on its Canvas renderer, no basemap. */
async function mountLeafletPoints(points: ReturnType<typeof densePoints>): Promise<PointLane> {
  const leafletModule = await import("leaflet");
  const L = (leafletModule as { default?: typeof leafletModule }).default ?? leafletModule;
  const map = L.map(container, {
    attributionControl: false,
    fadeAnimation: false,
    // Fractional journey zooms must not snap to integer levels.
    zoomAnimation: false,
    zoomControl: false,
    zoomSnap: 0,
  }).setView([DENSE_POINT_VIEW.center[1], DENSE_POINT_VIEW.center[0]], DENSE_POINT_VIEW.zoom);
  const renderer = L.canvas();
  const layer = L.layerGroup(
    points.map((point) =>
      L.circleMarker([point.latitude, point.longitude], {
        fillColor: POINT_COLOR,
        fillOpacity: 1,
        radius: POINT_RADIUS,
        renderer,
        stroke: false,
      }),
    ),
  ).addTo(map);
  void layer;
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  return {
    applyCamera: (camera) =>
      map.setView([camera.center[1], camera.center[0]], camera.zoom, { animate: false }),
    camera() {
      const center = map.getCenter();
      return {
        bearing: null,
        latitude: center.lat,
        longitude: center.lng,
        pitch: null,
        zoom: map.getZoom(),
      };
    },
    // Leaflet has no bearing or pitch: its lane follows centre and zoom only.
    cameraAxes: ["center", "zoom"],
    pointRenderer: () => "leaflet-canvas",
    ready: frame().then(frame).then(() => undefined),
    // The Canvas renderer redraws every marker in the frame after a view change.
    settled: async () => {},
    stats: () => null,
  };
}

function waitFor(condition: () => boolean, timeoutMs = 20_000) {
  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (condition()) resolve();
      else if (performance.now() - started > timeoutMs)
        reject(new Error("benchmark map not ready"));
      else requestAnimationFrame(poll);
    };
    poll();
  });
}

type Recording = {
  frames: number[];
  loafBlockingMs: number;
  loafScriptMs: number;
  loafCount: number;
  inputDurations: number[];
};

let recording: Recording | null = null;
const loafObserver = new PerformanceObserver((list) => {
  if (!recording) return;
  for (const entry of list.getEntries() as Array<
    PerformanceEntry & { blockingDuration?: number; scripts?: Array<{ duration: number }> }
  >) {
    recording.loafCount++;
    recording.loafBlockingMs += entry.blockingDuration ?? 0;
    for (const script of entry.scripts ?? []) recording.loafScriptMs += script.duration;
  }
});
try {
  loafObserver.observe({ type: "long-animation-frame", buffered: false });
} catch {
  // Long Animation Frames are Chromium-only; frame intervals remain available.
}
const eventObserver = new PerformanceObserver((list) => {
  if (!recording) return;
  for (const entry of list.getEntries()) {
    if (/^(pointermove|mousemove|wheel|pointerdown|mousedown)$/.test(entry.name)) {
      recording.inputDurations.push(entry.duration);
    }
  }
});
try {
  eventObserver.observe({
    type: "event",
    durationThreshold: 16,
    buffered: false,
  } as PerformanceObserverInit);
} catch {
  // Event Timing is optional evidence.
}

const mounted = await mountEngine();
container.dataset.engine = engine;
await mounted.ready;
container.dataset.ready = "true";

declare global {
  interface Window {
    interactionBenchmark: {
      engine: BenchmarkEngine;
      camera(): BenchmarkCamera;
      presentationCost(frames: number, bearing?: number): Promise<number | null>;
      presentCamera(state: { center: [number, number]; zoom: number; bearing?: number }): void;
      /**
       * Runs `densePointJourney(steps)`, the cameras of the retained-point spec; by default
       * with the spec's step count for this point count.
       */
      pointJourney(steps?: number): Promise<PointJourneyResult>;
      pointRenderer(): string | null;
      start(): void;
      stop(): Promise<Recording>;
    };
  }
}

type PointJourneyResult = {
  after: PointLaneStats | null;
  before: PointLaneStats | null;
  cameraAxes: Array<keyof DensePointCamera>;
  /** Where the lane ended: proves it followed the journey (Leaflet ignores bearing/pitch). */
  finalCamera: BenchmarkCamera;
  /** The journey's last camera command. */
  lastCamera: DensePointCamera;
  points: number;
  steps: Array<{
    /** Camera command until the next animation frame callback (after the engine's draw). */
    presentMs: number;
    /** Camera command until the engine reports every point for that camera drawn. */
    settledMs: number;
    /** Maps lanes: application upload bytes and retained point frames of this step. */
    applicationUploadBytes: number | null;
    retainedPointFrames: number | null;
  }>;
};

window.interactionBenchmark = {
  engine,
  async pointJourney(stepCount) {
    const lane = pointLane;
    if (!lane) throw new Error("not a point journey page (missing points=N)");
    const cameras = densePointJourney(stepCount ?? densePointJourneySteps(pointCount));
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    await frame();
    await lane.settled();
    const before = lane.stats();
    const steps: PointJourneyResult["steps"] = [];
    for (const camera of cameras) {
      const started = performance.now();
      lane.applyCamera(camera);
      await frame();
      const presentMs = performance.now() - started;
      await lane.settled();
      const settledMs = performance.now() - started;
      const stats = lane.stats();
      steps.push({
        applicationUploadBytes: stats?.applicationUploadBytes ?? null,
        presentMs,
        retainedPointFrames: stats?.retainedPointFrames ?? null,
        settledMs,
      });
    }
    return {
      after: lane.stats(),
      before,
      cameraAxes: lane.cameraAxes,
      finalCamera: lane.camera(),
      lastCamera: cameras.at(-1)!,
      points: pointCount,
      steps,
    };
  },
  pointRenderer: () => mounted.pointRenderer?.() ?? null,
  camera: () => mounted.camera(),
  presentCamera(state) {
    if (!mounted.presentCamera) throw new Error(`${engine} has no controlled camera command`);
    mounted.presentCamera(state);
  },
  async presentationCost(frames, bearing = 0) {
    const present = mounted.presentCamera;
    if (!present) return null;
    const costs: number[] = [];
    for (let i = 0; i < frames; i++) {
      await new Promise(requestAnimationFrame);
      // Sub-tile camera motion, one presentation per animation frame: the
      // steady-state drag case without tile churn.
      const started = performance.now();
      present({
        center: [initial.center[0] + (i % 40) * 0.0004, initial.center[1]],
        zoom: initial.zoom + (i % 2) * 0.01,
        bearing,
      });
      costs.push(performance.now() - started);
    }
    costs.sort((left, right) => left - right);
    return costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
  },
  start() {
    const current: Recording = {
      frames: [],
      loafBlockingMs: 0,
      loafScriptMs: 0,
      loafCount: 0,
      inputDurations: [],
    };
    recording = current;
    const tick = (time: number) => {
      if (recording !== current) return;
      current.frames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  async stop() {
    // Let observers deliver entries for the final frames.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = recording!;
    recording = null;
    return result;
  },
};
