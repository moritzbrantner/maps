"use client";

import { drawCanvasGeographicRaster } from "./canvas-geographic-raster";
import {
  getHeatLayerFeatureCollectionInBounds,
  isHeatFieldContoursVisible,
  isHeatFieldRasterVisible,
} from "./heat-layer-data";
import type { HeatLayerFeature, HeatLayerFeatureCollection } from "./heat-layer-types";
import { clamp } from "./heat-layer-utils";
import {
  createMapsHeatSurfaceViewport,
  getMapsHeatLayerViewportBounds,
  projectMapsHeatLayerCoordinate,
  queryMapsHeatLayerFeatureCollection,
  type MapsHeatLayerViewportGeometry,
} from "./maps-heat-layer-bounds";
import type { MapsHeatLayerDescriptor } from "./maps-heat-layer-registration";
import type {
  MapRenderCircle,
  MapRenderLine,
  MapVectorRenderPrimitive,
} from "./map-render-frame";
import {
  createHeatSurfaceRenderPlan,
  getHeatLayerSurfaceQueryBounds,
  isHeatSurfaceCacheGeometryReusable,
  type HeatSurfaceBounds,
  type HeatSurfaceCacheMetadata,
  type HeatSurfaceRenderPlan,
  type HeatSurfaceViewport,
} from "./heat-surface-render-plan";
import {
  createHeatLayerDataSurfaceDataUrl,
  createHeatLayerDataSurfaceImage,
  createHeatLayerInterpolatedSurfaceDataUrl,
  createHeatLayerInterpolatedSurfaceImage,
  type HeatLayerSurfaceImage,
} from "./heat-surface";
import type { GeoJsonMultiLineStringGeometry } from "./temporal-geojson-types";
import { createHeatLayerSurfaceWork, type HeatLayerSurfaceWork } from "./heat-layer-work";

export type MapsHeatLayerViewport = MapsHeatLayerViewportGeometry;

export type MapsHeatRasterRenderStep = {
  bounds: HeatSurfaceBounds;
  image: HTMLImageElement;
  opacity: number;
  projection: "latitude" | "mercator" | "screen";
  /** The work counters of the render state that owns this raster; its draws count into them. */
  work: HeatLayerSurfaceWork;
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
  /** The descriptor whose inputs are known to produce the committed raster (`metadata`). */
  metadataDescriptor: MapsHeatLayerDescriptor | null;
  pendingKey: string | null;
  requestId: number;
  resource: MapsHeatRasterResource | null;
};

export type MapsHeatLayerRenderState = {
  fieldResource: MapsHeatRasterResource | null;
  surface: MapsHeatSurfaceState;
  /** Camera-path work of this layer for its whole lifetime; a reset keeps counting. */
  readonly work: HeatLayerSurfaceWork;
};

export function createMapsHeatLayerRenderState(): MapsHeatLayerRenderState {
  return {
    fieldResource: null,
    surface: {
      metadata: null,
      metadataDescriptor: null,
      pendingKey: null,
      requestId: 0,
      resource: null,
    },
    work: createHeatLayerSurfaceWork(),
  };
}

