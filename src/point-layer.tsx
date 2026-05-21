"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo } from "react";

import {
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
} from "./aggregation";
import { joinClassNames, toLeafletLatLng, type MapViewportProps } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";

export type PointLayerFeature<TProperties = Record<string, unknown>> = {
  coordinates: [longitude: number, latitude: number];
  point: IndexedMapPoint<TProperties>;
};

export type PointLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<PointLayerFeature<TProperties>> & {
    filterPoint?: MapPointFilter<TProperties>;
    getPointColor?: (feature: PointLayerFeature<TProperties>) => string;
    getPointRadius?: (feature: PointLayerFeature<TProperties>) => number;
    layerId?: string;
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
    "getPointColor" | "getPointRadius" | "onFeatureSelect" | "pointColor" | "pointRadius"
  > &
    MapFeatureInteractionProps<BubbleLayerFeature<TProperties>> & {
      bubbleColor?: string;
      getBubbleColor?: (feature: BubbleLayerFeature<TProperties>) => string;
      getWeight?: BubbleLayerWeightAccessor<TProperties>;
      maxRadius?: number;
      maxWeight?: number;
      minRadius?: number;
      onFeatureSelect?: (feature: BubbleLayerFeature<TProperties> | null) => void;
      weightMetric?: string;
    };

export function PointLayer<TProperties = Record<string, unknown>>({
  filterPoint,
  getFeatureId,
  getPointColor,
  getPointRadius,
  layerId,
  onFeatureHover,
  onFeatureSelect,
  points,
  pointColor = "#0f172a",
  pointRadius = 6,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: PointLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const deferredPoints = useDeferredValue(points);
  const features = useMemo(
    () => createPointLayerFeatures(deferredPoints, { filterPoint }),
    [deferredPoints, filterPoint],
  );

  return (
    <PointFeatureLayer<PointLayerFeature<TProperties>>
      features={features}
      getFeatureId={getFeatureId}
      getPointColor={getPointColor}
      getPointRadius={getPointRadius}
      layerId={layerId}
      onFeatureHover={onFeatureHover}
      onFeatureSelect={onFeatureSelect}
      pointColor={pointColor}
      pointRadius={pointRadius}
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
  getFeatureId,
  getPointColor,
  getPointRadius,
  layerId,
  onFeatureHover,
  onFeatureSelect,
  pointColor,
  pointRadius,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: MapFeatureInteractionProps<TFeature> & {
  features: readonly TFeature[];
  getPointColor?: (feature: TFeature) => string;
  getPointRadius?: (feature: TFeature) => number;
  layerId?: string;
  onFeatureSelect?: (feature: TFeature | null) => void;
  pointColor: string;
  pointRadius: number;
}) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `point-layer-${generatedLayerId}`;

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer(resolvedLayerId, ({ isMeasuring, layer, leaflet, map }) => {
      layer.clearLayers();

      for (const feature of features) {
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const marker = leaflet.circleMarker(toLeafletLatLng(feature.coordinates), {
          className: joinClassNames(
            "mb-maps__point-marker",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color: "#ffffff",
          fillColor: getPointColor?.(feature) ?? pointColor,
          fillOpacity: 0.92,
          interactive: !isMeasuring,
          opacity: 1,
          radius: Math.max(0, getPointRadius?.(feature) ?? pointRadius),
          weight: selected ? 3 : 2,
        });

        if (!isMeasuring) {
          marker.on("click", (event: { containerPoint?: { x: number; y: number } } = {}) => {
            surface.handleFeatureClick(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
              onFeatureSelect,
              renderFeaturePopup,
            });
          });
          marker.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
            map.getContainer().style.cursor = "pointer";
            surface.handleFeatureHover(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
              onFeatureHover,
              renderFeatureTooltip,
            });
          });
          marker.on("mousemove", (event: { containerPoint?: { x: number; y: number } } = {}) => {
            surface.handleFeatureHover(feature, getFlatFeaturePosition(map, feature.coordinates, event), {
              onFeatureHover,
              renderFeatureTooltip,
            });
          });
          marker.on("mouseout", () => {
            map.getContainer().style.cursor = "";
            surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
          });
        }

        marker.addTo(layer);
      }
    });
  }, [
    features,
    getFeatureId,
    getPointColor,
    getPointRadius,
    resolvedLayerId,
    onFeatureHover,
    onFeatureSelect,
    pointColor,
    pointRadius,
    renderFeaturePopup,
    renderFeatureTooltip,
    selectedFeatureId,
    surface,
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
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const radius = Math.max(0, getPointRadius?.(feature) ?? pointRadius) * (0.72 + projected.scale * 0.28);

        return (
          <circle
            className={joinClassNames(
              "mb-maps__globe-point",
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
                onFeatureSelect,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onPointerEnter={() => {
              if (!surface.isMeasuring) {
                surface.handleFeatureHover(feature, { x: projected.x, y: projected.y }, {
                  onFeatureHover,
                  renderFeatureTooltip,
                });
              }
            }}
            onPointerLeave={() => {
              surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
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
  getBubbleColor,
  getWeight,
  layerId,
  maxRadius,
  maxWeight,
  minRadius,
  onFeatureSelect,
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
      layerId={layerId}
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

  return map.latLngToContainerPoint?.(toLeafletLatLng(coordinates)) ?? { x: 0, y: 0 };
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

export type { MapViewportProps };
