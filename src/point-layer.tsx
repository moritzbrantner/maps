"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, useRef } from "react";

import {
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
} from "./aggregation";
import { joinClassNames, toLatLng, type MapViewportProps } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import type { FlatLayer, FlatLayerGroup } from "./maplibre-compat";

export type PointLayerFeature<TProperties = Record<string, unknown>> = {
  coordinates: [longitude: number, latitude: number];
  point: IndexedMapPoint<TProperties>;
};

export type PointLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<PointLayerFeature<TProperties>> & {
    draggable?: boolean | ((feature: PointLayerFeature<TProperties>) => boolean);
    filterPoint?: MapPointFilter<TProperties>;
    getPointColor?: (feature: PointLayerFeature<TProperties>) => string;
    getPointRadius?: (feature: PointLayerFeature<TProperties>) => number;
    layerId?: string;
    onFeatureDrag?: (
      feature: PointLayerFeature<TProperties>,
      coordinates: [longitude: number, latitude: number],
    ) => void;
    onFeatureDragEnd?: (
      feature: PointLayerFeature<TProperties>,
      coordinates: [longitude: number, latitude: number],
    ) => void;
    onFeatureSelect?: (feature: PointLayerFeature<TProperties> | null) => void;
    points: readonly MapPoint<TProperties>[];
    pointColor?: string;
    pointRadius?: number;
  };

export type BubbleLayerFeature<TProperties = Record<string, unknown>> =
  PointLayerFeature<TProperties> & {
    rawValue: number;
    radius: number;
    value: number;
  };

export type BubbleLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type BubbleLayerProps<TProperties = Record<string, unknown>> =
  Omit<
    PointLayerProps<TProperties>,
    | "draggable"
    | "getPointColor"
    | "getPointRadius"
    | "onFeatureDrag"
    | "onFeatureDragEnd"
    | "onFeatureSelect"
    | "pointColor"
    | "pointRadius"
  > &
  MapFeatureInteractionProps<BubbleLayerFeature<TProperties>> & {
      bubbleColor?: string;
      draggable?: boolean | ((feature: BubbleLayerFeature<TProperties>) => boolean);
      getBubbleColor?: (feature: BubbleLayerFeature<TProperties>) => string;
      getWeight?: BubbleLayerWeightAccessor<TProperties>;
      maxRadius?: number;
      maxWeight?: number;
      minRadius?: number;
      onFeatureDrag?: (
        feature: BubbleLayerFeature<TProperties>,
        coordinates: [longitude: number, latitude: number],
      ) => void;
      onFeatureDragEnd?: (
        feature: BubbleLayerFeature<TProperties>,
        coordinates: [longitude: number, latitude: number],
      ) => void;
      onFeatureSelect?: (feature: BubbleLayerFeature<TProperties> | null) => void;
      weightMetric?: string;
    };

