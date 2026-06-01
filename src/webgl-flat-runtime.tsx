"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

import {
  constrainMapViewState,
  normalizeMapBounds,
  type MapBounds,
  resolveMapLibreStyle,
  type MapViewState,
  type MapViewStateChangeReason,
  type RasterMapStyle,
} from "./map-display";

export type FlatMapRuntime = "maplibre" | "webgl";

export type WebGlFlatViewport = {
  bounds: [west: number, south: number, east: number, north: number];
  center: [longitude: number, latitude: number];
  height: number;
  width: number;
  zoom: number;
};

export type WebGlFlatTileSource = {
  maxZoom: number;
  minZoom: number;
  tileSize: number;
  url: string;
};

export type WebGlFlatTile = {
  bounds: [west: number, south: number, east: number, north: number];
  key: string;
  x: number;
  y: number;
  z: number;
};

type WebGlFlatRuntimeProps = {
  mapStyle: RasterMapStyle;
  maxBounds?: MapBounds;
  maxZoom?: number;
  onContextMenu?: (context: {
    coordinates: [longitude: number, latitude: number];
    position: { x: number; y: number };
  }) => void;
  onReady?: () => void;
  onViewStateChange: (viewState: MapViewState, reason: MapViewStateChangeReason) => void;
  viewState: MapViewState;
};

const FLAT_TILE_DEFAULT_MAX_ZOOM = 19;
const FLAT_TILE_DEFAULT_MIN_ZOOM = 0;
const FLAT_TILE_MAX_VISIBLE_TILES = 256;
const FLAT_TILE_TEXTURE_CACHE_SIZE = 512;
const FLAT_TILE_LOAD_CONCURRENCY = 8;
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const DEFAULT_TILE_SIZE = 256;
const MAX_FLAT_ZOOM = 22;
const MIN_FLAT_ZOOM = 0;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function WebGlFlatRuntime({
  mapStyle,
  maxBounds,
  maxZoom,
  onContextMenu,
  onReady,
  onViewStateChange,
  viewState,
}: WebGlFlatRuntimeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<ReturnType<typeof createWebGlFlatRuntime> | null>(null);
  const dragRef = useRef<{
    center: [longitude: number, latitude: number];
    pointerId: number;
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
  const viewStateRef = useRef(viewState);

  viewStateRef.current = viewState;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    runtimeRef.current = createWebGlFlatRuntime({
      container,
      mapStyle,
      viewState,
    });
    runtimeRef.current?.render();
    onReady?.();

    return () => {
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.setMapStyle(mapStyle);
    runtimeRef.current?.render();
  }, [mapStyle]);

  useEffect(() => {
    runtimeRef.current?.setViewState(viewState);
    runtimeRef.current?.render();
  }, [viewState.center[0], viewState.center[1], viewState.zoom]);

  return (
    <div
      className="mb-maps__canvas mb-maps__webgl-flat"
      data-flat-runtime="webgl"
      ref={containerRef}
      onContextMenu={(event) => {
        event.preventDefault();
        const coordinate = getPointerCoordinate(containerRef.current, event, viewStateRef.current);

        if (!coordinate) {
          return;
        }

        const rect = event.currentTarget.getBoundingClientRect();

        onContextMenu?.({
          coordinates: coordinate,
          position: {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          },
        });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }

        dragRef.current = {
          center: viewStateRef.current.center,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          zoom: viewStateRef.current.zoom,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;

        if (!drag || drag.pointerId !== event.pointerId) {
          return;
        }

        onViewStateChange(
          constrainWebGlFlatViewState(
            panWebGlFlatViewState(drag.center, drag.zoom, event.clientX - drag.x, event.clientY - drag.y),
            containerRef.current,
            { maxBounds, maxZoom },
          ),
          "pan",
        );
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          dragRef.current = null;
        }
      }}
      onWheel={(event) => {
        event.preventDefault();
        onViewStateChange(
          constrainWebGlFlatViewState(
            {
              ...viewStateRef.current,
              zoom: getWebGlFlatZoom(viewStateRef.current.zoom, event.deltaY, maxZoom),
            },
            containerRef.current,
            { maxBounds, maxZoom },
          ),
          "zoom",
        );
      }}
    />
  );
}

