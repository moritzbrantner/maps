"use client";

import { toLatLng } from "./map-display";
import type {
  FlatLayer,
  FlatLayerFactory,
  FlatLayerGroup,
  FlatMapAdapter,
} from "./maplibre-compat";
import type { HeatFieldContourFeatureCollection, HeatFieldImage } from "./scalar-field-render";
import {
  createHeatLayerDataSurfaceDataUrl,
  createHeatLayerDataSurfaceImage,
  createHeatLayerInterpolatedSurfaceDataUrl,
  createHeatLayerInterpolatedSurfaceImage,
  type HeatLayerMetricPoint,
  type HeatLayerSurfaceImage,
  type HeatLayerSurfaceSource,
  type PreparedHeatLayerColorRamp,
} from "./heat-surface";
import { formatHeatLayerFeatureValue } from "./heat-layer-data";
import {
  METERS_PER_DEGREE_AT_EQUATOR,
  type HeatLayerFeatureCollection,
  type HeatLayerRadius,
  type HeatLayerRenderStrategy,
  type HeatLayerSurfaceMode,
} from "./heat-layer-types";
import { clamp, roundHeatLayerCacheNumber } from "./heat-layer-utils";

type HeatLayerManagedLayer = {
  remove?: () => unknown;
};

type HeatLayerImageOverlay = HeatLayerManagedLayer & {
  bounds?: [[number, number], [number, number]];
  options?: Record<string, unknown>;
  setBounds?: (bounds: [[number, number], [number, number]]) => unknown;
  setOpacity?: (opacity: number) => unknown;
  setUrl?: (url: string) => unknown;
  url?: string;
};

export type HeatLayerFlatRenderState = {
  contourLayers: HeatLayerManagedLayer[];
  dataLayers: HeatLayerManagedLayer[];
  renderRequestId: number;
  surfaceCache: HeatLayerSurfaceCache | null;
  surfaceClassName: string | null;
  surfaceLayer: HeatLayerImageOverlay | null;
};

type HeatLayerSurfaceCache = {
  bounds: [west: number, south: number, east: number, north: number];
  coverageBounds: [west: number, south: number, east: number, north: number];
  dataSignature: string;
  key: string;
  objectUrl: boolean;
  rasterHeight: number;
  rasterWidth: number;
  strategy: Exclude<HeatLayerRenderStrategy, "auto">;
  url: string;
  zoomBucket: number;
};

type HeatLayerSurfaceRenderOptions = {
  cacheKey: string;
  colorRamp: PreparedHeatLayerColorRamp;
  coverageBounds: [west: number, south: number, east: number, north: number];
  dataSignature: string;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: {
    getMetricPoint: (x: number, y: number) => HeatLayerMetricPoint;
    getMetricX?: (x: number) => number;
    getMetricY?: (y: number) => number;
  };
  mode: Exclude<HeatLayerSurfaceMode, "field">;
  overlayBounds: [west: number, south: number, east: number, north: number];
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
  zoomBucket: number;
};

export function renderHeatLayerFieldSurface({
  image,
  layer,
  flat,
  opacity,
  state,
}: {
  image: HeatFieldImage | null;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  opacity: number;
  state: HeatLayerFlatRenderState;
}) {
  if (!image) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const [west, south, east, north] = image.bounds;

  renderOrUpdateHeatLayerImageOverlay({
    bounds: [
      [south, west],
      [north, east],
    ],
    className: "mb-maps__heat-surface mb-maps__heat-surface--field",
    layer,
    flat,
    opacity,
    state,
    url: image.url,
  });
}

