import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { MapPoint, MapPointFilter } from "./aggregation";
import { createHeatLayerSourceIndex } from "./heat-layer-data";
import {
  METERS_PER_DEGREE_AT_EQUATOR,
  type HeatLayerColorStop,
  type HeatLayerRadius,
  type HeatLayerRenderStrategy,
  type HeatLayerWeightAccessor,
} from "./heat-layer-types";
import {
  createHeatLayerInterpolatedSurfaceDataUrl,
  prepareHeatLayerColorRamp,
  type HeatLayerSurfaceSource,
} from "./heat-surface";
import type { HeatSurfaceBounds } from "./heat-surface-render-plan";
import type { MapsHeatLayerViewportGeometry } from "./maps-heat-layer-bounds";
import type { MapsHeatLayerDescriptor } from "./maps-heat-layer-registration";
import {
  createMapsHeatLayerRenderState,
  prepareMapsHeatLayerRender,
  resetMapsHeatLayerRenderState,
  type MapsHeatLayerRenderState,
} from "./maps-heat-layer-rendering";

/*
 * PRINCIPLE-010 / TEST-022 differential oracle for retained heat surfaces.
 *
 * The retained path is the production Maps heat path: one long-lived
 * `MapsHeatLayerRenderState`, the stable-raster cache metadata, the bounds-keyed
 * source-index query cache and async request supersession.
 *
 * The oracle shares none of that machinery. It recomputes weights, filtering,
 * normalization, source selection and raster geometry from the raw inputs with
 * plain code, and only reuses the stateless rasterizer
 * (`createHeatLayerInterpolatedSurfaceDataUrl`) as the pixel kernel. Pixels are
 * observed through a recording 2D canvas, so two artifacts are equal only when
 * they issue the same draw operations.
 */

type DensityInputs = {
  async: boolean;
  colorRamp: readonly HeatLayerColorStop[];
  filterPoint?: MapPointFilter;
  getWeight?: HeatLayerWeightAccessor;
  intensity: number;
  maxRasterPixels: number;
  maxWeight?: number;
  minZoomDeltaForRebuild: number;
  opacity: number;
  overscanRatio: number;
  points: readonly MapPoint[];
  radius: HeatLayerRadius;
  strategy: HeatLayerRenderStrategy;
};

type ViewInputs = {
  center: [longitude: number, latitude: number];
  height: number;
  width: number;
  zoom: number;
};

const TILE_SIZE = 512;
const WARM_RAMP: readonly HeatLayerColorStop[] = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.35, "#22c55e"],
  [0.7, "#fde047"],
  [1, "#dc2626"],
];
const COOL_RAMP: readonly HeatLayerColorStop[] = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.5, "#38bdf8"],
  [1, "#1d4ed8"],
];

const BASE_VIEW: ViewInputs = { center: [10, 48], height: 480, width: 640, zoom: 6 };

