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

async function mountMap() {
  let controller: MapSurfaceController | undefined;
  const changed = vi.fn();
  const content = (collection = featureCollection) => (
    <MapsMapView
      mapLabel="Camera presentation"
      mapStyle={{ tiles: false }}
      fitToData={false}
      initialViewState={{ center: [0, 0], zoom: 4 }}
      onMapControllerReady={(next) => {
        controller = next;
      }}
      onViewStateChange={changed}
    >
      <GeoJsonLayer featureCollection={collection} />
    </MapsMapView>
  );
  const mounted = render(content());
  await waitFor(() => {
    expect(mounted.getByLabelText("Camera presentation").dataset.mapReady).toBe("true");
    expect(paints.at(-1)?.x).toBe(340);
  });
  paints.length = 0;
  vi.mocked(runtime.frame).mockClear();
  vi.mocked(runtime.project).mockClear();
  vi.mocked(runtime.projectPacked).mockClear();
  changed.mockClear();
  const canvas = mounted.container.querySelector<HTMLCanvasElement>('[data-flat-runtime="maps"]')!;
  const overlay = mounted.container.querySelector<HTMLCanvasElement>(
    '[data-map-overlay-runtime="maps"]',
  )!;
  return {
    ...mounted,
    canvas,
    overlay,
    changed,
    controller: controller!,
    replaceLayer: () =>
      mounted.rerender(
        content({
          ...featureCollection,
          features: [
            {
              ...featureCollection.features[0]!,
              geometry: { type: "Point", coordinates: [20, 0] },
            },
          ],
        }),
      ),
  };
}

function flushAnimationFrame(now = 16) {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, timestamp: number, id = 1) {
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => true;
  const event = new Event(type, { bubbles: true });
  for (const [name, value] of Object.entries({
    pointerId: id,
    pointerType: "mouse",
    button: 0,
    clientX: x,
    clientY: 80,
    timeStamp: timestamp,
  }))
    Object.defineProperty(event, name, { value });
  fireEvent(canvas, event);
}

