"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MapsCanvasFlatRuntimeController } from "../src/canvas-flat-runtime";
import type { MapsRasterTileId } from "../src/flat-runtime-wasm";
import {
  decodeShortbreadBasemapLines,
  type ShortbreadBasemapLine,
  type ShortbreadBasemapLineKind,
} from "../src/vector-tile-wasm";

const SHORTBREAD_TILE_URL = "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt";
const SHORTBREAD_MAX_ZOOM = 14;
const SHORTBREAD_CACHE_CAPACITY = 64;
const SHORTBREAD_LOAD_CONCURRENCY = 8;
const SHORTBREAD_ACCEPT =
  "application/vnd.mapbox-vector-tile,application/x-protobuf,application/octet-stream;q=0.9,*/*;q=0.1";

type ShortbreadFeatureProperties = {
  kind: ShortbreadBasemapLineKind;
};

type ShortbreadController = Pick<
  MapsCanvasFlatRuntimeController,
  "evictShortbreadTile" | "uploadShortbreadTile"
>;

type CachedShortbreadTile =
  | {
      lines: null;
      renderPath: "wgpu-tile";
      segmentCount: number;
    }
  | {
      lines: ShortbreadBasemapLine[];
      renderPath: "geojson-fallback";
      segmentCount: number;
    };

