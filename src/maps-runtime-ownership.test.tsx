import { Suspense, startTransition, useState, useCallback } from "react";
import { MapsCanvasFlatRuntime } from "./canvas-flat-runtime";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeoJsonLayer } from "./geojson-layer";
import { MapsMapView } from "./maps-map-view";
import type { MapSurfaceController, MapViewState } from "./map-display";
import type { MapsFlatRasterFrame, MapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { loadMapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { loadMapsWgpuBaseMapRenderer, type MapsWgpuBaseMapRenderer } from "./wgpu-base-map-wasm";

// Replace only the WASM/device boundary. The Map View, input host, layer
// preparation, projection cache and application-frame packing are real.
vi.mock("./flat-runtime-wasm", () => ({ loadMapsFlatRasterRuntime: vi.fn() }));
vi.mock("./wgpu-base-map-wasm", () => ({ loadMapsWgpuBaseMapRenderer: vi.fn() }));

const featureCollection = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      id: "entity",
      properties: {},
      geometry: { type: "Point" as const, coordinates: [10, 0] },
    },
  ],
};

let camera: MapsFlatRasterFrame["camera"];
let runtime: MapsFlatRasterRuntime;
let renderer: MapsWgpuBaseMapRenderer;
let paints: Array<{ zoom: number; x: number | undefined }>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let resizeCallbacks: Array<{ callback: ResizeObserverCallback; target?: Element }>;
let size: { width: number; height: number };
let context: CanvasRenderingContext2D;

beforeEach(() => {
  vi.mocked(loadMapsFlatRasterRuntime).mockReset();
  vi.mocked(loadMapsWgpuBaseMapRenderer).mockReset();
  camera = { center: [0, 0], zoom: 4, bearing: 0, pitch: 0, width: 600, height: 400 };
  size = { width: 600, height: 400 };
  paints = [];
  frames = new Map();
  nextFrame = 0;
  resizeCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: { callback: ResizeObserverCallback; target?: Element };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback };
        resizeCallbacks.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    ...size,
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: size.width,
    bottom: size.height,
    toJSON() {},
  }));
  context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  runtime = {
    dispose: vi.fn(),
    fitBounds: vi.fn(),
    markFailed: vi.fn(),
    markLoaded: vi.fn(),
    panBy: vi.fn(),
    panBetween: vi.fn((previousX, previousY, x, y) => {
      camera.center = [camera.center[0] + previousX - x, camera.center[1] + previousY - y];
    }),
    setViewState: vi.fn((state: MapViewState) => {
      camera = { ...camera, ...state, bearing: state.bearing ?? 0, pitch: state.pitch ?? 0 };
    }),
    resize: vi.fn((width, height) => {
      camera = { ...camera, width, height };
    }),
    project: vi.fn((longitude: number, latitude: number): [number, number] => [
      camera.width / 2 + (longitude - camera.center[0]) * camera.zoom,
      camera.height / 2 - (latitude - camera.center[1]) * camera.zoom,
    ]),
    projectPacked: vi.fn((coordinates: Float64Array) => {
      const projected = new Float64Array(coordinates.length);
      for (let index = 0; index < coordinates.length; index += 2) {
        projected[index] =
          camera.width / 2 + (coordinates[index]! - camera.center[0]) * camera.zoom;
        projected[index + 1] =
          camera.height / 2 - (coordinates[index + 1]! - camera.center[1]) * camera.zoom;
      }
      return projected;
    }),
    unproject: vi.fn((): [number, number] => [0, 0]),
    zoomAbout: vi.fn((delta, _x, _y, min, max) => {
      camera.zoom = Math.max(min, Math.min(max, camera.zoom + delta));
    }),
    frame: vi.fn(
      (): MapsFlatRasterFrame => ({
        camera: { ...camera, center: [...camera.center] },
        cancellations: [],
        evictions: [],
        placements: [],
        requests: [],
        // An identifiable device-boundary payload, not a replacement projection.
        renderCamera: {
          viewProjection: [camera.zoom, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        visibleBounds: {
          west: -180,
          east: 180,
          south: -85,
          north: 85,
          crossesAntimeridian: false,
          spansFullWorld: true,
        },
      }),
    ),
  };
  renderer = {
    dispose: vi.fn(),
    evictTile: vi.fn(),
    isDeviceLost: vi.fn(() => false),
    resize: vi.fn(),
    uploadTile: vi.fn(),
    render: vi.fn((_tiles, matrix, application) => {
      paints.push({ zoom: matrix.viewProjection[0], x: application?.circles[0]?.x });
      return 0;
    }),
  };
  vi.mocked(loadMapsFlatRasterRuntime).mockResolvedValue(runtime);
  vi.mocked(loadMapsWgpuBaseMapRenderer).mockResolvedValue(renderer);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushAnimationFrame(now = 16) {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

async function ready(container: HTMLElement) {
  await waitFor(() =>
    expect(container.querySelector("[data-map-ready]")?.getAttribute("data-map-ready")).toBe(
      "true",
    ),
  );
}

// The browser host and React adapters are real; only the WASM/device edge is stubbed.
describe("React ownership regression on merged source", () => {
  it("keeps one controller and ready notification across camera changes", async () => {
    const onReady = vi.fn();
    const mounted = render(
      <MapsMapView
        mapLabel="Regression"
        mapStyle={{ tiles: false }}
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 4 }}
        onMapControllerReady={onReady}
      >
        <GeoJsonLayer featureCollection={featureCollection} />
      </MapsMapView>,
    );
    await ready(mounted.container);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const original = onReady.mock.calls[0]![0] as MapSurfaceController;
    const initialCalls = onReady.mock.calls.length;
    for (let i = 0; i < 8; i++) act(() => original.setViewState({ center: [i + 1, 0], zoom: 4 }));
    const after = onReady.mock.calls.length - initialCalls;
    expect(after).toBe(0);
    expect(vi.mocked(loadMapsFlatRasterRuntime)).toHaveBeenCalledTimes(1);
    expect(new Set(onReady.mock.calls.map((call) => call[0])).size).toBe(1);
  });

  it("applies the latest committed camera before WASM startup publishes readiness", async () => {
    let resolve!: (value: MapsFlatRasterRuntime) => void;
    const pending = new Promise<MapsFlatRasterRuntime>((accept) => {
      resolve = accept;
    });
    vi.mocked(loadMapsFlatRasterRuntime).mockReturnValueOnce(pending);
    const onReady = vi.fn();
    const onChange = vi.fn();
    const content = (zoom: number) => (
      <MapsMapView
        mapLabel="Regression"
        mapStyle={{ tiles: false }}
        fitToData={false}
        viewState={{ center: [0, 0], zoom }}
        onMapControllerReady={onReady}
        onViewStateChange={onChange}
      >
        <GeoJsonLayer featureCollection={featureCollection} />
      </MapsMapView>
    );
    const mounted = render(content(4));
    expect(loadMapsFlatRasterRuntime).toHaveBeenCalledTimes(1);
    mounted.rerender(content(7));
    await act(async () => {
      resolve(runtime);
      await pending;
    });
    await ready(mounted.container);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const ctrl = onReady.mock.calls.at(-1)![0] as MapSurfaceController;
    expect(ctrl.getViewState().zoom).toBe(7);
    expect(runtime.setViewState).toHaveBeenCalledWith(expect.objectContaining({ zoom: 7 }));
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ zoom: 4 }),
      expect.objectContaining({ reason: "initial" }),
    );
  });
});

