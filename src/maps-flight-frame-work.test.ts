import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  MapsFlatRasterFrame,
  MapsFlatRasterRuntime,
  MapsRasterTileId,
} from "./flat-runtime-wasm";
import { loadMapsFlatRasterRuntime } from "./flat-runtime-wasm";
import type { MapViewState } from "./map-display";
import { createMapsBrowserRuntime } from "./maps-browser-runtime";
import { loadMapsWgpuBaseMapRenderer } from "./wgpu-base-map-wasm";

// #433 Fast: a flight presents one camera frame per animation frame. Tile arrivals and raster
// fade-ins during the flight must not add base renders or frame plans of their own: the
// flight's next frame already plans the arrived tiles and draws the fade at its time.
// `camera-transition-journey-v1` found up to ~9 plans and renders per animation frame
// during a zoom-out flight. Replace only the WASM/device boundary.
vi.mock("./flat-runtime-wasm", () => ({ loadMapsFlatRasterRuntime: vi.fn() }));
vi.mock("./wgpu-base-map-wasm", () => ({ loadMapsWgpuBaseMapRenderer: vi.fn() }));

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let now: number;
let runtime: MapsFlatRasterRuntime;

/** A Rust-like flat runtime: 4x4 tiles per integer zoom over loaded parents, a linear zoom flight. */
function createRuntime(): MapsFlatRasterRuntime {
  let camera = {
    bearing: 0,
    center: [0, 0] as [number, number],
    height: 400,
    pitch: 0,
    width: 600,
    zoom: 2,
  };
  let flight: { from: number; to: number; duration: number } | null = null;
  const resident = new Set<string>();
  const pending = new Set<string>();
  const tilesAt = (zoom: number): MapsRasterTileId[] => {
    const z = Math.floor(zoom);
    return [0, 1, 2, 3].flatMap((x) =>
      [0, 1, 2, 3].map((y) => ({ key: `${z}/${x}/${y}`, x, y, z })),
    );
  };
  return {
    activateTileset: vi.fn(() => "unused"),
    dispose: vi.fn(),
    fitBounds: vi.fn(),
    flyTo: vi.fn((state: MapViewState, duration?: number) => {
      flight = { duration: duration ?? 1000, from: camera.zoom, to: state.zoom };
      return flight.duration;
    }),
    advanceFlight: vi.fn((elapsed: number) => {
      if (!flight) return false;
      const t = Math.min(1, elapsed / flight.duration);
      camera = { ...camera, zoom: flight.from + (flight.to - flight.from) * t };
      if (t >= 1) flight = null;
      return t < 1;
    }),
    cancelFlight: vi.fn(() => {
      flight = null;
    }),
    frame: vi.fn((): MapsFlatRasterFrame => {
      const visible = tilesAt(camera.zoom);
      const requests = visible.filter((tile) => !resident.has(tile.key) && !pending.has(tile.key));
      for (const tile of requests) pending.add(tile.key);
      // As Rust, loaded parent tiles stay placed beneath their children, so children fade in.
      const z = Math.floor(camera.zoom);
      const parents = [0, 1]
        .flatMap((x) => [0, 1].map((y) => ({ key: `${z - 1}/${x}/${y}`, x, y, z: z - 1 })))
        .filter((tile) => resident.has(tile.key));
      return {
        camera: { ...camera, center: [...camera.center] },
        cancellations: [],
        evictions: [],
        placements: [...parents, ...visible].map((tile, index) => ({
          localNorth: 0,
          localSize: 64,
          localWest: index * 64,
          screenHeight: 64,
          screenWidth: 64,
          screenX: index * 64,
          screenY: 0,
          tile,
          worldCopy: 0,
        })),
        renderCamera: { viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        requests,
        visibleBounds: {
          crossesAntimeridian: false,
          east: 180,
          north: 85,
          south: -85,
          spansFullWorld: true,
          west: -180,
        },
      };
    }),
    mapPlaneScale: vi.fn(() => null),
    markFailed: vi.fn((tile: MapsRasterTileId) => pending.delete(tile.key)),
    markLoaded: vi.fn((tile: MapsRasterTileId) => {
      pending.delete(tile.key);
      resident.add(tile.key);
    }),
    markSourceLoaded: vi.fn(),
    panBetween: vi.fn(),
    panBy: vi.fn(),
    project: vi.fn((): [number, number] => [0, 0]),
    projectPacked: vi.fn((coordinates: Float64Array) => new Float64Array(coordinates.length)),
    resize: vi.fn((width: number, height: number) => {
      camera = { ...camera, height, width };
    }),
    rotateAbout: vi.fn(),
    setBackgroundStyle: vi.fn(),
    setSkyStyle: vi.fn(),
    setViewState: vi.fn((state: MapViewState) => {
      flight = null;
      camera = { ...camera, ...state, bearing: state.bearing ?? 0, pitch: state.pitch ?? 0 };
    }),
    takeSourceEvictions: vi.fn(() => []),
    unproject: vi.fn((): [number, number] => [0, 0]),
    zoom: vi.fn(() => camera.zoom),
    zoomAbout: vi.fn(),
  };
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  now = 1000;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // Inside an animation frame the document timeline reads that frame's time, as in a browser.
  Object.defineProperty(document, "timeline", {
    configurable: true,
    value: {
      get currentTime() {
        return now;
      },
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        bottom: 400,
        height: 400,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
        x: 0,
        y: 0,
      }) as DOMRect,
  );
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, property) => (target[property] ??= vi.fn()),
    set: (target, property, value) => {
      target[property] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  runtime = createRuntime();
  vi.mocked(loadMapsFlatRasterRuntime).mockResolvedValue(runtime);
  // No WebGPU: the base map draws on the Canvas fallback.
  vi.mocked(loadMapsWgpuBaseMapRenderer).mockRejectedValue(new Error("WebGPU is unavailable."));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as { timeline?: unknown }).timeline;
});

