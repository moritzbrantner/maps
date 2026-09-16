import { describe, expect, test, vi } from "vitest";

import type { HeatLayerFeatureCollection } from "./heat-layer-types";
import {
  createMapsHeatSurfaceViewport,
  getMapsHeatLayerViewportBounds,
  projectMapsHeatLayerCoordinate,
  queryMapsHeatLayerFeatureCollection,
  type MapsHeatLayerViewportGeometry,
} from "./maps-heat-layer-bounds";

describe("Maps heat-layer antimeridian bounds", () => {
  test("unwraps a crossing viewport into one continuous render world", () => {
    const viewport = createCrossingViewport();
    const heatViewport = createMapsHeatSurfaceViewport(viewport);

    expect(getMapsHeatLayerViewportBounds(viewport)).toEqual([170, -10, 190, 10]);
    expect(heatViewport.containerPointToLatLng([0, 50]).lng).toBeCloseTo(170);
    expect(heatViewport.containerPointToLatLng([100, 50]).lng).toBeCloseTo(180);
    expect(heatViewport.containerPointToLatLng([200, 50]).lng).toBeCloseTo(190);
  });

  test("falls back to continuous visible bounds when pitched camera padding cannot unproject", () => {
    const viewport = createCrossingViewport();
    const unproject = viewport.unproject;
    viewport.unproject = (x, y) => {
      if (x < 0 || x > viewport.width || y < 0 || y > viewport.height) {
        throw new Error("unsupported pitched camera coordinate");
      }
      return unproject(x, y);
    };
    const heatViewport = createMapsHeatSurfaceViewport(viewport);

    expect(heatViewport.containerPointToLatLng([-50, -25])).toEqual({ lat: 15, lng: 165 });
    expect(heatViewport.containerPointToLatLng([250, 125])).toEqual({ lat: -15, lng: 195 });
  });

  test("fails closed when an oriented camera cannot project a heat raster vertex", () => {
    const viewport = createCrossingViewport();
    viewport.project = () => {
      throw new Error("unsupported pitched camera coordinate");
    };
    const heatViewport = createMapsHeatSurfaceViewport(viewport);

    expect(projectMapsHeatLayerCoordinate(viewport, [180, 0])).toBeNull();
    expect(heatViewport.latLngToContainerPoint([0, 180])).toEqual({
      x: Number.NaN,
      y: Number.NaN,
    });
  });

  test("splits source queries canonically and shifts only returned render coordinates", () => {
    const source = createFeatureCollection([
      { id: "east", longitude: 179 },
      { id: "west", longitude: -179 },
      { id: "outside", longitude: 0 },
    ]);
    const getFeatureCollection = vi.fn(
      ([west, south, east, north]: [number, number, number, number]) => ({
        features: source.features.filter((feature) => {
          const [longitude, latitude] = feature.geometry.coordinates;
          return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
        }),
        type: "FeatureCollection" as const,
      }),
    );

    const result = queryMapsHeatLayerFeatureCollection(getFeatureCollection, [170, -10, 190, 10]);

    expect(getFeatureCollection).toHaveBeenNthCalledWith(1, [170, -10, 180, 10]);
    expect(getFeatureCollection).toHaveBeenNthCalledWith(2, [-180, -10, -170, 10]);
    expect(result.features.map((feature) => feature.properties.pointId)).toEqual(["east", "west"]);
    expect(result.features.map((feature) => feature.geometry.coordinates[0])).toEqual([179, 181]);
    expect(source.features[1]?.geometry.coordinates[0]).toBe(-179);
  });
});

function createCrossingViewport(): MapsHeatLayerViewportGeometry {
  return {
    bounds: [170, -10, -170, 10],
    height: 100,
    project([longitude, latitude]) {
      const continuousLongitude = longitude < 0 ? longitude + 360 : longitude;
      return {
        x: ((continuousLongitude - 170) / 20) * 200,
        y: ((10 - latitude) / 20) * 100,
      };
    },
    unproject(x, y) {
      const longitude = 170 + (x / 200) * 20;
      return [longitude > 180 ? longitude - 360 : longitude, 10 - (y / 100) * 20];
    },
    width: 200,
    zoom: 4,
  };
}

function createFeatureCollection(
  points: Array<{ id: string; longitude: number }>,
): HeatLayerFeatureCollection {
  return {
    features: points.map((point) => ({
      geometry: {
        coordinates: [point.longitude, 0],
        type: "Point",
      },
      properties: {
        kind: "heat-point",
        label: point.id,
        pointCount: 1,
        pointId: point.id,
        rawWeight: 1,
        weight: 1,
      },
      type: "Feature",
    })),
    type: "FeatureCollection",
  };
}