describe("Concurrent React render isolation regression", () => {
  it("keeps speculative render callbacks out of the live engine", async () => {
    const never = new Promise<void>(() => {});
    function Block({ suspend }: { suspend: boolean }) {
      if (suspend) throw never;
      return <span>Committed UI</span>;
    }
    const committed = vi.fn();
    const speculative = vi.fn();
    const onReady = vi.fn();
    const viewState: MapViewState = { center: [0, 0], zoom: 4 };
    const content = (suspend: boolean) => (
      <Suspense fallback={<span>Loading speculative UI</span>}>
        <MapsCanvasFlatRuntime
          mapStyle={{ tiles: false }}
          viewState={viewState}
          onViewStateChange={suspend ? speculative : committed}
          onReady={onReady}
        />
        <Block suspend={suspend} />
      </Suspense>
    );
    const mounted = render(content(false));
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    committed.mockClear();
    act(() => startTransition(() => mounted.rerender(content(true))));
    expect(mounted.queryByText("Loading speculative UI")).toBeNull();
    expect(mounted.getByText("Committed UI")).toBeTruthy();
    const canvas = mounted.container.querySelector('[data-flat-runtime="maps"]')!;
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
    act(flushAnimationFrame);
    expect(speculative).not.toHaveBeenCalled();
    expect(committed).toHaveBeenCalledOnce();
  });
});

