"use client";

import {
  startTransition,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  type MutableRefObject,
} from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type VisibleAggregationSummary,
} from "./aggregation";
import { escapeHtml, joinClassNames, toLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import type { FlatLayer } from "./maplibre-compat";
import { reconcileFlatLayerEntries } from "./flat-layer-reconciler";

export type ClusterLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<AggregatedMapFeature<TProperties>> & {
    clusterRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    filterPoint?: MapPointFilter<TProperties>;
    layerId?: string;
    maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    onFeatureSelect?: (feature: AggregatedMapFeature<TProperties> | null) => void;
    onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void;
    points: readonly MapPoint<TProperties>[];
  };

export function ClusterLayer<TProperties = Record<string, unknown>>({
  clusterRadius,
  filterPoint,
  getFeatureId,
  hoveredFeatureId,
  layerId,
  maxZoom,
  minZoom,
  onHoveredFeatureIdChange,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onSelectedFeatureIdChange,
  onViewportAggregationChange,
  points,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: ClusterLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `cluster-layer-${generatedLayerId}`;
  const isFlatSurface = surface?.display === "flat" || surface?.display === "globe";
  const deferredPoints = useDeferredValue(points);
  const lastViewportSummaryKeyRef = useRef<string | null>(null);
  const surfaceRef = useRef(surface);
  const flatFeatureCacheRef = useRef<Map<string, FlatClusterCacheEntry>>(new Map());
  const index = useMemo(
    () =>
      createPointAggregationIndex(deferredPoints, {
        filterPoint,
        maxZoom,
        minZoom,
        radius: clusterRadius,
      }),
    [clusterRadius, deferredPoints, filterPoint, maxZoom, minZoom],
  );

  useEffect(() => {
    surfaceRef.current = surface;
  });

  useEffect(() => {
    if (!isFlatSurface) {
      flatFeatureCacheRef.current.clear();
      return;
    }

    return surfaceRef.current?.registerMapLibreLayer(
      resolvedLayerId,
      ({ isMeasuring, layer, flat, map }) => {
        const currentSurface = surfaceRef.current;

        if (!currentSurface) {
          return;
        }

      const bounds = map.getBounds();
      const aggregation = index.getViewportAggregation({
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        zoom: map.getZoom(),
      });

      emitViewportSummary(aggregation.summary, lastViewportSummaryKeyRef, onViewportAggregationChange);

      reconcileFlatLayerEntries<FlatClusterCacheEntry>({
        cache: flatFeatureCacheRef.current,
        layer,
        plans: aggregation.features.map((feature) => {
          const selected = currentSurface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
          const hovered = currentSurface.isFeatureHovered(feature, hoveredFeatureId, getFeatureId);
          const featureKey = getFlatClusterFeatureKey(feature, getFeatureId);
          const coordinatesKey = createFlatClusterCoordinatesKey(feature.coordinates);
          const signature = createFlatClusterSignature({
            feature,
            hovered,
            isMeasuring,
            selected,
          });

          return {
            key: featureKey,
            render: () => {
              if (feature.kind === "cluster") {
                const marker = flat.circleMarker(toLatLng(feature.coordinates), {
                  className: joinClassNames(
                    "mb-maps__cluster-marker",
                    hovered && "mb-maps__feature--hovered",
                    selected && "mb-maps__feature--selected",
                  ),
                  color: "#ffffff",
                  fillColor: getClusterColor(feature.pointCount),
                  fillOpacity: 0.9,
                  interactive: !isMeasuring,
                  opacity: 1,
                  radius: getClusterRadius(feature.pointCount),
                  weight: selected ? 3 : 2,
                });

                if (!isMeasuring) {
                  marker.on("click", (event: { containerPoint?: { x: number; y: number } } = {}) => {
                    map.setView(toLatLng(feature.coordinates), feature.expansionZoom);
                    currentSurface.setViewState(
                      {
                        center: feature.coordinates,
                        zoom: feature.expansionZoom,
                      },
                      "cluster-expand",
                    );
                    currentSurface.handleFeatureClick(
                      feature,
                      getFlatFeaturePosition(map, feature.coordinates, event),
                      {
                        getFeatureId,
                        onFeatureSelect,
                        onSelectedFeatureIdChange,
                        renderFeaturePopup,
                      },
                    );
                  });
                  marker.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
                    suppressNativeContextMenu(event);
                    currentSurface.handleFeatureContextMenu(
                      feature,
                      getFlatFeaturePosition(map, feature.coordinates, event),
                      {
                        coordinates: feature.coordinates,
                        getFeatureId,
                        onFeatureContextMenu,
                        onFeatureSelect,
                        onSelectedFeatureIdChange,
                        renderFeatureContextMenu,
                        renderFeaturePopup,
                      },
                    );
                  });
                  marker.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
                    map.getContainer().style.cursor = "pointer";
                    currentSurface.handleFeatureHover(
                      feature,
                      getFlatFeaturePosition(map, feature.coordinates, event),
                      {
                        getFeatureId,
                        onHoveredFeatureIdChange,
                        onFeatureHover,
                        renderFeatureTooltip,
                      },
                    );
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
                const countMarker = flat
                  .marker(toLatLng(feature.coordinates), {
                    icon: flat.divIcon({
                      className: "mb-maps__cluster-count",
                      html: escapeHtml(feature.pointCountAbbreviated),
                      iconAnchor: [18, 18],
                      iconSize: [36, 36],
                    }),
                    interactive: false,
                  })
                  .addTo(layer);

                return {
                  coordinatesKey,
                  layers: [marker, countMarker],
                  signature,
                };
              }

              const marker = flat.circleMarker(toLatLng(feature.coordinates), {
                className: joinClassNames(
                  "mb-maps__point-marker",
                  hovered && "mb-maps__feature--hovered",
                  selected && "mb-maps__feature--selected",
                ),
                color: "#ffffff",
                fillColor: "#0f172a",
                fillOpacity: 0.92,
                interactive: !isMeasuring,
                opacity: 1,
                radius: 6,
                weight: selected ? 3 : 2,
              });

              if (!isMeasuring) {
                marker.on("click", (event: { containerPoint?: { x: number; y: number } } = {}) => {
                  currentSurface.handleFeatureClick(
                    feature,
                    getFlatFeaturePosition(map, feature.coordinates, event),
                    {
                      getFeatureId,
                      onFeatureSelect,
                      onSelectedFeatureIdChange,
                      renderFeaturePopup,
                    },
                  );
                });
                marker.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
                  suppressNativeContextMenu(event);
                  currentSurface.handleFeatureContextMenu(
                    feature,
                    getFlatFeaturePosition(map, feature.coordinates, event),
                    {
                      coordinates: feature.coordinates,
                      getFeatureId,
                      onFeatureContextMenu,
                      onFeatureSelect,
                      onSelectedFeatureIdChange,
                      renderFeatureContextMenu,
                      renderFeaturePopup,
                    },
                  );
                });
                marker.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
                  map.getContainer().style.cursor = "pointer";
                  currentSurface.handleFeatureHover(
                    feature,
                    getFlatFeaturePosition(map, feature.coordinates, event),
                    {
                      getFeatureId,
                      onHoveredFeatureIdChange,
                      onFeatureHover,
                      renderFeatureTooltip,
                    },
                  );
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
              return {
                coordinatesKey,
                layers: [marker],
                signature,
              };
            },
            signature,
            update: (entry) => {
              if (entry.coordinatesKey === coordinatesKey) {
                return true;
              }

              const updated = entry.layers.every((cachedLayer) =>
                Boolean(cachedLayer.setLatLng?.(toLatLng(feature.coordinates))),
              );

              if (updated) {
                entry.coordinatesKey = coordinatesKey;
              }

              return updated;
            },
          };
        }),
      });
      },
      { preserveOnRender: true },
    );
  }, [
    getFeatureId,
    hoveredFeatureId,
    index,
    resolvedLayerId,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    onViewportAggregationChange,
    renderFeaturePopup,
    renderFeatureContextMenu,
    renderFeatureTooltip,
    selectedFeatureId,
    isFlatSurface,
  ]);

  return null;
}

