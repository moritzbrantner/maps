"use client";

import type { MapPoint } from "./aggregation";
import type { GeoJsonMapSource } from "./geojson-source";
import {
  type MapLibreMapStyle,
  toLatLng as toFlatLatLng,
  toLngLat,
  toMapLibreBounds,
} from "./maplibre-compat";

export type MapDisplayMode = "flat" | "globe";

export type MapViewState = {
  center: [longitude: number, latitude: number];
  zoom: number;
};

export type MapBounds = [west: number, south: number, east: number, north: number];

export type MapFitBoundsOptions = {
  animate?: boolean;
  durationMs?: number;
  maxZoom?: number;
  padding?: number;
};

export type MapFlyToOptions = {
  animate?: boolean;
  durationMs?: number;
};

export type MapViewStateChangeReason =
  | "initial"
  | "fit-to-data"
  | "fit-bounds"
  | "fly-to"
  | "pan"
  | "zoom"
  | "cluster-expand"
  | "prop-change"
  | "programmatic";

export type MapViewStateChangeContext = {
  display: MapDisplayMode;
  reason: MapViewStateChangeReason;
};

/**
 * Shared viewport contract for convenience maps and MapView.
 *
 * Pass `viewState` with `onViewStateChange` for a controlled viewport. Pass
 * `defaultViewState` for an uncontrolled initial viewport; `initialViewState`
 * remains as the legacy alias.
 */
export type MapViewportProps = {
  viewState?: MapViewState;
  defaultViewState?: MapViewState;
  /**
   * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
   */
  initialViewState?: MapViewState;
  maxBounds?: MapBounds;
  maxZoom?: number;
  onViewStateChange?: (
    viewState: MapViewState,
    context: MapViewStateChangeContext,
  ) => void;
};

export type MapSurfaceController = {
  display: MapDisplayMode;
  fitToData: () => void;
  fitBounds: (bounds: MapBounds, options?: MapFitBoundsOptions) => void;
  fitPoints: <TProperties>(
    points: readonly MapPoint<TProperties>[],
    options?: MapFitBoundsOptions,
  ) => void;
  fitGeoJson: <TProperties extends Record<string, unknown>>(
    source: GeoJsonMapSource<TProperties>,
    options?: MapFitBoundsOptions,
  ) => void;
  flyTo: (viewState: MapViewState, options?: MapFlyToOptions) => void;
  getViewState: () => MapViewState;
  setViewState: (viewState: MapViewState, reason?: MapViewStateChangeReason) => void;
};

export type { MapLibreMapStyle };
export type LegacyRasterMapStyle = {
  attribution?: string;
  maxZoom?: number;
  minZoom?: number;
  tileSize?: number;
  tiles?: string | readonly string[] | false;
} & Record<string, unknown>;
export type RasterMapStyle = MapLibreMapStyle | LegacyRasterMapStyle;
export const defaultMapLibreStyle = {
  sources: {
    osm: {
      attribution: "\u00a9 OpenStreetMap contributors",
      tileSize: 256,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      type: "raster",
    },
  },
  layers: [
    {
      id: "osm-raster",
      source: "osm",
      type: "raster",
    },
  ],
  version: 8,
} satisfies Exclude<MapLibreMapStyle, string>;

export const defaultRasterMapStyle: RasterMapStyle = defaultMapLibreStyle;

export function getMapBoundsCenter(bounds: MapBounds): [longitude: number, latitude: number] {
  return [
    normalizeLongitude((bounds[0] + bounds[2]) / 2),
    clampLatitude((bounds[1] + bounds[3]) / 2),
  ];
}

export function padMapBounds(bounds: MapBounds, paddingDegrees: number): MapBounds {
  const padding = Number.isFinite(paddingDegrees) ? Math.max(0, paddingDegrees) : 0;

  return [
    normalizeLongitude(bounds[0] - padding),
    clampLatitude(bounds[1] - padding),
    normalizeLongitude(bounds[2] + padding),
    clampLatitude(bounds[3] + padding),
  ];
}

export function mergeMapBounds(
  ...boundsList: Array<MapBounds | null | undefined>
): MapBounds | null {
  const validBounds = boundsList.filter(isValidMapBounds);

  if (validBounds.length === 0) {
    return null;
  }

  return validBounds.reduce(
    (merged, bounds) => [
      Math.min(merged[0], bounds[0]),
      Math.min(merged[1], bounds[1]),
      Math.max(merged[2], bounds[2]),
      Math.max(merged[3], bounds[3]),
    ] as MapBounds,
    validBounds[0]!,
  );
}

