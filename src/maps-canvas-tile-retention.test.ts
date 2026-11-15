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

// #447: on the Canvas fallback, decoded tile images are the only tile memory Maps retains.
// Rust owns the cache budget and names every eviction; the browser runtime must close what
// Rust evicts and publish what it still holds, however long the camera keeps zooming.
// Replace only the WASM/device boundary: the runtime below stands in for Rust scheduling.
vi.mock("./flat-runtime-wasm", () => ({ loadMapsFlatRasterRuntime: vi.fn() }));
vi.mock("./wgpu-base-map-wasm", () => ({
  loadMapsWgpuBaseMapRenderer: vi.fn(),
}));

const CACHE_CAPACITY = 12;

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let bitmaps: Array<{ closed: boolean; key: string }>;

/** A Rust-like scheduler: four tiles per integer zoom, an LRU cache of `CACHE_CAPACITY`. */
function createRuntime(): MapsFlatRasterRuntime {
  let camera = {
    bearing: 0,
    center: [0, 0] as [number, number],
    height: 400,
    pitch: 0,
    width: 600,
    zoom: 2,
  };
  const resident: string[] = [];
  const pending = new Set<string>();
  const tilesAt = (zoom: number): MapsRasterTileId[] => {
    const z = Math.floor(zoom);
    return [0, 1].flatMap((x) =>
      [0, 1].map((y) => ({ key: `${z}/${x}/${y}`, x, y, z })),
    );
  };
  const parse = (key: string): MapsRasterTileId => {
    const [z, x, y] = key.split("/").map(Number) as [number, number, number];
    return { key, x, y, z };
  };
  return {
    activateTileset: vi.fn(() => "unused"),
    dispose: vi.fn(),
    fitBounds: vi.fn(),
    flyTo: vi.fn(() => 0),
    advanceFlight: vi.fn(() => false),
    cancelFlight: vi.fn(),
    frame: vi.fn((): MapsFlatRasterFrame => {
      const visible = tilesAt(camera.zoom);
      const keys = new Set(visible.map((tile) => tile.key));
      const evictions: MapsRasterTileId[] = [];
      while (resident.length > CACHE_CAPACITY) {
        const index = resident.findIndex((key) => !keys.has(key));
        if (index < 0) break;
        evictions.push(parse(resident.splice(index, 1)[0]!));
      }
      const requests = visible.filter(
        (tile) => !resident.includes(tile.key) && !pending.has(tile.key),
      );
      for (const tile of requests) pending.add(tile.key);
      return {
        camera: { ...camera, center: [...camera.center] },
        cancellations: [],
        evictions,
        placements: visible.map((tile, index) => ({
          tile,
          worldCopy: 0,
          localWest: index * 256,
          localNorth: 0,
          localSize: 256,
          screenX: index * 256,
          screenY: 0,
          screenWidth: 256,
          screenHeight: 256,
        })),
        renderCamera: {
          viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
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
      if (!resident.includes(tile.key)) resident.push(tile.key);
    }),
    markSourceLoaded: vi.fn(),
    panBetween: vi.fn(),
    panBy: vi.fn(),
    project: vi.fn((): [number, number] => [0, 0]),
    projectPacked: vi.fn(
      (coordinates: Float64Array) => new Float64Array(coordinates.length),
    ),
    resize: vi.fn((width: number, height: number) => {
      camera = { ...camera, height, width };
    }),
    rotateAbout: vi.fn(),
    setBackgroundStyle: vi.fn(),
    setSkyStyle: vi.fn(),
    setViewState: vi.fn((state: MapViewState) => {
      camera = {
        ...camera,
        ...state,
        bearing: state.bearing ?? 0,
        pitch: state.pitch ?? 0,
      };
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
  bitmaps = [];
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
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(
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
  // Every 2D call is accepted; pixels are not this test's subject.
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
  vi.mocked(loadMapsFlatRasterRuntime).mockResolvedValue(createRuntime());
  // No WebGPU: the base map draws on the Canvas fallback.
  vi.mocked(loadMapsWgpuBaseMapRenderer).mockRejectedValue(
    new Error("WebGPU is unavailable in this browser."),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let round = 0; round < 4; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}

it("closes every decoded tile Rust evicts and publishes the bounded rest during sustained zoom on Canvas", async () => {
  const canvas = document.createElement("canvas");
  const fallback = document.createElement("canvas");
  const host = createMapsBrowserRuntime(canvas, fallback, {
    createTileImageLoader: () => ({
      dispose() {},
      load: async (_url, tile) => {
        const bitmap = { closed: false, key: tile.key };
        bitmaps.push(bitmap);
        return {
          close: () => {
            bitmap.closed = true;
          },
          height: 256,
          width: 256,
        } as unknown as ImageBitmap;
      },
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
    await settle();
    expect(canvas.dataset.mapBaseRenderer).toBe("canvas2d");

    // Zoom in and back out across 18 integer levels: 72 distinct tiles, 6x the budget.
    for (const zoom of [
      ...Array.from({ length: 18 }, (_, step) => 3 + step),
      2,
      10,
      19,
    ]) {
      host.controller?.setViewState({ center: [0, 0], zoom });
      await settle();
      const live = bitmaps.filter((bitmap) => !bitmap.closed);
      expect(canvas.dataset.mapBaseRetainedTiles).toBe(String(live.length));
      expect(live.length).toBeLessThanOrEqual(CACHE_CAPACITY + 4);
    }
    expect(bitmaps.length).toBeGreaterThan(6 * CACHE_CAPACITY);
  } finally {
    host.dispose();
  }
  // Disposal releases the retained set too.
  expect(bitmaps.filter((bitmap) => !bitmap.closed)).toEqual([]);
});