export function PointLayer<TProperties = Record<string, unknown>>({
  filterPoint,
  draggable,
  getFeatureId,
  getPointColor,
  getPointRadius,
  hoveredFeatureId,
  layerId,
  onHoveredFeatureIdChange,
  onFeatureContextMenu,
  onFeatureDrag,
  onFeatureDragEnd,
  onFeatureHover,
  onFeatureSelect,
  onSelectedFeatureIdChange,
  points,
  pointColor = "#0f172a",
  pointRadius = 6,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: PointLayerProps<TProperties>) {
  const deferredPoints = useDeferredValue(points);
  const features = useMemo(
    () => createPointLayerFeatures(deferredPoints, { filterPoint }),
    [deferredPoints, filterPoint],
  );

  return (
    <PointFeatureLayer<PointLayerFeature<TProperties>>
      features={features}
      draggable={draggable}
      getFeatureId={getFeatureId}
      getPointColor={getPointColor}
      getPointRadius={getPointRadius}
      hoveredFeatureId={hoveredFeatureId}
      layerId={layerId}
      onHoveredFeatureIdChange={onHoveredFeatureIdChange}
      onFeatureContextMenu={onFeatureContextMenu}
      onFeatureDrag={onFeatureDrag}
      onFeatureDragEnd={onFeatureDragEnd}
      onFeatureHover={onFeatureHover}
      onFeatureSelect={onFeatureSelect}
      onSelectedFeatureIdChange={onSelectedFeatureIdChange}
      pointColor={pointColor}
      pointRadius={pointRadius}
      renderFeatureContextMenu={renderFeatureContextMenu}
      renderFeaturePopup={renderFeaturePopup}
      renderFeatureTooltip={renderFeatureTooltip}
      selectedFeatureId={selectedFeatureId}
    />
  );
}

function PointFeatureLayer<
  TFeature extends {
    coordinates: [longitude: number, latitude: number];
    point: {
      id: string;
      label: string;
    };
  },
>({
  features,
  draggable,
  getFeatureId,
  getPointColor,
  getPointRadius,
  hoveredFeatureId,
  layerId,
  onHoveredFeatureIdChange,
  onFeatureContextMenu,
  onFeatureDrag,
  onFeatureDragEnd,
  onFeatureHover,
  onFeatureSelect,
  onSelectedFeatureIdChange,
  pointColor,
  pointRadius,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: MapFeatureInteractionProps<TFeature> & {
  draggable?: boolean | ((feature: TFeature) => boolean);
  features: readonly TFeature[];
  getPointColor?: (feature: TFeature) => string;
  getPointRadius?: (feature: TFeature) => number;
  layerId?: string;
  onFeatureDrag?: (feature: TFeature, coordinates: [longitude: number, latitude: number]) => void;
  onFeatureDragEnd?: (feature: TFeature, coordinates: [longitude: number, latitude: number]) => void;
  onFeatureSelect?: (feature: TFeature | null) => void;
  pointColor: string;
  pointRadius: number;
}) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `point-layer-${generatedLayerId}`;
  const isFlatSurface = surface?.display === "flat";
  const surfaceRef = useRef(surface);
  const flatMarkerCacheRef = useRef<Map<string, FlatPointCacheEntry>>(new Map());
  const globeDragRef = useRef<{
    feature: TFeature;
    pointerId: number;
  } | null>(null);

  useEffect(() => {
    surfaceRef.current = surface;
  });

  useEffect(() => {
    if (!isFlatSurface) {
      flatMarkerCacheRef.current.clear();
      return;
    }

    return surfaceRef.current?.registerFlatLayer(
      resolvedLayerId,
      ({ isMeasuring, layer, flat, map }) => {
        const currentSurface = surfaceRef.current;

        if (!currentSurface) {
          return;
        }

        const cache = flatMarkerCacheRef.current;
        const seen = new Set<string>();
        const preparedFeatures = features.map((feature) => {
          const selected = currentSurface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
          const hovered = currentSurface.isFeatureHovered(feature, hoveredFeatureId, getFeatureId);
          const featureDraggable = isFeatureDraggable(feature, draggable);
          const featureKey = getFlatPointFeatureKey(feature, getFeatureId);
          const coordinatesKey = createFlatPointCoordinatesKey(feature.coordinates);
          const fillColor = getPointColor?.(feature) ?? pointColor;
          const radius = Math.max(0, getPointRadius?.(feature) ?? pointRadius);
          const signature = createFlatPointSignature({
            featureDraggable,
            fillColor,
            hovered,
            isMeasuring,
            radius,
            selected,
          });

          return {
            coordinatesKey,
            feature,
            featureDraggable,
            featureKey,
            fillColor,
            hovered,
            radius,
            selected,
            signature,
          };
        });

        if (
          (cache.size === 0 && layer.layers.length > 0) ||
          preparedFeatures.some((entry) => {
            const cached = cache.get(entry.featureKey);

            return cached && cached.signature !== entry.signature;
          })
        ) {
          layer.clearLayers();
          cache.clear();
        }

        for (const {
          coordinatesKey,
          feature,
          featureDraggable,
          featureKey,
          fillColor,
          hovered,
          radius,
          selected,
          signature,
        } of preparedFeatures) {
          const cached = cache.get(featureKey);

          seen.add(featureKey);

          if (cached?.signature === signature) {
            if (cached.coordinatesKey !== coordinatesKey) {
              for (const cachedLayer of cached.layers) {
                cachedLayer.setLatLng?.(toLatLng(feature.coordinates));
              }
              cached.coordinatesKey = coordinatesKey;
            }
            continue;
          }

          if (cached) {
            removeFlatPointCacheEntry(layer, cached);
          }

          const marker = flat.circleMarker(toLatLng(feature.coordinates), {
            bubblingMouseEvents: false,
            className: joinClassNames(
              "mb-maps__point-marker",
              featureDraggable && "mb-maps__feature--draggable",
              hovered && "mb-maps__feature--hovered",
              selected && "mb-maps__feature--selected",
            ),
            color: "#ffffff",
            fillColor,
            fillOpacity: 0.92,
            interactive: !isMeasuring,
            opacity: 1,
            radius,
            weight: selected ? 3 : 2,
          });

          if (!isMeasuring) {
            marker.on("click", (event: { containerPoint?: { x: number; y: number } } = {}) => {
              currentSurface.handleFeatureClick(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
                getFeatureId,
                onFeatureSelect,
                onSelectedFeatureIdChange,
                renderFeaturePopup,
              });
            });
            marker.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
              suppressNativeContextMenu(event);
              currentSurface.handleFeatureContextMenu(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
                coordinates: feature.coordinates,
                getFeatureId,
                onFeatureContextMenu,
                onFeatureSelect,
                onSelectedFeatureIdChange,
                renderFeatureContextMenu,
                renderFeaturePopup,
              });
            });
            if (featureDraggable) {
              bindFlatPointDrag(marker as FlatPointMarker, {
                coordinates: feature.coordinates,
                feature,
                map: map as FlatDragMap,
                onFeatureDrag,
                onFeatureDragEnd,
              });
            }
            marker.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
              map.getContainer().style.cursor = featureDraggable ? "grab" : "pointer";
              currentSurface.handleFeatureHover(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
                getFeatureId,
                onHoveredFeatureIdChange,
                onFeatureHover,
                renderFeatureTooltip,
              });
            });
            marker.on("mousemove", (event: { containerPoint?: { x: number; y: number } } = {}) => {
              currentSurface.handleFeatureHover(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
                getFeatureId,
                onHoveredFeatureIdChange,
                onFeatureHover,
                renderFeatureTooltip,
              });
            });
            marker.on("mouseout", () => {
              map.getContainer().style.cursor = "";
              currentSurface.handleFeatureHover(null, null, {
                getFeatureId,
                onHoveredFeatureIdChange,
                onFeatureHover,
                renderFeatureTooltip,
              });
            });
          }

          marker.addTo(layer);
          cache.set(featureKey, {
            coordinatesKey,
            layers: [marker],
            signature,
          });
        }

        for (const [featureKey, cached] of cache) {
          if (seen.has(featureKey)) {
            continue;
          }

          removeFlatPointCacheEntry(layer, cached);
          cache.delete(featureKey);
        }
      },
      { preserveOnRender: true, renderOnViewStateChange: false },
    );
  }, [
    features,
    draggable,
    getFeatureId,
    getPointColor,
    getPointRadius,
    hoveredFeatureId,
    resolvedLayerId,
    onFeatureContextMenu,
    onFeatureDrag,
    onFeatureDragEnd,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    pointColor,
    pointRadius,
    renderFeaturePopup,
    renderFeatureContextMenu,
    renderFeatureTooltip,
    selectedFeatureId,
    isFlatSurface,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  return (
    <>
      {features.map((feature) => {
        const projected = surface.projectGlobeCoordinate(feature.coordinates, surface.viewState);

        if (!projected.visible) {
          return null;
        }

        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, hoveredFeatureId, getFeatureId);
        const featureDraggable = isFeatureDraggable(feature, draggable);
        const radius = Math.max(0, getPointRadius?.(feature) ?? pointRadius) * (0.72 + projected.scale * 0.28);

        return (
          <circle
            className={joinClassNames(
              "mb-maps__globe-point",
              featureDraggable && "mb-maps__feature--draggable",
              hovered && "mb-maps__feature--hovered",
              selected && "mb-maps__feature--selected",
            )}
            cx={projected.x}
            cy={projected.y}
            fill={getPointColor?.(feature) ?? pointColor}
            key={feature.point.id}
            onClick={(event) => {
              event.stopPropagation();
              surface.handleFeatureClick(feature, { x: projected.x, y: projected.y }, {
                getFeatureId,
                onFeatureSelect,
                onSelectedFeatureIdChange,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              surface.handleFeatureContextMenu(feature, { x: projected.x, y: projected.y }, {
                coordinates: feature.coordinates,
                getFeatureId,
                onFeatureContextMenu,
                onFeatureSelect,
                onSelectedFeatureIdChange,
                renderFeatureContextMenu,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onPointerDown={(event) => {
              if (!featureDraggable || surface.isMeasuring) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              globeDragRef.current = {
                feature,
                pointerId: event.pointerId,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = globeDragRef.current;

              if (!drag || drag.pointerId !== event.pointerId || drag.feature !== feature) {
                return;
              }

              const coordinates = surface.getGlobePointerCoordinate(event);

              if (!coordinates) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              onFeatureDrag?.(feature, coordinates);
            }}
            onPointerUp={(event) => {
              const drag = globeDragRef.current;

              if (!drag || drag.pointerId !== event.pointerId || drag.feature !== feature) {
                return;
              }

              const coordinates = surface.getGlobePointerCoordinate(event);
              globeDragRef.current = null;
              event.preventDefault();
              event.stopPropagation();

              if (coordinates) {
                onFeatureDragEnd?.(feature, coordinates);
              }
            }}
            onPointerEnter={() => {
              if (!surface.isMeasuring) {
                surface.handleFeatureHover(feature, { x: projected.x, y: projected.y }, {
                  getFeatureId,
                  onHoveredFeatureIdChange,
                  onFeatureHover,
                  renderFeatureTooltip,
                });
              }
            }}
            onPointerLeave={() => {
              surface.handleFeatureHover(null, null, {
                getFeatureId,
                onHoveredFeatureIdChange,
                onFeatureHover,
                renderFeatureTooltip,
              });
            }}
            r={radius}
            style={{ opacity: 0.42 + projected.scale * 0.58 }}
          >
            <title>{feature.point.label}</title>
          </circle>
        );
      })}
    </>
  );
}

export function BubbleLayer<TProperties = Record<string, unknown>>({
  bubbleColor = "#2563eb",
  filterPoint,
  draggable,
  getBubbleColor,
  getWeight,
  layerId,
  maxRadius,
  maxWeight,
  minRadius,
  onFeatureSelect,
  onFeatureDrag,
  onFeatureDragEnd,
  points,
  weightMetric,
  ...interactionProps
}: BubbleLayerProps<TProperties>) {
  const deferredPoints = useDeferredValue(points);
  const features = useMemo(
    () =>
      createBubbleLayerFeatures(deferredPoints, {
        filterPoint,
        getWeight,
        maxRadius,
        maxWeight,
        minRadius,
        weightMetric,
      }),
    [deferredPoints, filterPoint, getWeight, maxRadius, maxWeight, minRadius, weightMetric],
  );

  return (
    <PointFeatureLayer<BubbleLayerFeature<TProperties>>
      {...interactionProps}
      features={features}
      getPointColor={(feature) => getBubbleColor?.(feature) ?? bubbleColor}
      getPointRadius={(feature) => feature.radius}
      draggable={draggable}
      layerId={layerId}
      onFeatureDrag={onFeatureDrag}
      onFeatureDragEnd={onFeatureDragEnd}
      onFeatureSelect={onFeatureSelect}
      pointColor={bubbleColor}
      pointRadius={6}
    />
  );
}

export function createPointLayerFeatures<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
  } = {},
): Array<PointLayerFeature<TProperties>> {
  return points
    .map(toIndexedMapPoint)
    .filter(isValidPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      coordinates: [point.longitude, point.latitude],
      point,
    }));
}

export function createBubbleLayerFeatures<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: BubbleLayerWeightAccessor<TProperties>;
    maxRadius?: number;
    maxWeight?: number;
    minRadius?: number;
    weightMetric?: string;
  } = {},
): Array<BubbleLayerFeature<TProperties>> {
  const baseFeatures = createPointLayerFeatures(points, { filterPoint: options.filterPoint });
  const weightedFeatures = baseFeatures
    .map((feature) => ({
      feature,
      rawValue: resolveBubblePointWeight(feature.point, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFeatures.map((entry) => entry.rawValue));
  const minRadius = Math.max(0, options.minRadius ?? 5);
  const maxRadius = Math.max(minRadius, options.maxRadius ?? 32);

  return weightedFeatures.map(({ feature, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      ...feature,
      rawValue,
      radius: minRadius + Math.sqrt(value) * (maxRadius - minRadius),
      value,
    };
  });
}

function getFlatFeaturePosition(
  map: { latLngToContainerPoint?: (latLng: [number, number]) => { x: number; y: number } },
  coordinates: [number, number],
  event: { containerPoint?: { x: number; y: number } },
) {
  if (event.containerPoint) {
    return event.containerPoint;
  }

  return map.latLngToContainerPoint?.(toLatLng(coordinates)) ?? { x: 0, y: 0 };
}

function bindFlatPointDrag<TFeature>(
  marker: FlatPointMarker,
  options: {
    coordinates: [longitude: number, latitude: number];
    feature: TFeature;
    map: FlatDragMap;
    onFeatureDrag?: (feature: TFeature, coordinates: [longitude: number, latitude: number]) => void;
    onFeatureDragEnd?: (feature: TFeature, coordinates: [longitude: number, latitude: number]) => void;
  },
) {
  let dragStart:
    | {
        coordinates: [number, number];
        pointer: [number, number];
      }
    | null = null;
  let lastCoordinates: [number, number] | null = null;

  const handleMove = (event: FlatDragEvent = {}) => {
    const pointerCoordinates = getFlatDragCoordinates(options.map, event);
    const coordinates = dragStart && pointerCoordinates
      ? getOffsetDragCoordinates(dragStart, pointerCoordinates)
      : pointerCoordinates;

    if (!coordinates) {
      return;
    }

    lastCoordinates = coordinates;
    marker.setLatLng?.(toLatLng(coordinates));
    options.onFeatureDrag?.(options.feature, coordinates);
  };

  const handleUp = (event: FlatDragEvent = {}) => {
    const pointerCoordinates = getFlatDragCoordinates(options.map, event);
    const coordinates =
      dragStart && pointerCoordinates
        ? getOffsetDragCoordinates(dragStart, pointerCoordinates)
        : pointerCoordinates ?? lastCoordinates;

    options.map.off?.("mousemove", handleMove);
    options.map.off?.("mouseup", handleUp);
    options.map.dragging?.enable?.();
    const container = options.map.getContainer?.();
    if (container) {
      container.style.cursor = "";
    }

    if (coordinates) {
      marker.setLatLng?.(toLatLng(coordinates));
      options.onFeatureDragEnd?.(options.feature, coordinates);
    }

    dragStart = null;
    lastCoordinates = null;
  };

  marker.on("mousedown", (event: FlatDragEvent = {}) => {
    suppressNativeContextMenu(event);
    const pointerCoordinates = getFlatDragCoordinates(options.map, event);

    dragStart = pointerCoordinates
      ? {
          coordinates: options.coordinates,
          pointer: pointerCoordinates,
        }
      : null;
    lastCoordinates = options.coordinates;
    marker.bringToFront?.();
    options.map.dragging?.disable?.();
    const container = options.map.getContainer?.();
    if (container) {
      container.style.cursor = "grabbing";
    }
    options.map.on?.("mousemove", handleMove);
    options.map.on?.("mouseup", handleUp);
  });
}

function getFlatDragCoordinates(map: FlatDragMap, event: FlatDragEvent) {
  if (event.latlng) {
    return [event.latlng.lng, event.latlng.lat] as [number, number];
  }

  if (event.containerPoint && map.containerPointToLatLng) {
    const latlng = map.containerPointToLatLng([event.containerPoint.x, event.containerPoint.y]);

    return [latlng.lng, latlng.lat] as [number, number];
  }

  return null;
}

function getOffsetDragCoordinates(
  start: {
    coordinates: [number, number];
    pointer: [number, number];
  },
  pointerCoordinates: [number, number],
) {
  return [
    start.coordinates[0] + pointerCoordinates[0] - start.pointer[0],
    start.coordinates[1] + pointerCoordinates[1] - start.pointer[1],
  ] as [number, number];
}

function isFeatureDraggable<TFeature>(
  feature: TFeature,
  draggable: boolean | ((feature: TFeature) => boolean) | undefined,
) {
  return typeof draggable === "function" ? draggable(feature) : draggable === true;
}

type FlatPointMarker = {
  bringToFront?: () => void;
  on: (event: string, handler: (event?: FlatDragEvent) => void) => FlatPointMarker;
  setLatLng?: (latLng: [number, number]) => void;
};

type FlatDragMap = {
  containerPointToLatLng?: (point: [number, number]) => { lat: number; lng: number };
  dragging?: {
    disable?: () => void;
    enable?: () => void;
  };
  getContainer?: () => { style: { cursor: string } };
  off?: (event: string, handler: (event?: FlatDragEvent) => void) => void;
  on?: (event: string, handler: (event?: FlatDragEvent) => void) => void;
};

type FlatDragEvent = FlatFeaturePointerEvent & {
  latlng?: { lat: number; lng: number };
};

type FlatPointCacheEntry = {
  coordinatesKey: string;
  layers: FlatLayer[];
  signature: string;
};

type FlatFeaturePointerEvent = {
  containerPoint?: { x: number; y: number };
  originalEvent?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
};

function suppressNativeContextMenu(event: FlatFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
  event.originalEvent?.stopPropagation?.();
}

function resolveBubblePointWeight<TProperties>(
  point: IndexedMapPoint<TProperties>,
  options: {
    getWeight?: BubbleLayerWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(point)
    : options.weightMetric
      ? point.metrics[options.weightMetric] ?? 0
      : point.metrics.weight ?? 1;

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
}

function toIndexedMapPoint<TProperties>(
  point: MapPoint<TProperties>,
  index: number,
): IndexedMapPoint<TProperties> {
  return {
    id: String(point.id ?? index),
    label: point.label ?? "",
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: point.metrics ?? {},
    properties: point.properties ?? ({} as TProperties),
  };
}

function isValidPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getFlatPointFeatureKey<TFeature>(
  feature: TFeature & {
    coordinates: [longitude: number, latitude: number];
    point: {
      id: string;
    };
  },
  getFeatureId?: (feature: TFeature) => string,
) {
  return getFeatureId?.(feature) || feature.point.id || feature.coordinates.join(",");
}

function createFlatPointCoordinatesKey(coordinates: [longitude: number, latitude: number]) {
  return coordinates.join(",");
}

function createFlatPointSignature({
  featureDraggable,
  fillColor,
  hovered,
  isMeasuring,
  radius,
  selected,
}: {
  featureDraggable: boolean;
  fillColor: string;
  hovered: boolean;
  isMeasuring: boolean;
  radius: number;
  selected: boolean;
}) {
  return JSON.stringify({
    featureDraggable,
    fillColor,
    hovered,
    interactive: !isMeasuring,
    radius,
    selected,
  });
}

function removeFlatPointCacheEntry(layer: FlatLayerGroup, entry: FlatPointCacheEntry) {
  for (const cachedLayer of entry.layers) {
    layer.removeLayer(cachedLayer);
  }
}

export type { MapViewportProps };