export function renderHeatLayerContourSurface({
  collection,
  isMeasuring,
  layer,
  flat,
  lineColor,
  lineOpacity,
  lineWidth,
  state,
}: {
  collection: HeatFieldContourFeatureCollection | null;
  isMeasuring: boolean;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  lineColor?: string;
  lineOpacity: number;
  lineWidth?: number;
  state: HeatLayerFlatRenderState;
}) {
  if (!collection) {
    return;
  }

  const safeOpacity = clamp(lineOpacity, 0, 1);
  const safeLineWidth = Math.max(0.25, lineWidth ?? 1);

  for (const feature of collection.features) {
    const geometry = feature.geometry;

    if (geometry?.type !== "MultiLineString") {
      continue;
    }

    const lines = (geometry.coordinates as Array<Array<[number, number]>>).filter(
      (line) => line.length >= 2,
    );

    if (lines.length === 0) {
      continue;
    }

    const polyline = flat.polyline(
      lines.map((line) => line.map(toLatLng)),
      {
        bubblingMouseEvents: false,
        className: "mb-maps__heat-contour",
        color: lineColor ?? "#111827",
        interactive: !isMeasuring,
        opacity: safeOpacity,
        weight: safeLineWidth,
      },
    );

    bindHeatLayerTooltip(
      polyline,
      feature.properties?.valueLabel ?? String(feature.properties?.value ?? ""),
    );
    polyline.addTo(layer);
    state.contourLayers.push(polyline);
  }
}

export function renderHeatLayerDataPoints({
  color,
  data,
  formatValue,
  isMeasuring,
  layer,
  flat,
  opacity,
  radius,
  state,
  strokeColor,
  strokeWidth,
}: {
  color: string;
  data: HeatLayerFeatureCollection;
  formatValue?: (value: number) => string;
  isMeasuring: boolean;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  opacity: number;
  radius: number;
  state: HeatLayerFlatRenderState;
  strokeColor: string;
  strokeWidth: number;
}) {
  for (const feature of data.features) {
    const [longitude, latitude] = feature.geometry.coordinates;
    const marker = flat.circleMarker(toLatLng([longitude, latitude]), {
      bubblingMouseEvents: false,
      className: "mb-maps__heat-data-point",
      color: strokeColor,
      fillColor: color,
      fillOpacity: clamp(opacity, 0, 1),
      interactive: !isMeasuring,
      opacity: clamp(opacity, 0, 1),
      radius: Math.max(0, radius),
      weight: Math.max(0, strokeWidth),
    });

    bindHeatLayerTooltip(marker, formatHeatLayerFeatureValue(feature, formatValue));
    marker.addTo(layer);
    state.dataLayers.push(marker);
  }
}

export function renderHeatLayerSurface({
  asyncRender,
  colorRamp,
  data,
  intensity,
  layer,
  flat,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  mode,
  opacity,
  overscanRatio,
  radius,
  state,
  strategy,
}: {
  asyncRender: boolean;
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  intensity: number;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  mode: HeatLayerSurfaceMode;
  opacity: number;
  overscanRatio: number;
  radius: HeatLayerRadius;
  state: HeatLayerFlatRenderState;
  strategy: HeatLayerRenderStrategy;
}) {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const safeOpacity = clamp(opacity, 0, 1);
  const resolvedStrategy = resolveHeatLayerRenderStrategy(strategy, radius);
  const renderOptions =
    resolvedStrategy === "stable-raster" && isMeterHeatLayerRadius(radius)
      ? createStableHeatLayerSurfaceRenderOptions({
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
          state,
          width,
        })
      : createViewportHeatLayerSurfaceRenderOptions({
          colorRamp,
          data,
          height,
          intensity,
          map,
          mode,
          radius,
          width,
        });

  if (!renderOptions) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const cachedUrl =
    state.surfaceCache?.key === renderOptions.cacheKey ? state.surfaceCache.url : null;

  if (cachedUrl) {
    renderOrUpdateHeatLayerImageOverlay({
      bounds: heatLayerBoundsToLatLngBounds(renderOptions.overlayBounds),
      className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
      layer,
      flat,
      opacity: safeOpacity,
      state,
      url: cachedUrl,
    });
    return;
  }

  state.renderRequestId += 1;
  const requestId = state.renderRequestId;
  const cacheMetadata = {
    bounds: renderOptions.overlayBounds,
    coverageBounds: renderOptions.coverageBounds,
    dataSignature: renderOptions.dataSignature,
    key: renderOptions.cacheKey,
    rasterHeight: renderOptions.height,
    rasterWidth: renderOptions.width,
    strategy: resolvedStrategy,
    zoomBucket: renderOptions.zoomBucket,
  };

  if (asyncRender) {
    createHeatLayerSurfaceImage(renderOptions).then((image) => {
      if (state.renderRequestId !== requestId) {
        revokeHeatLayerSurfaceImage(image);
        return;
      }

      setHeatLayerSurfaceCache(state, {
        ...cacheMetadata,
        objectUrl: image.objectUrl,
        url: image.url,
      });

      renderOrUpdateHeatLayerImageOverlay({
        bounds: heatLayerBoundsToLatLngBounds(renderOptions.overlayBounds),
        className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
        layer,
        flat,
        opacity: safeOpacity,
        state,
        url: image.url,
      });
    });
    return;
  }

  const image = createHeatLayerSurfaceDataImage(renderOptions);

  setHeatLayerSurfaceCache(state, {
    ...cacheMetadata,
    objectUrl: image.objectUrl,
    url: image.url,
  });

  renderOrUpdateHeatLayerImageOverlay({
    bounds: heatLayerBoundsToLatLngBounds(renderOptions.overlayBounds),
    className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
    layer,
    flat,
    opacity: safeOpacity,
    state,
    url: image.url,
  });
}

