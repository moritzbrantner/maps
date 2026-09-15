"use client";

import { drawCanvasGeographicRaster } from "./canvas-geographic-raster";
import {
  getHeatLayerFeatureCollectionInBounds,
  isHeatFieldContoursVisible,
  isHeatFieldRasterVisible,
} from "./heat-layer-data";
import type { HeatLayerFeature, HeatLayerFeatureCollection } from "./heat-layer-types";
import { clamp } from "./heat-layer-utils";
import type { MapsHeatLayerDescriptor } from "./maps-heat-layer-registration";
import type { FlatMapAdapter } from "./maplibre-compat";
import type {
  MapRenderCircle,
  MapRenderLine,
  MapVectorRenderPrimitive,
} from "./map-render-frame";
import {
  createHeatSurfaceRenderPlan,
  getHeatLayerSurfaceQueryBounds,
  type HeatSurfaceBounds,
  type HeatSurfaceCacheMetadata,
  type HeatSurfaceRenderPlan,
} from "./heat-surface-render-plan";
import {
  createHeatLayerDataSurfaceDataUrl,
  createHeatLayerDataSurfaceImage,
  createHeatLayerInterpolatedSurfaceDataUrl,
  createHeatLayerInterpolatedSurfaceImage,
  type HeatLayerSurfaceImage,
} from "./heat-surface";
import type { GeoJsonMultiLineStringGeometry } from "./temporal-geojson-types";

export type MapsHeatLayerViewport = {
  bounds: HeatSurfaceBounds;
  height: number;
  project(coordinate: [longitude: number, latitude: number]): { x: number; y: number } | null;
  unproject(x: number, y: number): [longitude: number, latitude: number] | null;
  width: number;
  zoom: number;
};

export type MapsHeatRasterRenderStep = {
  bounds: HeatSurfaceBounds;
  image: HTMLImageElement;
  opacity: number;
  projection: "latitude" | "mercator" | "screen";
};

export type MapsHeatLayerPreparedRender = {
  primitives: MapVectorRenderPrimitive<unknown>[];
  raster: MapsHeatRasterRenderStep | null;
};

type MapsHeatRasterResource = MapsHeatRasterRenderStep & {
  key: string;
  objectUrl: boolean;
  url: string;
};

type MapsHeatSurfaceState = {
  metadata: HeatSurfaceCacheMetadata | null;
  pendingKey: string | null;
  requestId: number;
  resource: MapsHeatRasterResource | null;
};

export type MapsHeatLayerRenderState = {
  fieldResource: MapsHeatRasterResource | null;
  surface: MapsHeatSurfaceState;
};

export function createMapsHeatLayerRenderState(): MapsHeatLayerRenderState {
  return {
    fieldResource: null,
    surface: {
      metadata: null,
      pendingKey: null,
      requestId: 0,
      resource: null,
    },
  };
}

export function resetMapsHeatLayerRenderState(state: MapsHeatLayerRenderState) {
  state.surface.requestId += 1;
  state.surface.pendingKey = null;
  revokeRasterResource(state.surface.resource);
  state.surface.resource = null;
  state.surface.metadata = null;
  state.fieldResource = null;
}

export function prepareMapsHeatLayerRender({
  descriptor,
  requestRender,
  state,
  viewport,
}: {
  descriptor: MapsHeatLayerDescriptor;
  requestRender: () => void;
  state: MapsHeatLayerRenderState;
  viewport: MapsHeatLayerViewport;
}): MapsHeatLayerPreparedRender {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom > descriptor.heatmapMaxZoom
  ) {
    return { primitives: [], raster: null };
  }

  if (descriptor.heatmapSurfaceMode === "field") {
    return prepareFieldLayerRender(descriptor, state, viewport, requestRender);
  }

  return prepareDensityLayerRender(descriptor, state, viewport, requestRender);
}

