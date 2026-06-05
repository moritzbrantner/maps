"use client";

import { toLatLng } from "./map-display";
import type { FlatMapAdapter } from "./maplibre-compat";
import {
  METERS_PER_DEGREE_AT_EQUATOR,
  type HeatLayerFeatureCollection,
  type HeatLayerRadius,
  type HeatLayerRenderStrategy,
  type HeatLayerSurfaceMode,
} from "./heat-layer-types";
import { clamp, roundHeatLayerCacheNumber } from "./heat-layer-utils";
import type {
  HeatLayerMetricPoint,
  HeatLayerSurfaceSource,
  PreparedHeatLayerColorRamp,
} from "./heat-surface";

export type HeatSurfaceResolvedRenderStrategy = Exclude<HeatLayerRenderStrategy, "auto">;

export type HeatSurfaceBounds = [
  west: number,
  south: number,
  east: number,
  north: number,
];

export type HeatSurfaceCacheMetadata = {
  bounds: HeatSurfaceBounds;
  coverageBounds: HeatSurfaceBounds;
  dataSignature: string;
  key: string;
  rasterHeight: number;
  rasterWidth: number;
  strategy: HeatSurfaceResolvedRenderStrategy;
  zoomBucket: number;
};

export type HeatSurfaceRenderPlan = {
  cacheKey: string;
  cacheMetadata: HeatSurfaceCacheMetadata;
  colorRamp: PreparedHeatLayerColorRamp;
  coverageBounds: HeatSurfaceBounds;
  dataSignature: string;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: {
    getMetricPoint: (x: number, y: number) => HeatLayerMetricPoint;
    getMetricX?: (x: number) => number;
    getMetricY?: (y: number) => number;
  };
  mode: Exclude<HeatLayerSurfaceMode, "field">;
  overlayBounds: HeatSurfaceBounds;
  sources: readonly HeatLayerSurfaceSource[];
  strategy: HeatSurfaceResolvedRenderStrategy;
  width: number;
  zoomBucket: number;
};

export function createHeatSurfaceRenderPlan({
  colorRamp,
  data,
  height,
  intensity,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  mode,
  overscanRatio,
  radius,
  surfaceCache,
  strategy,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  height: number;
  intensity: number;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  mode: HeatLayerSurfaceMode;
  overscanRatio: number;
  radius: HeatLayerRadius;
  surfaceCache: HeatSurfaceCacheMetadata | null;
  strategy: HeatLayerRenderStrategy;
  width: number;
}): HeatSurfaceRenderPlan | null {
  if (width <= 0 || height <= 0) {
    return null;
  }

  const resolvedStrategy = resolveHeatLayerRenderStrategy(strategy, radius);

  return resolvedStrategy === "stable-raster" && isMeterHeatLayerRadius(radius)
    ? createStableHeatSurfaceRenderPlan({
        colorRamp,
        data,
        height,
        intensity,
        map,
        maxRasterPixels,
        minZoomDeltaForRebuild,
        mode,
        overscanRatio,
        radius,
        surfaceCache,
        width,
      })
    : createViewportHeatSurfaceRenderPlan({
        colorRamp,
        data,
        height,
        intensity,
        map,
        mode,
        radius,
        width,
      });
}

export function getHeatLayerSurfaceQueryBounds({
  intensity,
  map,
  minZoomDeltaForRebuild,
  overscanRatio,
  radius,
  surfaceCache,
  strategy,
}: {
  intensity: number;
  map: FlatMapAdapter;
  minZoomDeltaForRebuild: number;
  overscanRatio: number;
  radius: HeatLayerRadius;
  surfaceCache: HeatSurfaceCacheMetadata | null;
  strategy: HeatLayerRenderStrategy;
}) {
  const resolvedStrategy = resolveHeatLayerRenderStrategy(strategy, radius);

  if (resolvedStrategy !== "stable-raster" || !isMeterHeatLayerRadius(radius)) {
    return getHeatLayerPaddedBounds(map, radius, intensity);
  }

  const zoomBucket = getHeatLayerZoomBucket(map.getZoom(), minZoomDeltaForRebuild);
  const paddedBounds = getHeatLayerPaddedBounds(map, radius, intensity);

  if (
    surfaceCache &&
    surfaceCache.strategy === "stable-raster" &&
    surfaceCache.zoomBucket === zoomBucket &&
    heatLayerBoundsContain(surfaceCache.coverageBounds, paddedBounds)
  ) {
    return surfaceCache.coverageBounds;
  }

  return getHeatLayerStableCoverageBounds(map, radius, intensity, overscanRatio);
}