export function resolveWebGlFlatTileSource(
  mapStyle: RasterMapStyle,
): WebGlFlatTileSource | null {
  const resolvedStyle = resolveMapLibreStyle(mapStyle);

  if (typeof resolvedStyle === "string") {
    return {
      maxZoom: FLAT_TILE_DEFAULT_MAX_ZOOM,
      minZoom: FLAT_TILE_DEFAULT_MIN_ZOOM,
      tileSize: DEFAULT_TILE_SIZE,
      url: resolvedStyle,
    };
  }

  const rasterSource = Object.values(resolvedStyle.sources ?? {}).find(
    (source) => source && typeof source === "object" && "type" in source && source.type === "raster",
  ) as { maxzoom?: number; minzoom?: number; tileSize?: number; tiles?: string[] } | undefined;
  const url = rasterSource?.tiles?.[0];

  return url
    ? {
        maxZoom: rasterSource.maxzoom ?? FLAT_TILE_DEFAULT_MAX_ZOOM,
        minZoom: rasterSource.minzoom ?? FLAT_TILE_DEFAULT_MIN_ZOOM,
        tileSize: rasterSource.tileSize ?? DEFAULT_TILE_SIZE,
        url,
      }
    : null;
}

export function getWebGlFlatViewport(
  viewState: MapViewState,
  size: { height: number; width: number },
): WebGlFlatViewport {
  return {
    bounds: getWebGlFlatViewportBounds(viewState, size),
    center: viewState.center,
    height: size.height,
    width: size.width,
    zoom: viewState.zoom,
  };
}

export function getWebGlFlatViewportBounds(
  viewState: MapViewState,
  size: { height: number; width: number },
): [west: number, south: number, east: number, north: number] {
  const centerWorld = coordinateToWebGlFlatWorldPoint(viewState.center, viewState.zoom);
  const westNorth = webGlFlatWorldPointToCoordinate(
    {
      x: centerWorld.x - size.width / 2,
      y: centerWorld.y - size.height / 2,
    },
    viewState.zoom,
  );
  const eastSouth = webGlFlatWorldPointToCoordinate(
    {
      x: centerWorld.x + size.width / 2,
      y: centerWorld.y + size.height / 2,
    },
    viewState.zoom,
  );

  return [westNorth[0], eastSouth[1], eastSouth[0], westNorth[1]];
}

export function getVisibleWebGlFlatTiles(
  viewport: WebGlFlatViewport,
  source: WebGlFlatTileSource,
  maxTiles = FLAT_TILE_MAX_VISIBLE_TILES,
): WebGlFlatTile[] {
  const tileZoom = clamp(Math.floor(viewport.zoom), source.minZoom, source.maxZoom);
  const scale = 2 ** tileZoom;
  const center = coordinateToTilePoint(viewport.center, tileZoom);
  const tileScale = source.tileSize * 2 ** (viewport.zoom - tileZoom);
  const halfColumns = viewport.width / tileScale / 2;
  const halfRows = viewport.height / tileScale / 2;
  const minX = Math.floor(center.x - halfColumns) - 1;
  const maxX = Math.floor(center.x + halfColumns) + 1;
  const minY = clamp(Math.floor(center.y - halfRows) - 1, 0, scale - 1);
  const maxY = clamp(Math.floor(center.y + halfRows) + 1, 0, scale - 1);
  const tiles: WebGlFlatTile[] = [];
  const keys = new Set<string>();

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (tiles.length >= maxTiles) {
        return tiles;
      }

      const wrappedX = wrapTileX(x, tileZoom);
      const key = `${tileZoom}/${wrappedX}/${y}`;

      if (keys.has(key)) {
        continue;
      }

      keys.add(key);
      tiles.push({
        bounds: [
          tileXToLongitude(wrappedX, tileZoom),
          tileYToLatitude(y + 1, tileZoom),
          tileXToLongitude(wrappedX + 1, tileZoom),
          tileYToLatitude(y, tileZoom),
        ],
        key,
        x: wrappedX,
        y,
        z: tileZoom,
      });
    }
  }

  return tiles;
}

