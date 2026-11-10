import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import type { MapPoint } from "./aggregation";
import type { HeatLayerProps } from "./heat-layer-types";
import type { HeatLayerDataWork, HeatLayerSurfaceWork } from "./heat-layer-work";
import type { MapsHeatLayerViewportGeometry } from "./maps-heat-layer-bounds";
import { MapsHeatLayerMount } from "./maps-heat-layer-mount";
import type { MapsHeatLayerDescriptor } from "./maps-heat-layer-registration";
import {
  createMapsHeatLayerRenderState,
  prepareMapsHeatLayerRender,
  resetMapsHeatLayerRenderState,
} from "./maps-heat-layer-rendering";

/*
 * Deterministic work counters of the first-party heat/scalar Map Layer (#171 phase 2).
 *
 * The production pair is exercised: `MapsHeatLayerMount` builds the camera-independent
 * artifacts (density source index, scalar-field grid, field image, contours) and publishes a
 * descriptor; one long-lived `MapsHeatLayerRenderState` prepares every camera frame from it,
 * as the Maps overlay does. Counts are read from the resources that decide the work.
 */

const TILE_SIZE = 512;
const VIEWPORT = { height: 600, width: 800 };
const CAMERA_FRAMES = 32;

type AnyRecord = Record<string, unknown>;

afterEach(() => {
  cleanup();
});

