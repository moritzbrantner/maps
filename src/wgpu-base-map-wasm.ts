import type { MapsWasmModuleBase } from "./aggregation-wasm";
import type { MapsRasterTilePlacement } from "./flat-runtime-wasm";

export const DEFAULT_MAPS_WGPU_WASM_PACKAGE = "@moritzbrantner/maps-wgpu/wasm";

let configuredMapsWgpuWasmPackage: string | undefined;

export type MapsWgpuBaseMapRenderer = {
  dispose(): void;
  evictTile(key: string): void;
  render(
    placements: MapsRasterTilePlacement[],
    viewportWidth: number,
    viewportHeight: number,
  ): number;
  resize(width: number, height: number): void;
  uploadTile(key: string, image: ImageBitmap): void;
};

type MapsWgpuBaseMapWasmRenderer = {
  evictTile(key: string): void;
  free?: () => void;
  render(
    placements: MapsRasterTilePlacement[],
    viewportWidth: number,
    viewportHeight: number,
  ): number;
  resize(width: number, height: number): void;
  uploadTile(key: string, image: ImageBitmap): void;
};

type MapsWgpuBaseMapWasmModule = MapsWasmModuleBase & {
  createWgpuBaseMapRenderer?: (canvas: HTMLCanvasElement) => Promise<MapsWgpuBaseMapWasmRenderer>;
};

export function configureMapsWgpuWasmPackage(packageName?: string) {
  configuredMapsWgpuWasmPackage = packageName;
}

export async function loadMapsWgpuBaseMapRenderer(
  canvas: HTMLCanvasElement,
  packageName?: string,
): Promise<MapsWgpuBaseMapRenderer> {
  const wasmModule = await importMapsWgpuWasmModule(packageName);
  await wasmModule.default?.();
  const createRenderer = wasmModule.createWgpuBaseMapRenderer;

  if (!createRenderer) {
    throw new Error("Maps wgpu base-map renderer is unavailable.");
  }

  const renderer = await createRenderer(canvas);
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.free?.();
    },
    evictTile(key) {
      assertLive(disposed);
      renderer.evictTile(key);
    },
    render(placements, viewportWidth, viewportHeight) {
      assertLive(disposed);
      return renderer.render(placements, viewportWidth, viewportHeight);
    },
    resize(width, height) {
      assertLive(disposed);
      renderer.resize(width, height);
    },
    uploadTile(key, image) {
      assertLive(disposed);
      renderer.uploadTile(key, image);
    },
  };
}

async function importMapsWgpuWasmModule(packageName?: string): Promise<MapsWgpuBaseMapWasmModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MapsWgpuBaseMapWasmModule>;
  const resolvedPackage =
    packageName ?? configuredMapsWgpuWasmPackage ?? DEFAULT_MAPS_WGPU_WASM_PACKAGE;

  return dynamicImport(resolvedPackage);
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps wgpu base-map renderer has been disposed.");
  }
}