export function resetMapsHeatLayerRenderState(state: MapsHeatLayerRenderState) {
  state.surface.requestId += 1;
  state.surface.pendingKey = null;
  revokeRasterResource(state.surface.resource);
  state.surface.resource = null;
  state.surface.metadata = null;
  state.surface.metadataDescriptor = null;
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
  raster.work.rasterDraws += 1;
  if (raster.projection === "screen") {
    context.save();
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.globalAlpha = clamp(raster.opacity, 0, 1);
    context.drawImage(raster.image, 0, 0, viewport.width, viewport.height);
    context.restore();
    return true;
  }

  const triangles = drawCanvasGeographicRaster({
    bounds: raster.bounds,
    context,
    devicePixelRatio,
    image: raster.image,
    opacity: raster.opacity,
    project: (coordinate) => projectMapsHeatLayerCoordinate(viewport, coordinate),
    verticalScale: raster.projection,
  });
  raster.work.rasterDrawTriangles += triangles;
  return triangles > 0;
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
    const viewportBounds = getMapsHeatLayerViewportBounds(viewport);
    const fieldDataPointCollection = descriptor.fieldDataPointCollection;
    const data = fieldDataPointCollection
      ? queryMapsHeatLayerFeatureCollection(
          (bounds) => getHeatLayerFeatureCollectionInBounds(fieldDataPointCollection, bounds),
          viewportBounds,
        )
      : queryMapsHeatLayerFeatureCollection(
          (bounds) => descriptor.heatIndex.getFeatureCollection(bounds),
          viewportBounds,
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
  const map = createMapsHeatSurfaceViewport(viewport);
  const raster = canReuseCommittedStableRaster(descriptor, state, map)
    ? reuseCommittedStableRaster(descriptor, state)
    : planHeatSurfaceRaster(descriptor, state, viewport, map, requestRender);
  const primitives = descriptor.showDataPoints
    ? createDataPointPrimitives(
        descriptor,
        queryMapsHeatLayerFeatureCollection(
          (bounds) => descriptor.heatIndex.getFeatureCollection(bounds),
          getMapsHeatLayerViewportBounds(viewport),
        ),
      )
    : [];

  return { primitives, raster };
}

/**
 * A camera frame that stays inside the committed stable raster's geometry, with the same
 * descriptor that produced it, has nothing to recompute: the raster is geographic, the source
 * index is immutable and every planning input lives on the descriptor. Skipping the query and
 * plan keeps such frames constant in the number of points (#171 phase 2).
 */
function canReuseCommittedStableRaster(
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
  map: HeatSurfaceViewport,
) {
  const { metadata, metadataDescriptor, pendingKey, resource } = state.surface;

  return (
    metadata !== null &&
    metadataDescriptor === descriptor &&
    pendingKey === null &&
    resource?.key === metadata.key &&
    isHeatSurfaceCacheGeometryReusable({
      intensity: descriptor.heatmapIntensity,
      map,
      minZoomDeltaForRebuild: descriptor.heatmapMinZoomDeltaForRebuild,
      radius: descriptor.heatmapRadius,
      strategy: descriptor.heatmapRenderStrategy,
      surfaceCache: metadata,
    })
  );
}

function reuseCommittedStableRaster(
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
) {
  const resource = state.surface.resource!;
  state.work.surfaceRasterReuses += 1;
  resource.bounds = state.surface.metadata!.bounds;
  resource.opacity = descriptor.heatmapOpacity;
  resource.projection = "mercator";
  return getReadyRaster(resource);
}

function planHeatSurfaceRaster(
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
  viewport: MapsHeatLayerViewport,
  map: HeatSurfaceViewport,
  requestRender: () => void,
) {
  const queryBounds = getHeatLayerSurfaceQueryBounds({
    intensity: descriptor.heatmapIntensity,
    map,
    minZoomDeltaForRebuild: descriptor.heatmapMinZoomDeltaForRebuild,
    overscanRatio: descriptor.heatmapOverscanRatio,
    radius: descriptor.heatmapRadius,
    strategy: descriptor.heatmapRenderStrategy,
    surfaceCache: state.surface.metadata,
  });
  const data = queryMapsHeatLayerFeatureCollection(
    (bounds) => descriptor.heatIndex.getFeatureCollection(bounds),
    queryBounds,
  );
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
    work: state.work,
  });
  return prepareHeatSurfaceRaster(plan, descriptor, state, requestRender);
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
      pixels: image.width * image.height,
      projection: "latitude",
      requestRender,
      url: image.url,
      work: state.work,
    });
  } else {
    state.fieldResource.opacity = descriptor.fieldOpacity;
  }

  return getReadyRaster(state.fieldResource);
}