type TileState =
  | { status: "idle" | "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "error"; error: string };

export function useShortbreadBasemap(
  visibleTilesInput: readonly MapsRasterTileId[],
  controller: ShortbreadController | null,
) {
  const enabled = useMemo(shouldEnableShortbreadBasemap, []);
  const cacheRef = useRef(new Map<string, CachedShortbreadTile>());
  const inflightRef = useRef(new Map<string, AbortController>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [tileState, setTileState] = useState<TileState>({ status: "idle", error: null });

  const visibleTiles = useMemo(
    () => normalizeShortbreadTiles(visibleTilesInput),
    [visibleTilesInput],
  );
  const visibleTileKey = visibleTiles.map((tile) => tile.key).join("|");

  useEffect(() => {
    cacheRef.current.clear();
    setCacheVersion((version) => version + 1);

    return () => {
      for (const key of cacheRef.current.keys()) {
        controller?.evictShortbreadTile(key);
      }
      cacheRef.current.clear();
    };
  }, [controller]);

  useEffect(() => {
    if (!enabled || visibleTiles.length === 0 || !controller) {
      return;
    }

    const visibleKeys = new Set(visibleTiles.map((tile) => tile.key));
    for (const [key, active] of inflightRef.current) {
      if (!visibleKeys.has(key)) {
        active.abort();
        inflightRef.current.delete(key);
      }
    }

    pruneShortbreadCache(cacheRef.current, visibleKeys, controller);

    let started = false;
    let availableSlots = Math.max(0, SHORTBREAD_LOAD_CONCURRENCY - inflightRef.current.size);
    for (const tile of visibleTiles) {
      if (availableSlots === 0) break;
      if (cacheRef.current.has(tile.key) || inflightRef.current.has(tile.key)) {
        continue;
      }

      started = true;
      availableSlots -= 1;
      const abort = new AbortController();
      inflightRef.current.set(tile.key, abort);

      void loadShortbreadTile(tile, abort.signal)
        .then(async (bytes) => {
          inflightRef.current.delete(tile.key);
          if (abort.signal.aborted) return;

          const gpuSegmentCount = controller.uploadShortbreadTile(tile, bytes);
          if (gpuSegmentCount !== null) {
            cacheRef.current.set(tile.key, {
              lines: null,
              renderPath: "wgpu-tile",
              segmentCount: gpuSegmentCount,
            });
          } else {
            const lines = await decodeShortbreadBasemapLines(bytes, tile);
            if (abort.signal.aborted) return;
            cacheRef.current.set(tile.key, {
              lines,
              renderPath: "geojson-fallback",
              segmentCount: countLineSegments(lines),
            });
          }

          setCacheVersion((version) => version + 1);
          setTileState({ status: "ready", error: null });
        })
        .catch((error) => {
          inflightRef.current.delete(tile.key);
          if (abort.signal.aborted) return;
          setTileState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    if (started) {
      setTileState({ status: "loading", error: null });
    }
  }, [cacheVersion, controller, enabled, visibleTileKey]);

  useEffect(
    () => () => {
      for (const active of inflightRef.current.values()) {
        active.abort();
      }
      inflightRef.current.clear();
    },
    [],
  );

  const visibleCacheEntries = useMemo(
    () =>
      visibleTiles
        .map((tile) => [tile, cacheRef.current.get(tile.key)] as const)
        .filter(
          (
            entry,
          ): entry is readonly [MapsRasterTileId, CachedShortbreadTile] =>
            entry[1] !== undefined,
        ),
    [cacheVersion, visibleTileKey],
  );

  const featureCollection = useMemo(() => {
    const features = [];
    for (const [tile, cached] of visibleCacheEntries) {
      if (!cached.lines) continue;
      for (const [index, line] of cached.lines.entries()) {
        features.push({
          geometry: {
            coordinates: line.coordinates,
            type: "LineString" as const,
          },
          id: `${tile.key}:${line.kind}:${index}`,
          properties: { kind: line.kind },
          type: "Feature" as const,
        });
      }
    }

    return {
      features,
      type: "FeatureCollection" as const,
    };
  }, [visibleCacheEntries]);

  const segmentCount = visibleCacheEntries.reduce(
    (sum, [, cached]) => sum + cached.segmentCount,
    0,
  );
  const renderPath = visibleCacheEntries.some(
    ([, cached]) => cached.renderPath === "geojson-fallback",
  )
    ? "geojson-fallback"
    : visibleCacheEntries.length > 0
      ? "wgpu-tile"
      : "pending";

  return {
    enabled,
    error: tileState.error,
    featureCollection,
    renderPath,
    segmentCount,
    state: tileState.status,
    tileCount: visibleTiles.length,
  };
}

export function getShortbreadBasemapStyle(kind: ShortbreadBasemapLineKind) {
  return shortbreadStyle(kind);
}

async function loadShortbreadTile(tile: MapsRasterTileId, signal: AbortSignal) {
  const response = await fetch(buildShortbreadUrl(tile), {
    headers: {
      Accept: SHORTBREAD_ACCEPT,
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Shortbread vector tile request failed with HTTP ${response.status}: ${tile.key}`,
    );
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`Shortbread vector tile response was empty: ${tile.key}`);
  }
  return bytes;
}

function buildShortbreadUrl(tile: MapsRasterTileId) {
  return SHORTBREAD_TILE_URL.replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

function normalizeShortbreadTiles(tiles: readonly MapsRasterTileId[]) {
  const unique = new Map<string, MapsRasterTileId>();

  for (const tile of tiles) {
    const normalized =
      tile.z <= SHORTBREAD_MAX_ZOOM ? tile : ancestorTile(tile, SHORTBREAD_MAX_ZOOM);
    unique.set(normalized.key, normalized);
  }

  return [...unique.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function pruneShortbreadCache(
  cache: Map<string, CachedShortbreadTile>,
  visibleKeys: ReadonlySet<string>,
  controller: ShortbreadController,
) {
  while (cache.size > SHORTBREAD_CACHE_CAPACITY) {
    const candidate =
      [...cache.keys()].find((key) => !visibleKeys.has(key)) ?? cache.keys().next().value;
    if (candidate === undefined) return;
    cache.delete(candidate);
    controller.evictShortbreadTile(candidate);
  }
}

function ancestorTile(tile: MapsRasterTileId, z: number): MapsRasterTileId {
  const scale = 2 ** (tile.z - z);
  const x = Math.floor(tile.x / scale);
  const y = Math.floor(tile.y / scale);
  return { key: `${z}/${x}/${y}`, x, y, z };
}

function countLineSegments(lines: readonly ShortbreadBasemapLine[]) {
  return lines.reduce((sum, line) => sum + Math.max(0, line.coordinates.length - 1), 0);
}

function shortbreadStyle(kind: ShortbreadBasemapLineKind) {
  switch (kind) {
    case "coast":
      return { lineColor: "#4f93b8", lineOpacity: 0.95, lineWidth: 1.5 };
    case "water":
      return { lineColor: "#6ba9c9", lineOpacity: 0.9, lineWidth: 1.2 };
    case "boundary":
      return { lineColor: "#b27188", lineOpacity: 0.75, lineWidth: 1 };
    case "street":
      return { lineColor: "#9a8c7d", lineOpacity: 0.72, lineWidth: 0.9 };
  }
}

function shouldEnableShortbreadBasemap() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return !params.has("e2e") || params.get("vectorTiles") === "fixture";
}
