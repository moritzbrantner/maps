"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, type ReactNode } from "react";
import type { LayerGroup } from "leaflet";

import { joinClassNames, toLeafletLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";

export type MapFlow<TProperties = Record<string, unknown>> = {
  from: [longitude: number, latitude: number];
  id: string;
  label?: string;
  metrics?: Record<string, number>;
  properties?: TProperties;
  to: [longitude: number, latitude: number];
};

export type IndexedMapFlow<TProperties = Record<string, unknown>> = {
  from: [longitude: number, latitude: number];
  id: string;
  label: string;
  metrics: Record<string, number>;
  properties: TProperties;
  to: [longitude: number, latitude: number];
};

export type FlowLayerFeature<TProperties = Record<string, unknown>> = {
  flow: IndexedMapFlow<TProperties>;
  rawValue: number;
  value: number;
  width: number;
};

export type FlowLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  flow: IndexedMapFlow<TProperties>,
) => number;

export type FlowShape = "straight" | "arc";

export type FlowDirectionMarker = "arrow" | "none";

export type FlowLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<FlowLayerFeature<TProperties>> & {
    directionMarker?: FlowDirectionMarker;
    flowColor?: string;
    flowShape?: FlowShape;
    flowValueFormat?: (value: number, feature: FlowLayerFeature<TProperties>) => string;
    flows: readonly MapFlow<TProperties>[];
    getFlowLabel?: (feature: FlowLayerFeature<TProperties>) => ReactNode;
    getFlowColor?: (feature: FlowLayerFeature<TProperties>) => string;
    getWeight?: FlowLayerWeightAccessor<TProperties>;
    hoveredFlowOpacity?: number;
    inactiveFlowOpacity?: number;
    layerId?: string;
    maxWeight?: number;
    maxWidth?: number;
    minWidth?: number;
    onFeatureSelect?: (feature: FlowLayerFeature<TProperties> | null) => void;
    selectedFlowOpacity?: number;
    showDirection?: boolean;
    showEndpoints?: boolean;
    weightMetric?: string;
  };