export function getHeatLayerSurfaceQueryBounds({
  intensity,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  overscanRatio,
  radius,
  state,
  strategy,
}: {
  intensity: number;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  overscanRatio: number;
  radius: HeatLayerRadius;
  state: HeatLayerFlatRenderState;
  strategy: HeatLayerRenderStrategy;
}) {
  const resolvedStrategy = resolveHeatLayerRenderStrategy(strategy, radius);

  if (resolvedStrategy !== "stable-raster" || !isMeterHeatLayerRadius(radius)) {
    return getHeatLayerPaddedBounds(map, radius, intensity);
  }

  const zoomBucket = getHeatLayerZoomBucket(map.getZoom(), minZoomDeltaForRebuild);
  const paddedBounds = getHeatLayerPaddedBounds(map, radius, intensity);

  if (
    state.surfaceCache &&
    state.surfaceCache.strategy === "stable-raster" &&
    state.surfaceCache.zoomBucket === zoomBucket &&
    heatLayerBoundsContain(state.surfaceCache.coverageBounds, paddedBounds)
  ) {
    return state.surfaceCache.coverageBounds;
  }

  void maxRasterPixels;

  return getHeatLayerStableCoverageBounds(map, radius, intensity, overscanRatio);
}

export function getHeatLayerViewportBounds(
  map: FlatMapAdapter,
): [west: number, south: number, east: number, north: number] {
  const bounds = map.getBounds();

  return [
    clamp(bounds.getWest(), -180, 180),
    clamp(bounds.getSouth(), -90, 90),
    clamp(bounds.getEast(), -180, 180),
    clamp(bounds.getNorth(), -90, 90),
  ];
}

export function resolveHeatLayerGlobeRadius(
  radius: HeatLayerRadius,
  coordinate: [longitude: number, latitude: number],
  viewState: { center: [number, number]; zoom: number },
  projectCoordinate: (
    coordinate: [longitude: number, latitude: number],
    viewState: { center: [number, number]; zoom: number },
  ) => { visible: boolean; x: number; y: number },
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      projectCoordinate(nextCoordinate, viewState),
    );
  }

  return resolveHeatLayerDisplayRadius(radius, viewState.zoom);
}

export function createHeatLayerFlatRenderState(): HeatLayerFlatRenderState {
  return {
    contourLayers: [],
    dataLayers: [],
    renderRequestId: 0,
    surfaceCache: null,
    surfaceClassName: null,
    surfaceLayer: null,
  };
}

export function resetHeatLayerFlatRenderState(state: HeatLayerFlatRenderState) {
  state.renderRequestId += 1;
  state.contourLayers = [];
  state.dataLayers = [];
  revokeHeatLayerSurfaceCache(state.surfaceCache);
  state.surfaceCache = null;
  state.surfaceClassName = null;
  state.surfaceLayer = null;
}

export function removeHeatLayerSurfaceLayer(
  parent: FlatLayerGroup,
  state: HeatLayerFlatRenderState,
) {
  if (!state.surfaceLayer) {
    return;
  }

  removeHeatLayerManagedLayer(parent, state.surfaceLayer);
  state.surfaceLayer = null;
  state.surfaceClassName = null;
}