export function drawMapsHeatRaster(
  context: CanvasRenderingContext2D,
  raster: MapsHeatRasterRenderStep,
  viewport: MapsHeatLayerViewport,
  devicePixelRatio: number,
) {
  if (raster.projection === "screen") {
    context.save();
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.globalAlpha = clamp(raster.opacity, 0, 1);
    context.drawImage(raster.image, 0, 0, viewport.width, viewport.height);
    context.restore();
    return true;
  }

  return drawCanvasGeographicRaster({
    bounds: raster.bounds,
    context,
    devicePixelRatio,
    image: raster.image,
    opacity: raster.opacity,
    project: viewport.project,
    verticalScale: raster.projection,
  });
}

function prepareFieldLayerRender(
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
  viewport: MapsHeatLayerViewport,
  requestRender: () => void,
): MapsHeatLayerPreparedRender {
  const raster =
    isHeatFieldRasterVisible(descriptor.fieldRenderMode) && descriptor.fieldImage
      ? prepareFieldRaster(descriptor, state, requestRender)
      : null;
  const primitives: MapVectorRenderPrimitive<unknown>[] = [];

  if (isHeatFieldContoursVisible(descriptor.fieldRenderMode)) {
    primitives.push(...createContourPrimitives(descriptor));
  }

  if (descriptor.showDataPoints) {
    const data = getHeatLayerFeatureCollectionInBounds(
      descriptor.fieldDataPointCollection ?? descriptor.heatIndex.getFeatureCollection(viewport.bounds),
      viewport.bounds,
    );
    primitives.push(...createDataPointPrimitives(descriptor, data));
  }

  return { primitives, raster };
}

function prepareDensityLayerRender(
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
  viewport: MapsHeatLayerViewport,
  requestRender: () => void,
): MapsHeatLayerPreparedRender {
  const map = createHeatSurfaceAdapter(viewport);
  const queryBounds = getHeatLayerSurfaceQueryBounds({
    intensity: descriptor.heatmapIntensity,
    map,
    minZoomDeltaForRebuild: descriptor.heatmapMinZoomDeltaForRebuild,
    overscanRatio: descriptor.heatmapOverscanRatio,
    radius: descriptor.heatmapRadius,
    strategy: descriptor.heatmapRenderStrategy,
    surfaceCache: state.surface.metadata,
  });
  const data = descriptor.heatIndex.getFeatureCollection(queryBounds);
  const plan = createHeatSurfaceRenderPlan({
    colorRamp: descriptor.heatmapColorRamp,
    data,
    height: viewport.height,
    intensity: descriptor.heatmapIntensity,
    map,
    maxRasterPixels: descriptor.heatmapMaxRasterPixels,
    minZoomDeltaForRebuild: descriptor.heatmapMinZoomDeltaForRebuild,
    mode: descriptor.heatmapSurfaceMode,
    overscanRatio: descriptor.heatmapOverscanRatio,
    radius: descriptor.heatmapRadius,
    strategy: descriptor.heatmapRenderStrategy,
    surfaceCache: state.surface.metadata,
    width: viewport.width,
  });
  const raster = prepareHeatSurfaceRaster(
    plan,
    descriptor.heatmapAsyncRender,
    descriptor.heatmapOpacity,
    state,
    requestRender,
  );
  const primitives = descriptor.showDataPoints
    ? createDataPointPrimitives(
        descriptor,
        descriptor.heatIndex.getFeatureCollection(viewport.bounds),
      )
    : [];

  return { primitives, raster };
}

function prepareFieldRaster(
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
  requestRender: () => void,
) {
  const image = descriptor.fieldImage;
  if (!image) return null;

  const key = `field|${image.width}x${image.height}|${image.bounds.join(",")}|${image.url}`;
  if (state.fieldResource?.key !== key) {
    state.fieldResource = createRasterResource({
      bounds: image.bounds,
      key,
      objectUrl: false,
      opacity: descriptor.fieldOpacity,
      projection: "latitude",
      requestRender,
      url: image.url,
    });
  } else {
    state.fieldResource.opacity = descriptor.fieldOpacity;
  }

  return getReadyRaster(state.fieldResource);
}

