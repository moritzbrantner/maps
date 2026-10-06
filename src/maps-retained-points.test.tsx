import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MapSurfaceController, MapViewState } from "./map-display";
import type { MapsFlatRasterFrame, MapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { loadMapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { MapsMapView } from "./maps-map-view";
import { GeoJsonLayer } from "./geojson-layer";
import { PointLayer } from "./point-layer";
import {
  MAPS_WGPU_APPLICATION_RETAINED_POINTS,
  MAPS_WGPU_APPLICATION_RETAINED_POLYGONS,
} from "./wgpu-application-frame";
import { loadMapsWgpuBaseMapRenderer, type MapsWgpuBaseMapRenderer } from "./wgpu-base-map-wasm";

// Only the WASM/device boundary is stubbed; the Map View, overlay, layer preparation and
// retained-point transport are real.
vi.mock("./flat-runtime-wasm", () => ({ loadMapsFlatRasterRuntime: vi.fn() }));
vi.mock("./wgpu-base-map-wasm", () => ({ loadMapsWgpuBaseMapRenderer: vi.fn() }));

let camera: MapsFlatRasterFrame["camera"];
let runtime: MapsFlatRasterRuntime;
let renderer: MapsWgpuBaseMapRenderer;
let paints: Array<{ circles: number; order: number[]; zoom: number }>;
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
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return layoutRect(this, size);
  });
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
    evictVectorTile: vi.fn(),
    evictRetainedPoints: vi.fn(),
    setRetainedPoints: vi.fn((_group: number, lonLat: Float64Array) => lonLat.length / 2),
    evictRetainedPolygons: vi.fn(),
    setRetainedPolygons: vi.fn((_group: number, ringCounts: Uint32Array) => ringCounts.length),
    frameStats: vi.fn(() => ({
      drawCalls: 0,
      rasterTiles: 0,
      retainedVectorBytes: 0,
      retainedVectorFeatures: 0,
      retainedVectorLineSegments: 0,
      retainedVectorTiles: 0,
      retainedVectorTriangles: 0,
      applicationUploadBytes: 0,
      retainedPoints: 0,
      retainedPointPreparations: 0,
      retainedPointRebases: 0,
      retainedPointUploadBytes: 0,
      retainedPointFrames: 0,
      retainedPolygons: 0,
      retainedPolygonPreparations: 0,
      retainedPolygonRebases: 0,
      retainedPolygonUploadBytes: 0,
      retainedPolygonFrames: 0,
      vectorTiles: 0,
    })),
    isDeviceLost: vi.fn(() => false),
    resize: vi.fn(),
    setVectorMaxZoom: vi.fn(),
    setVectorStyle: vi.fn(),
    uploadTile: vi.fn(),
    uploadVectorTile: vi.fn(() => 0),
    render: vi.fn((_tiles, matrix, application) => {
      paints.push({
        circles: application?.circleCount ?? 0,
        order: Array.from(application?.order ?? []),
        zoom: matrix.viewProjection[0],
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

function createPoints(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `point-${index}`,
    latitude: ((index % 100) - 50) * 0.5,
    longitude: (Math.floor(index / 100) - 50) * 1 + offset,
  }));
}

async function mountPoints(points: ReturnType<typeof createPoints>) {
  let controller: MapSurfaceController | undefined;
  const content = (next: ReturnType<typeof createPoints>) => (
    <MapsMapView
      mapLabel="Retained points"
      mapStyle={{ tiles: false }}
      fitToData={false}
      initialViewState={{ center: [0, 0], zoom: 4 }}
      onMapControllerReady={(ready) => {
        controller = ready;
      }}
    >
      <PointLayer points={next} />
    </MapsMapView>
  );
  const mounted = render(content(points));
  await waitFor(() => {
    expect(mounted.getByLabelText("Retained points").dataset.mapReady).toBe("true");
    expect(renderer.setRetainedPoints).toHaveBeenCalled();
    expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POINTS, 1, 1]);
  });
  return { ...mounted, controller: controller!, rerenderPoints: (next: ReturnType<typeof createPoints>) => mounted.rerender(content(next)) };
}

describe("GPU-retained application points (#155)", () => {
  it("lowers dense points once and does no per-point work on camera-only frames", async () => {
    const points = createPoints(10_000);
    const { controller, container } = await mountPoints(points);
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;

    expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(1);
    const [group, lonLat, paint] = vi.mocked(renderer.setRetainedPoints!).mock.calls[0]!;
    expect(group).toBe(1);
    expect(lonLat).toHaveLength(20_000);
    expect(paint).toHaveLength(100_000);
    expect(overlay.dataset.mapOverlayBackend).toBe("wgpu-retained");

    vi.mocked(runtime.project).mockClear();
    vi.mocked(runtime.projectPacked).mockClear();
    paints.length = 0;
    for (let step = 1; step <= 20; step += 1) {
      act(() =>
        controller.setViewState({ center: [step * 0.5, step * 0.25], zoom: 4 + step * 0.1 }),
      );
    }

    // Every camera paint draws the retained group; nothing is re-lowered, re-projected
    // or re-uploaded from JS, and no screen circles cross the bridge.
    expect(paints.length).toBeGreaterThanOrEqual(20);
    for (const paint of paints) {
      expect(paint.circles).toBe(0);
      expect(paint.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POINTS, 1, 1]);
    }
    expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(1);
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(runtime.project).not.toHaveBeenCalled();
  });

  it("re-lowers on data changes and falls back to Canvas when the device rejects a group", async () => {
    const { rerenderPoints } = await mountPoints(createPoints(100));

    rerenderPoints(createPoints(100, 1));
    await waitFor(() => expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(2));

    // A group the device rejects retires the renderer: the Canvas fallback draws the map
    // and the points, instead of a hidden WebGPU canvas.
    vi.mocked(renderer.setRetainedPoints!).mockImplementationOnce(() => {
      throw new Error("device rejected the group");
    });
    rerenderPoints(createPoints(100, 2));
    await waitFor(() => expect(renderer.dispose).toHaveBeenCalled());
  });
});

