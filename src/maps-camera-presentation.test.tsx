import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeoJsonLayer } from "./geojson-layer";
import { OVERLAY_MOTION_MIN_POINTS } from "./overlay-motion-transform";
import { MapsMapView } from "./maps-map-view";
import type { MapSurfaceController, MapViewState } from "./map-display";
import type { MapsFlatRasterFrame, MapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { loadMapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { loadMapsWgpuBaseMapRenderer, type MapsWgpuBaseMapRenderer } from "./wgpu-base-map-wasm";
import { createMapsBrowserRuntime } from "./maps-browser-runtime";
import type { MapScreenRenderFrame } from "./map-screen-render-frame";

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
let surface: MapsFlatRasterFrame["surface"];

beforeEach(() => {
  camera = { center: [0, 0], zoom: 4, bearing: 0, pitch: 0, width: 600, height: 400 };
  surface = undefined;
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
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLCanvasElement) {
      return layoutRect(this, size);
    },
  );
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
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    rotate: vi.fn(),
    translate: vi.fn(),
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
    unproject: vi.fn((x: number, y: number): [number, number] => [
      camera.center[0] + (x - camera.width / 2) / camera.zoom,
      camera.center[1] - (y - camera.height / 2) / camera.zoom,
    ]),
    rotateAbout: vi.fn((delta: number) => {
      camera.bearing = (camera.bearing ?? 0) + delta;
    }),
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
        surface,
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
    render: vi.fn((_tiles, matrix, application, _margin, viewportClip) => {
      paints.push({
        zoom: matrix.viewProjection[0],
        x: application?.circles[0]?.x,
        ...(viewportClip ? { clip: viewportClip } : {}),
      });
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

async function mountMap(onMapContextMenu?: () => void) {
  let controller: MapSurfaceController | undefined;
  const changed = vi.fn();
  const content = (collection = featureCollection) => (
    <MapsMapView
      mapLabel="Camera presentation"
      mapStyle={{ tiles: false }}
      fitToData={false}
      initialViewState={{ center: [0, 0], zoom: 4 }}
      onMapContextMenu={onMapContextMenu}
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

/** The ±20° x ±10° rectangle, densified past the heavy-overlay threshold. */
function denseRectangle() {
  const perEdge = OVERLAY_MOTION_MIN_POINTS / 4;
  const corners: Array<[number, number]> = [
    [-20, -10],
    [20, -10],
    [20, 10],
    [-20, 10],
  ];
  const ring: Array<[number, number]> = [];
  corners.forEach(([x, y], index) => {
    const [nextX, nextY] = corners[(index + 1) % corners.length]!;
    for (let step = 0; step < perEdge; step += 1) {
      const t = step / perEdge;
      ring.push([x + (nextX - x) * t, y + (nextY - y) * t]);
    }
  });
  ring.push([-20, -10]);
  return ring;
}

const polygonCollection = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      id: "area",
      properties: {},
      geometry: { type: "Polygon" as const, coordinates: [denseRectangle()] },
    },
  ],
};

/**
 * A heavy polygon on the explicit no-WebGPU fallback, large enough for Canvas motion
 * presentation. Polygon support on WebGPU must not change this fallback oracle.
 */
async function mountPolygonMap(onSelectedFeatureIdChange?: (featureId: string | null) => void) {
  vi.mocked(loadMapsWgpuBaseMapRenderer).mockRejectedValue(
    new Error("WebGPU unavailable in Canvas motion fixture"),
  );
  const content = (collection: typeof polygonCollection = polygonCollection) => (
    <MapsMapView
      mapLabel="Polygon overlay"
      mapStyle={{ tiles: false }}
      fitToData={false}
      initialViewState={{ center: [0, 0], zoom: 4 }}
    >
      <GeoJsonLayer
        featureCollection={collection}
        onSelectedFeatureIdChange={onSelectedFeatureIdChange}
      />
    </MapsMapView>
  );
  const mounted = render(content());
  await waitFor(() =>
    expect(mounted.getByLabelText("Polygon overlay").dataset.mapReady).toBe("true"),
  );
  const canvas = mounted.container.querySelector<HTMLCanvasElement>('[data-flat-runtime="maps"]')!;
  const overlay = mounted.container.querySelector<HTMLCanvasElement>(
    '[data-map-overlay-runtime="maps"]',
  )!;
  await waitFor(() => expect(overlay.dataset.mapOverlayBackend).toBe("canvas2d"));
  vi.mocked(runtime.projectPacked).mockClear();
  return {
    canvas,
    overlay,
    replaceData: (collection: typeof polygonCollection) => mounted.rerender(content(collection)),
  };
}

/** A Map View without application layers, so pure pans may be translated. */
async function mountBareMap(label = "Bare map") {
  let controller: MapSurfaceController | undefined;
  const mounted = render(
    <MapsMapView
      mapLabel={label}
      mapStyle={{ tiles: false }}
      fitToData={false}
      initialViewState={{ center: [0, 0], zoom: 4 }}
      onMapControllerReady={(next) => {
        controller = next;
      }}
    />,
  );
  await waitFor(() => expect(mounted.getByLabelText(label).dataset.mapReady).toBe("true"));
  const canvas = mounted.container.querySelector<HTMLCanvasElement>('[data-flat-runtime="maps"]')!;
  return { canvas, controller: () => controller! };
}

function flushAnimationFrame(now = 16) {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

function pointer(
  canvas: HTMLCanvasElement,
  type: string,
  x: number,
  timestamp: number,
  id = 1,
  options: { button?: number; clientY?: number; ctrlKey?: boolean; pointerType?: string } = {},
) {
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => true;
  const event = new Event(type, { bubbles: true });
  for (const [name, value] of Object.entries({
    pointerId: id,
    pointerType: options.pointerType ?? "mouse",
    button: options.button ?? 0,
    ctrlKey: options.ctrlKey ?? false,
    clientX: x,
    clientY: options.clientY ?? 80,
    timeStamp: timestamp,
  }))
    Object.defineProperty(event, name, { value });
  fireEvent(canvas, event);
}

describe("Maps camera presentation", () => {
  it("repaints polygon-only application changes prepared during a retained camera pan", async () => {
    surface = { margin: 128, overscan: true };
    const canvas = document.createElement("canvas");
    const fallback = document.createElement("canvas");
    const frame: MapScreenRenderFrame = {
      width: 600,
      height: 400,
      primitives: [
        {
          kind: "polygon",
          rings: [
            [
              { x: 200, y: 100 },
              { x: 300, y: 100 },
              { x: 250, y: 200 },
            ],
          ],
          renderPrimitive: {
            kind: "polygon",
            feature: null,
            featureId: "area",
            primitiveId: "area",
            rings: [
              [
                [0, 0],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
            fillColor: "#336699",
            fillOpacity: 1,
            interactive: true,
            strokeColor: "#ffffff",
            strokeOpacity: 1,
            strokeWidth: 0,
          },
        },
      ],
    };
    const host = createMapsBrowserRuntime(canvas, fallback, {
      mapStyle: { tiles: false },
      viewState: { center: [0, 0], zoom: 4 },
      onViewStateChange: () => {},
      onCameraFrame: () =>
        host.controller?.renderApplicationFrame(frame, {
          selectedPrimitiveIds: new Set(["area"]),
        }),
    });
    try {
      await host.ready;
      expect(host.controller?.renderApplicationFrame(frame)).toBe(true);
      vi.mocked(renderer.render).mockClear();

      host.controller?.setViewState({ center: [1, 0], zoom: 4 });

      expect(renderer.render).toHaveBeenCalledTimes(1);
      expect(vi.mocked(renderer.render).mock.calls[0]?.[2]?.polygons).toHaveLength(1);
      expect(canvas.style.transform).toBe("");
    } finally {
      host.dispose();
    }
  });
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

  it("rotates about the viewport center on right-drag in one coalesced paint", async () => {
    const onMapContextMenu = vi.fn();
    const { canvas, changed } = await mountMap(onMapContextMenu);
    const right = { button: 2 };
    pointer(canvas, "pointerdown", 100, 100, 1, right);
    // Linux/macOS deliver contextmenu on press; a rotating drag must swallow it.
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 80 });
    pointer(canvas, "pointermove", 101, 108, 1, right);
    pointer(canvas, "pointermove", 110, 116, 1, right);
    pointer(canvas, "pointermove", 115, 124, 1, { ...right, clientY: 300 });
    pointer(canvas, "pointerup", 115, 132, 1, right);
    expect(runtime.rotateAbout).not.toHaveBeenCalled();
    act(flushAnimationFrame);

    // Above the center (y 80 < 200) dragging right turns the bearing down;
    // below it the same motion turns it up. The 1px move is within click tolerance.
    expect(vi.mocked(runtime.rotateAbout).mock.calls).toEqual([
      [-8, 300, 200],
      [4, 300, 200],
    ]);
    expect(runtime.panBetween).not.toHaveBeenCalled();
    expect(paints).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]![0]).toMatchObject({ bearing: -4 });
    // Windows delivers contextmenu after release: still part of the rotation.
    fireEvent.contextMenu(canvas, { clientX: 115, clientY: 80 });
    expect(onMapContextMenu).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("keeps right-click context menus when the pointer does not rotate", async () => {
    const onMapContextMenu = vi.fn();
    const { canvas } = await mountMap(onMapContextMenu);
    pointer(canvas, "pointerdown", 100, 100, 1, { button: 2 });
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 80 });
    pointer(canvas, "pointermove", 102, 108, 1, { button: 2 });
    expect(onMapContextMenu).not.toHaveBeenCalled();
    pointer(canvas, "pointerup", 102, 116, 1, { button: 2 });

    expect(onMapContextMenu).toHaveBeenCalledTimes(1);
    expect(runtime.rotateAbout).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("rotates on ctrl+left drag and with a turning two-finger touch", async () => {
    const { canvas } = await mountMap();
    pointer(canvas, "pointerdown", 100, 100, 1, { ctrlKey: true });
    pointer(canvas, "pointermove", 120, 108, 1, { ctrlKey: true });
    pointer(canvas, "pointerup", 120, 116, 1, { ctrlKey: true });
    act(flushAnimationFrame);
    expect(vi.mocked(runtime.rotateAbout).mock.calls).toEqual([[-16, 300, 200]]);
    expect(runtime.panBetween).not.toHaveBeenCalled();

    vi.mocked(runtime.rotateAbout).mockClear();
    const touch = (_x: number, y: number) => ({ clientY: y, pointerType: "touch" });
    const finger = (degrees: number, sign: 1 | -1) => {
      const radians = (degrees * Math.PI) / 180;
      return [300 + sign * Math.cos(radians) * 100, 80 + sign * Math.sin(radians) * 100] as const;
    };
    pointer(canvas, "pointerdown", 400, 200, 1, touch(400, 80));
    pointer(canvas, "pointerdown", 200, 204, 2, touch(200, 80));
    for (const degrees of [10, 20, 30]) {
      const [x1, y1] = finger(degrees, 1);
      const [x2, y2] = finger(degrees, -1);
      pointer(canvas, "pointermove", x1, 210 + degrees, 1, touch(x1, y1));
      pointer(canvas, "pointermove", x2, 211 + degrees, 2, touch(x2, y2));
    }
    act(flushAnimationFrame);

    const turns = vi.mocked(runtime.rotateAbout).mock.calls;
    expect(turns.length).toBeGreaterThan(0);
    // Fingers turned clockwise: content follows clockwise, so the bearing decreases,
    // about the pinch centroid rather than the viewport center.
    expect(turns.reduce((sum, call) => sum + call[0], 0)).toBeLessThan(-5);
    // Fingers move one at a time, so the centroid wobbles by a few pixels.
    for (const [, x, y] of turns) {
      expect(Math.abs(x - 300)).toBeLessThan(10);
      expect(Math.abs(y - 80)).toBeLessThan(10);
    }
  });

  it("presents pure pans by translating the retained overscan frame, then settles crisply", async () => {
    surface = { margin: 128, overscan: true };
    const mounted = await mountBareMap();
    const { canvas } = mounted;
    const controller = mounted.controller();
    expect(canvas.style.left).toBe("-128px");
    expect(canvas.style.width).toBe("calc(100% + 256px)");
    paints.length = 0;

    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    act(() => flushAnimationFrame(116));
    // The mock pans the center by -8; its projection scales by zoom 4.
    expect(paints).toHaveLength(0);
    expect(canvas.style.transform).toBe("translate(32px, 0px)");
    // Pointer anchors stay in viewport space while the surface is translated.
    pointer(canvas, "pointermove", 110, 124);
    act(() => flushAnimationFrame(132));
    expect(vi.mocked(runtime.panBetween).mock.calls.at(-1)).toEqual([108, 80, 110, 80]);
    expect(paints).toHaveLength(0);
    expect(canvas.style.transform).toBe("translate(40px, 0px)");

    // Leaving the rendered margin re-renders at the current camera.
    pointer(canvas, "pointermove", 150, 140);
    act(() => flushAnimationFrame(148));
    expect(paints).toHaveLength(1);
    expect(canvas.style.transform).toBe("");

    pointer(canvas, "pointermove", 152, 156);
    act(() => flushAnimationFrame(164));
    expect(paints).toHaveLength(1);
    expect(canvas.style.transform).toBe("translate(8px, 0px)");
    pointer(canvas, "pointerup", 152, 400);
    // A single idle frame is not "motion stopped": pointer input is not frame-aligned.
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 50);
    act(() => flushAnimationFrame(500));
    expect(paints).toHaveLength(1);
    // After the quiet window, one pixel-exact render replaces the translation.
    now.mockReturnValue(performance.now() + 100);
    act(() => flushAnimationFrame(516));
    expect(paints).toHaveLength(2);
    now.mockRestore();
    expect(canvas.style.transform).toBe("");
    expect(frames.size).toBe(0);

    // Zoom is not a translation.
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
    act(flushAnimationFrame);
    expect(paints).toHaveLength(3);
    // Programmatic pans within the margin translate too (mock projection scales by zoom).
    const { center, zoom } = camera;
    act(() => controller.setViewState({ center: [center[0] + 1, center[1]], zoom }));
    const [, x] = /translate\(([-\d.e]+)px, 0px\)/.exec(canvas.style.transform) ?? [];
    expect(Number(x)).toBeCloseTo(-zoom, 9);
    expect(paints).toHaveLength(3);
  });

  it("renders continuous zoom viewport-only and fills the margin once motion settles", async () => {
    surface = { margin: 128, overscan: true };
    const { canvas } = await mountBareMap();
    paints.length = 0;
    let clock = performance.now();
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);

    fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
    act(flushAnimationFrame);
    // A single discrete change keeps the margin, so a following pan can translate.
    expect(paints.at(-1)).not.toHaveProperty("clip");
    clock += 16;
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
    act(flushAnimationFrame);
    // Continuous non-translating motion replaces every frame: the margin is wasted fill.
    expect(paints.at(-1)).toMatchObject({ clip: { width: 600, height: 400 } });
    expect(paints).toHaveLength(2);

    clock += 50;
    act(flushAnimationFrame);
    expect(paints).toHaveLength(2);
    clock += 100;
    act(flushAnimationFrame);
    expect(paints).toHaveLength(3);
    expect(paints.at(-1)).not.toHaveProperty("clip");

    // The settled render filled the margin: a pan within it is a translation.
    clock += 1000;
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 104, 116);
    act(flushAnimationFrame);
    console.log("DBG", JSON.stringify(paints), canvas.style.transform, JSON.stringify(camera));
    expect(paints).toHaveLength(3);
    expect(canvas.style.transform).toMatch(/^translate\(/);
    now.mockRestore();
  });

  it("re-renders a pan that follows viewport-only motion before translating again", async () => {
    surface = { margin: 128, overscan: true };
    const { canvas } = await mountBareMap();
    paints.length = 0;
    let clock = performance.now();
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    for (let index = 0; index < 2; index += 1) {
      clock += 16;
      fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
      act(flushAnimationFrame);
    }
    expect(paints.at(-1)).toHaveProperty("clip");

    clock += 16;
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 104, 116);
    act(flushAnimationFrame);
    // The retained frame has no margin content: render the translation in full.
    expect(paints).toHaveLength(3);
    expect(paints.at(-1)).not.toHaveProperty("clip");
    clock += 16;
    pointer(canvas, "pointermove", 108, 132);
    act(flushAnimationFrame);
    expect(paints).toHaveLength(3);
    expect(canvas.style.transform).toMatch(/^translate\(/);
    now.mockRestore();
  });

  it("presents Canvas overlay motion by transforming the retained render, then settles crisply", async () => {
    const { canvas, overlay } = await mountPolygonMap();
    let clock = performance.now();
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);

    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    act(flushAnimationFrame);
    // The retained overlay is moved with the camera instead of re-projected: the mock
    // pans the center by -8 degrees and projects 4 px per degree.
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(overlay.style.transform).toBe("matrix(1, 0, 0, 1, 32, 0)");

    clock += 16;
    fireEvent.wheel(canvas, { deltaY: -20, clientX: 100, clientY: 80 });
    act(flushAnimationFrame);
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(overlay.style.transform).toMatch(/^matrix\(1\.0\d*, 0, 0, 1\.0\d*, /);
    // Browsers notify a newly observed element even without a size change (the overlay
    // re-observes after React re-renders): that must not force a full render mid-motion.
    act(() =>
      resizeCallbacks
        .filter((entry) => entry.target === overlay)
        .at(-1)!
        .callback([], {} as ResizeObserver),
    );
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(overlay.style.transform).not.toBe("");

    // Quiet for the settle window: one crisp re-projection replaces the transform.
    pointer(canvas, "pointerup", 108, 200);
    clock += 50;
    act(flushAnimationFrame);
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    clock += 100;
    act(flushAnimationFrame);
    expect(runtime.projectPacked).toHaveBeenCalled();
    expect(overlay.style.transform).toBe("");
    now.mockRestore();
  });

  it("keeps re-drawing light Canvas overlays exactly on every camera frame", async () => {
    const light = structuredClone(polygonCollection);
    light.features[0]!.geometry.coordinates = [
      [
        [-20, -10],
        [20, -10],
        [20, 10],
        [-20, 10],
        [-20, -10],
      ],
    ];
    const { canvas, overlay, replaceData } = await mountPolygonMap();
    act(() => replaceData(light));
    vi.mocked(runtime.projectPacked).mockClear();
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    act(flushAnimationFrame);
    expect(runtime.projectPacked).toHaveBeenCalledTimes(1);
    expect(overlay.style.transform).toBe("");
  });

  it("defers overlay data changes during motion to the settle render", async () => {
    const { canvas, overlay, replaceData } = await mountPolygonMap();
    let clock = performance.now();
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    act(flushAnimationFrame);
    pointer(canvas, "pointerup", 108, 132);

    // Streamed data arriving mid-motion re-renders React (and re-runs the overlay
    // effect) but joins the settle render instead of re-projecting immediately.
    const moved = structuredClone(polygonCollection);
    moved.features[0]!.geometry.coordinates = [
      [
        [0, 0],
        [5, 0],
        [5, 5],
        [0, 0],
      ],
    ];
    act(() => replaceData(moved));
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(overlay.style.transform).not.toBe("");

    clock += 150;
    act(flushAnimationFrame);
    expect(overlay.style.transform).toBe("");
    const projected = vi
      .mocked(runtime.projectPacked)
      .mock.calls.flatMap(([coordinates]) => [...coordinates]);
    expect(projected).toEqual(expect.arrayContaining([5, 5]));
    now.mockRestore();
  });

  it("picks features under the pointer through the overlay motion transform", async () => {
    const selected = vi.fn();
    const { canvas, overlay } = await mountPolygonMap(selected);
    const now = vi.spyOn(performance, "now").mockImplementation(() => 1000);
    // The polygon (±20° at 4 px per degree) renders at screen x 220..380. A 30 px drag
    // moves the camera 30° west, presenting it at 340..500.
    const row = { clientY: 200 };
    pointer(canvas, "pointerdown", 300, 100, 1, row);
    pointer(canvas, "pointermove", 330, 116, 1, row);
    act(flushAnimationFrame);
    pointer(canvas, "pointerup", 330, 132, 1, row);
    expect(overlay.style.transform).toBe("matrix(1, 0, 0, 1, 120, 0)");

    // x 480 is outside the polygon as rendered but inside it as presented.
    fireEvent.click(canvas, { clientX: 480, clientY: 200 });
    expect(selected).toHaveBeenLastCalledWith("area", expect.anything());
    selected.mockClear();
    // x 260 is inside the polygon as rendered but outside it as presented.
    fireEvent.click(canvas, { clientX: 260, clientY: 200 });
    expect(selected.mock.calls.every(([featureId]) => featureId !== "area")).toBe(true);
    now.mockRestore();
  });

  it("re-renders every pan while application geometry is drawn in the base frame", async () => {
    surface = { margin: 128, overscan: true };
    const { canvas } = await mountMap();
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 108, 116);
    act(() => flushAnimationFrame(116));
    pointer(canvas, "pointermove", 110, 124);
    act(() => flushAnimationFrame(132));
    expect(paints).toHaveLength(2);
    expect(canvas.style.transform).toBe("");
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

  it("repaints when a resize resets the backing store without changing the camera", async () => {
    await mountMap();
    paints.length = 0;
    const resizeMap = () =>
      resizeCallbacks
        .find((entry) => entry.target?.getAttribute("data-flat-runtime") === "maps")!
        .callback([], {} as ResizeObserver);
    // ResizeObserver reports on observe: an unchanged backing store keeps its pixels.
    act(resizeMap);
    expect(paints).toHaveLength(0);
    // A device-pixel-ratio change clears the backing store; the camera is unchanged.
    vi.stubGlobal("devicePixelRatio", 2);
    act(resizeMap);
    expect(paints).toHaveLength(1);
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

/** jsdom has no layout: emulate the host's inline surface geometry around the viewport. */
function layoutRect(canvas: HTMLCanvasElement, viewport: { width: number; height: number }) {
  const offset = (value: string) => Number.parseFloat(value) || 0;
  const extra = (value: string) => Number(/calc\(100% \+ (\d+)px\)/.exec(value)?.[1] ?? 0);
  // getBoundingClientRect includes the element's own transform.
  const translate = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(canvas.style.transform);
  const left = offset(canvas.style.left) + Number(translate?.[1] ?? 0);
  const top = offset(canvas.style.top) + Number(translate?.[2] ?? 0);
  const width = viewport.width + extra(canvas.style.width);
  const height = viewport.height + extra(canvas.style.height);
  return {
    width,
    height,
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    toJSON() {},
  } as DOMRect;
}
