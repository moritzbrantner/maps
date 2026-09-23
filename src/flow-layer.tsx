"use client";

import {
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { joinClassNames, toLatLng } from "./map-display";
import type { FlatLayer, FlatLayerFactory, FlatLayerGroup } from "./maplibre-compat";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import { createFlowLayerFeatures, createFlowPathCoordinates } from "./flow-layer-data";
export { createFlowLayerFeatures, createFlowPathCoordinates } from "./flow-layer-data";
import { reconcileFlatLayerEntries } from "./flat-layer-reconciler";

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

export type FlowShape =
  | "straight"
  | "arc"
  | "s-curve"
  | {
      bend?: number;
      direction?: "auto" | "clockwise" | "counterclockwise";
      segments?: number;
      type?: "straight" | "arc" | "s-curve";
    };

export type FlowDirectionMarker = "arrow" | "none";

export type FlowLayerProps<TProperties = Record<string, unknown>> = MapFeatureInteractionProps<
  FlowLayerFeature<TProperties>
> & {
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
  flowValueFormat: _flowValueFormat = defaultFlowValueFormat,
  flows,
  getFeatureId,
  getFlowColor,
  getFlowLabel: _getFlowLabel,
  getWeight,
  hoveredFeatureId,
  hoveredFlowOpacity = 0.95,
  inactiveFlowOpacity = 0.22,
  layerId,
  maxWeight,
  maxWidth,
  minWidth,
  onHoveredFeatureIdChange,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onSelectedFeatureIdChange,
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
  const surfaceRef = useRef(surface);
  const flatFlowCacheRef = useRef<Map<string, FlatFlowCacheEntry>>(new Map());
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
  const surfaceDisplay = surface?.display;
  const registerMapLibreLayer = surface?.registerMapLibreLayer;

  useEffect(() => {
    surfaceRef.current = surface;
  });

  useEffect(() => {
    if (!registerMapLibreLayer || (surfaceDisplay !== "flat" && surfaceDisplay !== "globe")) {
      flatFlowCacheRef.current.clear();
      return;
    }

    return registerMapLibreLayer(
      resolvedLayerId,
      ({ isMeasuring, layer, flat, map }) => {
        const currentSurface = surfaceRef.current;

        if (!currentSurface) {
          return;
        }

        const hasHoveredFlow = features.some((feature) =>
          currentSurface.isFeatureHovered(feature, hoveredFeatureId, getFeatureId),
        );

        reconcileFlatLayerEntries<FlatFlowCacheEntry>({
          cache: flatFlowCacheRef.current,
          layer,
          plans: features.map((feature) => {
            const color = getFlowColor?.(feature) ?? flowColor;
            const selected = currentSurface.isFeatureSelected(
              feature,
              selectedFeatureId,
              getFeatureId,
            );
            const hovered = currentSurface.isFeatureHovered(
              feature,
              hoveredFeatureId,
              getFeatureId,
            );
            const flowCoordinates = createFlowPathCoordinates(feature, flowShape);
            const flowLatLngs = flowCoordinates.map(toLatLng);
            const hasActiveFlow = Boolean(selectedFeatureId) || hasHoveredFlow;
            const active = selected || hovered;
            const opacity = active
              ? hovered
                ? hoveredFlowOpacity
                : selectedFlowOpacity
              : hasActiveFlow
                ? inactiveFlowOpacity
                : 0.72;
            const featureKey = getFlatFlowFeatureKey(feature, getFeatureId);
            const geometryKey = createFlatFlowGeometryKey(feature, flowCoordinates);
            const signature = createFlatFlowSignature({
              color,
              directionMarker,
              feature,
              hasActiveFlow,
              hovered,
              isMeasuring,
              opacity,
              selected,
              showDirection,
              showEndpoints,
            });

            return {
              key: featureKey,
              render: () => {
                const line = flat.polyline(flowLatLngs, {
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
                    currentSurface.handleFeatureClick(
                      feature,
                      getFlowPosition(map, feature, event),
                      {
                        getFeatureId,
                        onFeatureSelect,
                        onSelectedFeatureIdChange,
                        renderFeaturePopup,
                      },
                    );
                  });
                  line.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
                    suppressNativeContextMenu(event);
                    currentSurface.handleFeatureContextMenu(
                      feature,
                      getFlowPosition(map, feature, event),
                      {
                        coordinates: getFlowCenter(feature),
                        getFeatureId,
                        onFeatureContextMenu,
                        onFeatureSelect,
                        onSelectedFeatureIdChange,
                        renderFeatureContextMenu,
                        renderFeaturePopup,
                      },
                    );
                  });
                  line.on(
                    "mouseover",
                    (event: { containerPoint?: { x: number; y: number } } = {}) => {
                      map.getContainer().style.cursor = "pointer";
                      currentSurface.handleFeatureHover(
                        feature,
                        getFlowPosition(map, feature, event),
                        {
                          getFeatureId,
                          onHoveredFeatureIdChange,
                          onFeatureHover,
                          renderFeatureTooltip,
                        },
                      );
                    },
                  );
                  line.on("mouseout", () => {
                    map.getContainer().style.cursor = "";
                    currentSurface.handleFeatureHover(null, null, {
                      getFeatureId,
                      onHoveredFeatureIdChange,
                      onFeatureHover,
                      renderFeatureTooltip,
                    });
                  });
                }

                line.addTo(layer);
                const layers: FlatLayer[] = [line];
                let arrowLayer: FlatLayer | null = null;
                let fromEndpointLayer: FlatLayer | null = null;
                let toEndpointLayer: FlatLayer | null = null;

                if (showDirection && directionMarker === "arrow") {
                  arrowLayer =
                    addFlowArrowMarker({
                      color,
                      feature,
                      flowCoordinates,
                      flat,
                      map,
                      opacity,
                      overlay: layer,
                    }) ?? null;
                  if (arrowLayer) {
                    layers.push(arrowLayer);
                  }
                }

                if (showEndpoints) {
                  fromEndpointLayer = flat
                    .circleMarker(toLatLng(feature.flow.from), {
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
                  layers.push(fromEndpointLayer);
                  toEndpointLayer = flat
                    .circleMarker(toLatLng(feature.flow.to), {
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
                  layers.push(toEndpointLayer);
                }

                return {
                  arrowLayer,
                  fromEndpointLayer,
                  geometryKey,
                  layers,
                  lineLayer: line,
                  signature,
                  toEndpointLayer,
                };
              },
              signature,
              update: (entry) => {
                if (entry.geometryKey === geometryKey) {
                  return true;
                }

                const updated = updateFlatFlowCachedGeometry(entry, feature, flowCoordinates);

                if (updated) {
                  entry.geometryKey = geometryKey;
                }

                return updated;
              },
            };
          }),
        });
      },
      { preserveOnRender: true, renderOnViewStateChange: false },
    );
  }, [
    directionMarker,
    features,
    flowColor,
    flowShape,
    getFeatureId,
    getFlowColor,
    hoveredFeatureId,
    hoveredFlowOpacity,
    inactiveFlowOpacity,
    resolvedLayerId,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    renderFeaturePopup,
    renderFeatureContextMenu,
    renderFeatureTooltip,
    selectedFeatureId,
    selectedFlowOpacity,
    showDirection,
    showEndpoints,
    registerMapLibreLayer,
    surfaceDisplay,
  ]);

  return null;
}

function getFlowCenter<TProperties>(
  feature: FlowLayerFeature<TProperties>,
): [longitude: number, latitude: number] {
  return [
    (feature.flow.from[0] + feature.flow.to[0]) / 2,
    (feature.flow.from[1] + feature.flow.to[1]) / 2,
  ];
}

type FlatFlowCacheEntry = {
  arrowLayer: FlatLayer | null;
  fromEndpointLayer: FlatLayer | null;
  geometryKey: string;
  layers: FlatLayer[];
  lineLayer: FlatLayer;
  signature: string;
  toEndpointLayer: FlatLayer | null;
};

function getFlatFlowFeatureKey<TProperties>(
  feature: FlowLayerFeature<TProperties>,
  getFeatureId?: (feature: FlowLayerFeature<TProperties>) => string,
) {
  return getFeatureId?.(feature) || feature.flow.id;
}

function createFlatFlowGeometryKey<TProperties>(
  feature: FlowLayerFeature<TProperties>,
  flowCoordinates: Array<[longitude: number, latitude: number]>,
) {
  return JSON.stringify({
    flowCoordinates,
    from: feature.flow.from,
    to: feature.flow.to,
  });
}

function createFlatFlowSignature<TProperties>({
  color,
  directionMarker,
  feature,
  hasActiveFlow,
  hovered,
  isMeasuring,
  opacity,
  selected,
  showDirection,
  showEndpoints,
}: {
  color: string;
  directionMarker: FlowDirectionMarker;
  feature: FlowLayerFeature<TProperties>;
  hasActiveFlow: boolean;
  hovered: boolean;
  isMeasuring: boolean;
  opacity: number;
  selected: boolean;
  showDirection: boolean;
  showEndpoints: boolean;
}) {
  return JSON.stringify({
    color,
    directionMarker,
    flow: {
      id: feature.flow.id,
      label: feature.flow.label,
      metrics: feature.flow.metrics,
      properties: feature.flow.properties,
    },
    hasActiveFlow,
    hovered,
    interactive: !isMeasuring,
    opacity,
    rawValue: feature.rawValue,
    selected,
    showDirection,
    showEndpoints,
    value: feature.value,
    width: selected ? feature.width + 1.5 : feature.width,
  });
}

function updateFlatFlowCachedGeometry<TProperties>(
  entry: FlatFlowCacheEntry,
  feature: FlowLayerFeature<TProperties>,
  flowCoordinates: Array<[longitude: number, latitude: number]>,
) {
  if (entry.arrowLayer) {
    return false;
  }

  if (!entry.lineLayer.setLatLngs?.(flowCoordinates.map(toLatLng))) {
    return false;
  }

  entry.fromEndpointLayer?.setLatLng?.(toLatLng(feature.flow.from));
  entry.toEndpointLayer?.setLatLng?.(toLatLng(feature.flow.to));

  return true;
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

  return map.latLngToContainerPoint?.(toLatLng(midpoint)) ?? { x: 0, y: 0 };
}

export function addFlowArrowMarker<TProperties>({
  color,
  feature,
  flowCoordinates,
  flat,
  map,
  opacity,
  overlay,
}: {
  color: string;
  feature: FlowLayerFeature<TProperties>;
  flowCoordinates: Array<[longitude: number, latitude: number]>;
  flat: FlatLayerFactory;
  map: {
    latLngToContainerPoint?: (latLng: [number, number]) => { x: number; y: number };
  };
  opacity: number;
  overlay: FlatLayerGroup;
}) {
  if (!flat.divIcon || !flat.marker || flowCoordinates.length < 2) {
    return;
  }

  const to = flowCoordinates.at(-1)!;
  const previous = flowCoordinates.at(-2)!;
  const toPoint = map.latLngToContainerPoint?.(toLatLng(to));
  const previousPoint = map.latLngToContainerPoint?.(toLatLng(previous));
  const rotation =
    toPoint && previousPoint
      ? (Math.atan2(toPoint.y - previousPoint.y, toPoint.x - previousPoint.x) * 180) / Math.PI
      : 0;
  const size = Math.min(22, Math.max(9, feature.width * 1.35));
  const icon = flat.divIcon({
    className: "mb-maps__flow-arrow",
    html: `<span class="mb-maps__flow-arrow-glyph" style="--mb-maps-flow-arrow-color: ${escapeFlowCssValue(
      color,
    )}; --mb-maps-flow-arrow-opacity: ${opacity}; --mb-maps-flow-arrow-rotation: ${rotation}deg; --mb-maps-flow-arrow-size: ${size}px;"></span>`,
    iconAnchor: [size * 0.62, size / 2],
    iconSize: [size, size],
  });

  return flat
    .marker(toLatLng(to), {
      icon,
      interactive: false,
      keyboard: false,
      opacity,
    })
    .addTo(overlay);
}

function defaultFlowValueFormat(value: number) {
  return String(Math.round(value));
}

function escapeFlowCssValue(value: string) {
  return value.replace(/[;"'<>]/g, "");
}

type FlatFeaturePointerEvent = {
  containerPoint?: { x: number; y: number };
  originalEvent?: {
    preventDefault?: () => void;
  };
};

function suppressNativeContextMenu(event: FlatFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
}