type PolygonCollection = Parameters<typeof GeoJsonLayer>[0]["featureCollection"];

function polygonCollection(count: number, withPoint = false): PolygonCollection {
  const square = (west: number, south: number) => [
    [west, south],
    [west + 2, south],
    [west + 2, south + 2],
    [west, south + 2],
    [west, south],
  ];
  return {
    type: "FeatureCollection",
    features: [
      ...Array.from({ length: count }, (_, index) => ({
        geometry: {
          coordinates: [square(index * 3, 0), square(index * 3 + 0.5, 0.5).slice().reverse()],
          type: "Polygon" as const,
        },
        id: `zone-${index}`,
        properties: {},
        type: "Feature" as const,
      })),
      ...(withPoint
        ? [
            {
              geometry: { coordinates: [1, 1], type: "Point" as const },
              id: "marker",
              properties: {},
              type: "Feature" as const,
            },
          ]
        : []),
    ],
  };
}

describe("GPU-retained application polygons (#196)", () => {
  async function mountPolygons(collection: PolygonCollection, hoveredFeatureId?: string) {
    let controller: MapSurfaceController | undefined;
    const content = (next: PolygonCollection, hovered?: string) => (
      <MapsMapView
        mapLabel="Retained polygons"
        mapStyle={{ tiles: false }}
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 4 }}
        onMapControllerReady={(ready) => {
          controller = ready;
        }}
      >
        <GeoJsonLayer
          featureCollection={next}
          getFeatureId={(feature) => String(feature.id)}
          hoveredFeatureId={hovered ?? null}
        />
      </MapsMapView>
    );
    const mounted = render(content(collection, hoveredFeatureId));
    return {
      ...mounted,
      controller: () => controller!,
      rerenderPolygons: (next: PolygonCollection, hovered?: string) =>
        mounted.rerender(content(next, hovered)),
    };
  }

  it("lowers polygons once and does no per-polygon work on camera-only frames", async () => {
    const { container, controller } = await mountPolygons(polygonCollection(50));
    await waitFor(() => {
      expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(1);
      expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POLYGONS, 1, 1]);
    });
    const [group, ringCounts, pointCounts, lonLat, paint] = vi.mocked(renderer.setRetainedPolygons!)
      .mock.calls[0]!;
    expect(group).toBe(1);
    expect(Array.from(ringCounts)).toEqual(Array(50).fill(2));
    expect(Array.from(pointCounts)).toEqual(Array(100).fill(5));
    expect(lonLat).toHaveLength(100 * 5 * 2);
    expect(paint).toHaveLength(50 * 9);
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    expect(overlay.dataset.mapOverlayBackend).toBe("wgpu-retained");

    vi.mocked(runtime.project).mockClear();
    vi.mocked(runtime.projectPacked).mockClear();
    paints.length = 0;
    for (let step = 1; step <= 10; step += 1) {
      act(() => controller().setViewState({ center: [step * 0.5, 0], zoom: 4 + step * 0.1 }));
    }
    expect(paints.length).toBeGreaterThanOrEqual(10);
    for (const paint of paints) {
      expect(paint.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POLYGONS, 1, 1]);
    }
    expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(1);
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(runtime.project).not.toHaveBeenCalled();
  });

  it("re-lowers on interaction changes and returns mixed frames to the screen path", async () => {
    const { container, rerenderPolygons } = await mountPolygons(polygonCollection(3));
    await waitFor(() => expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(1));

    rerenderPolygons(polygonCollection(3), "zone-1");
    await waitFor(() => expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(2));
    const paint = vi.mocked(renderer.setRetainedPolygons!).mock.calls[1]![4];
    // Hovering widens the stroke of that polygon only.
    expect(paint[9 + 8]).toBeGreaterThan(paint[8]!);

    rerenderPolygons(polygonCollection(3, true));
    await waitFor(() => {
      expect(renderer.evictRetainedPolygons).toHaveBeenCalledWith(1);
      expect(paints.at(-1)?.order[0]).not.toBe(MAPS_WGPU_APPLICATION_RETAINED_POLYGONS);
    });
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    expect(overlay.dataset.mapOverlayBackend).toBe("wgpu");
  });
});

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