export function clearHeatLayerManagedLayers(
  parent: FlatLayerGroup,
  layers: HeatLayerManagedLayer[],
) {
  for (const layer of layers) {
    removeHeatLayerManagedLayer(parent, layer);
  }

  layers.length = 0;
}

export function clearHeatLayerNonSurfaceLayers(
  parent: FlatLayerGroup,
  state: HeatLayerFlatRenderState,
) {
  const layers = (parent as FlatLayerGroup & { layers?: HeatLayerManagedLayer[] }).layers;

  if (!Array.isArray(layers)) {
    return;
  }

  for (const layer of [...layers]) {
    if (layer !== state.surfaceLayer) {
      removeHeatLayerManagedLayer(parent, layer);
    }
  }
}

function createViewportHeatLayerSurfaceRenderOptions({
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
}): HeatLayerSurfaceRenderOptions | null {
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
  ] as [number, number, number, number];
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

  return {
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
    mode: mode as Exclude<HeatLayerSurfaceMode, "field">,
    overlayBounds,
    sources,
    width,
    zoomBucket: Number.NaN,
  };
}

function createStableHeatLayerSurfaceRenderOptions({
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
  state,
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
  state: HeatLayerFlatRenderState;
  width: number;
}): HeatLayerSurfaceRenderOptions | null {
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
    state.surfaceCache &&
    state.surfaceCache.strategy === "stable-raster" &&
    state.surfaceCache.zoomBucket === zoomBucket &&
    heatLayerBoundsContain(
      state.surfaceCache.coverageBounds,
      getHeatLayerPaddedBounds(map, radius, intensity),
    )
  ) {
    return {
      cacheKey: state.surfaceCache.key,
      colorRamp,
      coverageBounds: state.surfaceCache.coverageBounds,
      dataSignature: state.surfaceCache.dataSignature,
      height: state.surfaceCache.rasterHeight,
      maxInfluenceRadius: 1,
      metricProjection: createStableHeatLayerMetricProjection(state.surfaceCache.coverageBounds, {
        height: state.surfaceCache.rasterHeight,
        width: state.surfaceCache.rasterWidth,
      }),
      mode: mode as Exclude<HeatLayerSurfaceMode, "field">,
      overlayBounds: state.surfaceCache.bounds,
      sources: [],
      width: state.surfaceCache.rasterWidth,
      zoomBucket,
    };
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

  return {
    cacheKey,
    colorRamp,
    coverageBounds,
    dataSignature,
    height: dimensions.height,
    maxInfluenceRadius,
    metricProjection: createStableHeatLayerMetricProjection(coverageBounds, dimensions),
    mode: mode as Exclude<HeatLayerSurfaceMode, "field">,
    overlayBounds: coverageBounds,
    sources,
    width: dimensions.width,
    zoomBucket,
  };
}

function createHeatLayerSurfaceDataImage(
  options: HeatLayerSurfaceRenderOptions,
): HeatLayerSurfaceImage {
  return {
    objectUrl: false,
    url:
      options.mode === "data"
        ? createHeatLayerDataSurfaceDataUrl(options)
        : createHeatLayerInterpolatedSurfaceDataUrl(options),
  };
}

