import {
  importMapsWasmModule,
  type MapsWasmModuleBase,
} from "./aggregation-wasm";
import type { MapBounds, MapViewState } from "./map-display";

export type MapsRasterTileId = {
  key: string;
  x: number;
  y: number;
  z: number;
};

type MapsRasterTileCoordinates = Omit<MapsRasterTileId, "key">;

export type MapsRasterTilePlacement = {
  tile: MapsRasterTileId;
  worldCopy: number;
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
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
  requests: MapsRasterTileId[];
  visibleBounds: {
    crossesAntimeridian: boolean;
    east: number;
    north: number;
    south: number;
    spansFullWorld: boolean;
    west: number;
  };
};

type MapsFlatRasterWasmFrame = {
  camera: MapsFlatRasterFrame["camera"];
  cancellations: MapsRasterTileCoordinates[];
  evictions: MapsRasterTileCoordinates[];
  placements: Array<
    Omit<MapsRasterTilePlacement, "tile"> & { tile: MapsRasterTileCoordinates }
  >;
  requests: MapsRasterTileCoordinates[];
  visibleBounds: MapsFlatRasterFrame["visibleBounds"];
};

export type MapsFlatRasterRuntimeConfig = {
  center: [longitude: number, latitude: number];
  height: number;
  limits?: {
    cacheCapacity: number;
    loadConcurrency: number;
    maxVisibleTiles: number;
  };
  maxBounds?: MapBounds;
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
  frame(): MapsFlatRasterFrame;
  markFailed(tile: MapsRasterTileId): void;
  markLoaded(tile: MapsRasterTileId): void;
  panBy(deltaX: number, deltaY: number): void;
  project(longitude: number, latitude: number): [x: number, y: number];
  resize(width: number, height: number): void;
  setViewState(viewState: MapViewState): void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
  zoomAbout(
    deltaZoom: number,
    x: number,
    y: number,
    minZoom: number,
    maxZoom: number,
  ): void;
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
  frame(): MapsFlatRasterWasmFrame;
  free?: () => void;
  markFailed(z: number, x: number, y: number): void;
  markLoaded(z: number, x: number, y: number): void;
  panBy(deltaX: number, deltaY: number): void;
  project(longitude: number, latitude: number): [x: number, y: number];
  resize(width: number, height: number): void;
  setViewState(longitude: number, latitude: number, zoom: number): void;
  unproject(x: number, y: number): [longitude: number, latitude: number];
  zoomAbout(
    deltaZoom: number,
    x: number,
    y: number,
    minZoom: number,
    maxZoom: number,
  ): void;
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
  await wasmModule.default?.();
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
      return addRasterTileKeys(runtime.frame());
    },
    markFailed(tile) {
      assertLive(disposed);
      runtime.markFailed(tile.z, tile.x, tile.y);
    },
    markLoaded(tile) {
      assertLive(disposed);
      runtime.markLoaded(tile.z, tile.x, tile.y);
    },
    panBy(deltaX, deltaY) {
      assertLive(disposed);
      runtime.panBy(deltaX, deltaY);
    },
    project(longitude, latitude) {
      assertLive(disposed);
      return runtime.project(longitude, latitude);
    },
    resize(width, height) {
      assertLive(disposed);
      runtime.resize(width, height);
    },
    setViewState(viewState) {
      assertLive(disposed);
      runtime.setViewState(viewState.center[0], viewState.center[1], viewState.zoom);
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

function addRasterTileKeys(frame: MapsFlatRasterWasmFrame): MapsFlatRasterFrame {
  return {
    ...frame,
    cancellations: frame.cancellations.map(addRasterTileKey),
    evictions: frame.evictions.map(addRasterTileKey),
    placements: frame.placements.map((placement) => ({
      ...placement,
      tile: addRasterTileKey(placement.tile),
    })),
    requests: frame.requests.map(addRasterTileKey),
  };
}

function addRasterTileKey(tile: MapsRasterTileCoordinates): MapsRasterTileId {
  return {
    ...tile,
    key: `${tile.z}/${tile.x}/${tile.y}`,
  };
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps WASM flat raster runtime has been disposed.");
  }
}
