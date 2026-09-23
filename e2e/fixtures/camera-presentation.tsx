import "../../styles.css";
import { createRoot } from "react-dom/client";
import { configureMapsWasmPackage, importMapsWasmModule } from "../../src/aggregation-wasm";
import { GeoJsonLayer, type GeoJsonLayerProps } from "../../src/geojson-layer";
import { MapsMapView } from "../../src/maps-map-view";
import type { MapSurfaceController, MapViewState } from "../../src/map-display";
import type { MapsFlatRasterFrame, MapsFlatRasterRuntime } from "../../src/flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "../../src/wgpu-application-frame";

// Keep the entire grid, including the first entity used for picking, inside
// the viewport both before and after the measured zoom burst.
const coordinates: [number, number] = [13.335, 52.544];
const data: GeoJsonLayerProps["featureCollection"] = {
  type: "FeatureCollection",
  features: Array.from({ length: 1000 }, (_, i) => ({
    type: "Feature",
    id: `entity-${i}`,
    properties: {},
    geometry: {
      type: "Point",
      coordinates: [coordinates[0] + (i % 40) * 0.0035, coordinates[1] - Math.floor(i / 40) * 0.002],
    },
  })),
};

type Sample = { actual: [number, number] | null; expected: [number, number] };
declare global {
  interface Window {
    mapsCameraProbe: {
      frames: number;
      projected: number;
      changes: number;
      samples: Sample[];
      reset(): void;
      setViewState(state: MapViewState): void;
    };
  }
}
let controller: MapSurfaceController | undefined;
const probe = (window.mapsCameraProbe = {
  frames: 0,
  projected: 0,
  changes: 0,
  samples: [] as Sample[],
  reset() {
    this.frames = 0;
    this.projected = 0;
    this.changes = 0;
    this.samples = [];
  },
  setViewState(state: MapViewState) {
    controller!.setViewState(state);
  },
});

// Observe, but do not replace, the real Rust runtime and renderer. Expected
// coordinates come from that same Rust instance, not a JS projection formula.
configureMapsWasmPackage("/wasm/maps_wasm.js");
type WasmModule = {
  default(): Promise<unknown>;
  MapsFlatRasterRuntime: { prototype: Pick<MapsFlatRasterRuntime, "frame" | "project"> };
  MapsWgpuBaseMapRenderer: {
    prototype: {
      render(
        placements: unknown,
        camera: unknown,
        application: MapsWgpuApplicationFrame | null,
      ): number;
    };
  };
};
const wasm = await importMapsWasmModule<WasmModule>();
await wasm.default();
const runtimePrototype = wasm.MapsFlatRasterRuntime.prototype;
const originalFrame = runtimePrototype.frame;
const originalProject = runtimePrototype.project;
let activeRuntime: typeof runtimePrototype | undefined;
runtimePrototype.frame = function (): MapsFlatRasterFrame {
  // oxlint-disable-next-line typescript/no-this-alias -- Observe the actual instrumented Rust instance.
  activeRuntime = this;
  probe.frames++;
  return originalFrame.call(this);
};
runtimePrototype.project = function (longitude, latitude) {
  probe.projected++;
  return originalProject.call(this, longitude, latitude);
};
const expected = (): [number, number] => originalProject.call(activeRuntime!, ...coordinates);
const rendererPrototype = wasm.MapsWgpuBaseMapRenderer.prototype;
const originalRender = rendererPrototype.render;
rendererPrototype.render = function (placements, camera, application) {
  if (activeRuntime) {
    const circle = application?.circles[0];
    probe.samples.push({ actual: circle ? [circle.x, circle.y] : null, expected: expected() });
  }
  return originalRender.call(this, placements, camera, application);
};
// Canvas fallback uses the identical acceptance check, at its actual draw edge.
const originalClear = CanvasRenderingContext2D.prototype.clearRect;
const originalArc = CanvasRenderingContext2D.prototype.arc;
const seen = new WeakSet<HTMLCanvasElement>();
CanvasRenderingContext2D.prototype.clearRect = function (...args) {
  seen.delete(this.canvas);
  return originalClear.apply(this, args);
};
CanvasRenderingContext2D.prototype.arc = function (...args) {
  if (
    activeRuntime &&
    this.canvas.dataset.mapOverlayBackend === "canvas2d" &&
    !seen.has(this.canvas)
  ) {
    seen.add(this.canvas);
    probe.samples.push({ actual: [args[0], args[1]], expected: expected() });
  }
  return originalArc.apply(this, args);
};

createRoot(document.getElementById("root")!).render(
  <main>
    <h1>Camera-synchronized map entities</h1>
    <p>1,000 entities. Ordered zoom input, one frame, one Rust camera.</p>
    <MapsMapView
      mapLabel="Camera synchronization acceptance"
      mapStyle={{ tiles: false }}
      fitToData={false}
      initialViewState={{ center: [13.405, 52.52], zoom: 11 }}
      onMapControllerReady={(next) => {
        controller = next;
      }}
      onViewStateChange={() => {
        probe.changes++;
      }}
      style={{ height: 480 }}
    >
      <GeoJsonLayer
        featureCollection={data}
        pointColor="#2563eb"
        pointRadius={3}
        renderFeatureTooltip={(feature) => <span>Picked {feature.id}</span>}
      />
    </MapsMapView>
  </main>,
);