function createViewportHeatSurfaceRenderPlan({
  colorRamp,
  data,
  height,
  intensity,
  map,
  mode,
  radius,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  height: number;
  intensity: number;
  map: FlatMapAdapter;
  mode: HeatLayerSurfaceMode;
  radius: HeatLayerRadius;
  width: number;
}): HeatSurfaceRenderPlan | null {
  const sources = data.features
    .map((feature) => {
      const point = map.latLngToContainerPoint(toLatLng(feature.geometry.coordinates));
      const baseRadius =
        resolveHeatLayerProjectedRadius(radius, feature.geometry.coordinates, map) *
        Math.max(0, intensity);

      return {
        coordinate: feature.geometry.coordinates,
        dataInfluenceRadius: getHeatLayerDataInfluenceRadius(radius, intensity),
        influenceRadius: baseRadius * 2.6,
        metricPoint: coordinateToHeatLayerMetricPoint(feature.geometry.coordinates),
        point,
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));

  if (width <= 0 || height <= 0 || sources.length === 0 || maxInfluenceRadius <= 0) {
    return null;
  }

  const northWest = map.containerPointToLatLng([0, 0]);
  const southEast = map.containerPointToLatLng([width, height]);
  const overlayBounds = [
    Math.min(northWest.lng, southEast.lng),
    Math.min(northWest.lat, southEast.lat),
    Math.max(northWest.lng, southEast.lng),
    Math.max(northWest.lat, southEast.lat),
  ] as HeatSurfaceBounds;
  const dataSignature = createHeatLayerSurfaceDataSignature(sources);
  const cacheKey = createHeatLayerSurfaceCacheKey({
    colorRamp,
    dataSignature,
    height,
    maxInfluenceRadius,
    mode,
    overlayBounds,
    strategy: "viewport-raster",
    width,
    zoomBucket: Number.NaN,
  });

  return createHeatSurfaceRenderPlanFromOptions({
    cacheKey,
    colorRamp,
    coverageBounds: overlayBounds,
    dataSignature,
    height,
    maxInfluenceRadius,
    metricProjection: {
      getMetricPoint(x, y) {
        const coordinate = map.containerPointToLatLng([x, y]);

        return coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]);
      },
      getMetricX(x) {
        const coordinate = map.containerPointToLatLng([x, height / 2]);

        return coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]).x;
      },
      getMetricY(y) {
        const coordinate = map.containerPointToLatLng([width / 2, y]);

        return coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]).y;
      },
    },
    mode,
    overlayBounds,
    sources,
    strategy: "viewport-raster",
    width,
    zoomBucket: Number.NaN,
  });
}