export function buildWebGlFlatTileUrl(source: WebGlFlatTileSource, tile: WebGlFlatTile) {
  return source.url
    .replaceAll("{z}", String(tile.z))
    .replaceAll("{x}", String(tile.x))
    .replaceAll("{y}", String(tile.y))
    .replaceAll("{s}", "a");
}

export function coordinateToWebGlFlatWorldPoint(
  [longitude, latitude]: [longitude: number, latitude: number],
  zoom: number,
  tileSize = DEFAULT_TILE_SIZE,
) {
  const scale = tileSize * 2 ** zoom;
  const safeLatitude = clamp(latitude, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE);
  const latitudeRadians = safeLatitude * DEG_TO_RAD;

  return {
    x: ((normalizeLongitude(longitude) + 180) / 360) * scale,
    y:
      ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) /
        2) *
      scale,
  };
}

export function webGlFlatWorldPointToCoordinate(
  point: { x: number; y: number },
  zoom: number,
  tileSize = DEFAULT_TILE_SIZE,
): [longitude: number, latitude: number] {
  const scale = tileSize * 2 ** zoom;
  const longitude = (point.x / scale) * 360 - 180;
  const value = Math.PI * (1 - (2 * point.y) / scale);
  const latitude = Math.atan(Math.sinh(value)) * RAD_TO_DEG;

  return [normalizeLongitude(longitude), clamp(latitude, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE)];
}

export function panWebGlFlatViewState(
  center: [longitude: number, latitude: number],
  zoom: number,
  deltaX: number,
  deltaY: number,
): MapViewState {
  const centerWorld = coordinateToWebGlFlatWorldPoint(center, zoom);

  return {
    center: webGlFlatWorldPointToCoordinate(
      {
        x: centerWorld.x - deltaX,
        y: centerWorld.y - deltaY,
      },
      zoom,
    ),
    zoom,
  };
}

export function getWebGlFlatZoom(currentZoom: number, deltaY: number, maxZoom?: number) {
  const effectiveMaxZoom =
    typeof maxZoom === "number" && Number.isFinite(maxZoom)
      ? clamp(maxZoom, MIN_FLAT_ZOOM, MAX_FLAT_ZOOM)
      : MAX_FLAT_ZOOM;

  return clamp(currentZoom - deltaY * 0.0025, MIN_FLAT_ZOOM, effectiveMaxZoom);
}

export function getWebGlFlatBoundsMinZoom(
  bounds: MapBounds,
  size: { height: number; width: number },
) {
  const westNorth = coordinateToWebGlFlatWorldPoint([bounds[0], bounds[3]], 0);
  const eastSouth = coordinateToWebGlFlatWorldPoint([bounds[2], bounds[1]], 0);
  const worldWidth = Math.max(1e-6, eastSouth.x - westNorth.x);
  const worldHeight = Math.max(1e-6, eastSouth.y - westNorth.y);
  const scale = Math.max(size.width / worldWidth, size.height / worldHeight);

  return clamp(Math.log2(scale), MIN_FLAT_ZOOM, MAX_FLAT_ZOOM);
}

function constrainWebGlFlatViewState(
  viewState: MapViewState,
  container: HTMLDivElement | null,
  options: {
    maxBounds?: MapBounds;
    maxZoom?: number;
  },
) {
  const bounds = normalizeMapBounds(options.maxBounds);
  const size = container ? getContainerSize(container) : { height: 0, width: 0 };
  const minZoom = bounds && size.height > 0 && size.width > 0
    ? getWebGlFlatBoundsMinZoom(bounds, size)
    : undefined;
  const constrained = constrainMapViewState(viewState, {
    maxBounds: bounds,
    maxZoom: options.maxZoom,
    minZoom,
  });

  if (!bounds || size.height <= 0 || size.width <= 0) {
    return constrained;
  }

  return constrainWebGlFlatViewStateToBounds(constrained, bounds, size);
}

