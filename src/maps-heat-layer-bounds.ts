"use client";

import type { HeatLayerFeature, HeatLayerFeatureCollection } from "./heat-layer-types";
import type { HeatSurfaceBounds, HeatSurfaceViewport } from "./heat-surface-render-plan";

export type MapsHeatLayerViewportGeometry = {
  bounds: HeatSurfaceBounds;
  height: number;
  project(coordinate: [longitude: number, latitude: number]): { x: number; y: number } | null;
  unproject(x: number, y: number): [longitude: number, latitude: number] | null;
  width: number;
  zoom: number;
};

export function createMapsHeatSurfaceViewport(
  viewport: MapsHeatLayerViewportGeometry,
): HeatSurfaceViewport {
  const referenceLongitude = getMapsHeatLayerReferenceLongitude(viewport);

  return {
    containerPointToLatLng([x, y]) {
      const coordinate = tryUnprojectHeatLayerCoordinate(viewport, x, y);
      if (coordinate) {
        return {
          lat: coordinate[1],
          lng: unwrapHeatLayerLongitude(coordinate[0], referenceLongitude),
        };
      }

      return { lat: Number.NaN, lng: Number.NaN };
    },
    getContainer() {
      return {
        clientHeight: viewport.height,
        clientWidth: viewport.width,
      };
    },
    getVisibleBounds() {
      return getMapsHeatLayerViewportBounds(viewport);
    },
    getZoom() {
      return viewport.zoom;
    },
    latLngToContainerPoint(input) {
      const [latitude, longitude] = Array.isArray(input) ? input : [input.lat, input.lng];
      return projectMapsHeatLayerCoordinate(viewport, [longitude, latitude]) ?? {
        x: Number.NaN,
        y: Number.NaN,
      };
    },
  };
}

export function getMapsHeatLayerViewportBounds(
  viewport: MapsHeatLayerViewportGeometry,
): HeatSurfaceBounds {
  return unwrapHeatLayerBounds(
    viewport.bounds,
    getMapsHeatLayerReferenceLongitude(viewport),
  );
}

export function projectMapsHeatLayerCoordinate(
  viewport: MapsHeatLayerViewportGeometry,
  coordinate: [longitude: number, latitude: number],
) {
  try {
    const point = viewport.project(coordinate);
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  } catch {
    return null;
  }
}

export function queryMapsHeatLayerFeatureCollection(
  getFeatureCollection: (bounds: HeatSurfaceBounds) => HeatLayerFeatureCollection,
  inputBounds: HeatSurfaceBounds,
): HeatLayerFeatureCollection {
  const bounds =
    inputBounds[0] <= inputBounds[2]
      ? inputBounds
      : unwrapHeatLayerBounds(inputBounds, inputBounds[0] + 180);
  const [west, south, east, north] = bounds;
  const longitudeSpan = east - west;

  if (!bounds.every(Number.isFinite) || south > north || longitudeSpan < 0) {
    return { features: [], type: "FeatureCollection" };
  }

  if (longitudeSpan >= 360) {
    const referenceLongitude = west + longitudeSpan / 2;
    return remapHeatLayerFeatureCollection(
      getFeatureCollection([-180, south, 180, north]),
      (longitude) => unwrapHeatLayerLongitude(longitude, referenceLongitude),
    );
  }

  const firstWorld = Math.floor((west + 180) / 360);
  const lastWorld = Math.floor((east + 180) / 360);
  const features: HeatLayerFeature[] = [];

  for (let world = firstWorld; world <= lastWorld; world += 1) {
    const longitudeOffset = world * 360;
    const canonicalWest = Math.max(-180, west - longitudeOffset);
    const canonicalEast = Math.min(180, east - longitudeOffset);
    if (canonicalWest > canonicalEast) continue;

    const collection = getFeatureCollection([canonicalWest, south, canonicalEast, north]);
    for (const feature of collection.features) {
      features.push(shiftHeatLayerFeatureLongitude(feature, longitudeOffset));
    }
  }

  return { features, type: "FeatureCollection" };
}

function getMapsHeatLayerReferenceLongitude(viewport: MapsHeatLayerViewportGeometry) {
  const center = tryUnprojectHeatLayerCoordinate(viewport, viewport.width / 2, viewport.height / 2);
  if (center) return center[0];

  const [west, , east] = viewport.bounds;
  const longitudeSpan = east >= west ? east - west : east + 360 - west;
  return west + longitudeSpan / 2;
}

function tryUnprojectHeatLayerCoordinate(
  viewport: MapsHeatLayerViewportGeometry,
  x: number,
  y: number,
) {
  try {
    const coordinate = viewport.unproject(x, y);
    return coordinate?.every(Number.isFinite) ? coordinate : null;
  } catch {
    return null;
  }
}

function unwrapHeatLayerBounds(
  [west, south, east, north]: HeatSurfaceBounds,
  referenceLongitude: number,
): HeatSurfaceBounds {
  const longitudeSpan = east >= west ? east - west : east + 360 - west;
  if (!Number.isFinite(longitudeSpan) || longitudeSpan >= 360) {
    return [referenceLongitude - 180, south, referenceLongitude + 180, north];
  }

  const midpoint = west + longitudeSpan / 2;
  const unwrappedMidpoint = unwrapHeatLayerLongitude(midpoint, referenceLongitude);

  return [
    unwrappedMidpoint - longitudeSpan / 2,
    south,
    unwrappedMidpoint + longitudeSpan / 2,
    north,
  ];
}

function remapHeatLayerFeatureCollection(
  collection: HeatLayerFeatureCollection,
  mapLongitude: (longitude: number) => number,
): HeatLayerFeatureCollection {
  return {
    features: collection.features.map((feature) => {
      const longitude = mapLongitude(feature.geometry.coordinates[0]);
      return shiftHeatLayerFeatureLongitude(
        feature,
        longitude - feature.geometry.coordinates[0],
      );
    }),
    type: "FeatureCollection",
  };
}

function shiftHeatLayerFeatureLongitude(feature: HeatLayerFeature, longitudeOffset: number) {
  if (longitudeOffset === 0) return feature;

  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: [
        feature.geometry.coordinates[0] + longitudeOffset,
        feature.geometry.coordinates[1],
      ] as [number, number],
    },
  };
}

function unwrapHeatLayerLongitude(longitude: number, referenceLongitude: number) {
  if (!Number.isFinite(longitude) || !Number.isFinite(referenceLongitude)) return longitude;

  const delta = ((((longitude - referenceLongitude + 180) % 360) + 360) % 360) - 180;
  return referenceLongitude + delta;
}
