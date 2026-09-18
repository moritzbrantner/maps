"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { GeoJsonLayer } from "@moritzbrantner/maps";
import { MapSurfaceContext } from "../src/map-view";
import type { MapsRasterTileId } from "../src/flat-runtime-wasm";
import {
  decodeShortbreadBasemapLines,
  type ShortbreadBasemapLine,
  type ShortbreadBasemapLineKind,
} from "../src/vector-tile-wasm";

const SHORTBREAD_TILE_URL = "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt";
const SHORTBREAD_MAX_ZOOM = 14;
const SHORTBREAD_ACCEPT =
  "application/vnd.mapbox-vector-tile,application/x-protobuf,application/octet-stream;q=0.9,*/*;q=0.1";

type ShortbreadFeatureProperties = {
  kind: ShortbreadBasemapLineKind;
};

type TileState =
  | { status: "idle" | "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "error"; error: string };

export function ShortbreadBasemapLayer() {
  const surface = useContext(MapSurfaceContext);
  const enabled = useMemo(shouldEnableShortbreadBasemap, []);
  const cacheRef = useRef(new Map<string, ShortbreadBasemapLine[]>());
  const inflightRef = useRef(new Map<string, AbortController>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [tileState, setTileState] = useState<TileState>({ status: "idle", error: null });

  const visibleTiles = useMemo(
    () => normalizeShortbreadTiles(surface?.getVisibleTiles?.() ?? []),
    [
      surface,
      surface?.viewState.center[0],
      surface?.viewState.center[1],
      surface?.viewState.zoom,
      surface?.viewState.bearing,
      surface?.viewState.pitch,
    ],
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

    let started = false;
    for (const tile of visibleTiles) {
      if (cacheRef.current.has(tile.key) || inflightRef.current.has(tile.key)) {
        continue;
      }

      started = true;
      const controller = new AbortController();
      inflightRef.current.set(tile.key, controller);

      void loadShortbreadTile(tile, controller.signal)
        .then((lines) => {
          inflightRef.current.delete(tile.key);
          if (controller.signal.aborted) return;
          cacheRef.current.set(tile.key, lines);
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
  }, [enabled, visibleTileKey]);

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
    const features = [];
    for (const tile of visibleTiles) {
      const lines = cacheRef.current.get(tile.key) ?? [];
      for (const [index, line] of lines.entries()) {
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
  }, [cacheVersion, visibleTileKey]);

  if (!enabled) {
    return null;
  }

  return (
    <>
      <span
        aria-hidden="true"
        data-shortbread-error={tileState.error ?? undefined}
        data-shortbread-feature-count={featureCollection.features.length}
        data-shortbread-state={tileState.status}
        data-shortbread-tile-count={visibleTiles.length}
        hidden
      />
      <GeoJsonLayer<ShortbreadFeatureProperties>
        featureCollection={featureCollection}
        getFeatureStyle={(feature) => shortbreadStyle(feature.properties.kind)}
        isFeatureInteractive={() => false}
        layerId="shortbread-basemap"
      />
    </>
  );
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

  return decodeShortbreadBasemapLines(bytes, tile);
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

function ancestorTile(tile: MapsRasterTileId, z: number): MapsRasterTileId {
  const scale = 2 ** (tile.z - z);
  const x = Math.floor(tile.x / scale);
  const y = Math.floor(tile.y / scale);
  return { key: `${z}/${x}/${y}`, x, y, z };
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