function constrainWebGlFlatViewStateToBounds(
  viewState: MapViewState,
  bounds: MapBounds,
  size: { height: number; width: number },
): MapViewState {
  const westNorth = coordinateToWebGlFlatWorldPoint([bounds[0], bounds[3]], viewState.zoom);
  const eastSouth = coordinateToWebGlFlatWorldPoint([bounds[2], bounds[1]], viewState.zoom);
  const center = coordinateToWebGlFlatWorldPoint(viewState.center, viewState.zoom);
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const minCenterX = westNorth.x + halfWidth;
  const maxCenterX = eastSouth.x - halfWidth;
  const minCenterY = westNorth.y + halfHeight;
  const maxCenterY = eastSouth.y - halfHeight;
  const x = minCenterX <= maxCenterX
    ? clamp(center.x, minCenterX, maxCenterX)
    : (westNorth.x + eastSouth.x) / 2;
  const y = minCenterY <= maxCenterY
    ? clamp(center.y, minCenterY, maxCenterY)
    : (westNorth.y + eastSouth.y) / 2;
  const nextCenter = webGlFlatWorldPointToCoordinate({ x, y }, viewState.zoom);

  return nextCenter[0] === viewState.center[0] && nextCenter[1] === viewState.center[1]
    ? viewState
    : {
        ...viewState,
        center: nextCenter,
      };
}

function createWebGlFlatRuntime({
  container,
  mapStyle,
  viewState,
}: {
  container: HTMLDivElement;
  mapStyle: RasterMapStyle;
  viewState: MapViewState;
}) {
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;
  let animationFrame = 0;
  let currentMapStyle = mapStyle;
  let currentViewState = viewState;
  let size = getContainerSize(container);
  let tileState: WebGlFlatTileState | null = null;
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          resize();
          scheduleRender();
        });

  resizeObserver?.observe(container);

  if (typeof WebGLRenderingContext !== "undefined") {
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: "high-performance",
      });
      renderer.setClearColor(0xffffff, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = "mb-maps__webgl-flat-canvas";
      container.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(0, size.width, size.height, 0, -1000, 1000);
      camera.position.set(0, 0, 1);
      tileState = createWebGlFlatTileState({
        scene,
        scheduleRender,
      });
      resize();
    } catch {
      renderer = null;
      scene = null;
      camera = null;
    }
  }

  function resize() {
    size = getContainerSize(container);

    if (!renderer || !camera) {
      return;
    }

    camera.left = -size.width / 2;
    camera.right = size.width / 2;
    camera.top = size.height / 2;
    camera.bottom = -size.height / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(size.width, size.height, false);
  }

  function renderNow() {
    if (!renderer || !scene || !camera || !tileState) {
      return;
    }

    const source = resolveWebGlFlatTileSource(currentMapStyle);
    const viewport = getWebGlFlatViewport(currentViewState, size);

    syncWebGlFlatTileMeshes({
      source,
      state: tileState,
      viewport,
    });
    renderer.render(scene, camera);
  }

  function scheduleRender() {
    if (animationFrame) {
      cancelFrame(animationFrame);
    }

    animationFrame = scheduleFrame(() => {
      animationFrame = 0;
      renderNow();
    });
  }

  return {
    destroy() {
      resizeObserver?.disconnect();
      if (animationFrame) {
        cancelFrame(animationFrame);
      }
      tileState?.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
    },
    render: scheduleRender,
    setMapStyle(nextMapStyle: RasterMapStyle) {
      currentMapStyle = nextMapStyle;
    },
    setViewState(nextViewState: MapViewState) {
      currentViewState = nextViewState;
    },
  };
}

type WebGlFlatTileState = {
  activeLoads: number;
  cache: Map<string, THREE.Texture>;
  dispose: () => void;
  meshes: Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>;
  pending: Set<string>;
  queue: Array<{ source: WebGlFlatTileSource; tile: WebGlFlatTile; viewport: WebGlFlatViewport }>;
  scene: THREE.Scene;
  scheduleRender: () => void;
  sourceUrl: string | null;
  visibleKeys: Set<string>;
};

function createWebGlFlatTileState({
  scene,
  scheduleRender,
}: {
  scene: THREE.Scene;
  scheduleRender: () => void;
}): WebGlFlatTileState {
  const state: WebGlFlatTileState = {
    activeLoads: 0,
    cache: new Map(),
    dispose() {
      clearWebGlFlatTileMeshes(state);
      for (const texture of state.cache.values()) {
        texture.dispose();
      }
      state.cache.clear();
      state.pending.clear();
      state.queue = [];
      state.visibleKeys.clear();
    },
    meshes: new Map(),
    pending: new Set(),
    queue: [],
    scene,
    scheduleRender,
    sourceUrl: null,
    visibleKeys: new Set(),
  };

  return state;
}

