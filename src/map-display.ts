"use client";

import type { TileLayerOptions } from "leaflet";

import { getBoundsFromPoints, type MapPoint } from "./aggregation";
import type { MapCoordinate } from "./measurement";

export type MapDisplayMode = "flat" | "globe";

export type MapViewState = {
  center: [longitude: number, latitude: number];
  zoom: number;
};

export type MapViewStateChangeReason =
  | "initial"
  | "fit-to-data"
  | "pan"
  | "zoom"
  | "cluster-expand"
  | "prop-change"
  | "programmatic";

export type MapViewStateChangeContext = {
  display: MapDisplayMode;
  reason: MapViewStateChangeReason;
};

export type MapViewportProps = {
  viewState?: MapViewState;
  defaultViewState?: MapViewState;
  initialViewState?: MapViewState;
  onViewStateChange?: (
    viewState: MapViewState,
    context: MapViewStateChangeContext,
  ) => void;
};

export type MapSurfaceController = {
  display: MapDisplayMode;
  fitToData: () => void;
  getViewState: () => MapViewState;
  setViewState: (viewState: MapViewState, reason?: MapViewStateChangeReason) => void;
};

export type RasterMapStyle = {
  attribution?: string;
  maxZoom?: number;
  minZoom?: number;
  tileSize?: number;
  tiles?: string | readonly string[] | false;
} & Record<string, unknown>;

export type GlobeViewState = {
  center: [longitude: number, latitude: number];
  zoom: number;
};

export type GlobeProjectionResult = {
  scale: number;
  visible: boolean;
  x: number;
  y: number;
};

export const GLOBE_VIEWBOX_HEIGHT = 480;
export const GLOBE_VIEWBOX_WIDTH = 960;
export const defaultRasterMapStyle: RasterMapStyle = {
  attribution: "\u00a9 OpenStreetMap contributors",
  tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileSize: 256,
};

const DEG_TO_RAD = Math.PI / 180;

export function createInitialGlobeViewState<TProperties = Record<string, unknown>>({
  fitToData,
  initialViewState,
  points,
}: {
  fitToData: boolean;
  initialViewState?: MapViewState;
  points: readonly MapPoint<TProperties>[];
}): GlobeViewState {
  if (initialViewState) {
    return {
      center: initialViewState.center,
      zoom: initialViewState.zoom,
    };
  }

  if (fitToData) {
    const bounds = getBoundsFromPoints(points);

    if (bounds) {
      return {
        center: [normalizeLongitude((bounds[0] + bounds[2]) / 2), clampLatitude((bounds[1] + bounds[3]) / 2)],
        zoom: 1.8,
      };
    }
  }

  return {
    center: [12, 25],
    zoom: 1.35,
  };
}

export function createGlobalViewportQuery(zoom: number) {
  return {
    bounds: [-180, -90, 180, 90] as [number, number, number, number],
    zoom,
  };
}

export function projectGlobeCoordinate(
  [longitude, latitude]: [number, number],
  viewState: GlobeViewState,
): GlobeProjectionResult {
  const centerLongitude = viewState.center[0] * DEG_TO_RAD;
  const centerLatitude = viewState.center[1] * DEG_TO_RAD;
  const pointLongitude = longitude * DEG_TO_RAD;
  const pointLatitude = latitude * DEG_TO_RAD;
  const deltaLongitude = pointLongitude - centerLongitude;
  const sinLatitude = Math.sin(pointLatitude);
  const cosLatitude = Math.cos(pointLatitude);
  const sinCenterLatitude = Math.sin(centerLatitude);
  const cosCenterLatitude = Math.cos(centerLatitude);
  const cosDeltaLongitude = Math.cos(deltaLongitude);
  const visibility =
    sinCenterLatitude * sinLatitude + cosCenterLatitude * cosLatitude * cosDeltaLongitude;
  const radius = getGlobeRadius(viewState.zoom);

  return {
    scale: Math.max(0, visibility),
    visible: visibility >= -0.02,
    x:
      GLOBE_VIEWBOX_WIDTH / 2 +
      radius * cosLatitude * Math.sin(deltaLongitude),
    y:
      GLOBE_VIEWBOX_HEIGHT / 2 -
      radius *
        (cosCenterLatitude * sinLatitude -
          sinCenterLatitude * cosLatitude * cosDeltaLongitude),
  };
}