describe("Controlled composition regression", () => {
  it("does not repeat geometry work for controlled camera and controller state", async () => {
    const style = vi.fn((_feature: unknown) => ({ pointColor: "#2563eb" }));
    const collection = {
      ...featureCollection,
      features: Array.from({ length: 1000 }, (_, i) => ({
        ...featureCollection.features[0]!,
        id: `entity-${i}`,
        geometry: { type: "Point" as const, coordinates: [i / 100, 0] },
      })),
    };
    const notInteractive = () => false;
    function Consumer() {
      const [viewState, setViewState] = useState<MapViewState>({ center: [0, 0], zoom: 4 });
      const [, setController] = useState<MapSurfaceController | null>(null);
      const onReady = useCallback((next: MapSurfaceController) => setController(next), []);
      return (
        <MapsMapView
          mapLabel="Composition regression"
          mapStyle={{ tiles: false }}
          fitToData={false}
          viewState={viewState}
          onViewStateChange={setViewState}
          onMapControllerReady={onReady}
        >
          <GeoJsonLayer
            featureCollection={collection}
            getFeatureStyle={style}
            isFeatureInteractive={notInteractive}
          />
        </MapsMapView>
      );
    }
    const mounted = render(<Consumer />);
    await ready(mounted.container);
    paints.length = 0;
    vi.mocked(runtime.project).mockClear();
    vi.mocked(runtime.projectPacked).mockClear();
    style.mockClear();
    const canvas = mounted.container.querySelector('[data-flat-runtime="maps"]')!;
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
    act(flushAnimationFrame);
    expect(style).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.project)).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.projectPacked)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.projectPacked).mock.calls[0]![0]).toHaveLength(2000);
    expect(paints).toHaveLength(1);
  });
});

describe("plain browser host lifecycle", () => {
  it("applies camera and viewport changes made while the GPU is initializing", async () => {
    const { createMapsBrowserRuntime } = await import("./maps-browser-runtime");
    let finish!: (renderer: MapsWgpuBaseMapRenderer) => void;
    vi.mocked(loadMapsWgpuBaseMapRenderer).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const callback = vi.fn();
    const options = {
      mapStyle: { tiles: false } as const,
      viewState: { center: [0, 0] as [number, number], zoom: 4 },
      onViewStateChange: callback,
    };
    const canvas = document.createElement("canvas");
    const host = createMapsBrowserRuntime(canvas, document.createElement("canvas"), options);
    await waitFor(() => expect(loadMapsWgpuBaseMapRenderer).toHaveBeenCalledOnce());
    size = { width: 720, height: 450 };
    host.update({ ...options, viewState: { center: [2, 3], zoom: 7 } });
    finish(renderer);
    await host.ready;
    expect(host.controller!.getViewState()).toEqual({ center: [2, 3], zoom: 7 });
    expect(runtime.resize).toHaveBeenCalledWith(720, 450);
    expect(callback).not.toHaveBeenCalled();
    expect(canvas.dataset.mapBaseRenderer).toBe("wgpu");
    const controller = host.controller!;
    host.dispose();
    host.dispose();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(() => controller.setViewState({ center: [0, 0], zoom: 9 })).toThrow(/disposed/);
  });

  it.each(["wasm", "gpu"] as const)(
    "disposes exactly once when cancelled during %s initialization",
    async (phase) => {
      const { createMapsBrowserRuntime } = await import("./maps-browser-runtime");
      let finish!: () => void;
      if (phase === "wasm")
        vi.mocked(loadMapsFlatRasterRuntime).mockReturnValue(
          new Promise((resolve) => {
            finish = () => resolve(runtime);
          }),
        );
      else
        vi.mocked(loadMapsWgpuBaseMapRenderer).mockReturnValue(
          new Promise((resolve) => {
            finish = () => resolve(renderer);
          }),
        );
      const onReady = vi.fn();
      const host = createMapsBrowserRuntime(
        document.createElement("canvas"),
        document.createElement("canvas"),
        {
          mapStyle: { tiles: false },
          viewState: { center: [0, 0], zoom: 4 },
          onViewStateChange: vi.fn(),
          onReady,
        },
      );
      if (phase === "gpu")
        await waitFor(() => expect(loadMapsWgpuBaseMapRenderer).toHaveBeenCalledOnce());
      host.dispose();
      if (phase === "gpu") expect(runtime.dispose).toHaveBeenCalledOnce();
      finish();
      await host.ready;
      host.dispose();
      expect(onReady).not.toHaveBeenCalled();
      expect(runtime.dispose).toHaveBeenCalledOnce();
      expect(renderer.dispose).toHaveBeenCalledTimes(phase === "gpu" ? 1 : 0);
      expect(frames.size).toBe(0);
    },
  );

  it("uses updated fit options through the original public controller", async () => {
    const onController = vi.fn();
    const view = (padding: number, maxZoom: number) => (
      <MapsMapView
        fitToData={false}
        dataBounds={[0, 0, 2, 2]}
        fitBoundsPadding={padding}
        maxZoom={maxZoom}
        initialViewState={{ center: [0, 0], zoom: 4 }}
        mapStyle={{ tiles: false }}
        onMapControllerReady={onController}
      />
    );
    const mounted = render(view(10, 8));
    await ready(mounted.container);
    const controller = onController.mock.calls[0]![0] as MapSurfaceController;
    mounted.rerender(view(30, 12));
    act(() => controller.fitToData());
    expect(runtime.fitBounds).toHaveBeenLastCalledWith([0, 0, 2, 2], 30, 12);
    expect(new Set(onController.mock.calls.map((call) => call[0])).size).toBe(1);
    expect(onController).toHaveBeenCalledOnce();
  });
});
