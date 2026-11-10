import type { Page } from "playwright";

/**
 * Observation-only work counters for the mixed-layer acceptance Map View (#170).
 *
 * They wrap the prototypes of the real Rust/WASM classes the Map View already loaded
 * (the same module URL resolves to the same module instance), so every count is an
 * actual JS → WASM crossing or Canvas draw, not a React render or a mock. Optionally
 * each crossing is also emitted as a `runtime-profiler:js-to-wasm:<label>` User Timing
 * measure for the runtime-profiler browser collector.
 */
export type MixedLayerWork = {
  /** `MapsFlatRasterRuntime.framePacked`: camera/tile frame plans. */
  framePlans: number;
  /** `MapsFlatRasterRuntime.projectPacked` batches and their coordinate count. */
  projectionBatches: number;
  projectedCoordinates: number;
  /** `MapsWgpuBaseMapRenderer.renderPacked`: submitted WebGPU frames and their packed bytes. */
  gpuFrames: number;
  gpuFrameBytes: number;
  /** Retained point/shape group writes, by kind, and the typed-array bytes they carried. */
  retainedPointSets: number;
  retainedPointUpdates: number;
  retainedPointUpdatedRecords: number;
  retainedPolygonSets: number;
  retainedPolygonUpdates: number;
  retainedPolygonUpdatedRecords: number;
  retainedEvictions: number;
  retainedUploadBytes: number;
  /** Raster tile image uploads to the GPU renderer. */
  tileUploads: number;
  /** `MapsPointAggregationIndex.getViewportAggregation` queries. */
  aggregationQueries: number;
  /** Released WASM resources: a rebuild frees the previous runtime, renderer or index. */
  freedRuntimes: number;
  freedRenderers: number;
  freedAggregationIndexes: number;
  /** Canvas surface redraws, by Map View role. */
  canvasBaseRedraws: number;
  canvasOverlayRedraws: number;
};

type WasmClass = { prototype: Record<string, unknown> };

