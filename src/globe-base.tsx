"use client";

import { useEffect, useMemo, useRef } from "react";
import { geoOrthographic, geoPath } from "d3-geo";
import type { GeoPermissibleObjects } from "d3-geo";
import * as THREE from "three";
import { feature, mesh } from "topojson-client";
import worldTopology from "world-atlas/countries-110m.json";

import {
  createGlobeGraticuleLines,
  createVisibleSvgPath,
  getGlobeRadius,
  getGlobeSphereRotation,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  resolveTileLayerOptions,
  type GlobeBasemapMode,
  type GlobeViewState,
  type RasterMapStyle,
} from "./map-display";

export const GLOBE_TILE_MIN_ZOOM = 4;
const GLOBE_TILE_DEFAULT_MAX_TILE_ZOOM = 10;
const GLOBE_TILE_MAX_VISIBLE_TILES = 48;
const GLOBE_TILE_TEXTURE_CACHE_SIZE = 96;
const GLOBE_TILE_LOAD_CONCURRENCY = 6;
const GLOBE_TILE_PATCH_SEGMENTS = 8;
const GLOBE_TILE_RADIUS_OFFSET = 1.003;
const MERCATOR_MAX_LATITUDE = 85.05112878;
const DEG_TO_RAD = Math.PI / 180;

const globeLand = feature(worldTopology, worldTopology.objects.land) as GeoPermissibleObjects;
const globeCountryBorders = mesh(
  worldTopology,
  worldTopology.objects.countries,
  (left, right) => left !== right,
) as GeoPermissibleObjects;

export type GlobeBasemapPaths = {
  countryBorderPath: string;
  landPath: string;
};

export type GlobeTileSource = {
  maxZoom: number;
  minZoom: number;
  tileSize: number;
  url: string;
};

export type GlobeTile = {
  bounds: [west: number, south: number, east: number, north: number];
  key: string;
  x: number;
  y: number;
  z: number;
};

export function GlobeBase({
  basemapMode = "vector",
  mapStyle,
  viewState,
}: {
  basemapMode?: GlobeBasemapMode;
  mapStyle: string | RasterMapStyle;
  viewState: GlobeViewState;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderSchedulerRef = useRef<ReturnType<typeof createGlobeRenderScheduler> | null>(null);
  const basemapModeRef = useRef(basemapMode);
  const mapStyleRef = useRef(mapStyle);
  const viewStateRef = useRef(viewState);

  basemapModeRef.current = basemapMode;
  mapStyleRef.current = mapStyle;
  viewStateRef.current = viewState;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    if (typeof WebGLRenderingContext === "undefined") {
      return;
    }

    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }

    renderer.setClearAlpha(0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "mb-maps__globe-canvas";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(
      -GLOBE_VIEWBOX_WIDTH / 2,
      GLOBE_VIEWBOX_WIDTH / 2,
      GLOBE_VIEWBOX_HEIGHT / 2,
      -GLOBE_VIEWBOX_HEIGHT / 2,
      0.1,
      2000,
    );

    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);

    const material = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0,
      roughness: 0.72,
    });
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      material,
    );

    scene.add(sphere);
    const tileGroup = new THREE.Group();
    scene.add(tileGroup);
    scene.add(new THREE.AmbientLight(0xffffff, 1.9));

    const tileState = createGlobeTileState({
      group: tileGroup,
      scheduleRender: () => {
        renderSchedulerRef.current?.scheduleRender();
      },
    });

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(-280, 320, 700);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x8bd3ff, 0.9);
    rimLight.position.set(500, -180, 420);
    scene.add(rimLight);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const aspect = width / height;
      const viewBoxAspect = GLOBE_VIEWBOX_WIDTH / GLOBE_VIEWBOX_HEIGHT;
      let frustumWidth = GLOBE_VIEWBOX_WIDTH;
      let frustumHeight = GLOBE_VIEWBOX_HEIGHT;

      if (aspect > viewBoxAspect) {
        frustumWidth = GLOBE_VIEWBOX_HEIGHT * aspect;
      } else {
        frustumHeight = GLOBE_VIEWBOX_WIDTH / aspect;
      }

      camera.left = -frustumWidth / 2;
      camera.right = frustumWidth / 2;
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      renderSchedulerRef.current?.scheduleRender();
    };

    const resizeObserver = new ResizeObserver(resize);

    resizeObserver.observe(container);

    const render = () => {
      const current = viewStateRef.current;
      const radius = getGlobeRadius(current.zoom);

      camera.position.set(0, 0, radius + 1000);
      camera.near = 1;
      camera.far = radius * 2 + 2000;
      camera.updateProjectionMatrix();
      sphere.scale.setScalar(radius);
      tileGroup.scale.setScalar(radius);
      const rotation = getGlobeSphereRotation(current);
      sphere.rotation.set(rotation.x, rotation.y, rotation.z);
      tileGroup.rotation.set(rotation.x, rotation.y, rotation.z);
      syncGlobeTileMeshes({
        basemapMode: basemapModeRef.current,
        mapStyle: mapStyleRef.current,
        state: tileState,
        viewState: current,
      });
      renderer.render(scene, camera);
    };

    const renderScheduler = createGlobeRenderScheduler(render);

    renderSchedulerRef.current = renderScheduler;
    resize();
    renderScheduler.scheduleRender();

    return () => {
      renderScheduler.cancel();
      renderSchedulerRef.current = null;
      tileState.dispose();
      resizeObserver.disconnect();
      sphere.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    viewStateRef.current = viewState;
    renderSchedulerRef.current?.scheduleRender();
  }, [viewState.center[0], viewState.center[1], viewState.zoom]);

  useEffect(() => {
    basemapModeRef.current = basemapMode;
    mapStyleRef.current = mapStyle;
    renderSchedulerRef.current?.scheduleRender();
  }, [basemapMode, mapStyle]);

  return <div aria-hidden="true" className="mb-maps__globe-renderer" ref={containerRef} />;
}