function prepareHeatSurfaceRaster(
  plan: HeatSurfaceRenderPlan | null,
  asyncRender: boolean,
  opacity: number,
  state: MapsHeatLayerRenderState,
  requestRender: () => void,
): MapsHeatRasterRenderStep | null {
  if (!plan) {
    state.surface.requestId += 1;
    state.surface.pendingKey = null;
    revokeRasterResource(state.surface.resource);
    state.surface.resource = null;
    state.surface.metadata = null;
    return null;
  }

  const projection = plan.strategy === "viewport-raster" ? "screen" : "mercator";
  const current = state.surface.resource;
  if (current?.key === plan.cacheKey) {
    current.bounds = plan.overlayBounds;
    current.opacity = opacity;
    current.projection = projection;
    return getReadyRaster(current);
  }

  if (asyncRender) {
    if (state.surface.pendingKey !== plan.cacheKey) {
      const requestId = (state.surface.requestId += 1);
      state.surface.pendingKey = plan.cacheKey;

      createHeatSurfaceImage(plan).then((image) => {
        if (state.surface.requestId !== requestId || state.surface.pendingKey !== plan.cacheKey) {
          revokeHeatSurfaceImage(image);
          return;
        }

        state.surface.pendingKey = null;
        state.surface.metadata = plan.cacheMetadata;
        replaceSurfaceResource(
          state,
          createRasterResource({
            bounds: plan.overlayBounds,
            key: plan.cacheKey,
            objectUrl: image.objectUrl,
            opacity,
            projection,
            requestRender,
            url: image.url,
          }),
        );
        requestRender();
      });
    }

    return projection === "screen" ? null : getReadyRaster(current);
  }

  state.surface.requestId += 1;
  state.surface.pendingKey = null;
  const image = createHeatSurfaceDataImage(plan);
  state.surface.metadata = plan.cacheMetadata;
  const resource = createRasterResource({
    bounds: plan.overlayBounds,
    key: plan.cacheKey,
    objectUrl: image.objectUrl,
    opacity,
    projection,
    requestRender,
    url: image.url,
  });
  replaceSurfaceResource(state, resource);
  return getReadyRaster(resource);
}

function createHeatSurfaceDataImage(plan: HeatSurfaceRenderPlan): HeatLayerSurfaceImage {
  return {
    objectUrl: false,
    url:
      plan.mode === "data"
        ? createHeatLayerDataSurfaceDataUrl(plan)
        : createHeatLayerInterpolatedSurfaceDataUrl(plan),
  };
}

function createHeatSurfaceImage(plan: HeatSurfaceRenderPlan) {
  return plan.mode === "data"
    ? createHeatLayerDataSurfaceImage(plan)
    : createHeatLayerInterpolatedSurfaceImage(plan);
}

function createRasterResource({
  bounds,
  key,
  objectUrl,
  opacity,
  projection,
  requestRender,
  url,
}: {
  bounds: HeatSurfaceBounds;
  key: string;
  objectUrl: boolean;
  opacity: number;
  projection: MapsHeatRasterRenderStep["projection"];
  requestRender: () => void;
  url: string;
}): MapsHeatRasterResource {
  const image = new Image();
  const resource: MapsHeatRasterResource = {
    bounds,
    image,
    key,
    objectUrl,
    opacity,
    projection,
    url,
  };
  image.decoding = "async";
  image.onload = requestRender;
  image.onerror = requestRender;
  image.src = url;
  return resource;
}

function getReadyRaster(resource: MapsHeatRasterResource | null): MapsHeatRasterRenderStep | null {
  if (!resource?.image.complete || resource.image.naturalWidth <= 0 || resource.image.naturalHeight <= 0) {
    return null;
  }

  return resource;
}