function syncWebGlFlatTileMeshes({
  source,
  state,
  viewport,
}: {
  source: WebGlFlatTileSource | null;
  state: WebGlFlatTileState;
  viewport: WebGlFlatViewport;
}) {
  if (state.sourceUrl !== (source?.url ?? null)) {
    clearWebGlFlatTileMeshes(state);
    for (const texture of state.cache.values()) {
      texture.dispose();
    }
    state.cache.clear();
    state.pending.clear();
    state.queue = [];
    state.sourceUrl = source?.url ?? null;
  }

  const tiles = source ? getVisibleWebGlFlatTiles(viewport, source) : [];
  const visibleKeys = new Set(tiles.map((tile) => tile.key));

  state.visibleKeys = visibleKeys;

  for (const [key, mesh] of state.meshes) {
    if (!visibleKeys.has(key)) {
      state.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      state.meshes.delete(key);
      continue;
    }

    updateWebGlFlatTileMesh(mesh, key, viewport);
  }

  if (!source) {
    state.queue = [];
    state.pending.clear();
    return;
  }

  for (const tile of tiles) {
    if (state.meshes.has(tile.key)) {
      continue;
    }

    const cachedTexture = state.cache.get(tile.key);

    if (cachedTexture) {
      markWebGlFlatTextureUsed(state, tile.key, cachedTexture);
      addWebGlFlatTileMesh(state, tile, cachedTexture, viewport);
      continue;
    }

    enqueueWebGlFlatTileLoad(state, source, tile, viewport);
  }

  pumpWebGlFlatTileLoads(state);
  pruneWebGlFlatTextureCache(state);
}

function enqueueWebGlFlatTileLoad(
  state: WebGlFlatTileState,
  source: WebGlFlatTileSource,
  tile: WebGlFlatTile,
  viewport: WebGlFlatViewport,
) {
  if (state.pending.has(tile.key)) {
    return;
  }

  state.pending.add(tile.key);
  state.queue.push({ source, tile, viewport });
}

function pumpWebGlFlatTileLoads(state: WebGlFlatTileState) {
  while (state.activeLoads < FLAT_TILE_LOAD_CONCURRENCY && state.queue.length > 0) {
    const next = state.queue.shift();

    if (!next) {
      return;
    }

    state.activeLoads += 1;
    const textureLoader = new THREE.TextureLoader();

    textureLoader.setCrossOrigin("anonymous");
    textureLoader.load(
      buildWebGlFlatTileUrl(next.source, next.tile),
      (texture) => {
        state.activeLoads -= 1;
        state.pending.delete(next.tile.key);

        if (state.sourceUrl !== next.source.url) {
          texture.dispose();
          pumpWebGlFlatTileLoads(state);
          return;
        }

        texture.colorSpace = THREE.SRGBColorSpace;
        markWebGlFlatTextureUsed(state, next.tile.key, texture);

        if (state.visibleKeys.has(next.tile.key) && !state.meshes.has(next.tile.key)) {
          addWebGlFlatTileMesh(state, next.tile, texture, next.viewport);
          state.scheduleRender();
        }

        pumpWebGlFlatTileLoads(state);
        pruneWebGlFlatTextureCache(state);
      },
      undefined,
      () => {
        state.activeLoads -= 1;
        state.pending.delete(next.tile.key);
        pumpWebGlFlatTileLoads(state);
      },
    );
  }
}

function addWebGlFlatTileMesh(
  state: WebGlFlatTileState,
  tile: WebGlFlatTile,
  texture: THREE.Texture,
  viewport: WebGlFlatViewport,
) {
  const geometry = createWebGlFlatTileGeometry(tile, viewport);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);

  mesh.userData.tileKey = tile.key;
  state.scene.add(mesh);
  state.meshes.set(tile.key, mesh);
}