describe("heat/scalar work counters", () => {
  test("camera frames inside a stable density raster lower, hash and rasterize nothing", async () => {
    const layer = await mountHeatLayer({ heatmapAsyncRender: false, points: createPoints(500) });
    const camera = createCamera(layer.descriptor());

    camera.frame(BASE_VIEW);
    const afterFirstFrame = layer.snapshot(camera.work);
    expect(afterFirstFrame.data.sourceIndexBuilds).toBe(1);
    expect(afterFirstFrame.surface.surfaceRasterizations).toBe(1);
    expect(afterFirstFrame.surface.rasterUploads).toBe(1);

    for (let frame = 1; frame <= CAMERA_FRAMES; frame += 1) {
      // Pan and zoom within the rebuild bucket, staying inside the overscanned coverage.
      camera.frame({
        center: [BASE_VIEW.center[0] + frame * 0.01, BASE_VIEW.center[1] - frame * 0.006],
        zoom: BASE_VIEW.zoom + (frame % 4) * 0.05,
      });
    }

    const delta = diff(afterFirstFrame, layer.snapshot(camera.work));
    expect(delta.data).toEqual(zeroData());
    expect(delta.surface).toEqual({ ...zeroSurface(), surfaceRasterReuses: CAMERA_FRAMES });
  });

  test("leaving the coverage re-rasterizes once and lowers only the sources it covers", async () => {
    const points = createPoints(500);
    const layer = await mountHeatLayer({ heatmapAsyncRender: false, points });
    const camera = createCamera(layer.descriptor());

    camera.frame(BASE_VIEW);
    const before = layer.snapshot(camera.work);
    camera.frame({ center: [30, 20], zoom: BASE_VIEW.zoom });
    const delta = diff(before, layer.snapshot(camera.work));

    expect(delta.data.sourceIndexBuilds).toBe(0);
    expect(delta.data.sourceQueries).toBeGreaterThan(0);
    expect(delta.surface.surfacePlans).toBe(1);
    expect(delta.surface.surfaceRasterizations).toBe(1);
    expect(delta.surface.rasterUploads).toBe(1);
    expect(delta.surface.surfaceSourcesLowered).toBeGreaterThan(0);
    expect(delta.surface.surfaceSourcesLowered).toBeLessThan(points.length);
  });

  test("style changes re-rasterize without rebuilding the source index; data changes rebuild it", async () => {
    const layer = await mountHeatLayer({ heatmapAsyncRender: false, points: createPoints(500) });
    const camera = createCamera(layer.descriptor());
    camera.frame(BASE_VIEW);

    let before = layer.snapshot(camera.work);
    await layer.update({ heatmapColorRamp: [[0, "#000000"], [1, "#ffffff"]] });
    camera.use(layer.descriptor());
    camera.frame(BASE_VIEW);
    let delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data.sourceIndexBuilds).toBe(0);
    expect(delta.surface.surfaceRasterizations).toBe(1);

    before = layer.snapshot(camera.work);
    await layer.update({ heatmapOpacity: 0.5 });
    camera.use(layer.descriptor());
    camera.frame(BASE_VIEW);
    delta = diff(before, layer.snapshot(camera.work));
    // Opacity is applied at draw time; the raster itself is unchanged.
    expect(delta.data.sourceIndexBuilds).toBe(0);
    expect(delta.surface.surfaceRasterizations).toBe(0);
    expect(delta.surface.surfaceRasterReuses).toBe(1);

    before = layer.snapshot(camera.work);
    await layer.update({ points: createPoints(400, 7) });
    camera.use(layer.descriptor());
    camera.frame(BASE_VIEW);
    delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data.sourceIndexBuilds).toBe(1);
    expect(delta.data.sourceIndexPoints).toBe(400);
    expect(delta.surface.surfaceRasterizations).toBe(1);
  });

  test("viewport rasters are the declared camera-dependent path: one rasterization per moved frame", async () => {
    const layer = await mountHeatLayer({
      heatmapAsyncRender: false,
      heatmapRadius: 24,
      points: createPoints(200),
    });
    const camera = createCamera(layer.descriptor());
    camera.frame(BASE_VIEW);
    const before = layer.snapshot(camera.work);

    for (let frame = 1; frame <= 4; frame += 1) {
      camera.frame({ center: [BASE_VIEW.center[0] + frame * 0.05, 0], zoom: BASE_VIEW.zoom });
    }

    const delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data.sourceIndexBuilds).toBe(0);
    expect(delta.surface.surfaceRasterizations).toBe(4);
    expect(delta.surface.surfaceRasterReuses).toBe(0);
  });

  test("camera frames never rebuild a scalar field's grid, image, contours or raster upload", async () => {
    const layer = await mountHeatLayer(FIELD_PROPS);
    const camera = createCamera(layer.descriptor());
    camera.frame(BASE_VIEW);
    const before = layer.snapshot(camera.work);
    expect(before.data).toMatchObject({
      fieldContourBuilds: 1,
      fieldGridBuilds: 1,
      fieldGridCells: 48 * 32,
      fieldImageBuilds: 1,
      sourceIndexBuilds: 1,
      sourceIndexPoints: 0,
    });
    expect(before.surface.rasterUploads).toBe(1);

    for (let frame = 1; frame <= CAMERA_FRAMES; frame += 1) {
      camera.frame({
        center: [BASE_VIEW.center[0] + frame * 0.4, BASE_VIEW.center[1] - frame * 0.2],
        zoom: BASE_VIEW.zoom + frame * 0.1,
      });
    }

    const delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data).toEqual(zeroData());
    expect(delta.surface).toEqual(zeroSurface());
  });

  test("scalar-field style changes rebuild only the dependent artifact", async () => {
    const layer = await mountHeatLayer(FIELD_PROPS);
    const camera = createCamera(layer.descriptor());
    camera.frame(BASE_VIEW);

    let before = layer.snapshot(camera.work);
    await layer.update({ fieldColorRamp: [[0, "#000000"], [1, "#ff0000"]] });
    camera.use(layer.descriptor());
    camera.frame(BASE_VIEW);
    let delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data).toMatchObject({ fieldContourBuilds: 0, fieldGridBuilds: 0, fieldImageBuilds: 1 });
    expect(delta.surface.rasterUploads).toBe(1);

    before = layer.snapshot(camera.work);
    await layer.update({ fieldContourLevels: [10, 20] });
    camera.use(layer.descriptor());
    camera.frame(BASE_VIEW);
    delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data).toMatchObject({ fieldContourBuilds: 1, fieldGridBuilds: 0, fieldImageBuilds: 0 });
    expect(delta.surface.rasterUploads).toBe(0);

    before = layer.snapshot(camera.work);
    await layer.update({ points: createPoints(60, 3) });
    camera.use(layer.descriptor());
    camera.frame(BASE_VIEW);
    delta = diff(before, layer.snapshot(camera.work));
    expect(delta.data).toMatchObject({ fieldContourBuilds: 1, fieldGridBuilds: 1, fieldImageBuilds: 1 });
    expect(delta.surface.rasterUploads).toBe(1);
  });

  test("the retained async field reuses its grid for a style-only change", async () => {
    const layer = await mountHeatLayer({ ...FIELD_PROPS, fieldAsyncRender: true });
    await layer.settle();
    const before = layer.snapshot(createCamera(layer.descriptor()).work);
    expect(before.data.fieldGridBuilds).toBe(1);

    await layer.update({ fieldColorRamp: [[0, "#000000"], [1, "#00ff00"]] });
    await layer.settle();
    const delta = diff(before, layer.snapshot(createCamera(layer.descriptor()).work));

    expect(delta.data).toMatchObject({ fieldGridBuilds: 0, fieldGridReuses: 1, fieldImageBuilds: 1 });
  });

  test("a reset keeps the layer's surface counters", async () => {
    const layer = await mountHeatLayer({ heatmapAsyncRender: false, points: createPoints(100) });
    const camera = createCamera(layer.descriptor());
    camera.frame(BASE_VIEW);
    camera.reset();
    camera.frame(BASE_VIEW);

    expect(camera.work.surfaceRasterizations).toBe(2);
  });
});

/* -------------------------------- harness --------------------------------- */

type ViewInputs = { center: [longitude: number, latitude: number]; zoom: number };

const BASE_VIEW: ViewInputs = { center: [0, 0], zoom: 5 };

