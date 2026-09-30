import { importMapsWasmModule, type MapsWasmModuleBase } from "./aggregation-wasm";
import type { MapBounds, MapViewState } from "./map-display";

export type MapsRasterTileId = {
  key: string;
  x: number;
  y: number;
  z: number;
};

export type MapsRasterRenderCamera = {
  viewProjection: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
};

export type MapsRasterTilePlacement = {
  tile: MapsRasterTileId;
  worldCopy: number;
  localWest: number;
  localNorth: number;
  localSize: number;
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
  /** False for placements that only fill the render-surface margin. */
  visible?: boolean;
};

export type MapsFlatRasterFrame = {
  camera: {
    bearing: number;
    center: [longitude: number, latitude: number];
    height: number;
    pitch: number;
    width: number;
    zoom: number;
  };
  cancellations: MapsRasterTileId[];
  evictions: MapsRasterTileId[];
  placements: MapsRasterTilePlacement[];
  /** The render camera maps into the viewport grown by `surface.margin` per side. */
  renderCamera: MapsRasterRenderCamera;
  requests: MapsRasterTileId[];
  /**
   * Render-surface geometry. With `overscan`, the margin holds map content, so a pure
   * screen translation of this frame is a valid presentation of a panned camera.
   */
  surface?: { margin: number; overscan: boolean };
  visibleBounds: {
    crossesAntimeridian: boolean;
    east: number;
    north: number;
    south: number;
    spansFullWorld: boolean;
    west: number;
  };
};

export type MapsFlatRasterRuntimeConfig = {
  bearing?: number;
  center: [longitude: number, latitude: number];
  height: number;
  limits?: {
    cacheCapacity: number;
    loadConcurrency: number;
    maxVisibleTiles: number;
  };
  maxBounds?: MapBounds;
  pitch?: number;
  /** Presentation-only render-surface margin, CSS px per side (default 0). */
  renderMargin?: number;
  source: {
    maxZoom: number;
    minZoom: number;
    tileSize: number;
  };
  width: number;
  zoom: number;
};

export type MapsFlatRasterRuntime = {
  dispose(): void;
  fitBounds(bounds: MapBounds, padding: number, maxZoom: number): void;
  /** Advances scheduling; dispatch the returned work and retain the frame for reads/redraws. */
  frame(): MapsFlatRasterFrame;
  markFailed(tile: MapsRasterTileId): void;
  markLoaded(tile: MapsRasterTileId): void;
  panBetween(previousX: number, previousY: number, currentX: number, currentY: number): void;
  panBy(deltaX: number, deltaY: number): void;
  project(longitude: number, latitude: number): [x: number, y: number];
  projectPacked(coordinates: Float64Array): Float64Array;
  resize(width: number, height: number): void;
  /** Rotates by `deltaBearing` degrees keeping the ground point under (x, y) fixed. */
  rotateAbout(deltaBearing: number, x: number, y: number): void;
  setViewState(viewState: MapViewState): void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
  zoomAbout(deltaZoom: number, x: number, y: number, minZoom: number, maxZoom: number): void;
};

type MapsFlatRasterWasmRuntime = {
  fitBounds(
    west: number,
    south: number,
    east: number,
    north: number,
    padding: number,
    maxZoom: number,
  ): void;
  /** Packed frame; layout documented with `pack_frame_plan` in maps-wasm. */
  framePacked(): Float64Array;
  free?: () => void;
  markFailed(z: number, x: number, y: number): void;
  markLoaded(z: number, x: number, y: number): void;
  panBetween(previousX: number, previousY: number, currentX: number, currentY: number): void;
  panBy(deltaX: number, deltaY: number): void;
  project(longitude: number, latitude: number): [x: number, y: number];
  projectPacked(coordinates: Float64Array): Float64Array;
  resize(width: number, height: number): void;
  rotateAbout(deltaBearing: number, x: number, y: number): void;
  setViewState(
    longitude: number,
    latitude: number,
    zoom: number,
    bearing: number,
    pitch: number,
  ): void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
  zoomAbout(deltaZoom: number, x: number, y: number, minZoom: number, maxZoom: number): void;
};

type MapsFlatRasterWasmRuntimeConstructor = new (
  config: MapsFlatRasterRuntimeConfig,
) => MapsFlatRasterWasmRuntime;

type MapsFlatRasterWasmModule = MapsWasmModuleBase & {
  MapsFlatRasterRuntime?: MapsFlatRasterWasmRuntimeConstructor;
};