function prepareHeatSurfaceRaster(
  plan: HeatSurfaceRenderPlan | null,
  descriptor: MapsHeatLayerDescriptor,
  state: MapsHeatLayerRenderState,
  requestRender: () => void,
): MapsHeatRasterRenderStep | null {
  const asyncRender = descriptor.heatmapAsyncRender;
  const opacity = descriptor.heatmapOpacity;
  if (!plan) {
    state.surface.requestId += 1;
    state.surface.pendingKey = null;
    revokeRasterResource(state.surface.resource);
    state.surface.resource = null;
    state.surface.metadata = null;
    state.surface.metadataDescriptor = null;
    return null;
  }

  const projection = plan.strategy === "viewport-raster" ? "screen" : "mercator";
  const current = state.surface.resource;
  if (current?.key === plan.cacheKey) {
    state.work.surfaceRasterReuses += 1;
    if (state.surface.pendingKey === null && state.surface.metadata?.key === plan.cacheKey) {
      // These inputs plan exactly the committed raster.
      state.surface.metadataDescriptor = descriptor;
    }
    current.bounds = plan.overlayBounds;
    current.opacity = opacity;
    current.projection = projection;
    return getReadyRaster(current);
  }

  if (asyncRender) {
    if (state.surface.pendingKey !== plan.cacheKey) {
      const requestId = (state.surface.requestId += 1);
      state.surface.pendingKey = plan.cacheKey;
      countRasterization(state.work, plan);

      createHeatSurfaceImage(plan).then((image) => {
        if (state.surface.requestId !== requestId || state.surface.pendingKey !== plan.cacheKey) {
          state.work.surfaceResultsDiscarded += 1;
          revokeHeatSurfaceImage(image);
          return;
        }

        state.surface.pendingKey = null;
        state.surface.metadata = plan.cacheMetadata;
        state.surface.metadataDescriptor = descriptor;
        replaceSurfaceResource(
          state,
          createRasterResource({
            bounds: plan.overlayBounds,
            key: plan.cacheKey,
            objectUrl: image.objectUrl,
            opacity,
            pixels: plan.width * plan.height,
            projection,
            requestRender,
            url: image.url,
            work: state.work,
          }),
        );
        requestRender();
      });
    } else {
      state.work.surfaceRasterReuses += 1;
    }

    return projection === "screen" ? null : getReadyRaster(current);
  }

  state.surface.requestId += 1;
  state.surface.pendingKey = null;
  countRasterization(state.work, plan);
  const image = createHeatSurfaceDataImage(plan);
  state.surface.metadata = plan.cacheMetadata;
  state.surface.metadataDescriptor = descriptor;
  const resource = createRasterResource({
    bounds: plan.overlayBounds,
    key: plan.cacheKey,
    objectUrl: image.objectUrl,
    opacity,
    pixels: plan.width * plan.height,
    projection,
    requestRender,
    url: image.url,
    work: state.work,
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
  pixels,
  projection,
  requestRender,
  url,
  work,
}: {
  bounds: HeatSurfaceBounds;
  key: string;
  objectUrl: boolean;
  opacity: number;
  /** Pixels of the raster handed to the pixel backend, for the upload counters. */
  pixels: number;
  projection: MapsHeatRasterRenderStep["projection"];
  requestRender: () => void;
  url: string;
  work: HeatLayerSurfaceWork;
}): MapsHeatRasterResource {
  work.rasterUploads += 1;
  work.rasterUploadPixels += pixels;
  const image = new Image();
  const resource: MapsHeatRasterResource = {
    bounds,
    image,
    key,
    objectUrl,
    opacity,
    projection,
    url,
    work,
  };
  image.decoding = "async";
  image.onload = () => {
    work.rasterImagesDecoded += 1;
    requestRender();
  };
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
      interactive: true,
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

function countRasterization(work: HeatLayerSurfaceWork, plan: HeatSurfaceRenderPlan) {
  work.surfaceRasterizations += 1;
  work.surfaceRasterPixels += plan.width * plan.height;
}
