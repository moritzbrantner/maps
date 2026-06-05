import { describe, expect, test } from "vitest";

import type { FlatMapAdapter } from "./maplibre-compat";
import { prepareHeatLayerColorRamp } from "./heat-surface";
import {
  createHeatSurfaceRenderPlan,
  type HeatSurfaceCacheMetadata,
} from "./heat-surface-render-plan";
import type { HeatLayerFeatureCollection } from "./heat-layer-types";

const colorRamp = prepareHeatLayerColorRamp([
  [0, "rgba(15, 23, 42, 0)"],
  [0.35, "#22c55e"],
  [0.7, "#fde047"],
  [1, "#dc2626"],
]);

describe("heat surface render planning", () => {
  test("resolves auto strategy from radius units", () => {
    const meterPlan = createPlan({
      radius: { meters: 100_000 },
      strategy: "auto",
    });
    const pixelPlan = createPlan({
      radius: 24,
      strategy: "auto",
    });

    expect(meterPlan?.strategy).toBe("stable-raster");
    expect(pixelPlan?.strategy).toBe("viewport-raster");
  });

  test("keeps explicit viewport strategy for meter radii", () => {
    const firstPlan = createPlan({
      centerLongitude: 0,
      radius: { meters: 100_000 },
      strategy: "viewport-raster",
    });
    const movedPlan = createPlan({
      centerLongitude: 12,
      radius: { meters: 100_000 },
      strategy: "viewport-raster",
    });

    expect(firstPlan?.strategy).toBe("viewport-raster");
    expect(Number.isNaN(firstPlan?.zoomBucket)).toBe(true);
    expect(movedPlan?.cacheKey).not.toBe(firstPlan?.cacheKey);
  });

  test("keeps stable raster dimensions within the pixel budget", () => {
    const maxRasterPixels = 10_000;
    const plan = createPlan({
      height: 1_200,
      maxRasterPixels,
      radius: { meters: 100_000 },
      strategy: "stable-raster",
      width: 2_000,
    });

    expect(plan).not.toBeNull();
    expect((plan?.width ?? 0) * (plan?.height ?? 0)).toBeLessThanOrEqual(maxRasterPixels);
  });

  test("reuses stable cache metadata when cached coverage still contains the padded viewport", () => {
    const initialPlan = createPlan({
      overscanRatio: 2,
      radius: { meters: 100_000 },
      strategy: "stable-raster",
    });
    const cachedPlan = createPlan({
      overscanRatio: 2,
      radius: { meters: 100_000 },
      strategy: "stable-raster",
      surfaceCache: initialPlan?.cacheMetadata ?? null,
    });

    expect(cachedPlan?.cacheKey).toBe(initialPlan?.cacheKey);
    expect(cachedPlan?.cacheMetadata).toEqual(initialPlan?.cacheMetadata);
    expect(cachedPlan?.overlayBounds).toEqual(initialPlan?.cacheMetadata.bounds);
    expect(cachedPlan?.coverageBounds).toEqual(initialPlan?.cacheMetadata.coverageBounds);
    expect(cachedPlan?.width).toBe(initialPlan?.cacheMetadata.rasterWidth);
    expect(cachedPlan?.height).toBe(initialPlan?.cacheMetadata.rasterHeight);
    expect(cachedPlan?.dataSignature).toBe(initialPlan?.cacheMetadata.dataSignature);
    expect(cachedPlan?.sources).toHaveLength(0);
  });

  test("returns null for invalid or empty inputs", () => {
    expect(createPlan({ width: 0 })).toBeNull();
    expect(createPlan({ height: 0 })).toBeNull();
    expect(createPlan({ data: createFeatureCollection([]) })).toBeNull();
    expect(createPlan({ intensity: 0 })).toBeNull();
    expect(createPlan({ intensity: -1 })).toBeNull();
  });

  test("changes the cache key when source weights change", () => {
    const lightPlan = createPlan({
      data: createFeatureCollection([{ id: "a", latitude: 0, longitude: 0, weight: 0.25 }]),
    });
    const heavyPlan = createPlan({
      data: createFeatureCollection([{ id: "a", latitude: 0, longitude: 0, weight: 0.75 }]),
    });

    expect(lightPlan?.cacheKey).not.toBe(heavyPlan?.cacheKey);
  });
});

function createPlan({
  centerLatitude = 0,
  centerLongitude = 0,
  data = createFeatureCollection([{ id: "a", latitude: 0, longitude: 0, weight: 1 }]),
  height = 640,
  intensity = 1,
  maxRasterPixels = 512_000,
  minZoomDeltaForRebuild = 1,
  overscanRatio = 1,
  radius = { meters: 100_000 },
  strategy = "auto",
  surfaceCache = null,
  width = 960,
  zoom = 4,
}: {
  centerLatitude?: number;
  centerLongitude?: number;
  data?: HeatLayerFeatureCollection;
  height?: number;
  intensity?: number;
  maxRasterPixels?: number;
  minZoomDeltaForRebuild?: number;
  overscanRatio?: number;
  radius?: Parameters<typeof createHeatSurfaceRenderPlan>[0]["radius"];
  strategy?: Parameters<typeof createHeatSurfaceRenderPlan>[0]["strategy"];
  surfaceCache?: HeatSurfaceCacheMetadata | null;
  width?: number;
  zoom?: number;
} = {}) {
  return createHeatSurfaceRenderPlan({
    colorRamp,
    data,
    height,
    intensity,
    map: createMockMap({ centerLatitude, centerLongitude, height, width, zoom }),
    maxRasterPixels,
    minZoomDeltaForRebuild,
    mode: "interpolated",
    overscanRatio,
    radius,
    strategy,
    surfaceCache,
    width,
  });
}

function createMockMap({
  centerLatitude,
  centerLongitude,
  height,
  width,
  zoom,
}: {
  centerLatitude: number;
  centerLongitude: number;
  height: number;
  width: number;
  zoom: number;
}): FlatMapAdapter {
  return {
    containerPointToLatLng([x, y]: [number, number]) {
      const scale = 2 ** (zoom - 2);

      return {
        lat: centerLatitude - ((y - height / 2) / (height * scale)) * 170,
        lng: centerLongitude + ((x - width / 2) / (width * scale)) * 360,
      };
    },
    getContainer() {
      return {
        clientHeight: height,
        clientWidth: width,
      };
    },
    getZoom() {
      return zoom;
    },
    latLngToContainerPoint(latLng: [number, number] | { lat: number; lng: number }) {
      const [latitude, longitude] = Array.isArray(latLng)
        ? latLng
        : [latLng.lat, latLng.lng];
      const scale = 2 ** (zoom - 2);

      return {
        x: width / 2 + ((longitude - centerLongitude) / 360) * width * scale,
        y: height / 2 - ((latitude - centerLatitude) / 170) * height * scale,
      };
    },
  } as FlatMapAdapter;
}

function createFeatureCollection(
  points: Array<{
    id: string;
    latitude: number;
    longitude: number;
    weight: number;
  }>,
): HeatLayerFeatureCollection {
  return {
    features: points.map((point) => ({
      geometry: {
        coordinates: [point.longitude, point.latitude],
        type: "Point",
      },
      properties: {
        kind: "heat-point",
        label: point.id,
        pointCount: 1,
        pointId: point.id,
        rawWeight: point.weight,
        weight: point.weight,
      },
      type: "Feature",
    })),
    type: "FeatureCollection",
  };
}