function replaceSurfaceResource(state: MapsHeatLayerRenderState, resource: MapsHeatRasterResource) {
  if (state.surface.resource?.url !== resource.url) {
    revokeRasterResource(state.surface.resource);
  }
  state.surface.resource = resource;
}

function revokeRasterResource(resource: MapsHeatRasterResource | null) {
  if (resource?.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(resource.url);
  }
}

function revokeHeatSurfaceImage(image: HeatLayerSurfaceImage) {
  if (image.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(image.url);
  }
}

function createContourPrimitives(descriptor: MapsHeatLayerDescriptor) {
  const collection = descriptor.fieldContourCollection;
  if (!collection) return [];

  const primitives: MapVectorRenderPrimitive<unknown>[] = [];
  const lineColor = descriptor.fieldContourColor ?? "#111827";
  const lineOpacity = clamp(descriptor.fieldContourOpacity, 0, 1);
  const lineWidth = Math.max(0.25, descriptor.fieldContourLineWidth ?? 1);

  collection.features.forEach((feature, featureIndex) => {
    const geometry = feature.geometry as GeoJsonMultiLineStringGeometry | null;
    if (geometry?.type !== "MultiLineString") return;

    geometry.coordinates.forEach((line, lineIndex) => {
      const coordinates = line
        .map((coordinate) => [coordinate[0], coordinate[1]] as [number, number])
        .filter((coordinate) => coordinate.every(Number.isFinite));
      if (coordinates.length < 2) return;

      const featureId = `${descriptor.layerId}:contour:${featureIndex}:${lineIndex}`;
      const primitive: MapRenderLine<typeof feature> = {
        coordinates,
        feature,
        featureId,
        interactive: false,
        kind: "line",
        primitiveId: featureId,
        strokeColor: lineColor,
        strokeOpacity: lineOpacity,
        strokeWidth: lineWidth,
      };
      primitives.push(primitive as MapVectorRenderPrimitive<unknown>);
    });
  });

  return primitives;
}

function createDataPointPrimitives(
  descriptor: MapsHeatLayerDescriptor,
  data: HeatLayerFeatureCollection,
) {
  return data.features.map((feature, index) => {
    const featureId = feature.properties.pointId || `${descriptor.layerId}:data:${index}`;
    const primitive: MapRenderCircle<HeatLayerFeature> = {
      center: feature.geometry.coordinates,
      feature,
      featureId,
      fillColor: descriptor.dataPointColor,
      fillOpacity: clamp(descriptor.dataPointOpacity, 0, 1),
      interactive: false,
      kind: "circle",
      label: null,
      primitiveId: `${descriptor.layerId}:data:${featureId}`,
      radius: Math.max(0, descriptor.dataPointRadius),
      strokeColor: descriptor.dataPointStrokeColor,
      strokeOpacity: clamp(descriptor.dataPointOpacity, 0, 1),
      strokeWidth: Math.max(0, descriptor.dataPointStrokeWidth),
    };
    return primitive as MapVectorRenderPrimitive<unknown>;
  });
}

function createHeatSurfaceAdapter(viewport: MapsHeatLayerViewport): FlatMapAdapter {
  const adapter = {
    containerPointToLatLng([x, y]: [number, number]) {
      const coordinate = viewport.unproject(x, y);
      return coordinate
        ? { lat: coordinate[1], lng: coordinate[0] }
        : { lat: Number.NaN, lng: Number.NaN };
    },
    getContainer() {
      return {
        clientHeight: viewport.height,
        clientWidth: viewport.width,
      };
    },
    getZoom() {
      return viewport.zoom;
    },
    latLngToContainerPoint(input: { lat: number; lng: number }) {
      return viewport.project([input.lng, input.lat]) ?? { x: Number.NaN, y: Number.NaN };
    },
  };

  // The heat planner historically accepted FlatMapAdapter even though it only reads the
  // projection/viewport methods above. The first-party runtime supplies only that narrow shape;
  // no MapLibre object or MapLibre layer registration participates in this execution path.
  return adapter as unknown as FlatMapAdapter;
}