function updateWebGlFlatTileMesh(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
  key: string,
  viewport: WebGlFlatViewport,
) {
  const [z, x, y] = key.split("/").map(Number);

  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }

  const tile: WebGlFlatTile = {
    bounds: [
      tileXToLongitude(x, z),
      tileYToLatitude(y + 1, z),
      tileXToLongitude(x + 1, z),
      tileYToLatitude(y, z),
    ],
    key,
    x,
    y,
    z,
  };

  mesh.geometry.dispose();
  mesh.geometry = createWebGlFlatTileGeometry(tile, viewport);
}

function createWebGlFlatTileGeometry(tile: WebGlFlatTile, viewport: WebGlFlatViewport) {
  const centerWorld = coordinateToWebGlFlatWorldPoint(viewport.center, viewport.zoom);
  const northWest = coordinateToWebGlFlatWorldPoint([tile.bounds[0], tile.bounds[3]], viewport.zoom);
  const southEast = coordinateToWebGlFlatWorldPoint([tile.bounds[2], tile.bounds[1]], viewport.zoom);
  const x0 = northWest.x - centerWorld.x;
  const x1 = southEast.x - centerWorld.x;
  const y0 = -(northWest.y - centerWorld.y);
  const y1 = -(southEast.y - centerWorld.y);
  const vertices = [
    x0,
    y1,
    0,
    x1,
    y1,
    0,
    x1,
    y0,
    0,
    x0,
    y0,
    0,
  ];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  return geometry;
}

function clearWebGlFlatTileMeshes(state: WebGlFlatTileState) {
  for (const mesh of state.meshes.values()) {
    state.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  state.meshes.clear();
}

function markWebGlFlatTextureUsed(state: WebGlFlatTileState, key: string, texture: THREE.Texture) {
  state.cache.delete(key);
  state.cache.set(key, texture);
}

function pruneWebGlFlatTextureCache(state: WebGlFlatTileState) {
  while (state.cache.size > FLAT_TILE_TEXTURE_CACHE_SIZE) {
    const oldestKey = state.cache.keys().next().value;

    if (!oldestKey) {
      return;
    }

    if (state.meshes.has(oldestKey)) {
      markWebGlFlatTextureUsed(state, oldestKey, state.cache.get(oldestKey)!);
      continue;
    }

    state.cache.get(oldestKey)?.dispose();
    state.cache.delete(oldestKey);
  }
}

function getPointerCoordinate(
  container: HTMLDivElement | null,
  event: { clientX: number; clientY: number },
  viewState: MapViewState,
) {
  if (!container) {
    return null;
  }

  const rect = container.getBoundingClientRect();
  const centerWorld = coordinateToWebGlFlatWorldPoint(viewState.center, viewState.zoom);

  return webGlFlatWorldPointToCoordinate(
    {
      x: centerWorld.x + event.clientX - rect.left - rect.width / 2,
      y: centerWorld.y + event.clientY - rect.top - rect.height / 2,
    },
    viewState.zoom,
  );
}

function getContainerSize(container: HTMLElement) {
  const rect = container.getBoundingClientRect();

  return {
    height: Math.max(1, Math.round(rect.height || container.clientHeight || 1)),
    width: Math.max(1, Math.round(rect.width || container.clientWidth || 1)),
  };
}

function scheduleFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }

  return window.setTimeout(callback, 0);
}

function cancelFrame(id: number) {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }

  window.clearTimeout(id);
}

function coordinateToTilePoint(
  coordinate: [longitude: number, latitude: number],
  zoom: number,
) {
  const world = coordinateToWebGlFlatWorldPoint(coordinate, zoom, 1);

  return {
    x: world.x,
    y: world.y,
  };
}

function tileXToLongitude(x: number, zoom: number) {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileYToLatitude(y: number, zoom: number) {
  const value = Math.PI * (1 - (2 * y) / 2 ** zoom);

  return Math.atan(Math.sinh(value)) * RAD_TO_DEG;
}

function wrapTileX(x: number, zoom: number) {
  const scale = 2 ** zoom;

  return ((x % scale) + scale) % scale;
}

function normalizeLongitude(longitude: number) {
  if (!Number.isFinite(longitude)) {
    return 0;
  }

  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
