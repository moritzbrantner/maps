"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, LineString, Polygon } from "geojson";
import type { MapsRasterTileId } from "../src/flat-runtime-wasm";
import { decodeShortbreadBasemap, type ShortbreadBasemapTile } from "../src/vector-tile-wasm";

import { POLYGON_PAINT_ORDER, type ShortbreadFeatureProperties } from "./shortbread-style";
export { getShortbreadBasemapStyle, type ShortbreadFeatureProperties } from "./shortbread-style";

const SHORTBREAD_TILE_URL = "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt";
const SHORTBREAD_MAX_ZOOM = 14;
const SHORTBREAD_CACHE_CAPACITY = 64;
const SHORTBREAD_LOAD_CONCURRENCY = 8;
const SHORTBREAD_ACCEPT =
  "application/vnd.mapbox-vector-tile,application/x-protobuf,application/octet-stream;q=0.9,*/*;q=0.1";

type TileState =
  | { status: "idle" | "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "error"; error: string };

export function useShortbreadBasemap(visibleTilesInput: readonly MapsRasterTileId[]) {
  const enabled = useMemo(shouldEnableShortbreadBasemap, []);
  const cacheRef = useRef(new Map<string, ShortbreadBasemapTile>());
  const inflightRef = useRef(new Map<string, AbortController>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [tileState, setTileState] = useState<TileState>({ status: "idle", error: null });

  const visibleTiles = useMemo(
    () => normalizeShortbreadTiles(visibleTilesInput),
    [visibleTilesInput],
  );
  const visibleTileKey = visibleTiles.map((tile) => tile.key).join("|");

  useEffect(() => {
    if (!enabled || visibleTiles.length === 0) {
      return;
    }

    const visibleKeys = new Set(visibleTiles.map((tile) => tile.key));
    for (const [key, controller] of inflightRef.current) {
      if (!visibleKeys.has(key)) {
        controller.abort();
        inflightRef.current.delete(key);
      }
    }

    pruneShortbreadCache(cacheRef.current, visibleKeys);

    let started = false;
    let availableSlots = Math.max(0, SHORTBREAD_LOAD_CONCURRENCY - inflightRef.current.size);
    for (const tile of visibleTiles) {
      if (availableSlots === 0) break;
      if (cacheRef.current.has(tile.key) || inflightRef.current.has(tile.key)) {
        continue;
      }

      started = true;
      availableSlots -= 1;
      const controller = new AbortController();
      inflightRef.current.set(tile.key, controller);

      void loadShortbreadTile(tile, controller.signal)
        .then((basemapTile) => {
          inflightRef.current.delete(tile.key);
          if (controller.signal.aborted) return;
          cacheRef.current.set(tile.key, basemapTile);
          setCacheVersion((version) => version + 1);
          setTileState({ status: "ready", error: null });
        })
        .catch((error) => {
          inflightRef.current.delete(tile.key);
          if (controller.signal.aborted) return;
          setTileState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    if (started) {
      setTileState({ status: "loading", error: null });
    }
  }, [cacheVersion, enabled, visibleTileKey]);

  useEffect(
    () => () => {
      for (const controller of inflightRef.current.values()) {
        controller.abort();
      }
      inflightRef.current.clear();
    },
    [],
  );

  const featureCollection = useMemo(() => {
    const features: FeatureCollection<
      Polygon | LineString,
      ShortbreadFeatureProperties
    >["features"] = [];
    for (const kind of POLYGON_PAINT_ORDER) {
      for (const tile of visibleTiles) {
        const polygons = cacheRef.current.get(tile.key)?.polygons ?? [];
        for (const [index, polygon] of polygons.entries()) {
          if (polygon.kind !== kind) continue;
          features.push({
            geometry: { coordinates: polygon.rings, type: "Polygon" },
            id: `${tile.key}:polygon:${index}`,
            properties: { kind, sourceKind: polygon.sourceKind },
            type: "Feature",
          });
        }
      }
    }
    for (const tile of visibleTiles) {
      const lines = cacheRef.current.get(tile.key)?.lines ?? [];
      for (const [index, line] of lines.entries()) {
        features.push({
          geometry: {
            coordinates: line.coordinates,
            type: "LineString" as const,
          },
          id: `${tile.key}:line:${index}`,
          properties: { kind: line.kind, sourceKind: null },
          type: "Feature" as const,
        });
      }
    }

    return {
      features,
      type: "FeatureCollection" as const,
    };
  }, [cacheVersion, visibleTileKey]);

  return {
    enabled,
    error: tileState.error,
    featureCollection,
    state: tileState.status,
    tileCount: visibleTiles.length,
  };
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

  return decodeShortbreadBasemap(bytes, tile);
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
  cache: Map<string, ShortbreadBasemapTile>,
  visibleKeys: ReadonlySet<string>,
) {
  while (cache.size > SHORTBREAD_CACHE_CAPACITY) {
    const candidate =
      [...cache.keys()].find((key) => !visibleKeys.has(key)) ?? cache.keys().next().value;
    if (candidate === undefined) return;
    cache.delete(candidate);
  }
}

function ancestorTile(tile: MapsRasterTileId, z: number): MapsRasterTileId {
  const scale = 2 ** (tile.z - z);
  const x = Math.floor(tile.x / scale);
  const y = Math.floor(tile.y / scale);
  return { key: `${z}/${x}/${y}`, x, y, z };
}

function shouldEnableShortbreadBasemap() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return !params.has("e2e") || params.get("vectorTiles") === "fixture";
}
