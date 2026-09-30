// Comparative interaction benchmark host. One engine per page load so engines never
// share a main thread, GPU context or tile cache. Input is driven externally with
// trusted browser events (scripts/benchmark-interactions.mjs); this page only mounts
// the engine against the shared tile source and observes frames/input latency.
import "maplibre-gl/dist/maplibre-gl.css";
import "leaflet/dist/leaflet.css";

export type BenchmarkEngine = "maps-wgpu" | "maps-canvas2d" | "maplibre" | "leaflet" | "canvas2d";
type BenchmarkCamera = {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number | null;
};

const params = new URLSearchParams(location.search);
const engine = (params.get("engine") ?? "maps-wgpu") as BenchmarkEngine;
const tileUrl = `${location.origin}/__bench_tiles/{z}/{x}/{y}.png`;
const initial = { center: [13.405, 52.52] as [number, number], zoom: 11 };
const container = document.getElementById("map")!;

if (engine === "maps-canvas2d") {
  // Same capability probe the browser runtime uses; forces its Canvas2D backend.
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => undefined });
}

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
};

async function mountEngine(): Promise<MountedEngine> {
  switch (engine) {
    case "maps-wgpu":
    case "maps-canvas2d":
      return mountMaps();
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

async function mountMapLibre() {
  const maplibreModule = await import("maplibre-gl");
  const maplibregl =
    (maplibreModule as { default?: typeof maplibreModule }).default ?? maplibreModule;
  const map = new maplibregl.Map({
    container,
    style: rasterStyle as never,
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
      start(): void;
      stop(): Promise<Recording>;
    };
  }
}

window.interactionBenchmark = {
  engine,
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