export function GlobeSvgOverlayBase({
  showVectorBasemap = true,
  viewState,
}: {
  showVectorBasemap?: boolean;
  viewState: GlobeViewState;
}) {
  const radius = getGlobeRadius(viewState.zoom);
  const basemapPaths = useMemo(
    () => createGlobeBasemapPaths(viewState),
    [viewState.center[0], viewState.center[1], viewState.zoom],
  );
  const graticulePaths = useMemo(
    () =>
      createGlobeGraticuleLines(viewState)
        .map(createVisibleSvgPath)
        .filter((path): path is string => Boolean(path)),
    [viewState.center[0], viewState.center[1], viewState.zoom],
  );

  return (
    <>
      {showVectorBasemap ? (
        <>
          <g className="mb-maps__globe-land">
            <path d={basemapPaths.landPath} />
          </g>
          <path className="mb-maps__globe-country-borders" d={basemapPaths.countryBorderPath} />
        </>
      ) : null}
      <g className="mb-maps__globe-graticule">
        {graticulePaths.map((path, index) => (
          <path d={path} key={index} />
        ))}
      </g>
      <circle
        className="mb-maps__globe-rim"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
    </>
  );
}

export function createGlobeRenderScheduler(render: () => void) {
  let animationFrame = 0;

  return {
    cancel() {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    },
    scheduleRender() {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }

      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        render();
      });
    },
  };
}

export function resolveGlobeTileSource(mapStyle: string | RasterMapStyle): GlobeTileSource | null {
  const tileLayerOptions = resolveTileLayerOptions(mapStyle);

  if (!tileLayerOptions) {
    return null;
  }

  return {
    maxZoom:
      typeof tileLayerOptions.options.maxZoom === "number"
        ? tileLayerOptions.options.maxZoom
        : GLOBE_TILE_DEFAULT_MAX_TILE_ZOOM,
    minZoom: typeof tileLayerOptions.options.minZoom === "number" ? tileLayerOptions.options.minZoom : 0,
    tileSize: typeof tileLayerOptions.options.tileSize === "number" ? tileLayerOptions.options.tileSize : 256,
    url: tileLayerOptions.url,
  };
}

export function getGlobeTileZoom(viewState: GlobeViewState, source: GlobeTileSource) {
  return clamp(Math.floor(viewState.zoom + 1), source.minZoom, source.maxZoom);
}

export function getVisibleGlobeTiles(
  viewState: GlobeViewState,
  source: GlobeTileSource,
  maxTiles = GLOBE_TILE_MAX_VISIBLE_TILES,
): GlobeTile[] {
  if (viewState.zoom < GLOBE_TILE_MIN_ZOOM) {
    return [];
  }

  let tileZoom = getGlobeTileZoom(viewState, source);

  while (tileZoom >= source.minZoom) {
    const tiles = createVisibleGlobeTilesAtZoom(viewState, tileZoom);

    if (tiles.length <= maxTiles || tileZoom === source.minZoom) {
      return tiles.slice(0, maxTiles);
    }

    tileZoom -= 1;
  }

  return [];
}

export function buildGlobeTileUrl(source: GlobeTileSource, tile: GlobeTile) {
  return source.url
    .replaceAll("{z}", String(tile.z))
    .replaceAll("{x}", String(tile.x))
    .replaceAll("{y}", String(tile.y))
    .replaceAll("{s}", "a");
}