export function constrainMapViewState(
  viewState: MapViewState,
  options: {
    maxBounds?: MapBounds | null;
    maxZoom?: number;
    minZoom?: number;
  },
): MapViewState {
  const maxZoom = normalizeMapMaxZoom(options.maxZoom);
  const minZoom = normalizeMapMinZoom(options.minZoom);
  const maxBounds = normalizeMapBounds(options.maxBounds);
  const effectiveMaxZoom =
    maxZoom === undefined || (minZoom !== undefined && maxZoom < minZoom) ? undefined : maxZoom;
  const zoom =
    effectiveMaxZoom === undefined
      ? Math.max(minZoom ?? Number.NEGATIVE_INFINITY, viewState.zoom)
      : clamp(viewState.zoom, minZoom ?? Number.NEGATIVE_INFINITY, effectiveMaxZoom);
  const center = maxBounds ? constrainMapCenterToBounds(viewState.center, maxBounds) : viewState.center;

  if (viewState.zoom === zoom && center === viewState.center) {
    return viewState;
  }

  return {
    ...viewState,
    center,
    zoom,
  };
}

export function normalizeMapMaxZoom(maxZoom?: number) {
  return typeof maxZoom === "number" && Number.isFinite(maxZoom) ? Math.max(0, maxZoom) : undefined;
}

export function normalizeMapMinZoom(minZoom?: number) {
  return typeof minZoom === "number" && Number.isFinite(minZoom) ? Math.max(0, minZoom) : undefined;
}

export function normalizeMapBounds(bounds?: MapBounds | null): MapBounds | null {
  if (!bounds) {
    return null;
  }

  const [west, south, east, north] = bounds;

  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  ) {
    return null;
  }

  return [
    Math.min(west, east),
    clamp(Math.min(south, north), -90, 90),
    Math.max(west, east),
    clamp(Math.max(south, north), -90, 90),
  ];
}

export function constrainMapCenterToBounds(
  center: [longitude: number, latitude: number],
  bounds: MapBounds,
) {
  const longitude = clamp(center[0], bounds[0], bounds[2]);
  const latitude = clamp(center[1], bounds[1], bounds[3]);

  return longitude === center[0] && latitude === center[1]
    ? center
    : ([longitude, latitude] as [longitude: number, latitude: number]);
}

export function toLatLng([longitude, latitude]: [number, number]) {
  return toFlatLatLng([longitude, latitude]);
}

export { toLngLat, toMapLibreBounds };

export function resolveTileLayerOptions(mapStyle: RasterMapStyle): {
  options: {
    attribution?: string;
    maxZoom?: number;
    minZoom?: number;
    tileSize?: number;
  };
  url: string;
} | null {
  const resolvedStyle = resolveMapLibreStyle(mapStyle);

  if (typeof resolvedStyle === "string") {
    return { options: {}, url: resolvedStyle };
  }

  const rasterSource = Object.values(resolvedStyle.sources ?? {}).find(
    (source) => source && typeof source === "object" && "type" in source && source.type === "raster",
  ) as
    | {
        attribution?: string;
        maxzoom?: number;
        minzoom?: number;
        tileSize?: number;
        tiles?: string[];
      }
    | undefined;
  const url = rasterSource?.tiles?.[0];

  return url
    ? {
        options: {
          attribution: rasterSource.attribution,
          maxZoom: rasterSource.maxzoom,
          minZoom: rasterSource.minzoom,
          tileSize: rasterSource.tileSize,
        },
        url,
      }
    : null;
}

export function resolveMapLibreStyle(mapStyle: RasterMapStyle): MapLibreMapStyle {
  if (typeof mapStyle === "string" || "version" in mapStyle) {
    return mapStyle as MapLibreMapStyle;
  }

  const tiles = mapStyle.tiles ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const url = Array.isArray(tiles) ? tiles[0] : tiles;

  if (tiles === false || !url) {
    return {
      layers: [],
      sources: {},
      version: 8,
    };
  }

  return {
    layers: [
      {
        id: "legacy-raster",
        source: "legacy-raster",
        type: "raster",
      },
    ],
    sources: {
      "legacy-raster": {
        attribution: mapStyle.attribution,
        maxzoom: mapStyle.maxZoom,
        minzoom: mapStyle.minZoom,
        tileSize: mapStyle.tileSize,
        tiles: [url],
        type: "raster",
      },
    },
    version: 8,
  };
}

export function resolveMapLibreDisplayStyle(
  mapStyle: RasterMapStyle,
  display: MapDisplayMode,
): MapLibreMapStyle {
  const resolvedStyle = resolveMapLibreStyle(mapStyle);

  if (display !== "globe" || typeof resolvedStyle === "string") {
    return resolvedStyle;
  }

  const style = {
    ...resolvedStyle,
    layers: [...(resolvedStyle.layers ?? [])],
    sources: { ...resolvedStyle.sources },
  } as Record<string, unknown>;

  style.projection = { type: "globe" };
  style.sky ??= {
    "atmosphere-blend": [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      1,
      5,
      1,
      7,
      0,
    ],
  };

  return style as Exclude<MapLibreMapStyle, string>;
}

export function joinClassNames(...values: Array<string | undefined | false>) {
  return values.filter(Boolean).join(" ");
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isValidMapBounds(bounds: MapBounds | null | undefined): bounds is MapBounds {
  return Boolean(bounds?.every((value) => Number.isFinite(value)));
}

function normalizeLongitude(longitude: number) {
  if (!Number.isFinite(longitude)) {
    return 0;
  }

  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function clampLatitude(latitude: number) {
  return clamp(latitude, -82, 82);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
