import { createRoot } from "react-dom/client";
import "@moritzbrantner/ui/atlas/styles.css";
import "@moritzbrantner/ui/component-sources.css";
import "../styles.css";
import "./engine.css";
import { initializeMapsAggregationWasm } from "../src/aggregation-runtime";
import {
  configureMapsWasmPackage,
  isMapsWebGpuAvailable,
  preferMapsWasmRendererModule,
} from "../src/aggregation-wasm";
import { EnginePage } from "./EnginePage";

// `?view=inspector` shows the renderer inspector (#167) on the same engine page entry.
const view = new URLSearchParams(location.search).get("view");
const inspector = view === "inspector";
if (inspector && new URLSearchParams(location.search).get("gpu") === "off") {
  // Same capability probe the browser runtime uses: forces the Canvas2D backend.
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => undefined });
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="engine-loading" role="status">
    Loading Maps engine…
  </main>,
);

async function bootstrap() {
  const wasmUrl = (fileName: string) =>
    new URL(`${import.meta.env.BASE_URL}wasm/${fileName}`, location.origin).href;
  // #305: Canvas2D (no WebGPU) loads only the WebGPU-free core module; a WebGPU page loads only
  // the full renderer module, declared before the aggregation runtime starts loading.
  configureMapsWasmPackage({
    core: wasmUrl("maps_wasm_core.js"),
    renderer: wasmUrl("maps_wasm.js"),
  });
  if (isMapsWebGpuAvailable()) preferMapsWasmRendererModule();
  if (!(await initializeMapsAggregationWasm())) {
    throw new Error("The Maps engine could not load. Reload to try again.");
  }
  if (inspector) {
    await import("./engine/engine-inspector.css");
    const { EngineInspector } = await import("./engine/EngineInspector");
    root.render(<EngineInspector />);
    return;
  }
  if (view === "benchmark") {
    const { EngineBenchmarkFixture } = await import("./engine/EngineBenchmarkFixture");
    root.render(<EngineBenchmarkFixture />);
    return;
  }
  root.render(<EnginePage />);
}

bootstrap().catch((error: unknown) => {
  root.render(
    <main className="engine-loading" role="alert">
      <h1>Maps engine unavailable</h1>
      <p>{error instanceof Error ? error.message : "The Maps engine could not load."}</p>
      <a href={`${import.meta.env.BASE_URL}stats/`}>Stats</a>
    </main>,
  );
});