/** Installs the counters once per document; later calls only reset them. */
export async function installMixedLayerWork(page: Page, options: { measure?: boolean } = {}) {
  await page.evaluate(async ({ measure }) => {
    type Counters = Record<string, number>;
    const global = window as unknown as { mapsMixedLayerWork?: { counters: Counters } };
    const zero = (): Counters => ({
      aggregationQueries: 0,
      canvasBaseRedraws: 0,
      canvasOverlayRedraws: 0,
      framePlans: 0,
      freedAggregationIndexes: 0,
      freedRenderers: 0,
      freedRuntimes: 0,
      gpuFrameBytes: 0,
      gpuFrames: 0,
      projectedCoordinates: 0,
      projectionBatches: 0,
      retainedEvictions: 0,
      retainedPointSets: 0,
      retainedPointUpdatedRecords: 0,
      retainedPointUpdates: 0,
      retainedPolygonSets: 0,
      retainedPolygonUpdatedRecords: 0,
      retainedPolygonUpdates: 0,
      retainedUploadBytes: 0,
      tileUploads: 0,
    });
    if (global.mapsMixedLayerWork) {
      global.mapsMixedLayerWork.counters = zero();
      return;
    }
    const state = { counters: zero() };
    global.mapsMixedLayerWork = state;
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<Record<string, WasmClass | undefined>>;
    const wasm = await dynamicImport(new URL("/wasm/maps_wasm.js", location.origin).href);
    const bytes = (values: readonly unknown[]) =>
      values.reduce<number>(
        (sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0),
        0,
      );
    const wrap = (
      owner: WasmClass | undefined,
      method: string,
      label: string | null,
      count: (counters: Counters, args: unknown[]) => void,
    ) => {
      const original = owner?.prototype[method];
      if (typeof original !== "function") return;
      owner!.prototype[method] = function (this: unknown, ...args: unknown[]) {
        count(state.counters, args);
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          // An explicit end keeps coarsened clocks from ending a measure before it starts.
          if (measure && label) {
            const end = Math.max(start, performance.now());
            performance.measure(`runtime-profiler:js-to-wasm:${label}`, { end, start });
          }
        }
      };
    };
    const runtime = wasm.MapsFlatRasterRuntime;
    const renderer = wasm.MapsWgpuBaseMapRenderer;
    const aggregation = wasm.MapsPointAggregationIndex;
    wrap(runtime, "framePacked", "frame-plan", (c) => c.framePlans!++);
    wrap(runtime, "projectPacked", "projection-batch", (c, [coordinates]) => {
      c.projectionBatches!++;
      c.projectedCoordinates! += ArrayBuffer.isView(coordinates)
        ? (coordinates as Float64Array).length / 2
        : 0;
    });
    wrap(runtime, "free", null, (c) => c.freedRuntimes!++);
    wrap(renderer, "renderPacked", "gpu-frame-submit", (c, args) => {
      c.gpuFrames!++;
      c.gpuFrameBytes! += bytes(args);
    });
    wrap(renderer, "setRetainedPoints", "retained-upload", (c, args) => {
      c.retainedPointSets!++;
      c.retainedUploadBytes! += bytes(args);
    });
    wrap(renderer, "updateRetainedPoints", "retained-upload", (c, args) => {
      c.retainedPointUpdates!++;
      c.retainedPointUpdatedRecords! += (args[1] as Uint32Array | undefined)?.length ?? 0;
      c.retainedUploadBytes! += bytes(args);
    });
    wrap(renderer, "setRetainedPolygons", "retained-upload", (c, args) => {
      c.retainedPolygonSets!++;
      c.retainedUploadBytes! += bytes(args);
    });
    wrap(renderer, "updateRetainedPolygons", "retained-upload", (c, args) => {
      c.retainedPolygonUpdates!++;
      c.retainedPolygonUpdatedRecords! += (args[1] as Uint32Array | undefined)?.length ?? 0;
      c.retainedUploadBytes! += bytes(args);
    });
    wrap(renderer, "evictRetainedPoints", null, (c) => c.retainedEvictions!++);
    wrap(renderer, "evictRetainedPolygons", null, (c) => c.retainedEvictions!++);
    wrap(renderer, "uploadTile", "tile-upload", (c) => c.tileUploads!++);
    wrap(renderer, "free", null, (c) => c.freedRenderers!++);
    wrap(aggregation, "getViewportAggregation", "aggregation-query", (c) => c.aggregationQueries!++);
    wrap(aggregation, "free", null, (c) => c.freedAggregationIndexes!++);
    // The Canvas base paints its whole surface with one fillRect per frame; the
    // application overlay clears its surface once per redraw.
    const context = CanvasRenderingContext2D.prototype;
    const clear = context.clearRect;
    context.clearRect = function (...args) {
      if (this.canvas.dataset.mapOverlayRuntime === "maps") state.counters.canvasOverlayRedraws!++;
      return clear.apply(this, args);
    };
    const fill = context.fillRect;
    context.fillRect = function (...args) {
      const { dataset } = this.canvas;
      if (
        args[0] === 0 &&
        args[1] === 0 &&
        (dataset.flatRuntime === "maps" || dataset.mapBaseFallback === "canvas2d")
      )
        state.counters.canvasBaseRedraws!++;
      return fill.apply(this, args);
    };
  }, { measure: options.measure ?? false });
}

export function resetMixedLayerWork(page: Page) {
  return installMixedLayerWork(page);
}

export function readMixedLayerWork(page: Page): Promise<MixedLayerWork> {
  return page.evaluate(
    () =>
      ({
        ...(window as unknown as { mapsMixedLayerWork: { counters: MixedLayerWork } })
          .mapsMixedLayerWork.counters,
      }) as MixedLayerWork,
  );
}

/** Waits for `frames` animation frames so queued presentation work has run. */
export function settleFrames(page: Page, frames = 4) {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let seen = 0;
        const tick = () => (++seen >= count ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );
}
