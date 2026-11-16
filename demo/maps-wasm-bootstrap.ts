import { initializeMapsAggregationWasm } from "../src/aggregation-runtime";
import {
  configureMapsWasmPackage,
  isMapsWebGpuAvailable,
  preferMapsWasmRendererModule,
} from "../src/aggregation-wasm";

/**
 * Loads the hosted Rust/WASM runtime for a first-party Pages entry (`/engine/`, `/features/`).
 * #305: Canvas2D (no WebGPU) loads only the WebGPU-free core module; a WebGPU page loads only
 * the full renderer module, declared before the aggregation runtime starts loading.
 */
export async function loadHostedMapsWasm(): Promise<void> {
  const wasmUrl = (fileName: string) =>
    new URL(`${import.meta.env.BASE_URL}wasm/${fileName}`, location.origin).href;
  configureMapsWasmPackage({
    core: wasmUrl("maps_wasm_core.js"),
    renderer: wasmUrl("maps_wasm.js"),
  });
  if (isMapsWebGpuAvailable()) preferMapsWasmRendererModule();
  if (!(await initializeMapsAggregationWasm())) {
    throw new Error("The Maps engine could not load. Reload to try again.");
  }
}