function getClusterColor(pointCount: number) {
  if (pointCount >= 2_500) {
    return "#ea580c";
  }

  if (pointCount >= 250) {
    return "#7c3aed";
  }

  if (pointCount >= 25) {
    return "#0284c7";
  }

  return "#0f766e";
}

function getClusterRadius(pointCount: number) {
  if (pointCount >= 2_500) {
    return 42;
  }

  if (pointCount >= 250) {
    return 32;
  }

  if (pointCount >= 25) {
    return 24;
  }

  return 18;
}

function serializeVisibleAggregationSummary(summary: VisibleAggregationSummary) {
  return JSON.stringify({
    bounds: summary.bounds.map((value) => Number(value.toFixed(6))),
    metrics: Object.entries(summary.metrics)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, Number(value.toFixed(6))]),
    visibleClusterCount: summary.visibleClusterCount,
    visiblePointCount: summary.visiblePointCount,
    visibleUnclusteredCount: summary.visibleUnclusteredCount,
    zoom: Number(summary.zoom.toFixed(6)),
  });
}

function getFlatClusterFeatureKey<TProperties>(
  feature: AggregatedMapFeature<TProperties>,
  getFeatureId?: (feature: AggregatedMapFeature<TProperties>) => string,
) {
  return (
    getFeatureId?.(feature) ||
    (feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`)
  );
}

function createFlatClusterCoordinatesKey(coordinates: [longitude: number, latitude: number]) {
  return coordinates.join(",");
}

function createFlatClusterSignature<TProperties>({
  feature,
  hovered,
  isMeasuring,
  selected,
}: {
  feature: AggregatedMapFeature<TProperties>;
  hovered: boolean;
  isMeasuring: boolean;
  selected: boolean;
}) {
  return JSON.stringify({
    fillColor: feature.kind === "cluster" ? getClusterColor(feature.pointCount) : "#0f172a",
    hovered,
    interactive: !isMeasuring,
    kind: feature.kind,
    label: feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.id,
    radius: feature.kind === "cluster" ? getClusterRadius(feature.pointCount) : 6,
    selected,
  });
}

type FlatClusterCacheEntry = {
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

function emitViewportSummary(
  summary: VisibleAggregationSummary,
  lastKeyRef: MutableRefObject<string | null>,
  onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void,
) {
  const key = serializeVisibleAggregationSummary(summary);

  if (lastKeyRef.current === key) {
    return;
  }

  lastKeyRef.current = key;
  startTransition(() => {
    onViewportAggregationChange?.(summary);
  });
}

function getFlatFeaturePosition(
  map: { project: (coordinates: [number, number]) => { x: number; y: number } },
  coordinates: [longitude: number, latitude: number],
  event: { containerPoint?: { x: number; y: number } } = {},
) {
  return event.containerPoint ?? map.project(coordinates);
}

function suppressNativeContextMenu(event: FlatFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
  event.originalEvent?.stopPropagation?.();
}
