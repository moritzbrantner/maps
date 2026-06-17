"use client";

import { toLatLng } from "./map-display";
import type {
  FlatLayer,
  FlatLayerFactory,
  FlatLayerGroup,
  FlatMapAdapter,
} from "./maplibre-compat";
import {
  beginFlatLayerResourceRequest,
  clearFlatLayerEntries,
  createFlatLayerResourceState,
  isCurrentFlatLayerResourceRequest,
  reconcileFlatLayerEntries,
  resetFlatLayerResourceState,
  type FlatLayerEntry,
  type FlatLayerResourceState,
} from "./flat-layer-reconciler";
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
  getHeatLayerSurfaceQueryBounds as getPlannedHeatLayerSurfaceQueryBounds,
  type HeatSurfaceCacheMetadata,
  type HeatSurfaceRenderPlan,
} from "./heat-surface-render-plan";

type HeatLayerManagedLayer = FlatLayer;

type HeatLayerImageOverlay = FlatLayer & {
  bounds?: [[number, number], [number, number]];
  options?: Record<string, unknown>;
  setBounds?: (bounds: [[number, number], [number, number]]) => unknown;
  setOpacity?: (opacity: number) => unknown;
  setUrl?: (url: string) => unknown;
  url?: string;
};

export type HeatLayerFlatRenderState = {
  contourEntries: Map<string, HeatLayerManagedEntry>;
  dataEntries: Map<string, HeatLayerManagedEntry>;
  surface: FlatLayerResourceState<HeatLayerImageOverlay, HeatLayerSurfaceCache>;
};

type HeatLayerSurfaceCache = HeatSurfaceCacheMetadata & {
  objectUrl: boolean;
  url: string;
};

type HeatLayerManagedEntry = FlatLayerEntry<HeatLayerManagedLayer>;

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
    clearHeatLayerContourLayers(layer, state);
    return;
  }

  const safeOpacity = clamp(lineOpacity, 0, 1);
  const safeLineWidth = Math.max(0.25, lineWidth ?? 1);

  reconcileFlatLayerEntries<HeatLayerManagedEntry>({
    cache: state.contourEntries,
    layer,
    plans: collection.features.flatMap((feature, index) => {
      const geometry = feature.geometry;

      if (geometry?.type !== "MultiLineString") {
        return [];
      }

      const lines = (geometry.coordinates as Array<Array<[number, number]>>).filter(
        (line) => line.length >= 2,
      );

      if (lines.length === 0) {
        return [];
      }

      const tooltip = feature.properties?.valueLabel ?? String(feature.properties?.value ?? "");
      const signature = JSON.stringify({
        geometry,
        interactive: !isMeasuring,
        lineColor: lineColor ?? "#111827",
        opacity: safeOpacity,
        tooltip,
        weight: safeLineWidth,
      });

      return [
        {
          key: `contour:${index}:${tooltip}`,
          render: () => {
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

            bindHeatLayerTooltip(polyline, tooltip);
            polyline.addTo(layer);

            return {
              layers: [polyline],
              signature,
            };
          },
          signature,
        },
      ];
    }),
  });
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
  const safeOpacity = clamp(opacity, 0, 1);
  const safeRadius = Math.max(0, radius);
  const safeStrokeWidth = Math.max(0, strokeWidth);

  reconcileFlatLayerEntries<HeatLayerManagedEntry>({
    cache: state.dataEntries,
    layer,
    plans: data.features.map((feature, index) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      const tooltip = formatHeatLayerFeatureValue(feature, formatValue);
      const signature = JSON.stringify({
        color,
        coordinates: feature.geometry.coordinates,
        interactive: !isMeasuring,
        opacity: safeOpacity,
        radius: safeRadius,
        strokeColor,
        strokeWidth: safeStrokeWidth,
        tooltip,
      });

      return {
        key: feature.properties.pointId || `data:${longitude},${latitude}:${index}`,
        render: () => {
          const marker = flat.circleMarker(toLatLng([longitude, latitude]), {
            bubblingMouseEvents: false,
            className: "mb-maps__heat-data-point",
            color: strokeColor,
            fillColor: color,
            fillOpacity: safeOpacity,
            interactive: !isMeasuring,
            opacity: safeOpacity,
            radius: safeRadius,
            weight: safeStrokeWidth,
          });

          bindHeatLayerTooltip(marker, tooltip);
          marker.addTo(layer);

          return {
            layers: [marker],
            signature,
          };
        },
        signature,
      };
    }),
  });
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
    surfaceCache: state.surface.metadata,
    width,
  });

  if (!plan) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const cachedUrl = state.surface.metadata?.key === plan.cacheKey ? state.surface.metadata.url : null;

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

  const requestId = beginFlatLayerResourceRequest(state.surface);

  if (asyncRender) {
    createHeatLayerSurfaceImage(plan).then((image) => {
      if (!isCurrentFlatLayerResourceRequest(state.surface, requestId)) {
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
    surfaceCache: state.surface.metadata,
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

export function createHeatLayerFlatRenderState(): HeatLayerFlatRenderState {
  return {
    contourEntries: new Map(),
    dataEntries: new Map(),
    surface: createFlatLayerResourceState(),
  };
}

export function resetHeatLayerFlatRenderState(state: HeatLayerFlatRenderState) {
  state.contourEntries.clear();
  state.dataEntries.clear();
  resetFlatLayerResourceState({
    remove: (layer) => {
      layer.remove?.();
    },
    revokeMetadata: revokeHeatLayerSurfaceCache,
    state: state.surface,
  });
}

export function removeHeatLayerSurfaceLayer(
  parent: FlatLayerGroup,
  state: HeatLayerFlatRenderState,
) {
  beginFlatLayerResourceRequest(state.surface);
  const surfaceLayer = state.surface.resource;

  if (!surfaceLayer) {
    return;
  }

  removeHeatLayerManagedLayer(parent, surfaceLayer);
  state.surface.resource = null;
  state.surface.signature = null;
}

export function clearHeatLayerDataPointLayers(
  parent: FlatLayerGroup,
  state: HeatLayerFlatRenderState,
) {
  clearFlatLayerEntries({ cache: state.dataEntries, layer: parent });
}

export function clearHeatLayerContourLayers(
  parent: FlatLayerGroup,
  state: HeatLayerFlatRenderState,
) {
  clearFlatLayerEntries({ cache: state.contourEntries, layer: parent });
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
  if (state.surface.metadata?.url !== cache.url) {
    revokeHeatLayerSurfaceCache(state.surface.metadata);
  }

  state.surface.metadata = cache;
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

  if (!state.surface.resource || state.surface.signature !== className) {
    removeHeatLayerSurfaceLayer(layer, state);
    state.surface.resource = flat
      .imageOverlay(url, bounds, {
        className,
        interactive: false,
        opacity: safeOpacity,
      })
      .addTo(layer) as unknown as HeatLayerImageOverlay;
    state.surface.signature = className;
    return;
  }

  updateHeatLayerImageOverlay(state.surface.resource, {
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
  parent.removeLayer(layer);
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