export function FlowLayer<TProperties = Record<string, unknown>>({
  directionMarker = "arrow",
  flowColor = "#0f766e",
  flowShape = "straight",
  flowValueFormat = defaultFlowValueFormat,
  flows,
  getFeatureId,
  getFlowColor,
  getFlowLabel,
  getWeight,
  hoveredFlowOpacity = 0.95,
  inactiveFlowOpacity = 0.22,
  layerId,
  maxWeight,
  maxWidth,
  minWidth,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
  selectedFlowOpacity = 0.95,
  showDirection = false,
  showEndpoints = true,
  weightMetric,
}: FlowLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `flow-layer-${generatedLayerId}`;
  const deferredFlows = useDeferredValue(flows);
  const features = useMemo(
    () =>
      createFlowLayerFeatures(deferredFlows, {
        getWeight,
        maxWeight,
        maxWidth,
        minWidth,
        weightMetric,
      }),
    [deferredFlows, getWeight, maxWeight, maxWidth, minWidth, weightMetric],
  );

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer(resolvedLayerId, ({ isMeasuring, layer, leaflet, map }) => {
      layer.clearLayers();

      const hasHoveredFlow = features.some((feature) => surface.isFeatureHovered(feature, getFeatureId));

      for (const feature of features) {
        const color = getFlowColor?.(feature) ?? flowColor;
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const flowCoordinates = createFlowPathCoordinates(feature, flowShape);
        const flowLatLngs = flowCoordinates.map(toLeafletLatLng);
        const hasActiveFlow = Boolean(selectedFeatureId) || hasHoveredFlow;
        const active = selected || hovered;
        const opacity = active
          ? hovered
            ? hoveredFlowOpacity
            : selectedFlowOpacity
          : hasActiveFlow
            ? inactiveFlowOpacity
            : 0.72;
        const line = leaflet.polyline(flowLatLngs, {
          className: joinClassNames(
            "mb-maps__flow-line",
            active && "mb-maps__flow-line--active",
            hasActiveFlow && !active && "mb-maps__flow-line--inactive",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color,
          interactive: !isMeasuring,
          opacity,
          weight: selected ? feature.width + 1.5 : feature.width,
        });

        if (!isMeasuring) {
          line.on("click", (event: { containerPoint?: { x: number; y: number } } = {}) => {
            surface.handleFeatureClick(feature, getFlowPosition(map, feature, event), {
              onFeatureSelect,
              renderFeaturePopup,
            });
          });
          line.on("contextmenu", (event: LeafletFeaturePointerEvent = {}) => {
            suppressNativeContextMenu(event);
            surface.handleFeatureContextMenu(feature, getFlowPosition(map, feature, event), {
              coordinates: getFlowCenter(feature),
              onFeatureContextMenu,
              onFeatureSelect,
              renderFeatureContextMenu,
              renderFeaturePopup,
            });
          });
          line.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
            map.getContainer().style.cursor = "pointer";
            surface.handleFeatureHover(feature, getFlowPosition(map, feature, event), {
              onFeatureHover,
              renderFeatureTooltip,
            });
          });
          line.on("mouseout", () => {
            map.getContainer().style.cursor = "";
            surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
          });
        }

        line.addTo(layer);

        if (showDirection && directionMarker === "arrow") {
          addFlowArrowMarker({
            color,
            feature,
            flowCoordinates,
            leaflet,
            map,
            opacity,
            overlay: layer,
          });
        }

        if (showEndpoints) {
          leaflet
            .circleMarker(toLeafletLatLng(feature.flow.from), {
              className: "mb-maps__flow-endpoint mb-maps__flow-endpoint--from",
              color: "#ffffff",
              fillColor: color,
              fillOpacity: 0.9,
              interactive: false,
              opacity: 1,
              radius: Math.max(3, feature.width * 0.55),
              weight: 1.5,
            })
            .addTo(layer);
          leaflet
            .circleMarker(toLeafletLatLng(feature.flow.to), {
              className: "mb-maps__flow-endpoint mb-maps__flow-endpoint--to",
              color: "#ffffff",
              fillColor: color,
              fillOpacity: 0.95,
              interactive: false,
              opacity: 1,
              radius: Math.max(4, feature.width * 0.75),
              weight: 1.5,
            })
            .addTo(layer);
        }
      }
    });
  }, [
    directionMarker,
    features,
    flowColor,
    flowShape,
    getFeatureId,
    getFlowColor,
    hoveredFlowOpacity,
    inactiveFlowOpacity,
    resolvedLayerId,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    renderFeaturePopup,
    renderFeatureContextMenu,
    renderFeatureTooltip,
    selectedFeatureId,
    selectedFlowOpacity,
    showDirection,
    showEndpoints,
    surface,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  const hasHoveredFlow = features.some((feature) => surface.isFeatureHovered(feature, getFeatureId));

  return (
    <>
      {features.map((feature) => {
        const from = surface.projectGlobeCoordinate(feature.flow.from, surface.viewState);
        const to = surface.projectGlobeCoordinate(feature.flow.to, surface.viewState);

        if (!from.visible && !to.visible) {
          return null;
        }

        const color = getFlowColor?.(feature) ?? flowColor;
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const baseOpacity = clamp(0.28 + Math.min(from.scale, to.scale) * 0.72, 0.18, 0.92);
        const hasActiveFlow = Boolean(selectedFeatureId) || hasHoveredFlow;
        const active = selected || hovered;
        const opacity = active
          ? hovered
            ? hoveredFlowOpacity
            : selectedFlowOpacity
          : hasActiveFlow
            ? inactiveFlowOpacity
            : baseOpacity;
        const position = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
        const title = formatFlowTitle(feature, getFlowLabel, flowValueFormat);

        return (
          <g
            className={joinClassNames(
              "mb-maps__globe-flow",
              active && "mb-maps__flow-line--active",
              hasActiveFlow && !active && "mb-maps__flow-line--inactive",
              hovered && "mb-maps__feature--hovered",
              selected && "mb-maps__feature--selected",
            )}
            key={feature.flow.id}
            onClick={(event) => {
              event.stopPropagation();
              surface.handleFeatureClick(feature, position, {
                onFeatureSelect,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              surface.handleFeatureContextMenu(feature, position, {
                coordinates: getFlowCenter(feature),
                onFeatureContextMenu,
                onFeatureSelect,
                renderFeatureContextMenu,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onPointerEnter={() => {
              if (!surface.isMeasuring) {
                surface.handleFeatureHover(feature, position, {
                  onFeatureHover,
                  renderFeatureTooltip,
                });
              }
            }}
            onPointerLeave={() => {
              surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
            }}
            style={{ opacity }}
          >
            <path
              d={`M${from.x.toFixed(2)} ${from.y.toFixed(2)}L${to.x.toFixed(2)} ${to.y.toFixed(2)}`}
              stroke={color}
              strokeWidth={selected ? feature.width + 1.5 : feature.width}
            >
              <title>{title}</title>
            </path>
            {showEndpoints && from.visible ? (
              <circle cx={from.x} cy={from.y} fill={color} r={Math.max(2.5, feature.width * 0.52)} />
            ) : null}
            {showEndpoints && to.visible ? (
              <circle cx={to.x} cy={to.y} fill={color} r={Math.max(3.5, feature.width * 0.72)} />
            ) : null}
          </g>
        );
      })}
    </>
  );
}

function getFlowCenter<TProperties>(
  feature: FlowLayerFeature<TProperties>,
): [longitude: number, latitude: number] {
  return [
    (feature.flow.from[0] + feature.flow.to[0]) / 2,
    (feature.flow.from[1] + feature.flow.to[1]) / 2,
  ];
}

export function createFlowLayerFeatures<TProperties = Record<string, unknown>>(
  flows: readonly MapFlow<TProperties>[],
  options: {
    getWeight?: FlowLayerWeightAccessor<TProperties>;
    maxWeight?: number;
    maxWidth?: number;
    minWidth?: number;
    weightMetric?: string;
  } = {},
): Array<FlowLayerFeature<TProperties>> {
  const indexedFlows = flows.map(toIndexedFlow).filter(isValidFlow);
  const weightedFlows = indexedFlows
    .map((flow) => ({
      flow,
      rawValue: resolveFlowWeight(flow, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFlows.map((entry) => entry.rawValue));
  const minWidth = Math.max(0, options.minWidth ?? 1.5);
  const maxWidth = Math.max(minWidth, options.maxWidth ?? 12);

  return weightedFlows.map(({ flow, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      flow,
      rawValue,
      value,
      width: minWidth + Math.sqrt(value) * (maxWidth - minWidth),
    };
  });
}

export function getBoundsFromFlows<TProperties>(flows: readonly MapFlow<TProperties>[]) {
  const coordinates = flows
    .flatMap((flow) => [flow.from, flow.to])
    .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));

  if (coordinates.length === 0) {
    return null;
  }

  return coordinates.reduce(
    (bounds, [longitude, latitude]) =>
      [
        Math.min(bounds[0], longitude),
        Math.min(bounds[1], latitude),
        Math.max(bounds[2], longitude),
        Math.max(bounds[3], latitude),
      ] as [number, number, number, number],
    [180, 90, -180, -90] as [number, number, number, number],
  );
}

function getFlowPosition<TProperties>(
  map: { latLngToContainerPoint?: (latLng: [number, number]) => { x: number; y: number } },
  feature: FlowLayerFeature<TProperties>,
  event: { containerPoint?: { x: number; y: number } },
) {
  if (event.containerPoint) {
    return event.containerPoint;
  }

  const midpoint: [number, number] = [
    (feature.flow.from[0] + feature.flow.to[0]) / 2,
    (feature.flow.from[1] + feature.flow.to[1]) / 2,
  ];

  return map.latLngToContainerPoint?.(toLeafletLatLng(midpoint)) ?? { x: 0, y: 0 };
}

export function createFlowPathCoordinates<TProperties>(
  feature: FlowLayerFeature<TProperties>,
  shape: FlowShape = "straight",
): Array<[longitude: number, latitude: number]> {
  const from = feature.flow.from;
  const to = feature.flow.to;

  if (shape !== "arc") {
    return [from, to];
  }

  const deltaLongitude = to[0] - from[0];
  const deltaLatitude = to[1] - from[1];
  const distance = Math.hypot(deltaLongitude, deltaLatitude);

  if (distance <= 0) {
    return [from, to];
  }

  const offset = clamp(distance * 0.22, 0, 4);
  const direction = getFlowArcDirection(feature.flow.id);
  const control: [number, number] = [
    (from[0] + to[0]) / 2 + (-deltaLatitude / distance) * offset * direction,
    (from[1] + to[1]) / 2 + (deltaLongitude / distance) * offset * direction,
  ];
  const coordinates: Array<[longitude: number, latitude: number]> = [];

  for (let index = 0; index < 24; index += 1) {
    const t = index / 23;
    const inverse = 1 - t;

    coordinates.push([
      inverse * inverse * from[0] + 2 * inverse * t * control[0] + t * t * to[0],
      inverse * inverse * from[1] + 2 * inverse * t * control[1] + t * t * to[1],
    ]);
  }

  return coordinates;
}

export function addFlowArrowMarker<TProperties>({
  color,
  feature,
  flowCoordinates,
  leaflet,
  map,
  opacity,
  overlay,
}: {
  color: string;
  feature: FlowLayerFeature<TProperties>;
  flowCoordinates: Array<[longitude: number, latitude: number]>;
  leaflet: typeof import("leaflet");
  map: {
    latLngToContainerPoint?: (latLng: [number, number]) => { x: number; y: number };
  };
  opacity: number;
  overlay: LayerGroup;
}) {
  if (!leaflet.divIcon || !leaflet.marker || flowCoordinates.length < 2) {
    return;
  }

  const to = flowCoordinates.at(-1)!;
  const previous = flowCoordinates.at(-2)!;
  const toPoint = map.latLngToContainerPoint?.(toLeafletLatLng(to));
  const previousPoint = map.latLngToContainerPoint?.(toLeafletLatLng(previous));
  const rotation =
    toPoint && previousPoint
      ? (Math.atan2(toPoint.y - previousPoint.y, toPoint.x - previousPoint.x) * 180) / Math.PI
      : 0;
  const size = clamp(feature.width * 1.35, 9, 22);
  const icon = leaflet.divIcon({
    className: "mb-maps__flow-arrow",
    html: `<span class="mb-maps__flow-arrow-glyph" style="--mb-maps-flow-arrow-color: ${escapeFlowCssValue(
      color,
    )}; --mb-maps-flow-arrow-opacity: ${opacity}; --mb-maps-flow-arrow-rotation: ${rotation}deg; --mb-maps-flow-arrow-size: ${size}px;"></span>`,
    iconAnchor: [size * 0.62, size / 2],
    iconSize: [size, size],
  });

  leaflet
    .marker(toLeafletLatLng(to), {
      icon,
      interactive: false,
      keyboard: false,
      opacity,
    })
    .addTo(overlay);
}

function getFlowArcDirection(id: string) {
  let hash = 0;

  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }

  return hash % 2 === 0 ? 1 : -1;
}

function formatFlowTitle<TProperties>(
  feature: FlowLayerFeature<TProperties>,
  getFlowLabel: ((feature: FlowLayerFeature<TProperties>) => ReactNode) | undefined,
  flowValueFormat: (value: number, feature: FlowLayerFeature<TProperties>) => string,
) {
  const label = getFlowLabel?.(feature) ?? feature.flow.label;
  const labelText =
    typeof label === "string" || typeof label === "number" ? String(label) : feature.flow.label;
  const valueText = flowValueFormat(feature.rawValue, feature);

  return labelText ? `${labelText}: ${valueText}` : valueText;
}

function defaultFlowValueFormat(value: number) {
  return String(Math.round(value));
}

function escapeFlowCssValue(value: string) {
  return value.replace(/[;"'<>]/g, "");
}

type LeafletFeaturePointerEvent = {
  containerPoint?: { x: number; y: number };
  originalEvent?: {
    preventDefault?: () => void;
  };
};

function suppressNativeContextMenu(event: LeafletFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
}

function resolveFlowWeight<TProperties>(
  flow: IndexedMapFlow<TProperties>,
  options: {
    getWeight?: FlowLayerWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(flow)
    : options.weightMetric
      ? flow.metrics[options.weightMetric] ?? 0
      : flow.metrics.weight ?? 1;

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
}

function toIndexedFlow<TProperties>(
  flow: MapFlow<TProperties>,
  index: number,
): IndexedMapFlow<TProperties> {
  return {
    from: flow.from,
    id: String(flow.id ?? index),
    label: flow.label ?? "",
    metrics: flow.metrics ?? {},
    properties: flow.properties ?? ({} as TProperties),
    to: flow.to,
  };
}

function isValidFlow<TProperties>(flow: IndexedMapFlow<TProperties>) {
  return (
    Number.isFinite(flow.from[0]) &&
    Number.isFinite(flow.from[1]) &&
    Number.isFinite(flow.to[0]) &&
    Number.isFinite(flow.to[1])
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