export function createGlobeBasemapPaths(viewState: GlobeViewState): GlobeBasemapPaths {
  const path = geoPath(createGlobeBasemapProjection(viewState));

  return {
    countryBorderPath: path(globeCountryBorders) ?? "",
    landPath: path(globeLand) ?? "",
  };
}

export function projectGlobeBasemapCoordinate(
  coordinate: [longitude: number, latitude: number],
  viewState: GlobeViewState,
) {
  return createGlobeBasemapProjection(viewState)(coordinate);
}

function createGlobeBasemapProjection(viewState: GlobeViewState) {
  return geoOrthographic()
    .scale(getGlobeRadius(viewState.zoom))
    .translate([GLOBE_VIEWBOX_WIDTH / 2, GLOBE_VIEWBOX_HEIGHT / 2])
    .rotate([-viewState.center[0], -viewState.center[1]])
    .clipAngle(90)
    .precision(0.25);
}

type GlobeTileState = {
  activeLoads: number;
  cache: Map<string, THREE.Texture>;
  dispose: () => void;
  group: THREE.Group;
  meshes: Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>;
  pending: Set<string>;
  queue: Array<{ source: GlobeTileSource; tile: GlobeTile }>;
  scheduleRender: () => void;
  sourceUrl: string | null;
  visibleKeys: Set<string>;
};

function createGlobeTileState({
  group,
  scheduleRender,
}: {
  group: THREE.Group;
  scheduleRender: () => void;
}): GlobeTileState {
  const state: GlobeTileState = {
    activeLoads: 0,
    cache: new Map(),
    dispose() {
      clearGlobeTileMeshes(state);
      for (const texture of state.cache.values()) {
        texture.dispose();
      }
      state.cache.clear();
      state.pending.clear();
      state.queue = [];
      state.visibleKeys.clear();
    },
    group,
    meshes: new Map(),
    pending: new Set(),
    queue: [],
    scheduleRender,
    sourceUrl: null,
    visibleKeys: new Set(),
  };

  return state;
}

function syncGlobeTileMeshes({
  basemapMode,
  mapStyle,
  state,
  viewState,
}: {
  basemapMode: GlobeBasemapMode;
  mapStyle: string | RasterMapStyle;
  state: GlobeTileState;
  viewState: GlobeViewState;
}) {
  const source = basemapMode === "tiles" ? resolveGlobeTileSource(mapStyle) : null;

  if (state.sourceUrl !== (source?.url ?? null)) {
    clearGlobeTileMeshes(state);
    for (const texture of state.cache.values()) {
      texture.dispose();
    }
    state.cache.clear();
    state.pending.clear();
    state.queue = [];
    state.sourceUrl = source?.url ?? null;
  }

  const tiles = source ? getVisibleGlobeTiles(viewState, source) : [];
  const visibleKeys = new Set(tiles.map((tile) => tile.key));

  state.visibleKeys = visibleKeys;

  for (const [key, mesh] of state.meshes) {
    if (!visibleKeys.has(key)) {
      state.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      state.meshes.delete(key);
    }
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
      markGlobeTileTextureUsed(state, tile.key, cachedTexture);
      addGlobeTileMesh(state, tile, cachedTexture);
      continue;
    }

    enqueueGlobeTileLoad(state, source, tile);
  }

  pumpGlobeTileLoads(state);
  pruneGlobeTileTextureCache(state);
}

function enqueueGlobeTileLoad(state: GlobeTileState, source: GlobeTileSource, tile: GlobeTile) {
  if (state.pending.has(tile.key)) {
    return;
  }

  state.pending.add(tile.key);
  state.queue.push({ source, tile });
}

function pumpGlobeTileLoads(state: GlobeTileState) {
  while (state.activeLoads < GLOBE_TILE_LOAD_CONCURRENCY && state.queue.length > 0) {
    const next = state.queue.shift();

    if (!next) {
      return;
    }

    state.activeLoads += 1;
    const textureLoader = new THREE.TextureLoader();

    textureLoader.setCrossOrigin("anonymous");
    textureLoader.load(
      buildGlobeTileUrl(next.source, next.tile),
      (texture) => {
        state.activeLoads -= 1;
        state.pending.delete(next.tile.key);

        if (state.sourceUrl !== next.source.url) {
          texture.dispose();
          pumpGlobeTileLoads(state);
          return;
        }

        texture.colorSpace = THREE.SRGBColorSpace;
        markGlobeTileTextureUsed(state, next.tile.key, texture);

        if (state.visibleKeys.has(next.tile.key) && !state.meshes.has(next.tile.key)) {
          addGlobeTileMesh(state, next.tile, texture);
          state.scheduleRender();
        }

        pumpGlobeTileLoads(state);
        pruneGlobeTileTextureCache(state);
      },
      undefined,
      () => {
        state.activeLoads -= 1;
        state.pending.delete(next.tile.key);
        pumpGlobeTileLoads(state);
      },
    );
  }
}