function createHeatLayerSurfaceImage(options: HeatLayerSurfaceRenderOptions) {
  return options.mode === "data"
    ? createHeatLayerDataSurfaceImage(options)
    : createHeatLayerInterpolatedSurfaceImage(options);
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
  overlayBounds: [west: number, south: number, east: number, north: number];
  strategy: Exclude<HeatLayerRenderStrategy, "auto">;
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
): Exclude<HeatLayerRenderStrategy, "auto"> {
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
): [west: number, south: number, east: number, north: number] {
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

function normalizeHeatLayerBounds(
  bounds: [west: number, south: number, east: number, north: number],
): [west: number, south: number, east: number, north: number] {
  return [
    clamp(bounds[0], -180, 180),
    clamp(bounds[1], -90, 90),
    clamp(bounds[2], -180, 180),
    clamp(bounds[3], -90, 90),
  ];
}

function heatLayerBoundsContain(
  outer: [west: number, south: number, east: number, north: number],
  inner: [west: number, south: number, east: number, north: number],
) {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}

function heatLayerBoundsToLatLngBounds([west, south, east, north]: [
  west: number,
  south: number,
  east: number,
  north: number,
]): [[number, number], [number, number]] {
  return [
    [south, west],
    [north, east],
  ];
}

function resolveStableHeatLayerRasterDimensions({
  bounds,
  maxRasterPixels,
  viewportHeight,
  viewportWidth,
}: {
  bounds: [west: number, south: number, east: number, north: number];
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
  bounds: [west: number, south: number, east: number, north: number],
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

function getHeatLayerMetricBounds([west, south, east, north]: [
  west: number,
  south: number,
  east: number,
  north: number,
]) {
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

function setHeatLayerSurfaceCache(state: HeatLayerFlatRenderState, cache: HeatLayerSurfaceCache) {
  if (state.surfaceCache?.url !== cache.url) {
    revokeHeatLayerSurfaceCache(state.surfaceCache);
  }

  state.surfaceCache = cache;
}

function revokeHeatLayerSurfaceCache(cache: HeatLayerSurfaceCache | null) {
  if (!cache?.objectUrl) {
    return;
  }

  revokeHeatLayerSurfaceObjectUrl(cache.url);
}

function revokeHeatLayerSurfaceImage(image: HeatLayerSurfaceImage) {
  if (image.objectUrl) {
    revokeHeatLayerSurfaceObjectUrl(image.url);
  }
}

function revokeHeatLayerSurfaceObjectUrl(url: string) {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

function renderOrUpdateHeatLayerImageOverlay({
  bounds,
  className,
  layer,
  flat,
  opacity,
  state,
  url,
}: {
  bounds: [[number, number], [number, number]];
  className: string;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  opacity: number;
  state: HeatLayerFlatRenderState;
  url: string;
}) {
  const safeOpacity = clamp(opacity, 0, 1);

  if (!state.surfaceLayer || state.surfaceClassName !== className) {
    removeHeatLayerSurfaceLayer(layer, state);
    state.surfaceLayer = flat
      .imageOverlay(url, bounds, {
        className,
        interactive: false,
        opacity: safeOpacity,
      })
      .addTo(layer) as unknown as HeatLayerImageOverlay;
    state.surfaceClassName = className;
    return;
  }

  updateHeatLayerImageOverlay(state.surfaceLayer, {
    bounds,
    opacity: safeOpacity,
    url,
  });
}

function updateHeatLayerImageOverlay(
  overlay: HeatLayerImageOverlay,
  {
    bounds,
    opacity,
    url,
  }: {
    bounds: [[number, number], [number, number]];
    opacity: number;
    url: string;
  },
) {
  if (typeof overlay.setUrl === "function") {
    overlay.setUrl(url);
  } else {
    overlay.url = url;
  }

  if (typeof overlay.setBounds === "function") {
    overlay.setBounds(bounds);
  } else {
    overlay.bounds = bounds;
  }

  if (typeof overlay.setOpacity === "function") {
    overlay.setOpacity(opacity);
  } else {
    overlay.options = {
      ...overlay.options,
      opacity,
    };
  }
}

function removeHeatLayerManagedLayer(parent: FlatLayerGroup, layer: HeatLayerManagedLayer) {
  const removableParent = parent as FlatLayerGroup & {
    layers?: unknown[];
  };

  if (typeof removableParent.removeLayer === "function") {
    removableParent.removeLayer(layer as FlatLayer);
    return;
  }

  if (typeof layer.remove === "function") {
    layer.remove();
  }

  if (Array.isArray(removableParent.layers)) {
    const index = removableParent.layers.indexOf(layer);

    if (index >= 0) {
      removableParent.layers.splice(index, 1);
    }
  }
}

function bindHeatLayerTooltip(layer: unknown, content: string) {
  const target = layer as {
    bindTooltip?: (content: string, options?: Record<string, unknown>) => unknown;
  };

  if (!content || typeof target.bindTooltip !== "function") {
    return;
  }

  target.bindTooltip(content, {
    className: "mb-maps__heat-tooltip",
    direction: "top",
    sticky: true,
  });
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
): [west: number, south: number, east: number, north: number] {
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

function getProjectedMetersRadius(
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

function resolveHeatLayerDisplayRadius(
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