describe("retained heat surface differential oracle", () => {
  let canvas: RecordingCanvasEnvironment;

  beforeEach(() => {
    canvas = installRecordingCanvasEnvironment();
  });

  afterEach(() => {
    canvas.restore();
    vi.restoreAllMocks();
  });

  test.each([false, true])(
    "matches the uncached reference over data/filter/radius/style/viewport mutations (async=%s)",
    async (async) => {
      const base = createDensityInputs({ async });
      const harness = createRetainedHarness(canvas);
      const sequence: Array<[label: string, inputs: DensityInputs, view: ViewInputs]> = [
        ["initial", base, BASE_VIEW],
        ["small pan inside coverage", base, { ...BASE_VIEW, center: [10.6, 48.2] }],
        [
          "filter change while coverage is reusable",
          { ...base, filterPoint: (point) => Number(point.id) % 3 !== 0 },
          { ...BASE_VIEW, center: [10.6, 48.2] },
        ],
        [
          "weight accessor change",
          {
            ...base,
            filterPoint: (point) => Number(point.id) % 3 !== 0,
            getWeight: (point) => (point.metrics.weight ?? 1) ** 2,
          },
          { ...BASE_VIEW, center: [10.6, 48.2] },
        ],
        ["explicit max weight normalization", { ...base, maxWeight: 40 }, BASE_VIEW],
        ["radius change", { ...base, radius: { meters: 90_000 } }, BASE_VIEW],
        ["intensity change", { ...base, intensity: 0.6 }, BASE_VIEW],
        ["color ramp change", { ...base, colorRamp: COOL_RAMP }, BASE_VIEW],
        ["opacity-only change", { ...base, colorRamp: COOL_RAMP, opacity: 0.4 }, BASE_VIEW],
        [
          "zoom inside the rebuild bucket",
          { ...base, colorRamp: COOL_RAMP, opacity: 0.4 },
          { ...BASE_VIEW, zoom: 6.4 },
        ],
        ["zoom across the rebuild bucket", base, { ...BASE_VIEW, zoom: 7.2 }],
        ["pan outside coverage", base, { ...BASE_VIEW, center: [17, 45] }],
        ["resize", base, { ...BASE_VIEW, height: 600, width: 900 }],
        ["dataset replacement", { ...base, points: createPoints(23, 64) }, BASE_VIEW],
        ["empty dataset", { ...base, points: [] }, BASE_VIEW],
        ["restored dataset", base, BASE_VIEW],
      ];

      const reusedSteps: string[] = [];
      let previous: ObservedArtifact = null;

      for (const [label, inputs, view] of sequence) {
        const observed = await harness.renderQuiescent(inputs, view);

        expect(observed, label).toEqual(createReferenceArtifact(inputs, view, observed));
        expect(canvas.pendingBlobCount(), label).toBe(0);
        if (observed && observed.url === previous?.url) reusedSteps.push(label);
        previous = observed;
      }

      // The sequence must exercise retained reuse, not only rebuilds.
      expect(reusedSteps).toEqual([
        "small pan inside coverage",
        "opacity-only change",
        "zoom inside the rebuild bucket",
      ]);

      harness.teardown();
      expect(canvas.liveObjectUrls()).toEqual([]);
    },
  );

  test("matches a fresh uncached pipeline for zoom-interpolated pixel radii (viewport raster)", async () => {
    const base: DensityInputs = {
      ...createDensityInputs({ async: true }),
      radius: { max: 36, maxZoom: 9, min: 12, minZoom: 3 },
      strategy: "viewport-raster",
    };
    const harness = createRetainedHarness(canvas);
    const sequence: Array<[DensityInputs, ViewInputs]> = [
      [base, BASE_VIEW],
      [base, { ...BASE_VIEW, center: [10.4, 48.1] }],
      [{ ...base, filterPoint: (point) => Number(point.id) % 2 === 1 }, BASE_VIEW],
      [base, { ...BASE_VIEW, zoom: 6.5 }],
      [{ ...base, colorRamp: COOL_RAMP, intensity: 1.4 }, BASE_VIEW],
      [base, { ...BASE_VIEW, height: 520, width: 700 }],
    ];

    for (const [index, [inputs, view]] of sequence.entries()) {
      const observed = await harness.renderQuiescent(inputs, view);
      const fresh = createRetainedHarness(canvas);
      const reference = await fresh.renderQuiescent({ ...inputs, async: false }, view);
      fresh.teardown();

      expect(observed?.projection, `step ${index}`).toBe("screen");
      expect(
        observed && { bounds: observed.bounds, content: observed.content, opacity: observed.opacity },
        `step ${index}`,
      ).toEqual(
        reference && { bounds: reference.bounds, content: reference.content, opacity: reference.opacity },
      );
    }

    harness.teardown();
    expect(canvas.liveObjectUrls()).toEqual([]);
  });

  test("commits only the newest request when async completions arrive in reverse order", async () => {
    const base = createDensityInputs({ async: true });
    const filtered = { ...base, filterPoint: (point: { id: string }) => Number(point.id) % 2 === 0 };
    const restyled = { ...filtered, colorRamp: COOL_RAMP };
    const harness = createRetainedHarness(canvas);

    await harness.renderQuiescent(base, BASE_VIEW);

    harness.frame(filtered, BASE_VIEW);
    harness.frame(restyled, BASE_VIEW);
    expect(canvas.pendingBlobCount()).toBe(2);

    await canvas.resolveBlobs("newest-first");
    const observed = await harness.renderQuiescent(restyled, BASE_VIEW);

    expect(observed).toEqual(createReferenceArtifact(restyled, BASE_VIEW, observed));
    expect(canvas.liveObjectUrls()).toEqual([observed?.url]);

    harness.teardown();
    expect(canvas.liveObjectUrls()).toEqual([]);
  });

  test("seeking temporal inputs back and forth never shows a superseded time slice", async () => {
    const base = createDensityInputs({ async: true });
    const slices = [createPoints(3, 48), createPoints(5, 48), createPoints(7, 48)].map((points) => ({
      ...base,
      points,
    }));
    const harness = createRetainedHarness(canvas);

    for (const index of [0, 2, 0, 1, 1, 2]) {
      const inputs = slices[index]!;
      const observed = await harness.renderQuiescent(inputs, BASE_VIEW);

      expect(observed, `slice ${index}`).toEqual(createReferenceArtifact(inputs, BASE_VIEW, observed));
    }

    // Scrub quickly: each seek supersedes the previous one before it completes.
    harness.frame(slices[0]!, BASE_VIEW);
    harness.frame(slices[1]!, BASE_VIEW);
    harness.frame(slices[2]!, BASE_VIEW);
    await canvas.resolveBlobs("newest-first");
    const observed = await harness.renderQuiescent(slices[2]!, BASE_VIEW);

    expect(observed).toEqual(createReferenceArtifact(slices[2]!, BASE_VIEW, observed));
    expect(canvas.liveObjectUrls()).toEqual([observed?.url]);

    harness.teardown();
    expect(canvas.liveObjectUrls()).toEqual([]);
  });

  test("teardown discards in-flight work without committing or requesting a render", async () => {
    const base = createDensityInputs({ async: true });
    const harness = createRetainedHarness(canvas);

    await harness.renderQuiescent(base, BASE_VIEW);
    harness.frame({ ...base, colorRamp: COOL_RAMP }, BASE_VIEW);
    expect(canvas.pendingBlobCount()).toBe(1);

    const rendersBeforeTeardown = harness.renderRequests();
    harness.teardown();
    await canvas.resolveBlobs("oldest-first");

    expect(harness.renderRequests()).toBe(rendersBeforeTeardown);
    expect(harness.state.surface.resource).toBeNull();
    expect(canvas.liveObjectUrls()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Retained (production) path                                                 */
/* -------------------------------------------------------------------------- */

type ObservedArtifact = {
  bounds: HeatSurfaceBounds;
  content: string;
  opacity: number;
  projection: string;
  url: string;
} | null;

function createRetainedHarness(canvas: RecordingCanvasEnvironment) {
  const state = createMapsHeatLayerRenderState();
  let descriptor: MapsHeatLayerDescriptor | null = null;
  let descriptorInputs: DensityInputs | null = null;
  let renderRequests = 0;

  const frame = (inputs: DensityInputs, view: ViewInputs) => {
    // Publish a new descriptor only when inputs change, as the mount does.
    if (descriptorInputs !== inputs) {
      descriptor = createProductionDescriptor(inputs);
      descriptorInputs = inputs;
    }

    return prepareMapsHeatLayerRender({
      descriptor: descriptor!,
      requestRender: () => {
        renderRequests += 1;
      },
      state,
      viewport: createMercatorViewport(view),
    });
  };

  return {
    frame,
    renderRequests: () => renderRequests,
    async renderQuiescent(inputs: DensityInputs, view: ViewInputs): Promise<ObservedArtifact> {
      frame(inputs, view);
      await canvas.resolveBlobs("oldest-first");
      const raster = frame(inputs, view).raster;

      if (!raster) return null;

      return {
        bounds: raster.bounds,
        content: canvas.contentOf(raster.image.src),
        opacity: raster.opacity,
        projection: raster.projection,
        url: raster.image.src,
      };
    },
    state: state as MapsHeatLayerRenderState,
    teardown() {
      resetMapsHeatLayerRenderState(state);
    },
  };
}

function createProductionDescriptor(inputs: DensityInputs): MapsHeatLayerDescriptor {
  return {
    dataPointColor: "#0f172a",
    dataPointOpacity: 0.94,
    dataPointRadius: 4,
    dataPointStrokeColor: "#ffffff",
    dataPointStrokeWidth: 1.5,
    fieldContourCollection: null,
    fieldContourOpacity: 1,
    fieldDataPointCollection: null,
    fieldImage: null,
    fieldOpacity: 1,
    fieldRenderMode: "raster",
    heatIndex: createHeatLayerSourceIndex(inputs.points, {
      filterPoint: inputs.filterPoint,
      getWeight: inputs.getWeight,
      maxWeight: inputs.maxWeight,
    }),
    heatmapAsyncRender: inputs.async,
    heatmapColorRamp: prepareHeatLayerColorRamp(inputs.colorRamp),
    heatmapIntensity: inputs.intensity,
    heatmapMaxRasterPixels: inputs.maxRasterPixels,
    heatmapMaxZoom: 16,
    heatmapMinZoomDeltaForRebuild: inputs.minZoomDeltaForRebuild,
    heatmapOpacity: inputs.opacity,
    heatmapOverscanRatio: inputs.overscanRatio,
    heatmapRadius: inputs.radius,
    heatmapRenderStrategy: inputs.strategy,
    heatmapSurfaceMode: "interpolated",
    layerId: "oracle-heat",
    showDataPoints: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Independent reference                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Recomputes the stable-raster artifact for the geometry the retained path
 * committed. Coverage placement is a free performance choice, so the oracle
 * checks that it is valid (contains the viewport, stays inside the pixel
 * budget) and then requires the content to be exactly what the current inputs
 * produce for that geometry.
 */
function createReferenceArtifact(
  inputs: DensityInputs,
  view: ViewInputs,
  observed: ObservedArtifact,
): ObservedArtifact {
  const weighted = inputs.points
    .map((point, index) => ({
      id: String(point.id ?? index),
      label: point.label ?? "",
      latitude: point.latitude,
      longitude: point.longitude,
      metrics: point.metrics ?? {},
      properties: point.properties ?? {},
    }))
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .filter((point) => inputs.filterPoint?.(point) ?? true)
    .map((point) => {
      const raw = inputs.getWeight ? inputs.getWeight(point) : (point.metrics.weight ?? 1);
      return { point, raw: Number.isFinite(raw) ? Math.max(0, raw) : 0 };
    })
    .filter((entry) => entry.raw > 0);
  const maxWeight =
    inputs.maxWeight !== undefined && Number.isFinite(inputs.maxWeight) && inputs.maxWeight > 0
      ? inputs.maxWeight
      : Math.max(1, ...weighted.map((entry) => entry.raw));
  const meters = typeof inputs.radius === "object" && "meters" in inputs.radius ? inputs.radius.meters : 0;
  const influenceMeters = meters * 2.6 * Math.max(0, inputs.intensity);

  if (weighted.length === 0 || influenceMeters <= 0) {
    return null;
  }

  // A non-empty input must produce a committed raster.
  expect(observed, "reference expects a committed raster").not.toBeNull();
  const bounds = observed!.bounds;
  const [rasterWidth, rasterHeight] = parseContentDimensions(observed!.content);
  const viewBounds = createMercatorViewport(view).bounds;

  expect(bounds[0]).toBeLessThanOrEqual(viewBounds[0]);
  expect(bounds[1]).toBeLessThanOrEqual(viewBounds[1]);
  expect(bounds[2]).toBeGreaterThanOrEqual(viewBounds[2]);
  expect(bounds[3]).toBeGreaterThanOrEqual(viewBounds[3]);
  expect(rasterWidth * rasterHeight).toBeLessThanOrEqual(inputs.maxRasterPixels);

  const west = lonToMetricX(bounds[0]);
  const east = lonToMetricX(bounds[2]);
  const south = latToMetricY(bounds[1]);
  const north = latToMetricY(bounds[3]);
  const metersPerPixel = Math.max((east - west) / rasterWidth, (north - south) / rasterHeight);
  const influenceRadius = influenceMeters / metersPerPixel;
  const sources: HeatLayerSurfaceSource[] = weighted
    .filter(
      ({ point }) =>
        point.longitude >= bounds[0] &&
        point.longitude <= bounds[2] &&
        point.latitude >= bounds[1] &&
        point.latitude <= bounds[3],
    )
    .map(({ point, raw }) => {
      const metricPoint = { x: lonToMetricX(point.longitude), y: latToMetricY(point.latitude) };

      return {
        coordinate: [point.longitude, point.latitude],
        dataInfluenceRadius: influenceMeters,
        influenceRadius,
        metricPoint,
        point: {
          x: ((metricPoint.x - west) / (east - west)) * rasterWidth,
          y: ((north - metricPoint.y) / (north - south)) * rasterHeight,
        },
        weight: raw / maxWeight,
      };
    });

  if (sources.length === 0) {
    return null;
  }

  const url = createHeatLayerInterpolatedSurfaceDataUrl({
    colorRamp: prepareHeatLayerColorRamp(inputs.colorRamp),
    height: rasterHeight,
    maxInfluenceRadius: influenceRadius,
    metricProjection: {
      getMetricPoint: (x, y) => ({
        x: west + (x / rasterWidth) * (east - west),
        y: north - (y / rasterHeight) * (north - south),
      }),
      getMetricX: (x) => west + (x / rasterWidth) * (east - west),
      getMetricY: (y) => north - (y / rasterHeight) * (north - south),
    },
    sources,
    width: rasterWidth,
  });

  return {
    bounds,
    content: recordedContentOf(url),
    opacity: inputs.opacity,
    projection: "mercator",
    url: observed!.url,
  };
}

function lonToMetricX(longitude: number) {
  return longitude * METERS_PER_DEGREE_AT_EQUATOR;
}

function latToMetricY(latitude: number) {
  const clamped = Math.min(Math.max(latitude, -85.05112878), 85.05112878);
  const radians = (clamped * Math.PI) / 180;

  return (
    (Math.log(Math.tan(Math.PI / 4 + radians / 2)) * (METERS_PER_DEGREE_AT_EQUATOR * 180)) / Math.PI
  );
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function createDensityInputs({ async }: { async: boolean }): DensityInputs {
  return {
    async,
    colorRamp: WARM_RAMP,
    intensity: 1,
    maxRasterPixels: 120_000,
    minZoomDeltaForRebuild: 1,
    opacity: 0.84,
    overscanRatio: 1,
    points: createPoints(11, 48),
    radius: { meters: 60_000 },
    strategy: "stable-raster",
  };
}

function createPoints(seed: number, count: number): MapPoint[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };

  return Array.from({ length: count }, (_, index) => ({
    id: index,
    latitude: 44 + next() * 8,
    longitude: 4 + next() * 14,
    metrics: { weight: 1 + Math.floor(next() * 20) },
  }));
}

function createMercatorViewport({ center, height, width, zoom }: ViewInputs): MapsHeatLayerViewportGeometry {
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
    const latitude =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / worldSize))) * 180) / Math.PI;
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

/* -------------------------------------------------------------------------- */
/* Recording canvas: the browser pixel/blob/image platform boundary           */
/* -------------------------------------------------------------------------- */

type RecordingCanvasEnvironment = ReturnType<typeof installRecordingCanvasEnvironment>;

const RECORDED_DATA_PREFIX = "data:image/x-oracle-recording;";
const RECORDED_BLOB_PREFIX = "blob:oracle/";

function recordedContentOf(url: string) {
  if (url.startsWith(RECORDED_DATA_PREFIX)) return url.slice(RECORDED_DATA_PREFIX.length);
  if (url.startsWith(RECORDED_BLOB_PREFIX)) {
    return url.slice(RECORDED_BLOB_PREFIX.length).replace(/#\d+$/, "");
  }
  throw new Error(`Unrecorded heat raster url: ${url.slice(0, 48)}`);
}

function parseContentDimensions(content: string): [width: number, height: number] {
  const match = /^(\d+)x(\d+):/.exec(content);
  if (!match) throw new Error(`Unrecorded heat raster content: ${content}`);
  return [Number(match[1]), Number(match[2])];
}

function installRecordingCanvasEnvironment() {
  const operations = new WeakMap<HTMLCanvasElement, string[]>();
  const pendingBlobs: Array<() => void> = [];
  const liveObjectUrls = new Set<string>();
  let objectUrlSequence = 0;
  const format = (value: number) => (Math.round(value * 1e6) / 1e6).toString();
  const digest = (canvas: HTMLCanvasElement) =>
    `${canvas.width}x${canvas.height}:${createHash("sha1")
      .update((operations.get(canvas) ?? []).join(";"))
      .digest("hex")}`;

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("maps-heat-oracle-recording-canvas");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const ops: string[] = [];
    operations.set(this, ops);
    let fillStyle = "";
    let globalAlpha = 1;
    let filter = "none";

    return {
      arc: (...values: number[]) => ops.push(`arc ${values.map(format).join(" ")}`),
      beginPath: () => ops.push("beginPath"),
      drawImage: (image: HTMLCanvasElement, x: number, y: number) =>
        ops.push(`drawImage ${digest(image)} ${format(x)} ${format(y)}`),
      fill: () => ops.push("fill"),
      fillRect: (...values: number[]) => ops.push(`fillRect ${values.map(format).join(" ")}`),
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
        ops.push(`fillStyle ${value}`);
      },
      get filter() {
        return filter;
      },
      set filter(value: string) {
        filter = value;
        ops.push(`filter ${value}`);
      },
      get globalAlpha() {
        return globalAlpha;
      },
      set globalAlpha(value: number) {
        globalAlpha = value;
        ops.push(`globalAlpha ${format(value)}`);
      },
      translate: (x: number, y: number) => ops.push(`translate ${format(x)} ${format(y)}`),
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return `${RECORDED_DATA_PREFIX}${digest(this)}`;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    const content = digest(this);
    pendingBlobs.push(() => callback({ content } as unknown as Blob));
  });

  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `${RECORDED_BLOB_PREFIX}${(blob as unknown as { content: string }).content}#${(objectUrlSequence += 1)}`;
    liveObjectUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    liveObjectUrls.delete(url);
  };

  class LoadedImage {
    complete = false;
    decoding = "auto";
    naturalHeight = 0;
    naturalWidth = 0;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    #src = "";

    get src() {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      const [width, height] = parseContentDimensions(recordedContentOf(value));
      this.naturalWidth = width;
      this.naturalHeight = height;
      this.complete = true;
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);

  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  return {
    contentOf: recordedContentOf,
    liveObjectUrls: () => [...liveObjectUrls],
    pendingBlobCount: () => pendingBlobs.length,
    async resolveBlobs(order: "newest-first" | "oldest-first") {
      await flush();
      const batch = pendingBlobs.splice(0, pendingBlobs.length);
      for (const resolve of order === "newest-first" ? batch.reverse() : batch) {
        resolve();
        await flush();
      }
    },
    restore() {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
      vi.unstubAllGlobals();
    },
  };
}
