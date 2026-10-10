"use client";

import { useMapsAggregationRuntime } from "./aggregation-runtime-react";
import {
  startTransition,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndex,
  type PointAggregationIndexOptions,
  type VisibleAggregationSummary,
} from "./aggregation";
import {
  reconcileFlatLayerEntries,
  updateFlatLayerEntriesHover,
  type FlatLayerEntryHover,
} from "./flat-layer-reconciler";
import { escapeHtml, joinClassNames, toLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import type { FlatLayer } from "./maplibre-compat";
import {
  createPointClusterRenderFrame,
  type MapPointClusterRenderFeature,
} from "./point-cluster-render-frame";

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
  const { pending: aggregationRuntimePending, version: aggregationRuntimeVersion } =
    useMapsAggregationRuntime();
  const indexRef = useRef<PointAggregationIndex<TProperties> | null>(null);
  const [indexVersion, setIndexVersion] = useState(0);

  // The index is created and disposed in one effect (never in render), so Strict Mode
  // replays and replaced options release their WASM memory, and layer callbacks only
  // ever read the committed index. While the aggregation runtime is pending there is no
  // index, so the layer renders nothing rather than every point as its own MapLibre layer
  // (#212); the runtime version builds the Rust-clustered index once it is ready.
  useEffect(() => {
    if (aggregationRuntimePending) {
      indexRef.current = null;
      setIndexVersion((version) => version + 1);
      return;
    }

    const index = createPointAggregationIndex(deferredPoints, {
      filterPoint,
      maxZoom,
      minZoom,
      radius: clusterRadius,
    });
    indexRef.current = index;
    setIndexVersion((version) => version + 1);
    return () => {
      if (indexRef.current === index) indexRef.current = null;
      index.dispose();
    };
  }, [
    aggregationRuntimePending,
    aggregationRuntimeVersion,
    clusterRadius,
    deferredPoints,
    filterPoint,
    maxZoom,
    minZoom,
  ]);

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
        const index = indexRef.current;

        if (!currentSurface) {
          return;
        }

        if (!index) {
          // Pending aggregation runtime: nothing is aggregated yet, so nothing is drawn.
          reconcileFlatLayerEntries<FlatClusterCacheEntry>({
            cache: flatFeatureCacheRef.current,
            layer,
            plans: [],
          });
          return;
        }

        const bounds = map.getBounds();
        const aggregation = index.getViewportAggregation({
          bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          zoom: map.getZoom(),
        });
        const renderFrame = createPointClusterRenderFrame(aggregation, getFeatureId);

        emitViewportSummary(
          renderFrame.summary,
          lastViewportSummaryKeyRef,
          onViewportAggregationChange,
        );

        reconcileFlatLayerEntries<FlatClusterCacheEntry>({
          cache: flatFeatureCacheRef.current,
          layer,
          plans: renderFrame.features.map((renderFeature) => {
            const feature = renderFeature.feature;
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
            const coordinatesKey = createFlatClusterCoordinatesKey(renderFeature.coordinates);
            const signature = createFlatClusterSignature({
              isMeasuring,
              renderFeature,
              selected,
            });
            const getClassName = (featureHovered: boolean) =>
              joinClassNames(
                renderFeature.kind === "cluster"
                  ? "mb-maps__cluster-marker"
                  : "mb-maps__point-marker",
                featureHovered && "mb-maps__feature--hovered",
                selected && "mb-maps__feature--selected",
              );
            const createHover = (marker: FlatLayer): FlatLayerEntryHover<boolean> => ({
              apply: (featureHovered) => {
                marker.setStyle?.({
                  className: getClassName(featureHovered),
                  // The Maps runtime's hover delta, as real MapLibre paint.
                  weight: selected || featureHovered ? 3 : 2,
                });
              },
              feature,
              state: hovered,
            });

            return {
              hoverState: hovered,
              key: renderFeature.id,
              render: () => {
                if (renderFeature.kind === "cluster") {
                  const marker = flat.circleMarker(toLatLng(renderFeature.coordinates), {
                    className: getClassName(hovered),
                    color: "#ffffff",
                    fillColor: renderFeature.fillColor,
                    fillOpacity: 0.9,
                    interactive: !isMeasuring,
                    opacity: 1,
                    radius: renderFeature.radius,
                    weight: selected || hovered ? 3 : 2,
                  });

                  if (!isMeasuring) {
                    marker.on(
                      "click",
                      (event: { containerPoint?: { x: number; y: number } } = {}) => {
                        map.setView(toLatLng(renderFeature.coordinates), renderFeature.expansionZoom);
                        currentSurface.setViewState(
                          {
                            center: renderFeature.coordinates,
                            zoom: renderFeature.expansionZoom,
                          },
                          "cluster-expand",
                        );
                        currentSurface.handleFeatureClick(
                          feature,
                          getFlatFeaturePosition(map, renderFeature.coordinates, event),
                          {
                            getFeatureId,
                            onFeatureSelect,
                            onSelectedFeatureIdChange,
                            renderFeaturePopup,
                          },
                        );
                      },
                    );
                    marker.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
                      suppressNativeContextMenu(event);
                      currentSurface.handleFeatureContextMenu(
                        feature,
                        getFlatFeaturePosition(map, renderFeature.coordinates, event),
                        {
                          coordinates: renderFeature.coordinates,
                          getFeatureId,
                          onFeatureContextMenu,
                          onFeatureSelect,
                          onSelectedFeatureIdChange,
                          renderFeatureContextMenu,
                          renderFeaturePopup,
                        },
                      );
                    });
                    marker.on(
                      "mouseover",
                      (event: { containerPoint?: { x: number; y: number } } = {}) => {
                        map.getContainer().style.cursor = "pointer";
                        currentSurface.handleFeatureHover(
                          feature,
                          getFlatFeaturePosition(map, renderFeature.coordinates, event),
                          {
                            getFeatureId,
                            onHoveredFeatureIdChange,
                            onFeatureHover,
                            renderFeatureTooltip,
                          },
                        );
                      },
                    );
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
                    .marker(toLatLng(renderFeature.coordinates), {
                      icon: flat.divIcon({
                        className: "mb-maps__cluster-count",
                        html: escapeHtml(renderFeature.label),
                        iconAnchor: [18, 18],
                        iconSize: [36, 36],
                      }),
                      interactive: false,
                    })
                    .addTo(layer);

                  return {
                    coordinatesKey,
                    hover: createHover(marker),
                    layers: [marker, countMarker],
                    signature,
                  };
                }

                const marker = flat.circleMarker(toLatLng(renderFeature.coordinates), {
                  className: getClassName(hovered),
                  color: "#ffffff",
                  fillColor: renderFeature.fillColor,
                  fillOpacity: 0.92,
                  interactive: !isMeasuring,
                  opacity: 1,
                  radius: renderFeature.radius,
                  weight: selected || hovered ? 3 : 2,
                });

                if (!isMeasuring) {
                  marker.on(
                    "click",
                    (event: { containerPoint?: { x: number; y: number } } = {}) => {
                      currentSurface.handleFeatureClick(
                        feature,
                        getFlatFeaturePosition(map, renderFeature.coordinates, event),
                        {
                          getFeatureId,
                          onFeatureSelect,
                          onSelectedFeatureIdChange,
                          renderFeaturePopup,
                        },
                      );
                    },
                  );
                  marker.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
                    suppressNativeContextMenu(event);
                    currentSurface.handleFeatureContextMenu(
                      feature,
                      getFlatFeaturePosition(map, renderFeature.coordinates, event),
                      {
                        coordinates: renderFeature.coordinates,
                        getFeatureId,
                        onFeatureContextMenu,
                        onFeatureSelect,
                        onSelectedFeatureIdChange,
                        renderFeatureContextMenu,
                        renderFeaturePopup,
                      },
                    );
                  });
                  marker.on(
                    "mouseover",
                    (event: { containerPoint?: { x: number; y: number } } = {}) => {
                      map.getContainer().style.cursor = "pointer";
                      currentSurface.handleFeatureHover(
                        feature,
                        getFlatFeaturePosition(map, renderFeature.coordinates, event),
                        {
                          getFeatureId,
                          onHoveredFeatureIdChange,
                          onFeatureHover,
                          renderFeatureTooltip,
                        },
                      );
                    },
                  );
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
                  hover: createHover(marker),
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
                  Boolean(cachedLayer.setLatLng?.(toLatLng(renderFeature.coordinates))),
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
      {
        onHoverChange: hoveredFeatureId
          ? undefined
          : () =>
              updateFlatLayerEntriesHover(flatFeatureCacheRef.current, (feature) =>
                Boolean(
                  surfaceRef.current?.isFeatureHovered(
                    feature as AggregatedMapFeature<TProperties>,
                    hoveredFeatureId,
                    getFeatureId,
                  ),
                ),
              ),
        preserveOnRender: true,
      },
    );
  }, [
    getFeatureId,
    hoveredFeatureId,
    indexVersion,
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

function createFlatClusterCoordinatesKey(coordinates: [longitude: number, latitude: number]) {
  return coordinates.join(",");
}

function createFlatClusterSignature<TProperties>({
  isMeasuring,
  renderFeature,
  selected,
}: {
  isMeasuring: boolean;
  renderFeature: MapPointClusterRenderFeature<TProperties>;
  selected: boolean;
}) {
  return JSON.stringify({
    fillColor: renderFeature.fillColor,
    interactive: !isMeasuring,
    kind: renderFeature.kind,
    label: renderFeature.label ?? renderFeature.id,
    radius: renderFeature.radius,
    selected,
  });
}

type FlatClusterCacheEntry = {
  coordinatesKey: string;
  hover: FlatLayerEntryHover<boolean>;
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
