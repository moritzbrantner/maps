"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, LineString, Polygon } from "geojson";
import type { MapsRasterTileId } from "../src/flat-runtime-wasm";
import type { GeoJsonLayerStyle } from "../src/geojson-layer";
import type {
  MapsCanvasFlatRuntimeController,
  MapsRetainedVectorBasemap,
} from "../src/maps-browser-runtime";
import {
  createMapsVectorBasemapStyleTable,
  type MapsVectorBasemapClassStyle,
  type MapsVectorBasemapStyleClass,
} from "../src/vector-basemap";
import { decodeShortbreadBasemap, type ShortbreadBasemapTile } from "../src/vector-tile-wasm";

import {
  POLYGON_PAINT_ORDER,
  getShortbreadBasemapStyle,
  type ShortbreadFeatureProperties,
} from "./shortbread-style";
export { getShortbreadBasemapStyle, type ShortbreadFeatureProperties } from "./shortbread-style";

export const SHORTBREAD_TILE_URL = "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt";
export const SHORTBREAD_MAX_ZOOM = 14;
const SHORTBREAD_CACHE_CAPACITY = 64;
const SHORTBREAD_LOAD_CONCURRENCY = 8;
const SHORTBREAD_ACCEPT =
  "application/vnd.mapbox-vector-tile,application/x-protobuf,application/octet-stream;q=0.9,*/*;q=0.1";

/** How the basemap reaches pixels: retained WebGPU buckets or the Canvas GeoJSON overlay. */
export type ShortbreadBasemapRenderer = "wgpu-retained" | "canvas-overlay" | "pending";

