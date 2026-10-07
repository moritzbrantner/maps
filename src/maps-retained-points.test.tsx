import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MapSurfaceController, MapViewState } from "./map-display";
import type { MapsFlatRasterFrame, MapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { loadMapsFlatRasterRuntime } from "./flat-runtime-wasm";
import { MapsMapView } from "./maps-map-view";
import { FlowLayer } from "./flow-layer";
import { GeoJsonLayer } from "./geojson-layer";
import { PointLayer } from "./point-layer";
import {
  MAPS_RETAINED_POLYGON_PAINT_STRIDE,
  MAPS_RETAINED_SHAPE_CIRCLE,
  MAPS_RETAINED_SHAPE_DIRECTION_MARKER,
  MAPS_RETAINED_SHAPE_LINE,
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

describe("GPU-retained labeled points (#204)", () => {
  it("keeps labeled points retained and projects only the labeled ones per camera frame", async () => {
    const points = createPoints(1_000);
    let controller: MapSurfaceController | undefined;
    const { container } = render(
      <MapsMapView
        mapLabel="Retained labeled points"
        mapStyle={{ tiles: false }}
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 4 }}
        onMapControllerReady={(ready) => {
          controller = ready;
        }}
      >
        <PointLayer
          points={points}
          getPointLabel={(feature) =>
            Number(feature.point.id.slice("point-".length)) % 100 === 0 ? feature.point.id : null
          }
        />
      </MapsMapView>,
    );
    await waitFor(() =>
      expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POINTS, 1, 1]),
    );
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    expect(overlay.dataset.mapOverlayBackend).toBe("wgpu-retained");
    // Labeled points stay in the one retained group, in painter order.
    expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderer.setRetainedPoints!).mock.calls[0]![1]).toHaveLength(2_000);
    await waitFor(() => expect(context.fillText).toHaveBeenCalledWith("point-100", 104, 300));
    const projectionsAfterMount = Number(overlay.dataset.mapOverlayLabelProjections);

    vi.mocked(runtime.project).mockClear();
    vi.mocked(runtime.projectPacked).mockClear();
    vi.mocked(context.fillText).mockClear();
    paints.length = 0;
    for (let step = 1; step <= 10; step += 1) {
      act(() => controller!.setViewState({ center: [step * 0.5, 0], zoom: 4 + step * 0.1 }));
    }

    expect(paints.length).toBeGreaterThanOrEqual(10);
    for (const paint of paints) {
      expect(paint.circles).toBe(0);
      expect(paint.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POINTS, 1, 1]);
    }
    expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(1);
    // Each camera frame projects the 10 labeled points, never the 1,000 retained ones.
    const projected = vi
      .mocked(runtime.projectPacked)
      .mock.calls.map(([coordinates]) => coordinates.length / 2);
    expect(projected).toEqual(Array(10).fill(10));
    expect(runtime.project).not.toHaveBeenCalled();
    expect(Number(overlay.dataset.mapOverlayLabelProjections) - projectionsAfterMount).toBe(100);
    expect(context.fillText).toHaveBeenCalledTimes(100);
    // The last frame's label follows the camera: center [5, 0], zoom 5.
    expect(context.fillText).toHaveBeenLastCalledWith("point-900", 300 + (-41 - 5) * 5, 200 + 25 * 5);
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
    expect(paint).toHaveLength(50 * MAPS_RETAINED_POLYGON_PAINT_STRIDE);
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

  it("keeps polygons on the projected path while the camera is pitched", async () => {
    const { container, controller } = await mountPolygons(polygonCollection(3));
    await waitFor(() =>
      expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POLYGONS, 1, 1]),
    );
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;

    // A vertex behind a pitched camera would be clipped on the GPU but dropped by picking.
    act(() => controller().setViewState({ center: [0, 0], zoom: 4, pitch: 40 }));
    await waitFor(() => {
      expect(overlay.dataset.mapOverlayBackend).toBe("wgpu");
      expect(paints.at(-1)?.order[0]).not.toBe(MAPS_WGPU_APPLICATION_RETAINED_POLYGONS);
    });

    act(() => controller().setViewState({ center: [0, 0], zoom: 4, pitch: 0 }));
    await waitFor(() => {
      expect(overlay.dataset.mapOverlayBackend).toBe("wgpu-retained");
      expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POLYGONS, 1, 1]);
    });
  });

  it("re-lowers on interaction changes and returns mixed frames to the screen path", async () => {
    const { container, rerenderPolygons } = await mountPolygons(polygonCollection(3));
    await waitFor(() => expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(1));

    rerenderPolygons(polygonCollection(3), "zone-1");
    await waitFor(() => expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(2));
    const paint = vi.mocked(renderer.setRetainedPolygons!).mock.calls[1]![4];
    // Hovering widens the stroke of that polygon only.
    expect(paint[MAPS_RETAINED_POLYGON_PAINT_STRIDE + 8]).toBeGreaterThan(paint[8]!);

    // An unlabeled point after the polygons joins their shape group (#195).
    rerenderPolygons(polygonCollection(3, true));
    await waitFor(() => expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(3));
    expect(vi.mocked(renderer.setRetainedPolygons!).mock.calls[2]![1]).toHaveLength(4);
    expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POLYGONS, 1, 1]);
    expect(renderer.setRetainedPoints).not.toHaveBeenCalled();
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    expect(overlay.dataset.mapOverlayBackend).toBe("wgpu-retained");
  });
});

