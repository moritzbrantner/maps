import type { MapsKernelRuntime } from "./runtime";

type MapsKernelsWasmModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  initSync?: (module?: unknown) => unknown;
  resampleLineFlat: (coordinates: Float64Array, coordinateCount: number) => Float64Array;
  resampleRingFlat: (coordinates: Float64Array, coordinateCount: number) => Float64Array;
};

const DEFAULT_WASM_PACKAGE = "@mb-rust/maps-kernels-wasm";

export async function loadMapsWasmKernelRuntime(
  packageName = DEFAULT_WASM_PACKAGE,
): Promise<MapsKernelRuntime> {
  const wasmModule = await importOptionalWasmModule(packageName);

  await wasmModule.default?.();

  return {
    backend: "wasm",
    resampleLineFlat(coordinates, coordinateCount) {
      return new Float64Array(wasmModule.resampleLineFlat(coordinates, coordinateCount));
    },
    resampleRingFlat(coordinates, coordinateCount) {
      return new Float64Array(wasmModule.resampleRingFlat(coordinates, coordinateCount));
    },
  };
}

async function importOptionalWasmModule(packageName: string): Promise<MapsKernelsWasmModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MapsKernelsWasmModule>;

  return dynamicImport(packageName);
}