type TileState =
  | { status: "idle" | "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "error"; error: string };

type ShortbreadBasemapController = Pick<
  MapsCanvasFlatRuntimeController,
  "getRetainedVectorBasemap" | "subscribeBaseRenderer"
>;

export type ShortbreadBasemapOptions = {
  /** Map controller; with the WebGPU backend the basemap bypasses the GeoJSON overlay. */
  controller?: ShortbreadBasemapController | null;
  /** Force the Canvas GeoJSON overlay even when WebGPU is available (comparison). */
  forceOverlay?: boolean;
  /** Per-class style overrides applied on top of the Shortbread demo style. */
  styleOverride?: (
    styleClass: MapsVectorBasemapStyleClass,
    style: MapsVectorBasemapClassStyle,
  ) => MapsVectorBasemapClassStyle;
  tileUrl?: string;
};

export function useShortbreadBasemap(
  visibleTilesInput: readonly MapsRasterTileId[],
  {
    controller = null,
    forceOverlay = false,
    styleOverride,
    tileUrl = SHORTBREAD_TILE_URL,
  }: ShortbreadBasemapOptions = {},
) {
  const enabled = useMemo(shouldEnableShortbreadBasemap, []);
  const bytesRef = useRef(new Map<string, ArrayBuffer>());
  const decodedRef = useRef(new Map<string, ShortbreadBasemapTile>());
  const decodingRef = useRef(new Set<string>());
  const uploadedRef = useRef(
    new Map<string, { buildMs: number; features: number; tile: MapsRasterTileId }>(),
  );
  const retainedOwnerRef = useRef<MapsRetainedVectorBasemap | null>(null);
  const inflightRef = useRef(new Map<string, AbortController>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [decodedVersion, setDecodedVersion] = useState(0);
  const [uploadedVersion, setUploadedVersion] = useState(0);
  const [tileState, setTileState] = useState<TileState>({ status: "idle", error: null });
  const retained = useRetainedVectorBasemap(controller, forceOverlay);
  const overlay = !retained && (controller !== null || forceOverlay);

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

    pruneShortbreadCache(bytesRef.current, visibleKeys);
    for (const key of decodedRef.current.keys()) {
      if (!bytesRef.current.has(key)) decodedRef.current.delete(key);
    }

    let started = false;
    let availableSlots = Math.max(0, SHORTBREAD_LOAD_CONCURRENCY - inflightRef.current.size);
    for (const tile of visibleTiles) {
      if (availableSlots === 0) break;
      if (bytesRef.current.has(tile.key) || inflightRef.current.has(tile.key)) {
        continue;
      }

      started = true;
      availableSlots -= 1;
      const controller = new AbortController();
      inflightRef.current.set(tile.key, controller);

      void loadShortbreadTile(tileUrl, tile, controller.signal)
        .then((bytes) => {
          inflightRef.current.delete(tile.key);
          if (controller.signal.aborted) return;
          bytesRef.current.set(tile.key, bytes);
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
  }, [cacheVersion, enabled, tileUrl, visibleTileKey]);

  useEffect(
    () => () => {
      for (const controller of inflightRef.current.values()) {
        controller.abort();
      }
      inflightRef.current.clear();
    },
    [],
  );

  // WebGPU: Rust decodes and tessellates each tile once; the GPU retains it until the
  // tile leaves the cache. No GeoJSON, no per-frame projection or path stroking.
  useEffect(() => {
    const uploaded = uploadedRef.current;
    const previous = retainedOwnerRef.current;
    retainedOwnerRef.current = retained;
    if (previous && previous !== retained && uploaded.size > 0) {
      // Switching to the overlay or another renderer: the previous handle must stop drawing
      // its tiles, or they would be composited under the replacement.
      for (const entry of uploaded.values()) {
        try {
          previous.evictTile(entry.tile);
        } catch {
          // A disposed renderer already released its tiles.
        }
      }
      uploaded.clear();
      setUploadedVersion((version) => version + 1);
    }
    if (!retained) return;
    let changed = false;
    for (const [key, entry] of uploaded) {
      if (!bytesRef.current.has(key)) {
        retained.evictTile(entry.tile);
        uploaded.delete(key);
        changed = true;
      }
    }
    for (const tile of visibleTiles) {
      const bytes = bytesRef.current.get(tile.key);
      if (!bytes || uploaded.has(tile.key)) continue;
      try {
        const started = performance.now();
        const features = retained.uploadTile(tile, new Uint8Array(bytes));
        uploaded.set(tile.key, { buildMs: performance.now() - started, features, tile });
        changed = true;
      } catch (error) {
        setTileState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (changed) setUploadedVersion((version) => version + 1);
  }, [cacheVersion, retained, visibleTileKey]);

  useEffect(() => {
    retained?.setStyle(createShortbreadStyleTable(styleOverride));
  }, [retained, styleOverride]);

  // Canvas fallback: decode to geographic GeoJSON for the overlay renderer.
  useEffect(() => {
    if (!overlay || !enabled) return;
    for (const tile of visibleTiles) {
      const bytes = bytesRef.current.get(tile.key);
      if (!bytes || decodedRef.current.has(tile.key) || decodingRef.current.has(tile.key)) {
        continue;
      }
      decodingRef.current.add(tile.key);
      void decodeShortbreadBasemap(bytes, tile)
        .then((decoded) => {
          if (bytesRef.current.get(tile.key) !== bytes) return;
          decodedRef.current.set(tile.key, decoded);
          setDecodedVersion((version) => version + 1);
        })
        .catch((error) => {
          setTileState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => decodingRef.current.delete(tile.key));
    }
  }, [cacheVersion, enabled, overlay, visibleTileKey]);

  const featureCollection = useMemo(() => {
    const features: FeatureCollection<
      Polygon | LineString,
      ShortbreadFeatureProperties
    >["features"] = [];
    if (!overlay) {
      return { features, type: "FeatureCollection" as const };
    }
    for (const kind of POLYGON_PAINT_ORDER) {
      for (const tile of visibleTiles) {
        const polygons = decodedRef.current.get(tile.key)?.polygons ?? [];
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
      const lines = decodedRef.current.get(tile.key)?.lines ?? [];
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
  }, [decodedVersion, overlay, visibleTileKey]);

  const featureCount = retained
    ? visibleTiles.reduce(
        (count, tile) => count + (uploadedRef.current.get(tile.key)?.features ?? 0),
        0,
      )
    : featureCollection.features.length;
  void uploadedVersion;
  const builds = [...uploadedRef.current.values()].map((entry) => entry.buildMs);

  const renderer: ShortbreadBasemapRenderer = retained
    ? "wgpu-retained"
    : overlay
      ? "canvas-overlay"
      : "pending";

  return {
    /** Main-thread ms per retained tile: Rust decode + tessellation + GPU upload. */
    buildMs: builds,
    enabled,
    error: tileState.error,
    featureCollection,
    featureCount,
    renderer,
    state: tileState.status,
    tileCount: visibleTiles.length,
  };
}

/** The controller's retained vector basemap, following base-renderer changes. */
function useRetainedVectorBasemap(
  controller: ShortbreadBasemapController | null,
  forceOverlay: boolean,
): MapsRetainedVectorBasemap | null {
  const [retained, setRetained] = useState<MapsRetainedVectorBasemap | null>(null);
  useEffect(() => {
    if (!controller || forceOverlay) {
      setRetained(null);
      return;
    }
    const read = () => {
      try {
        setRetained(controller.getRetainedVectorBasemap());
      } catch {
        setRetained(null);
      }
    };
    read();
    return controller.subscribeBaseRenderer(read);
  }, [controller, forceOverlay]);
  return retained;
}

/** The same Shortbread style as `getShortbreadBasemapStyle`, per retained style class. */
export function getShortbreadClassStyle(
  styleClass: MapsVectorBasemapStyleClass,
): MapsVectorBasemapClassStyle {
  const fill = (style: GeoJsonLayerStyle) => ({
    color: style.polygonFillColor ?? "#000000",
    opacity: style.polygonFillOpacity ?? 1,
  });
  const line = (style: GeoJsonLayerStyle) => ({
    color: style.lineColor ?? "#000000",
    opacity: style.lineOpacity ?? 1,
    width: style.lineWidth ?? 1,
  });
  switch (styleClass) {
    case "ocean":
    case "land":
    case "site":
    case "water":
    case "building":
      return fill(getShortbreadBasemapStyle(styleClass));
    case "land-forest":
      return fill(getShortbreadBasemapStyle("land", "forest"));
    case "water-glacier":
      return fill(getShortbreadBasemapStyle("water", "glacier"));
    case "building-outline": {
      const building = getShortbreadBasemapStyle("building");
      return {
        color: building.polygonStrokeColor ?? "#000000",
        opacity: 1,
        width: building.polygonStrokeWidth ?? 0,
      };
    }
    case "water-line":
      return line(getShortbreadBasemapStyle("water"));
    case "coast":
    case "street":
    case "boundary":
      return line(getShortbreadBasemapStyle(styleClass));
  }
}

function createShortbreadStyleTable(override: ShortbreadBasemapOptions["styleOverride"]) {
  return createMapsVectorBasemapStyleTable((styleClass) => {
    const style = getShortbreadClassStyle(styleClass);
    return override ? override(styleClass, style) : style;
  });
}

async function loadShortbreadTile(tileUrl: string, tile: MapsRasterTileId, signal: AbortSignal) {
  const response = await fetch(buildShortbreadUrl(tileUrl, tile), {
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

function buildShortbreadUrl(tileUrl: string, tile: MapsRasterTileId) {
  return tileUrl
    .replace("{z}", String(tile.z))
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

function pruneShortbreadCache(cache: Map<string, unknown>, visibleKeys: ReadonlySet<string>) {
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