function addGlobeTileMesh(state: GlobeTileState, tile: GlobeTile, texture: THREE.Texture) {
  const geometry = createGlobeTilePatchGeometry(tile);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);

  state.group.add(mesh);
  state.meshes.set(tile.key, mesh);
}

function clearGlobeTileMeshes(state: GlobeTileState) {
  for (const mesh of state.meshes.values()) {
    state.group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  state.meshes.clear();
}

function markGlobeTileTextureUsed(state: GlobeTileState, key: string, texture: THREE.Texture) {
  state.cache.delete(key);
  state.cache.set(key, texture);
}

function pruneGlobeTileTextureCache(state: GlobeTileState) {
  while (state.cache.size > GLOBE_TILE_TEXTURE_CACHE_SIZE) {
    const oldestKey = state.cache.keys().next().value;

    if (!oldestKey) {
      return;
    }

    if (state.meshes.has(oldestKey)) {
      markGlobeTileTextureUsed(state, oldestKey, state.cache.get(oldestKey)!);
      continue;
    }

    state.cache.get(oldestKey)?.dispose();
    state.cache.delete(oldestKey);
  }
}

function createVisibleGlobeTilesAtZoom(viewState: GlobeViewState, tileZoom: number): GlobeTile[] {
  const radius = getGlobeRadius(viewState.zoom);
  const longitudeSpan = clamp((GLOBE_VIEWBOX_WIDTH * 70 * 1.35) / radius, 1, 360);
  const latitudeSpan = clamp((GLOBE_VIEWBOX_HEIGHT * 70 * 1.35) / radius, 1, 170);
  const scale = 2 ** tileZoom;
  const centerX = ((normalizeLongitude(viewState.center[0]) + 180) / 360) * scale;
  const halfX = (longitudeSpan / 360) * scale * 0.5;
  const minX = Math.floor(centerX - halfX);
  const maxX = Math.floor(centerX + halfX);
  const north = clamp(viewState.center[1] + latitudeSpan / 2, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE);
  const south = clamp(viewState.center[1] - latitudeSpan / 2, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE);
  const minY = clamp(Math.floor(latitudeToTileY(north, tileZoom)), 0, scale - 1);
  const maxY = clamp(Math.floor(latitudeToTileY(south, tileZoom)), 0, scale - 1);
  const tiles: GlobeTile[] = [];
  const keys = new Set<string>();

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
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

function createGlobeTilePatchGeometry(tile: GlobeTile) {
  const [west, south, east, north] = tile.bounds;
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= GLOBE_TILE_PATCH_SEGMENTS; row += 1) {
    const v = row / GLOBE_TILE_PATCH_SEGMENTS;
    const latitude = north + (south - north) * v;

    for (let column = 0; column <= GLOBE_TILE_PATCH_SEGMENTS; column += 1) {
      const u = column / GLOBE_TILE_PATCH_SEGMENTS;
      const longitude = west + (east - west) * u;
      const point = globeCoordinateToVector(longitude, latitude, GLOBE_TILE_RADIUS_OFFSET);

      vertices.push(point.x, point.y, point.z);
      uvs.push(u, 1 - v);
    }
  }

  const rowSize = GLOBE_TILE_PATCH_SEGMENTS + 1;

  for (let row = 0; row < GLOBE_TILE_PATCH_SEGMENTS; row += 1) {
    for (let column = 0; column < GLOBE_TILE_PATCH_SEGMENTS; column += 1) {
      const a = row * rowSize + column;
      const b = a + 1;
      const c = a + rowSize;
      const d = c + 1;

      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

function globeCoordinateToVector(longitude: number, latitude: number, radius: number) {
  const longitudeRadians = longitude * DEG_TO_RAD;
  const latitudeRadians = latitude * DEG_TO_RAD;
  const cosLatitude = Math.cos(latitudeRadians);

  return new THREE.Vector3(
    radius * cosLatitude * Math.cos(longitudeRadians),
    radius * Math.sin(latitudeRadians),
    radius * cosLatitude * Math.sin(longitudeRadians),
  );
}

function latitudeToTileY(latitude: number, zoom: number) {
  const latitudeRadians = clamp(latitude, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE) * DEG_TO_RAD;

  return (
    ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) *
    2 ** zoom
  );
}

function tileXToLongitude(x: number, zoom: number) {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileYToLatitude(y: number, zoom: number) {
  const value = Math.PI * (1 - (2 * y) / 2 ** zoom);

  return (Math.atan(Math.sinh(value)) / DEG_TO_RAD);
}

function wrapTileX(x: number, zoom: number) {
  const scale = 2 ** zoom;

  return ((x % scale) + scale) % scale;
}

function normalizeLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