function createStableHeatSurfaceRenderPlan({
  colorRamp,
  data,
  height,
  intensity,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  mode,
  overscanRatio,
  radius,
  surfaceCache,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  height: number;
  intensity: number;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  mode: HeatLayerSurfaceMode;
  overscanRatio: number;
  radius: { meters: number };
  surfaceCache: HeatSurfaceCacheMetadata | null;
  width: number;
}): HeatSurfaceRenderPlan | null {
  const coverageBounds = getHeatLayerStableCoverageBounds(map, radius, intensity, overscanRatio);
  const zoomBucket = getHeatLayerZoomBucket(map.getZoom(), minZoomDeltaForRebuild);
  const dimensions = resolveStableHeatLayerRasterDimensions({
    bounds: coverageBounds,
    maxRasterPixels,
    viewportHeight: height,
    viewportWidth: width,
  });

  if (dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }

  if (
    surfaceCache &&
    surfaceCache.strategy === "stable-raster" &&
    surfaceCache.zoomBucket === zoomBucket &&
    heatLayerBoundsContain(
      surfaceCache.coverageBounds,
      getHeatLayerPaddedBounds(map, radius, intensity),
    )
  ) {
    return createHeatSurfaceRenderPlanFromOptions({
      cacheKey: surfaceCache.key,
      colorRamp,
      coverageBounds: surfaceCache.coverageBounds,
      dataSignature: surfaceCache.dataSignature,
      height: surfaceCache.rasterHeight,
      maxInfluenceRadius: 1,
      metricProjection: createStableHeatLayerMetricProjection(surfaceCache.coverageBounds, {
        height: surfaceCache.rasterHeight,
        width: surfaceCache.rasterWidth,
      }),
      mode,
      overlayBounds: surfaceCache.bounds,
      sources: [],
      strategy: "stable-raster",
      width: surfaceCache.rasterWidth,
      zoomBucket,
    });
  }

  const metricBounds = getHeatLayerMetricBounds(coverageBounds);
  const metersPerPixel = Math.max(
    (metricBounds.east - metricBounds.west) / Math.max(1, dimensions.width),
    (metricBounds.north - metricBounds.south) / Math.max(1, dimensions.height),
  );
  const dataInfluenceRadius = getHeatLayerDataInfluenceRadius(radius, intensity) ?? 0;
  const influenceRadius = dataInfluenceRadius / Math.max(1, metersPerPixel);
  const sources = data.features
    .map((feature) => {
      const metricPoint = coordinateToHeatLayerMetricPoint(feature.geometry.coordinates);

      return {
        coordinate: feature.geometry.coordinates,
        dataInfluenceRadius,
        influenceRadius,
        metricPoint,
        point: {
          x:
            ((metricPoint.x - metricBounds.west) /
              Math.max(Number.EPSILON, metricBounds.east - metricBounds.west)) *
            dimensions.width,
          y:
            ((metricBounds.north - metricPoint.y) /
              Math.max(Number.EPSILON, metricBounds.north - metricBounds.south)) *
            dimensions.height,
        },
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));

  if (sources.length === 0 || maxInfluenceRadius <= 0) {
    return null;
  }

  const dataSignature = createHeatLayerSurfaceDataSignature(sources);
  const cacheKey = createHeatLayerSurfaceCacheKey({
    colorRamp,
    dataSignature,
    height: dimensions.height,
    maxInfluenceRadius,
    mode,
    overlayBounds: coverageBounds,
    strategy: "stable-raster",
    width: dimensions.width,
    zoomBucket,
  });

  return createHeatSurfaceRenderPlanFromOptions({
    cacheKey,
    colorRamp,
    coverageBounds,
    dataSignature,
    height: dimensions.height,
    maxInfluenceRadius,
    metricProjection: createStableHeatLayerMetricProjection(coverageBounds, dimensions),
    mode,
    overlayBounds: coverageBounds,
    sources,
    strategy: "stable-raster",
    width: dimensions.width,
    zoomBucket,
  });
}

function createHeatSurfaceRenderPlanFromOptions({
  cacheKey,
  colorRamp,
  coverageBounds,
  dataSignature,
  height,
  maxInfluenceRadius,
  metricProjection,
  mode,
  overlayBounds,
  sources,
  strategy,
  width,
  zoomBucket,
}: Omit<HeatSurfaceRenderPlan, "cacheMetadata" | "mode"> & {
  mode: HeatLayerSurfaceMode;
}): HeatSurfaceRenderPlan {
  const resolvedMode = mode as Exclude<HeatLayerSurfaceMode, "field">;

  return {
    cacheKey,
    cacheMetadata: {
      bounds: overlayBounds,
      coverageBounds,
      dataSignature,
      key: cacheKey,
      rasterHeight: height,
      rasterWidth: width,
      strategy,
      zoomBucket,
    },
    colorRamp,
    coverageBounds,
    dataSignature,
    height,
    maxInfluenceRadius,
    metricProjection,
    mode: resolvedMode,
    overlayBounds,
    sources,
    strategy,
    width,
    zoomBucket,
  };
}

function createHeatLayerSurfaceCacheKey({
  colorRamp,
  dataSignature,
  height,
  maxInfluenceRadius,
  mode,
  overlayBounds,
  strategy,
  width,
  zoomBucket,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  dataSignature: string;
  height: number;
  maxInfluenceRadius: number;
  mode: HeatLayerSurfaceMode;
  overlayBounds: HeatSurfaceBounds;
  strategy: HeatSurfaceResolvedRenderStrategy;
  width: number;
  zoomBucket: number;
}) {
  return [
    strategy,
    mode,
    roundHeatLayerCacheNumber(width),
    roundHeatLayerCacheNumber(height),
    roundHeatLayerCacheNumber(zoomBucket),
    roundHeatLayerCacheNumber(maxInfluenceRadius),
    overlayBounds.map(roundHeatLayerCacheNumber).join(","),
    colorRamp.stops
      .map((stop) => `${roundHeatLayerCacheNumber(stop.density)}:${stop.color}`)
      .join(","),
    dataSignature,
  ].join("|");
}

function createHeatLayerSurfaceDataSignature(sources: readonly HeatLayerSurfaceSource[]) {
  return sources
    .map((source) =>
      [
        roundHeatLayerCacheNumber(source.coordinate[0]),
        roundHeatLayerCacheNumber(source.coordinate[1]),
        roundHeatLayerCacheNumber(source.influenceRadius),
        roundHeatLayerCacheNumber(source.dataInfluenceRadius ?? -1),
        roundHeatLayerCacheNumber(source.weight),
      ].join(","),
    )
    .join("|");
}

function resolveHeatLayerRenderStrategy(
  strategy: HeatLayerRenderStrategy,
  radius: HeatLayerRadius,
): HeatSurfaceResolvedRenderStrategy {
  if (strategy !== "auto") {
    return strategy;
  }

  return isMeterHeatLayerRadius(radius) ? "stable-raster" : "viewport-raster";
}

function isMeterHeatLayerRadius(radius: HeatLayerRadius): radius is { meters: number } {
  return typeof radius === "object" && "meters" in radius;
}

function getHeatLayerStableCoverageBounds(
  map: FlatMapAdapter,
  radius: { meters: number },
  intensity: number,
  overscanRatio: number,
): HeatSurfaceBounds {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const center = map.containerPointToLatLng([width / 2, height / 2]);
  const paddingPixels =
    Math.max(width, height) * Math.max(0, overscanRatio) +
    resolveHeatLayerProjectedRadius(radius, [center.lng, center.lat], map) *
      2.6 *
      Math.max(0, intensity);
  const northWest = map.containerPointToLatLng([-paddingPixels, -paddingPixels]);
  const southEast = map.containerPointToLatLng([width + paddingPixels, height + paddingPixels]);

  return normalizeHeatLayerBounds([
    Math.min(northWest.lng, southEast.lng),
    Math.min(northWest.lat, southEast.lat),
    Math.max(northWest.lng, southEast.lng),
    Math.max(northWest.lat, southEast.lat),
  ]);
}

function normalizeHeatLayerBounds(bounds: HeatSurfaceBounds): HeatSurfaceBounds {
  return [
    clamp(bounds[0], -180, 180),
    clamp(bounds[1], -90, 90),
    clamp(bounds[2], -180, 180),
    clamp(bounds[3], -90, 90),
  ];
}

function heatLayerBoundsContain(outer: HeatSurfaceBounds, inner: HeatSurfaceBounds) {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}

function resolveStableHeatLayerRasterDimensions({
  bounds,
  maxRasterPixels,
  viewportHeight,
  viewportWidth,
}: {
  bounds: HeatSurfaceBounds;
  maxRasterPixels: number;
  viewportHeight: number;
  viewportWidth: number;
}) {
  const metricBounds = getHeatLayerMetricBounds(bounds);
  const aspectRatio = Math.max(
    0.05,
    (metricBounds.east - metricBounds.west) / Math.max(1, metricBounds.north - metricBounds.south),
  );
  const safeMaxPixels = Math.max(1, Math.floor(maxRasterPixels));
  const viewportPixels = Math.max(1, viewportWidth * viewportHeight);
  const targetPixels = Math.min(safeMaxPixels, Math.max(1, viewportPixels));
  const width = Math.max(1, Math.round(Math.sqrt(targetPixels * aspectRatio)));
  const height = Math.max(1, Math.round(width / aspectRatio));

  if (width * height <= safeMaxPixels) {
    return { height, width };
  }

  const scale = Math.sqrt(safeMaxPixels / (width * height));

  return {
    height: Math.max(1, Math.floor(height * scale)),
    width: Math.max(1, Math.floor(width * scale)),
  };
}

function createStableHeatLayerMetricProjection(
  bounds: HeatSurfaceBounds,
  dimensions: { height: number; width: number },
) {
  const metricBounds = getHeatLayerMetricBounds(bounds);

  return {
    getMetricPoint(x: number, y: number) {
      return {
        x:
          metricBounds.west +
          (x / Math.max(1, dimensions.width)) * (metricBounds.east - metricBounds.west),
        y:
          metricBounds.north -
          (y / Math.max(1, dimensions.height)) * (metricBounds.north - metricBounds.south),
      };
    },
    getMetricX(x: number) {
      return (
        metricBounds.west +
        (x / Math.max(1, dimensions.width)) * (metricBounds.east - metricBounds.west)
      );
    },
    getMetricY(y: number) {
      return (
        metricBounds.north -
        (y / Math.max(1, dimensions.height)) * (metricBounds.north - metricBounds.south)
      );
    },
  };
}

function getHeatLayerMetricBounds([west, south, east, north]: HeatSurfaceBounds) {
  const southWest = coordinateToHeatLayerMetricPoint([west, south]);
  const northEast = coordinateToHeatLayerMetricPoint([east, north]);

  return {
    east: Math.max(southWest.x, northEast.x),
    north: Math.max(southWest.y, northEast.y),
    south: Math.min(southWest.y, northEast.y),
    west: Math.min(southWest.x, northEast.x),
  };
}

function getHeatLayerZoomBucket(zoom: number, minZoomDeltaForRebuild: number) {
  const interval = Math.max(0.000001, minZoomDeltaForRebuild);

  return Math.floor((Number.isFinite(zoom) ? zoom : 0) / interval);
}

function resolveHeatLayerProjectedRadius(
  radius: HeatLayerRadius,
  coordinate: [longitude: number, latitude: number],
  map: FlatMapAdapter,
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      map.latLngToContainerPoint(toLatLng(nextCoordinate)),
    );
  }

  return resolveHeatLayerDisplayRadius(radius, map.getZoom());
}