describe("GPU-retained lines and flows (#195)", () => {
  const flows = Array.from({ length: 20 }, (_, index) => ({
    from: [index * 2 - 20, -10] as [number, number],
    id: `flow-${index}`,
    to: [index * 2 - 18, 10] as [number, number],
  }));

  function content(withPoints: boolean, ready?: (controller: MapSurfaceController) => void) {
    return (
      <MapsMapView
        mapLabel="Retained flows"
        mapStyle={{ tiles: false }}
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 4 }}
        onMapControllerReady={ready}
      >
        {withPoints ? <PointLayer points={createPoints(500)} /> : null}
        <FlowLayer flows={flows} showDirection />
      </MapsMapView>
    );
  }

  it("keeps a point layer under a flow layer retained across camera frames", async () => {
    let controller: MapSurfaceController | undefined;
    const { container } = render(
      content(true, (ready) => {
        controller = ready;
      }),
    );
    await waitFor(() =>
      expect(paints.at(-1)?.order).toEqual([
        MAPS_WGPU_APPLICATION_RETAINED_POINTS,
        1,
        1,
        MAPS_WGPU_APPLICATION_RETAINED_POLYGONS,
        2,
        1,
      ]),
    );
    const overlay = container.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    expect(overlay.dataset.mapOverlayBackend).toBe("wgpu-retained");
    expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(1);
    expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(1);
    const [group, ringCounts, , , paint] = vi.mocked(renderer.setRetainedPolygons!).mock.calls[0]!;
    expect(group).toBe(2);
    const kinds = Array.from(
      { length: ringCounts.length },
      (_, index) => paint[index * MAPS_RETAINED_POLYGON_PAINT_STRIDE + 9],
    );
    expect(kinds.filter((kind) => kind === MAPS_RETAINED_SHAPE_LINE)).toHaveLength(20);
    expect(kinds.filter((kind) => kind === MAPS_RETAINED_SHAPE_DIRECTION_MARKER)).toHaveLength(20);
    // Each flow's two endpoints stay in the shape group, in painter order.
    expect(kinds.filter((kind) => kind === MAPS_RETAINED_SHAPE_CIRCLE)).toHaveLength(40);

    vi.mocked(runtime.project).mockClear();
    vi.mocked(runtime.projectPacked).mockClear();
    paints.length = 0;
    for (let step = 1; step <= 10; step += 1) {
      act(() => controller!.setViewState({ center: [step * 0.5, 0], zoom: 4 + step * 0.1 }));
    }
    expect(paints.length).toBeGreaterThanOrEqual(10);
    for (const paint of paints) {
      expect(paint.circles).toBe(0);
      expect(paint.order).toHaveLength(6);
    }
    expect(renderer.setRetainedPoints).toHaveBeenCalledTimes(1);
    expect(renderer.setRetainedPolygons).toHaveBeenCalledTimes(1);
    expect(runtime.projectPacked).not.toHaveBeenCalled();
    expect(runtime.project).not.toHaveBeenCalled();
  });

  it("evicts groups a new frame no longer uses or uses for another kind", async () => {
    const { rerender } = render(content(true));
    await waitFor(() => expect(paints.at(-1)?.order).toHaveLength(6));

    rerender(content(false));
    await waitFor(() =>
      expect(paints.at(-1)?.order).toEqual([MAPS_WGPU_APPLICATION_RETAINED_POLYGONS, 1, 1]),
    );
    expect(renderer.evictRetainedPoints).toHaveBeenCalledWith(1);
    expect(renderer.evictRetainedPolygons).toHaveBeenCalledWith(2);
    expect(vi.mocked(renderer.setRetainedPolygons!).mock.calls.at(-1)![0]).toBe(1);
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