const FIELD_PROPS: Partial<HeatLayerProps<AnyRecord>> = {
  domainBounds: [-12, -8, 12, 8],
  fieldColumns: 48,
  fieldRenderMode: "raster-contours",
  fieldRows: 32,
  heatmapSurfaceMode: "field",
  points: createPoints(80),
  valueMetric: "value",
};

async function mountHeatLayer(initial: Partial<HeatLayerProps<AnyRecord>>) {
  let props = { points: [], ...initial } as HeatLayerProps<AnyRecord>;
  let descriptor: MapsHeatLayerDescriptor | null = null;
  const publish = (_key: string, next: MapsHeatLayerDescriptor | null) => {
    if (next) descriptor = next;
  };
  const tree = () => <MapsHeatLayerMount layerKey="heat" props={props} publish={publish} />;
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(tree());
  });

  return {
    descriptor() {
      if (!descriptor) throw new Error("The heat layer did not publish a descriptor.");
      return descriptor;
    },
    async settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    },
    snapshot(surface: HeatLayerSurfaceWork) {
      return { data: { ...this.descriptor().work }, surface: { ...surface } };
    },
    async update(next: Partial<HeatLayerProps<AnyRecord>>) {
      props = { ...props, ...next };
      await act(async () => {
        view.rerender(tree());
      });
    },
  };
}

function createCamera(initial: MapsHeatLayerDescriptor) {
  const state = createMapsHeatLayerRenderState();
  let descriptor = initial;

  return {
    frame(view: ViewInputs) {
      return prepareMapsHeatLayerRender({
        descriptor,
        requestRender() {},
        state,
        viewport: createMercatorViewport(view),
      });
    },
    reset() {
      resetMapsHeatLayerRenderState(state);
    },
    use(next: MapsHeatLayerDescriptor) {
      descriptor = next;
    },
    work: state.work,
  };
}

type Snapshot = { data: HeatLayerDataWork; surface: HeatLayerSurfaceWork };

function diff(before: Snapshot, after: Snapshot): Snapshot {
  const subtract = <T extends Record<string, number>>(a: T, b: T) =>
    Object.fromEntries(Object.keys(b).map((key) => [key, b[key]! - a[key]!])) as T;
  return { data: subtract(before.data, after.data), surface: subtract(before.surface, after.surface) };
}

function zeroData(): HeatLayerDataWork {
  return {
    fieldContourBuilds: 0,
    fieldGridBuilds: 0,
    fieldGridCells: 0,
    fieldGridReuses: 0,
    fieldImageBuilds: 0,
    fieldImagePixels: 0,
    fieldResultsDiscarded: 0,
    sourceIndexBuilds: 0,
    sourceIndexPoints: 0,
    sourceQueries: 0,
    sourceQueryCacheHits: 0,
  };
}

function zeroSurface(): HeatLayerSurfaceWork {
  return {
    rasterUploadPixels: 0,
    rasterUploads: 0,
    surfacePlans: 0,
    surfaceRasterizations: 0,
    surfaceRasterPixels: 0,
    surfaceRasterReuses: 0,
    surfaceResultsDiscarded: 0,
    surfaceSignatureSources: 0,
    surfaceSourcesLowered: 0,
  };
}

function createPoints(count: number, seed = 1): MapPoint[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };

  return Array.from({ length: count }, (_, index) => ({
    id: `p${seed}-${index}`,
    latitude: -6 + random() * 12,
    longitude: -10 + random() * 20,
    metrics: { value: Math.round(random() * 40), weight: 1 + Math.round(random() * 9) },
  }));
}

function createMercatorViewport({ center, zoom }: ViewInputs): MapsHeatLayerViewportGeometry {
  const { height, width } = VIEWPORT;
  const worldSize = TILE_SIZE * 2 ** zoom;
  const toWorld = ([longitude, latitude]: [number, number]) => {
    const radians = (Math.min(Math.max(latitude, -85.05112878), 85.05112878) * Math.PI) / 180;
    return {
      x: ((longitude + 180) / 360) * worldSize,
      y: ((1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2) * worldSize,
    };
  };
  const origin = toWorld(center);
  const unproject = (x: number, y: number): [number, number] => {
    const worldX = origin.x - width / 2 + x;
    const worldY = origin.y - height / 2 + y;
    const longitude = (worldX / worldSize) * 360 - 180;
    const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / worldSize))) * 180) / Math.PI;
    return [longitude, latitude];
  };
  const northWest = unproject(0, 0);
  const southEast = unproject(width, height);

  return {
    bounds: [northWest[0], southEast[1], southEast[0], northWest[1]],
    height,
    project(coordinate) {
      const point = toWorld(coordinate);
      return { x: point.x - origin.x + width / 2, y: point.y - origin.y + height / 2 };
    },
    unproject,
    width,
    zoom,
  };
}