export function unprojectGlobePoint(
  point: { x: number; y: number },
  viewState: GlobeViewState,
): MapCoordinate | null {
  const radius = getGlobeRadius(viewState.zoom);
  const normalizedX = (point.x - GLOBE_VIEWBOX_WIDTH / 2) / radius;
  const normalizedY = -(point.y - GLOBE_VIEWBOX_HEIGHT / 2) / radius;
  const radiusSquared = normalizedX ** 2 + normalizedY ** 2;

  if (radiusSquared > 1) {
    return null;
  }

  const rho = Math.sqrt(radiusSquared);
  const centerLongitude = viewState.center[0] * DEG_TO_RAD;
  const centerLatitude = viewState.center[1] * DEG_TO_RAD;

  if (rho === 0) {
    return [normalizeLongitude(viewState.center[0]), clampLatitude(viewState.center[1])];
  }

  const angularDistance = Math.asin(Math.min(1, rho));
  const sinAngularDistance = Math.sin(angularDistance);
  const cosAngularDistance = Math.cos(angularDistance);
  const sinCenterLatitude = Math.sin(centerLatitude);
  const cosCenterLatitude = Math.cos(centerLatitude);
  const latitude = Math.asin(
    cosAngularDistance * sinCenterLatitude +
      (normalizedY * sinAngularDistance * cosCenterLatitude) / rho,
  );
  const longitude =
    centerLongitude +
    Math.atan2(
      normalizedX * sinAngularDistance,
      rho * cosCenterLatitude * cosAngularDistance -
        normalizedY * sinCenterLatitude * sinAngularDistance,
    );
  const coordinate: MapCoordinate = [
    normalizeLongitude(longitude / DEG_TO_RAD),
    clampLatitude(latitude / DEG_TO_RAD),
  ];
  const projected = projectGlobeCoordinate(coordinate, viewState);

  return projected.visible ? coordinate : null;
}

export function getGlobeRadius(zoom: number) {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1.35;

  return Math.min(GLOBE_VIEWBOX_HEIGHT, GLOBE_VIEWBOX_WIDTH) * (0.36 + safeZoom * 0.045);
}

export function getGlobeDragCenter(
  currentCenter: [longitude: number, latitude: number],
  deltaX: number,
  deltaY: number,
  zoom: number,
) {
  const degreesPerPixel = 70 / getGlobeRadius(zoom);

  return [
    normalizeLongitude(currentCenter[0] - deltaX * degreesPerPixel),
    clampLatitude(currentCenter[1] + deltaY * degreesPerPixel),
  ] as [number, number];
}

export function getGlobeZoom(currentZoom: number, deltaY: number) {
  return clamp(currentZoom - deltaY * 0.0025, 0.8, 8);
}

export function createGlobeGraticuleLines(
  viewState: GlobeViewState,
): Array<Array<GlobeProjectionResult>> {
  const lines: Array<Array<[number, number]>> = [];

  for (let latitude = -60; latitude <= 60; latitude += 30) {
    lines.push(
      Array.from({ length: 73 }, (_, index) => [-180 + index * 5, latitude] as [number, number]),
    );
  }

  for (let longitude = -150; longitude <= 180; longitude += 30) {
    lines.push(
      Array.from({ length: 37 }, (_, index) => [longitude, -90 + index * 5] as [number, number]),
    );
  }

  return lines.map((line) => line.map((coordinate) => projectGlobeCoordinate(coordinate, viewState)));
}

export function createVisibleSvgPath(points: readonly GlobeProjectionResult[]) {
  let path = "";
  let isDrawing = false;

  for (const point of points) {
    if (!point.visible) {
      isDrawing = false;
      continue;
    }

    path += `${isDrawing ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    isDrawing = true;
  }

  return path;
}

export function resolveTileLayerOptions(mapStyle: string | RasterMapStyle): {
  options: TileLayerOptions;
  url: string;
} | null {
  if (typeof mapStyle === "string") {
    return {
      options: {
        attribution: defaultRasterMapStyle.attribution,
      },
      url: mapStyle,
    };
  }

  const tiles = mapStyle.tiles ?? defaultRasterMapStyle.tiles;

  if (tiles === false) {
    return null;
  }

  const url = Array.isArray(tiles) ? tiles[0] : tiles;

  return {
    options: {
      attribution: mapStyle.attribution ?? defaultRasterMapStyle.attribution,
      maxZoom: typeof mapStyle.maxZoom === "number" ? mapStyle.maxZoom : undefined,
      minZoom: typeof mapStyle.minZoom === "number" ? mapStyle.minZoom : undefined,
      tileSize: typeof mapStyle.tileSize === "number" ? mapStyle.tileSize : undefined,
    },
    url: url ?? String(defaultRasterMapStyle.tiles),
  };
}

export function toLeafletLatLng([longitude, latitude]: [number, number]) {
  return [latitude, longitude] as [number, number];
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
