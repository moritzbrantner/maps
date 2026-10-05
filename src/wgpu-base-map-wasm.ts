import { importMapsWasmModule, type MapsWasmModuleBase } from "./aggregation-wasm";
import type {
  MapsRasterRenderCamera,
  MapsRasterTileId,
  MapsRasterTilePlacement,
} from "./flat-runtime-wasm";
import type { MapsWgpuApplicationFrame } from "./wgpu-application-frame";

// Mirrors PACKED_TILE_DRAW_HEADER_LENGTH / PACKED_TILE_DRAW_STRIDE in
// crates/maps-wasm/src/wgpu_base_map.rs.
const PACKED_TILE_DRAW_HEADER_LENGTH = 20;
const PACKED_TILE_DRAW_STRIDE = 6;

// Async hosts can overlap while replacing a renderer on the same DOM canvas.
// Only the latest request may change that canvas or submit work to its surface.
const rendererOwners = new WeakMap<HTMLCanvasElement, object>();
/** Counters of the last rendered frame and of retained vector resources. */
export type MapsWgpuFrameStats = {
  drawCalls: number;
  rasterTiles: number;
  retainedVectorBytes: number;
  retainedVectorFeatures: number;
  retainedVectorLineSegments: number;
  retainedVectorTiles: number;
  retainedVectorTriangles: number;
  vectorTiles: number;
};

export type MapsWgpuBaseMapRenderer = {
  dispose(): void;
  evictTile(tile: MapsRasterTileId): void;
  evictVectorTile(tile: MapsRasterTileId): void;
  frameStats(): MapsWgpuFrameStats;
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
  /** Style table from `createMapsVectorBasemapStyleTable`. */
  setVectorStyle(table: Float32Array): void;
  setVectorMaxZoom(maxZoom: number): void;
  uploadTile(tile: MapsRasterTileId, image: ImageBitmap): void;
  /**
   * Decodes Shortbread MVT bytes into tile-local GPU buckets (Rust) and retains them.
   * Returns the decoded feature count. Malformed tiles throw without failing the renderer.
   */
  uploadVectorTile(tile: MapsRasterTileId, bytes: Uint8Array): number;
};

type MapsWgpuBaseMapWasmRenderer = {
  evictTile(z: number, x: number, y: number): void;
  evictVectorTile(z: number, x: number, y: number): void;
  frameStats(): Float64Array | number[];
  free?: () => void;
  isDeviceLost(): boolean;
  /** Packed tile draws; layout documented with `unpack_tile_draws` in maps-wasm. */
  renderPacked(tileDraws: Float64Array, applicationFrame: MapsWgpuApplicationFrame | null): number;
  resize(width: number, height: number): void;
  setVectorMaxZoom(maxZoom: number): void;
  setVectorStyle(table: Float32Array): void;
  uploadTile(z: number, x: number, y: number, image: ImageBitmap): void;
  uploadVectorTile(z: number, x: number, y: number, bytes: Uint8Array): number;
};

type MapsWgpuBaseMapWasmModule = MapsWasmModuleBase & {
  createWgpuBaseMapRenderer?: (canvas: HTMLCanvasElement) => Promise<MapsWgpuBaseMapWasmRenderer>;
};

export async function loadMapsWgpuBaseMapRenderer(
  canvas: HTMLCanvasElement,
  packageName?: string,
): Promise<MapsWgpuBaseMapRenderer> {
  const owner = {};
  rendererOwners.set(canvas, owner);
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
    if (rendererOwners.get(canvas) === owner) canvas.style.opacity = "1";

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        if (rendererOwners.get(canvas) === owner) {
          canvas.style.opacity = "0";
          rendererOwners.delete(canvas);
        }
        renderer.free?.();
      },
      evictTile(tile) {
        runRendererOperation(canvas, owner, () => {
          assertLive(disposed);
          renderer.evictTile(tile.z, tile.x, tile.y);
        });
      },
      evictVectorTile(tile) {
        runRendererOperation(canvas, owner, () => {
          assertLive(disposed);
          renderer.evictVectorTile(tile.z, tile.x, tile.y);
        });
      },
      frameStats() {
        assertLive(disposed);
        const stats = renderer.frameStats();
        return {
          rasterTiles: stats[0] ?? 0,
          vectorTiles: stats[1] ?? 0,
          drawCalls: stats[2] ?? 0,
          retainedVectorTiles: stats[3] ?? 0,
          retainedVectorFeatures: stats[4] ?? 0,
          retainedVectorTriangles: stats[5] ?? 0,
          retainedVectorLineSegments: stats[6] ?? 0,
          retainedVectorBytes: stats[7] ?? 0,
        };
      },
      isDeviceLost() {
        return runRendererOperation(canvas, owner, () => {
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
        return runRendererOperation(canvas, owner, () => {
          assertLive(disposed);
          const capacity =
            PACKED_TILE_DRAW_HEADER_LENGTH + placements.length * PACKED_TILE_DRAW_STRIDE;
          // Reused across frames; wasm-bindgen copies the view into WASM memory.
          if (tileDraws.length < capacity) tileDraws = new Float64Array(capacity * 2);
          tileDraws.set(renderCamera.viewProjection);
          tileDraws[16] = surfaceMargin;
          tileDraws[17] = viewportClip?.width ?? 0;
          tileDraws[18] = viewportClip?.height ?? 0;
          // Same ratio the host uses to size the canvas backing store.
          tileDraws[19] = Math.max(1, globalThis.devicePixelRatio || 1);
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
        runRendererOperation(canvas, owner, () => {
          assertLive(disposed);
          renderer.resize(width, height);
        });
      },
      setVectorMaxZoom(maxZoom) {
        assertLive(disposed);
        renderer.setVectorMaxZoom(maxZoom);
      },
      setVectorStyle(table) {
        assertLive(disposed);
        renderer.setVectorStyle(table);
      },
      uploadTile(tile, image) {
        runRendererOperation(canvas, owner, () => {
          assertLive(disposed);
          renderer.uploadTile(tile.z, tile.x, tile.y, image);
        });
      },
      uploadVectorTile(tile, bytes) {
        // Data errors (malformed MVT) are the caller's; they must not hide the canvas.
        assertLive(disposed);
        return renderer.uploadVectorTile(tile.z, tile.x, tile.y, bytes);
      },
    };
  } catch (error) {
    if (rendererOwners.get(canvas) === owner) canvas.style.opacity = "0";
    throw error;
  }
}

function runRendererOperation<T>(canvas: HTMLCanvasElement, owner: object, operation: () => T): T {
  try {
    if (rendererOwners.get(canvas) !== owner) {
      throw new Error("Maps wgpu base-map renderer has been superseded.");
    }
    return operation();
  } catch (error) {
    if (rendererOwners.get(canvas) === owner) canvas.style.opacity = "0";
    throw error;
  }
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps wgpu base-map renderer has been disposed.");
  }
}