export async function loadMapsFlatRasterRuntime(
  config: MapsFlatRasterRuntimeConfig,
  packageName?: string,
): Promise<MapsFlatRasterRuntime> {
  const wasmModule = await importMapsWasmModule<MapsFlatRasterWasmModule>(packageName);
  const Constructor = wasmModule.MapsFlatRasterRuntime;

  if (!Constructor) {
    throw new Error("Maps WASM flat raster runtime is unavailable.");
  }

  const runtime = new Constructor(config);
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.free?.();
    },
    fitBounds(bounds, padding, maxZoom) {
      assertLive(disposed);
      runtime.fitBounds(...bounds, padding, maxZoom);
    },
    frame() {
      assertLive(disposed);
      return decodePackedRasterFrame(runtime.framePacked());
    },
    markFailed(tile) {
      assertLive(disposed);
      runtime.markFailed(tile.z, tile.x, tile.y);
    },
    markLoaded(tile) {
      assertLive(disposed);
      runtime.markLoaded(tile.z, tile.x, tile.y);
    },
    panBetween(previousX, previousY, currentX, currentY) {
      assertLive(disposed);
      runtime.panBetween(previousX, previousY, currentX, currentY);
    },
    panBy(deltaX, deltaY) {
      assertLive(disposed);
      runtime.panBy(deltaX, deltaY);
    },
    project(longitude, latitude) {
      assertLive(disposed);
      return runtime.project(longitude, latitude);
    },
    projectPacked(coordinates) {
      assertLive(disposed);
      return runtime.projectPacked(coordinates);
    },
    resize(width, height) {
      assertLive(disposed);
      runtime.resize(width, height);
    },
    rotateAbout(deltaBearing, x, y) {
      assertLive(disposed);
      runtime.rotateAbout(deltaBearing, x, y);
    },
    setViewState(viewState) {
      assertLive(disposed);
      runtime.setViewState(
        viewState.center[0],
        viewState.center[1],
        viewState.zoom,
        viewState.bearing ?? 0,
        viewState.pitch ?? 0,
      );
    },
    unproject(x, y) {
      assertLive(disposed);
      return runtime.unproject(x, y);
    },
    zoomAbout(deltaZoom, x, y, minZoom, maxZoom) {
      assertLive(disposed);
      runtime.zoomAbout(deltaZoom, x, y, minZoom, maxZoom);
    },
  };
}

// Mirrors PACKED_FRAME_HEADER_LENGTH / PACKED_PLACEMENT_STRIDE / PACKED_TILE_STRIDE
// in crates/maps-wasm/src/engine_scenario.rs.
const PACKED_FRAME_HEADER_LENGTH = 35;
const PACKED_PLACEMENT_STRIDE = 12;
const PACKED_TILE_STRIDE = 3;

/** Decodes one packed Rust frame. JS object construction here replaces per-field WASM crossings. */
export function decodePackedRasterFrame(packed: Float64Array): MapsFlatRasterFrame {
  if (packed.length < PACKED_FRAME_HEADER_LENGTH) {
    throw new Error("Maps WASM returned a truncated raster frame.");
  }
  const placementCount = packed[29]!;
  const requestCount = packed[30]!;
  const cancellationCount = packed[31]!;
  const evictionCount = packed[32]!;
  const tilesStart = PACKED_FRAME_HEADER_LENGTH + placementCount * PACKED_PLACEMENT_STRIDE;
  if (
    packed.length !==
    tilesStart + (requestCount + cancellationCount + evictionCount) * PACKED_TILE_STRIDE
  ) {
    throw new Error("Maps WASM returned a malformed raster frame.");
  }

  const placements: MapsRasterTilePlacement[] = new Array(placementCount);
  for (let index = 0; index < placementCount; index += 1) {
    const offset = PACKED_FRAME_HEADER_LENGTH + index * PACKED_PLACEMENT_STRIDE;
    placements[index] = {
      tile: rasterTileAt(packed, offset),
      worldCopy: packed[offset + 3]!,
      localWest: packed[offset + 4]!,
      localNorth: packed[offset + 5]!,
      localSize: packed[offset + 6]!,
      screenX: packed[offset + 7]!,
      screenY: packed[offset + 8]!,
      screenWidth: packed[offset + 9]!,
      screenHeight: packed[offset + 10]!,
      visible: packed[offset + 11] === 1,
    };
  }
  const tiles = (start: number, count: number) => {
    const result: MapsRasterTileId[] = new Array(count);
    for (let index = 0; index < count; index += 1) {
      result[index] = rasterTileAt(packed, tilesStart + (start + index) * PACKED_TILE_STRIDE);
    }
    return result;
  };

  return {
    camera: {
      center: [packed[0]!, packed[1]!],
      zoom: packed[2]!,
      bearing: packed[3]!,
      pitch: packed[4]!,
      width: packed[5]!,
      height: packed[6]!,
    },
    renderCamera: {
      viewProjection: Array.from(
        packed.subarray(7, 23),
      ) as MapsRasterRenderCamera["viewProjection"],
    },
    visibleBounds: {
      west: packed[23]!,
      south: packed[24]!,
      east: packed[25]!,
      north: packed[26]!,
      crossesAntimeridian: packed[27] === 1,
      spansFullWorld: packed[28] === 1,
    },
    placements,
    surface: { margin: packed[33]!, overscan: packed[34] === 1 },
    requests: tiles(0, requestCount),
    cancellations: tiles(requestCount, cancellationCount),
    evictions: tiles(requestCount + cancellationCount, evictionCount),
  };
}

function rasterTileAt(packed: Float64Array, offset: number): MapsRasterTileId {
  const z = packed[offset]!;
  const x = packed[offset + 1]!;
  const y = packed[offset + 2]!;
  return { key: `${z}/${x}/${y}`, x, y, z };
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps WASM flat raster runtime has been disposed.");
  }
}
