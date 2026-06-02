"use client";

import type { Map as MapLibreMap } from "maplibre-gl";

import type { MapViewState } from "./map-display";

export type MapLibreMapContextMenuEvent = {
  lngLat?: { lat: number; lng: number };
  originalEvent?: {
    defaultPrevented?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
  point?: { x: number; y: number };
};

export function getFlatContextMenuContext(map: MapLibreMap, event: MapLibreMapContextMenuEvent) {
  const position = event.point ?? { x: 0, y: 0 };
  const lngLat = event.lngLat ??
    map.unproject([position.x, position.y]) ??
    map.getCenter?.() ?? {
      lat: 25,
      lng: 12,
    };

  return {
    coordinates: [lngLat.lng, lngLat.lat] as [number, number],
    position,
  };
}

export function getFeatureCoordinate(feature: unknown): [longitude: number, latitude: number] {
  if (feature && typeof feature === "object") {
    const record = feature as Record<string, unknown>;
    const coordinates = record.coordinates;

    if (isCoordinate(coordinates)) {
      return coordinates;
    }

    const point = record.point as Record<string, unknown> | undefined;
    const flow = record.flow as Record<string, unknown> | undefined;

    if (typeof point?.longitude === "number" && typeof point.latitude === "number") {
      return [point.longitude, point.latitude];
    }

    if (isCoordinate(flow?.from) && isCoordinate(flow?.to)) {
      return [(flow.from[0] + flow.to[0]) / 2, (flow.from[1] + flow.to[1]) / 2];
    }
  }

  return [0, 0];
}

export function isBlockedHoverPosition(
  blocked: { x: number; y: number } | null,
  position: { x: number; y: number },
) {
  return Boolean(
    blocked && Math.abs(blocked.x - position.x) <= 1 && Math.abs(blocked.y - position.y) <= 1,
  );
}

export function isMapLibreOriginalEventPrevented(event: MapLibreMapContextMenuEvent) {
  return event.originalEvent?.defaultPrevented === true;
}

export function suppressNativeContextMenu(event: MapLibreMapContextMenuEvent) {
  event.originalEvent?.preventDefault?.();
  event.originalEvent?.stopPropagation?.();
}

export function getMapLibreViewState(map: MapLibreMap): MapViewState {
  const center = map.getCenter?.() ?? { lat: 25, lng: 12 };

  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
  };
}

function isCoordinate(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}
