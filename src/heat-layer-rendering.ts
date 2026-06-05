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
  type HeatLayerSurfaceImage,
  type PreparedHeatLayerColorRamp,
} from "./heat-surface";
import { formatHeatLayerFeatureValue } from "./heat-layer-data";
import {
  type HeatLayerFeatureCollection,
  type HeatLayerRadius,
  type HeatLayerRenderStrategy,
  type HeatLayerSurfaceMode,
} from "./heat-layer-types";
import { clamp } from "./heat-layer-utils";
import {
  createHeatSurfaceRenderPlan,
  getProjectedMetersRadius,
  getHeatLayerSurfaceQueryBounds as getPlannedHeatLayerSurfaceQueryBounds,
  resolveHeatLayerDisplayRadius,
  type HeatSurfaceCacheMetadata,
  type HeatSurfaceRenderPlan,
} from "./heat-surface-render-plan";

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

type HeatLayerSurfaceCache = HeatSurfaceCacheMetadata & {
  objectUrl: boolean;
  url: string;
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
  const plan = createHeatSurfaceRenderPlan({
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
    strategy,
    surfaceCache: state.surfaceCache,
    width,
  });

  if (!plan) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const cachedUrl = state.surfaceCache?.key === plan.cacheKey ? state.surfaceCache.url : null;

  if (cachedUrl) {
    renderOrUpdateHeatLayerImageOverlay({
      bounds: heatLayerBoundsToLatLngBounds(plan.overlayBounds),
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

  if (asyncRender) {
    createHeatLayerSurfaceImage(plan).then((image) => {
      if (state.renderRequestId !== requestId) {
        revokeHeatLayerSurfaceImage(image);
        return;
      }

      setHeatLayerSurfaceCache(state, {
        ...plan.cacheMetadata,
        objectUrl: image.objectUrl,
        url: image.url,
      });

      renderOrUpdateHeatLayerImageOverlay({
        bounds: heatLayerBoundsToLatLngBounds(plan.overlayBounds),
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

  const image = createHeatLayerSurfaceDataImage(plan);

  setHeatLayerSurfaceCache(state, {
    ...plan.cacheMetadata,
    objectUrl: image.objectUrl,
    url: image.url,
  });

  renderOrUpdateHeatLayerImageOverlay({
    bounds: heatLayerBoundsToLatLngBounds(plan.overlayBounds),
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
  void maxRasterPixels;

  return getPlannedHeatLayerSurfaceQueryBounds({
    intensity,
    map,
    minZoomDeltaForRebuild,
    overscanRatio,
    radius,
    strategy,
    surfaceCache: state.surfaceCache,
  });
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

  for (const layer of layers.slice()) {
    if (layer !== state.surfaceLayer) {
      removeHeatLayerManagedLayer(parent, layer);
    }
  }
}

function createHeatLayerSurfaceDataImage(
  options: HeatSurfaceRenderPlan,
): HeatLayerSurfaceImage {
  return {
    objectUrl: false,
    url:
      options.mode === "data"
        ? createHeatLayerDataSurfaceDataUrl(options)
        : createHeatLayerInterpolatedSurfaceDataUrl(options),
  };
}

function createHeatLayerSurfaceImage(options: HeatSurfaceRenderPlan) {
  return options.mode === "data"
    ? createHeatLayerDataSurfaceImage(options)
    : createHeatLayerInterpolatedSurfaceImage(options);
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
