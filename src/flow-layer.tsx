"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo } from "react";

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

export type FlowLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<FlowLayerFeature<TProperties>> & {
    flowColor?: string;
    flows: readonly MapFlow<TProperties>[];
    getFlowColor?: (feature: FlowLayerFeature<TProperties>) => string;
    getWeight?: FlowLayerWeightAccessor<TProperties>;
    layerId?: string;
    maxWeight?: number;
    maxWidth?: number;
    minWidth?: number;
    onFeatureSelect?: (feature: FlowLayerFeature<TProperties> | null) => void;
    showEndpoints?: boolean;
    weightMetric?: string;
  };

export function FlowLayer<TProperties = Record<string, unknown>>({
  flowColor = "#0f766e",
  flows,
  getFeatureId,
  getFlowColor,
  getWeight,
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

      for (const feature of features) {
        const color = getFlowColor?.(feature) ?? flowColor;
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const line = leaflet.polyline([toLeafletLatLng(feature.flow.from), toLeafletLatLng(feature.flow.to)], {
          className: joinClassNames(
            "mb-maps__flow-line",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color,
          interactive: !isMeasuring,
          opacity: 0.72,
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
    features,
    flowColor,
    getFeatureId,
    getFlowColor,
    resolvedLayerId,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    renderFeaturePopup,
    renderFeatureContextMenu,
    renderFeatureTooltip,
    selectedFeatureId,
    showEndpoints,
    surface,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

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
        const opacity = clamp(0.28 + Math.min(from.scale, to.scale) * 0.72, 0.18, 0.92);
        const position = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };

        return (
          <g
            className={joinClassNames(
              "mb-maps__globe-flow",
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
              <title>{feature.flow.label}</title>
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
