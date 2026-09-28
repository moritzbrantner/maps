import { importMapsWasmModule, type MapsWasmModuleBase } from "./aggregation-wasm";
import type {
  MapsRasterRenderCamera,
  MapsRasterTileId,
  MapsRasterTilePlacement,
} from "./flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "./wgpu-application-frame";

// Mirrors PACKED_TILE_DRAW_HEADER_LENGTH / PACKED_TILE_DRAW_STRIDE in
// crates/maps-wasm/src/wgpu_base_map.rs.
const PACKED_TILE_DRAW_HEADER_LENGTH = 19;
const PACKED_TILE_DRAW_STRIDE = 6;

export type MapsWgpuBaseMapRenderer = {
  dispose(): void;
  evictTile(tile: MapsRasterTileId): void;
  isDeviceLost(): boolean;
  render(
    placements: MapsRasterTilePlacement[],
    renderCamera: MapsRasterRenderCamera,
    applicationFrame?: MapsWgpuApplicationFrame | null,
    /** Render-surface margin (CSS px per side) the canvas extends beyond the viewport. */
    surfaceMargin?: number,
    /**
     * Viewport CSS size when only the viewport (the surface minus its margin) needs
     * pixels; margin-only placements are skipped and drawing is scissored to it.
     */
    viewportClip?: { width: number; height: number } | null,
  ): number;
  resize(width: number, height: number): void;
  uploadTile(tile: MapsRasterTileId, image: ImageBitmap): void;
};

type MapsWgpuBaseMapWasmRenderer = {
  evictTile(z: number, x: number, y: number): void;
  free?: () => void;
  isDeviceLost(): boolean;
  /** Packed tile draws; layout documented with `unpack_tile_draws` in maps-wasm. */
  renderPacked(tileDraws: Float64Array, applicationFrame: MapsWgpuApplicationFrame | null): number;
  resize(width: number, height: number): void;
  uploadTile(z: number, x: number, y: number, image: ImageBitmap): void;
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
    const createRenderer = wasmModule.createWgpuBaseMapRenderer;

    if (!createRenderer) {
      throw new Error("Maps wgpu base-map renderer is unavailable.");
    }

    const renderer = await createRenderer(canvas);
    let disposed = false;
    let tileDraws = new Float64Array(PACKED_TILE_DRAW_HEADER_LENGTH);
    canvas.style.opacity = "1";

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        canvas.style.opacity = "0";
        renderer.free?.();
      },
      evictTile(tile) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.evictTile(tile.z, tile.x, tile.y);
        });
      },
      isDeviceLost() {
        return runRendererOperation(canvas, () => {
          assertLive(disposed);
          return renderer.isDeviceLost();
        });
      },
      render(
        placements,
        renderCamera,
        applicationFrame = null,
        surfaceMargin = 0,
        viewportClip = null,
      ) {
        return runRendererOperation(canvas, () => {
          assertLive(disposed);
          const capacity =
            PACKED_TILE_DRAW_HEADER_LENGTH + placements.length * PACKED_TILE_DRAW_STRIDE;
          // Reused across frames; wasm-bindgen copies the view into WASM memory.
          if (tileDraws.length < capacity) tileDraws = new Float64Array(capacity * 2);
          tileDraws.set(renderCamera.viewProjection);
          tileDraws[16] = surfaceMargin;
          tileDraws[17] = viewportClip?.width ?? 0;
          tileDraws[18] = viewportClip?.height ?? 0;
          let length = PACKED_TILE_DRAW_HEADER_LENGTH;
          for (const placement of placements) {
            if (viewportClip && placement.visible === false) continue;
            tileDraws[length] = placement.tile.z;
            tileDraws[length + 1] = placement.tile.x;
            tileDraws[length + 2] = placement.tile.y;
            tileDraws[length + 3] = placement.localWest;
            tileDraws[length + 4] = placement.localNorth;
            tileDraws[length + 5] = placement.localSize;
            length += PACKED_TILE_DRAW_STRIDE;
          }
          return renderer.renderPacked(tileDraws.subarray(0, length), applicationFrame);
        });
      },
      resize(width, height) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.resize(width, height);
        });
      },
      uploadTile(tile, image) {
        runRendererOperation(canvas, () => {
          assertLive(disposed);
          renderer.uploadTile(tile.z, tile.x, tile.y, image);
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
