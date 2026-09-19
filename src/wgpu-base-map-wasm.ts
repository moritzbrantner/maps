import {
  importMapsWasmModule,
  type MapsWasmModuleBase,
} from "./aggregation-wasm";
import type {
  MapsRasterRenderCamera,
  MapsRasterTileId,
  MapsRasterTilePlacement,
} from "./flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "./wgpu-application-frame";

export type MapsWgpuBaseMapRenderer = {
  dispose(): void;
  evictShortbreadTile(tile: MapsRasterTileId): void;
  evictTile(key: string): void;
  isDeviceLost(): boolean;
  render(
    placements: MapsRasterTilePlacement[],
    renderCamera: MapsRasterRenderCamera,
    applicationFrame?: MapsWgpuApplicationFrame | null,
  ): number;
  resize(width: number, height: number): void;
  uploadShortbreadTile(tile: MapsRasterTileId, bytes: Uint8Array): number;
  uploadTile(key: string, image: ImageBitmap): void;
};

type MapsWgpuBaseMapWasmRenderer = {
  evictShortbreadTile(z: number, x: number, y: number): void;
  evictTile(key: string): void;
  free?: () => void;
  isDeviceLost(): boolean;
  render(
    placements: MapsRasterTilePlacement[],
    renderCamera: MapsRasterRenderCamera,
    applicationFrame: MapsWgpuApplicationFrame | null,
  ): number;
  resize(width: number, height: number): void;
  uploadShortbreadTile(z: number, x: number, y: number, bytes: Uint8Array): number;
  uploadTile(key: string, image: ImageBitmap): void;
};

type MapsWgpuBaseMapWasmModule = MapsWasmModuleBase & {
  createWgpuBaseMapRenderer?: (canvas: HTMLCanvasElement) => Promise<MapsWgpuBaseMapWasmRenderer>;
};

export async function loadMapsWgpuBaseMapRenderer(
  canvas: HTMLCanvasElement,
  packageName?: string,
): Promise<MapsWgpuBaseMapRenderer> {
  canvas.style.opacity = "0";

  try {
    const wasmModule = await importMapsWasmModule<MapsWgpuBaseMapWasmModule>(packageName);
    await wasmModule.default?.();
    const createRenderer = wasmModule.createWgpuBaseMapRenderer;

    if (!createRenderer) {
      throw new Error("Maps wgpu base-map renderer is unavailable.");
    }

    const renderer = await createRenderer(canvas);
    let disposed = false;
    canvas.style.opacity = "1";

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        canvas.style.opacity = "0";
        renderer.free?.();
      },
      evictShortbreadTile(tile) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.evictShortbreadTile(tile.z, tile.x, tile.y);
        });
      },
      evictTile(key) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.evictTile(key);
        });
      },
      isDeviceLost() {
        return runRendererOperation(canvas, () => {
          assertLive(disposed);
          return renderer.isDeviceLost();
        });
      },
      render(placements, renderCamera, applicationFrame = null) {
        return runRendererOperation(canvas, () => {
          assertLive(disposed);
          return renderer.render(placements, renderCamera, applicationFrame);
        });
      },
      resize(width, height) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.resize(width, height);
        });
      },
      uploadShortbreadTile(tile, bytes) {
        return runRendererOperation(canvas, () => {
          assertLive(disposed);
          return renderer.uploadShortbreadTile(tile.z, tile.x, tile.y, bytes);
        });
      },
      uploadTile(key, image) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.uploadTile(key, image);
        });
      },
    };
  } catch (error) {
    canvas.style.opacity = "0";
    throw error;
  }
}

function runRendererOperation<T>(canvas: HTMLCanvasElement, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    canvas.style.opacity = "0";
    throw error;
  }
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps wgpu base-map renderer has been disposed.");
  }
}