describe("Maps camera presentation", () => {
  it("coalesces wheel paints without dropping ordered, differently anchored Rust zoom commands", async () => {
    const { canvas, changed } = await mountMap();
    for (let index = 0; index < 8; index += 1) {
      fireEvent.wheel(canvas, { deltaY: -20, clientX: 100 + index, clientY: 80 });
    }
    expect(runtime.zoomAbout).not.toHaveBeenCalled();
    expect(paints).toHaveLength(0);
    expect(runtime.frame).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    act(flushAnimationFrame);
    expect(runtime.zoomAbout).toHaveBeenCalledTimes(8);
    expect(vi.mocked(runtime.zoomAbout).mock.calls.map((call) => call[1])).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107,
    ]);
    expect(paints).toHaveLength(1);
    expect(paints[0]!.zoom).toBeCloseTo(4.4);
    expect(paints[0]!.x).toBeCloseTo(344);
    expect(runtime.frame).toHaveBeenCalledTimes(1);
    expect(runtime.project).not.toHaveBeenCalled();
    expect(runtime.projectPacked).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("preserves zoom clamping when a burst reverses direction at the limit", async () => {
    const { canvas, controller } = await mountMap();
    act(() => controller.setViewState({ center: [0, 0], zoom: 22 }));
    paints.length = 0;
    fireEvent.wheel(canvas, { deltaY: -200, clientX: 120, clientY: 80 });
    fireEvent.wheel(canvas, { deltaY: 200, clientX: 120, clientY: 80 });
    act(flushAnimationFrame);
    expect(paints).toEqual([{ zoom: 21.5, x: 515 }]);
  });

  it("drains the final drag commands and inertia into the same first paint", async () => {
    const { canvas } = await mountMap();
    vi.spyOn(performance, "now").mockReturnValue(200);
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    pointer(canvas, "pointermove", 116, 132);
    pointer(canvas, "pointerup", 116, 148);
    expect(runtime.panBetween).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    act(() => flushAnimationFrame(216));
    expect(runtime.panBetween).toHaveBeenCalledTimes(3);
    expect(paints).toHaveLength(1);
    expect(runtime.project).not.toHaveBeenCalled();
    expect(runtime.projectPacked).toHaveBeenCalledTimes(1);
    expect(paints[0]!.x).toBeGreaterThan(404);
  });

  it("does not lose queued drag commands when a new gesture interrupts the first inertia tick", async () => {
    const { canvas } = await mountMap();
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    pointer(canvas, "pointermove", 116, 132);
    pointer(canvas, "pointerup", 116, 148);
    pointer(canvas, "pointerdown", 120, 152, 2);
    act(flushAnimationFrame);
    expect(runtime.panBetween).toHaveBeenCalledTimes(2);
    expect(paints).toEqual([{ zoom: 4, x: 404 }]);
    expect(frames.size).toBe(0);
  });

  it("presents the new layer coordinates on the first programmatic camera paint, before React effects", async () => {
    const { controller } = await mountMap();
    act(() => {
      controller.setViewState({ center: [0, 0], zoom: 7 });
      expect(paints).toEqual([{ zoom: 7, x: 370 }]);
    });
    // Reflecting camera state into React must not clear and submit the layers again.
    expect(paints).toEqual([{ zoom: 7, x: 370 }]);
    expect(runtime.project).not.toHaveBeenCalled();
    expect(runtime.projectPacked).toHaveBeenCalledTimes(1);
  });

  it("refreshes layers on resize even when the geographic camera is unchanged", async () => {
    await mountMap();
    size = { width: 800, height: 400 };
    act(() => {
      // The base Map View observer updates the Rust viewport. Layer observers are
      // deliberately not called: the first base paint must already be coherent.
      resizeCallbacks
        .find((entry) => entry.target?.getAttribute("data-flat-runtime") === "maps")!
        .callback([], {} as ResizeObserver);
      expect(paints).toEqual([{ zoom: 4, x: 440 }]);
    });
  });

  it("cancels a pending input paint when an explicit camera command supersedes it", async () => {
    const { canvas, controller, changed } = await mountMap();
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 120, clientY: 80 });
    act(() => controller.setViewState({ center: [0, 0], zoom: 8 }));
    act(flushAnimationFrame);
    expect(paints).toEqual([{ zoom: 8, x: 380 }]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps data updates coherent while an input frame is pending", async () => {
    const { canvas, replaceLayer } = await mountMap();
    fireEvent.wheel(canvas, { deltaY: -200, clientX: 120, clientY: 80 });
    replaceLayer();
    for (const paint of paints) expect(paint.x).toBe(300 + 20 * paint.zoom);
    act(flushAnimationFrame);
    expect(paints.at(-1)).toEqual({ zoom: 4.5, x: 390 });
  });

  it("moves layers to Canvas immediately if the GPU fails on a camera paint", async () => {
    const { controller, overlay } = await mountMap();
    vi.mocked(renderer.render).mockImplementationOnce(() => {
      throw new Error("device lost");
    });
    vi.mocked(context.arc).mockClear();
    act(() => {
      controller.setViewState({ center: [0, 0], zoom: 7 });
      expect(overlay.dataset.mapOverlayBackend).toBe("canvas2d");
      expect(context.arc).toHaveBeenCalledWith(370, 200, expect.any(Number), 0, Math.PI * 2);
    });
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not execute a queued camera paint after the Map View is unmounted", async () => {
    const { canvas, unmount, changed } = await mountMap();
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 120, clientY: 80 });
    unmount();
    paints.length = 0;
    changed.mockClear();
    act(flushAnimationFrame);
    expect(frames.size).toBe(0);
    expect(paints).toHaveLength(0);
    expect(changed).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});
