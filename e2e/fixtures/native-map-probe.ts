import { configureMapsWasmPackage, importMapsWasmModule } from "../../src/aggregation-wasm";
import type { MapsFlatRasterRuntime } from "../../src/flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "../../src/wgpu-application-frame";
import type { MapViewState } from "../../src/map-display";

export const anchor: [number, number] = [13.335, 52.544];
export const initialCamera: MapViewState = { center: [13.405, 52.52], zoom: 11 };
export const count = new URLSearchParams(location.search).get("count") === "10000" ? 10000 : 1000;
export const points = Array.from({ length: count }, (_, i) => ({
  id: `entity-${i}`,
  longitude: i === 0 ? anchor[0] : 13.36 + (i % 100) * 0.001,
  latitude: i === 0 ? anchor[1] : 52.535 - Math.floor(i / 100) * 0.00035,
}));
export const flows = Array.from({ length: 100 }, (_, i) => ({
  id: `flow-${i}`,
  from: [13.36, 52.53 - i * 0.0003] as [number, number],
  to: [13.45, 52.53 - i * 0.0003] as [number, number],
}));
type Sample = { actual: [number, number] | null; expected: [number, number] };
export const probe = {
  projected: 0,
  styles: 0,
  filters: 0,
  weights: 0,
  changes: 0,
  readyCount: 0,
  samples: [] as Sample[],
  cameraCpuMs: [] as number[],
  command: (_state: MapViewState) => {
    throw new Error("Map runtime not ready");
  },
  position: (): [number, number] => {
    throw new Error("Map runtime not ready");
  },
  reset() {
    this.projected = 0;
    this.styles = 0;
    this.filters = 0;
    this.weights = 0;
    this.changes = 0;
    this.samples = [];
    this.cameraCpuMs = [];
  },
};
declare global {
  interface Window {
    mapsNativeProbe: typeof probe;
  }
}
window.mapsNativeProbe = probe;
export const pointColor = () => {
  probe.styles++;
  return "#2563eb";
};
export const flowColor = () => {
  probe.styles++;
  return "#d97706";
};
export const filterPoint = () => {
  probe.filters++;
  return true;
};
export const weight = () => {
  probe.weights++;
  return 1;
};

/** Observation-only wrappers around the real Rust instance and pixel backend. */
export async function observeNativeMap() {
  configureMapsWasmPackage("/wasm/maps_wasm.js");
  const wasm = await importMapsWasmModule<{
    default(): Promise<unknown>;
    MapsFlatRasterRuntime: { prototype: MapsFlatRasterRuntime };
    MapsWgpuBaseMapRenderer: {
      prototype: {
        render(tiles: unknown, camera: unknown, frame: MapsWgpuApplicationFrame | null): number;
      };
    };
  }>();
  await wasm.default();
  const runtime = wasm.MapsFlatRasterRuntime.prototype;
  const originalFrame = runtime.frame;
  const originalProject = runtime.project;
  let active: MapsFlatRasterRuntime;
  let started: number | null = null;
  runtime.frame = function () {
    // oxlint-disable-next-line typescript/no-this-alias -- Observe the actual Rust instance.
    active = this;
    started = performance.now();
    return originalFrame.call(this);
  };
  runtime.project = function (longitude, latitude) {
    probe.projected++;
    return originalProject.call(this, longitude, latitude);
  };
  probe.position = () => originalProject.call(active, ...anchor);
  const renderer = wasm.MapsWgpuBaseMapRenderer.prototype;
  const originalRender = renderer.render;
  renderer.render = function (tiles, camera, frame) {
    const circle = frame?.circles[0];
    if (active)
      probe.samples.push({
        actual: circle ? [circle.x, circle.y] : null,
        expected: probe.position(),
      });
    const result = originalRender.call(this, tiles, camera, frame);
    // Synchronous camera preparation + submission only, not GPU completion or FPS.
    if (started !== null && circle) probe.cameraCpuMs.push(performance.now() - started);
    started = null;
    return result;
  };
  const originalClear = CanvasRenderingContext2D.prototype.clearRect;
  const originalArc = CanvasRenderingContext2D.prototype.arc;
  const seen = new WeakSet<HTMLCanvasElement>();
  CanvasRenderingContext2D.prototype.clearRect = function (...args) {
    seen.delete(this.canvas);
    return originalClear.apply(this, args);
  };
  CanvasRenderingContext2D.prototype.arc = function (...args) {
    if (active && this.canvas.dataset.mapOverlayBackend === "canvas2d" && !seen.has(this.canvas)) {
      seen.add(this.canvas);
      probe.samples.push({ actual: [args[0], args[1]], expected: probe.position() });
    }
    return originalArc.apply(this, args);
  };
}