/** Lets pending tile loads settle between animation frames. */
async function betweenFrames() {
  for (let round = 0; round < 4; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function animationFrame() {
  now += 16;
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

it("plans and renders the base once per animation frame while a flight overlaps tile arrivals and fade-ins", async () => {
  const canvas = document.createElement("canvas");
  const fallback = document.createElement("canvas");
  const host = createMapsBrowserRuntime(canvas, fallback, {
    createTileImageLoader: () => ({
      dispose() {},
      load: async () => ({ close() {}, height: 256, width: 256 }) as unknown as ImageBitmap,
    }),
    mapStyle: {
      maxZoom: 22,
      minZoom: 0,
      tileSize: 256,
      tiles: "https://tiles.test/{z}/{x}/{y}.png",
    },
    onViewStateChange: () => {},
    viewState: { center: [0, 0], zoom: 2 },
  });
  try {
    await host.ready;
    for (let frame = 0; frame < 30; frame++) {
      await betweenFrames();
      animationFrame();
    }
    await betweenFrames();
    expect(canvas.dataset.mapBaseRenderer).toBe("canvas2d");
    const stats = () => host.controller!.getRendererStats();

    /** Flies to `zoom` over 30 frames, checking one plan and one render per frame. */
    const fly = async (zoom: number) => {
      host.controller!.flyTo({ center: [0, 0], zoom }, { durationMs: 480 });
      let flightFrames = 0;
      let fadingFrames = 0;
      while (canvas.dataset.mapCameraTransition === "fly-to" && flightFrames < 60) {
        // Tiles requested by the last frame arrive before the next one: nothing renders then.
        const rendersBefore = stats().renders;
        const plansBefore = vi.mocked(runtime.frame).mock.calls.length;
        await betweenFrames();
        expect(stats().renders).toBe(rendersBefore);
        expect(vi.mocked(runtime.frame).mock.calls.length).toBe(plansBefore);

        animationFrame();
        flightFrames += 1;
        // The flight's frame plans the arrived tiles and draws the fade: one plan, one render.
        expect(vi.mocked(runtime.frame).mock.calls.length - plansBefore).toBe(1);
        expect(stats().renders - rendersBefore).toBe(1);
        if (frames.size > 1) fadingFrames += 1;
      }
      expect(canvas.dataset.mapCameraTransition).toBeUndefined();
      expect(flightFrames).toBe(30);
      // The flight crossed integer zooms with parents loaded: fade-ins overlapped it.
      expect(fadingFrames).toBeGreaterThan(0);
    };

    await fly(8);
    // A fade-in still running when the next flight starts was scheduled before the flight's
    // first frame: it runs first in that frame and must still not render twice.
    await betweenFrames();
    animationFrame();
    expect(frames.size).toBeGreaterThan(0);
    await fly(12);

    // After the flight, the last tiles arrive and fade in, one render per animation frame.
    const rendersAfterFlight = stats().renders;
    let settleFrames = 0;
    for (;;) {
      await betweenFrames();
      if (frames.size === 0 || settleFrames >= 40) break;
      const before = stats().renders;
      animationFrame();
      expect(stats().renders - before).toBeLessThanOrEqual(1);
      settleFrames += 1;
    }
    expect(stats().renders).toBeGreaterThan(rendersAfterFlight);
    expect(frames.size).toBe(0);
  } finally {
    host.dispose();
  }
});