function getHeatLayerDataInfluenceRadius(radius: HeatLayerRadius, intensity: number) {
  if (typeof radius === "object" && "meters" in radius) {
    return Math.max(0, radius.meters * 2.6 * Math.max(0, intensity));
  }

  return null;
}

function getHeatLayerPaddedBounds(
  map: FlatMapAdapter,
  radius: HeatLayerRadius,
  intensity: number,
): HeatSurfaceBounds {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const center = map.containerPointToLatLng([width / 2, height / 2]);
  const centerCoordinate: [number, number] = [center.lng, center.lat];
  const padding =
    resolveHeatLayerProjectedRadius(radius, centerCoordinate, map) * 2.6 * Math.max(0, intensity);
  const northWest = map.containerPointToLatLng([-padding, -padding]);
  const southEast = map.containerPointToLatLng([width + padding, height + padding]);

  return [
    clamp(Math.min(northWest.lng, southEast.lng), -180, 180),
    clamp(Math.min(northWest.lat, southEast.lat), -90, 90),
    clamp(Math.max(northWest.lng, southEast.lng), -180, 180),
    clamp(Math.max(northWest.lat, southEast.lat), -90, 90),
  ];
}

export function getProjectedMetersRadius(
  meters: number,
  [longitude, latitude]: [longitude: number, latitude: number],
  projectCoordinate: (coordinate: [longitude: number, latitude: number]) => {
    x: number;
    y: number;
  },
) {
  if (!Number.isFinite(meters) || meters <= 0) {
    return 0;
  }

  const center = projectCoordinate([longitude, latitude]);
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeScale = Math.max(0.000001, Math.abs(Math.cos(latitudeRadians)));
  const longitudeOffset = meters / (METERS_PER_DEGREE_AT_EQUATOR * longitudeScale);
  const edge = projectCoordinate([longitude + longitudeOffset, latitude]);

  return Math.hypot(edge.x - center.x, edge.y - center.y);
}

function coordinateToHeatLayerMetricPoint([longitude, latitude]: [
  longitude: number,
  latitude: number,
]): HeatLayerMetricPoint {
  const clampedLatitude = clamp(latitude, -85.05112878, 85.05112878);
  const latitudeRadians = (clampedLatitude * Math.PI) / 180;

  return {
    x: longitude * METERS_PER_DEGREE_AT_EQUATOR,
    y:
      (Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) *
        (METERS_PER_DEGREE_AT_EQUATOR * 180)) /
      Math.PI,
  };
}

export function resolveHeatLayerDisplayRadius(
  radius: Exclude<HeatLayerRadius, { meters: number }>,
  zoom: number,
) {
  if (typeof radius === "number") {
    return Math.max(0, radius);
  }

  const minZoom = radius.minZoom ?? 0;
  const maxZoom = radius.maxZoom ?? 9;

  if (maxZoom <= minZoom) {
    return Math.max(0, radius.max);
  }

  const progress = clamp((zoom - minZoom) / (maxZoom - minZoom), 0, 1);

  return Math.max(0, radius.min + (radius.max - radius.min) * progress);
}
