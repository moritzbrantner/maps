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
import type { MapSurfaceContextValue } from "./map-surface-context";
import { MapSurfaceContext } from "./map-view";
import type {
  FlatCircleCollectionFeature,
  FlatCircleCollectionLayer,
  FlatLayer,
  FlatLayerFactory,
  FlatLayerGroup,
  FlatPointerEvent,
} from "./maplibre-compat";
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
  const {
    pending: aggregationRuntimePending,
    status: aggregationRuntimeStatus,
    version: aggregationRuntimeVersion,
  } = useMapsAggregationRuntime();
  const indexRef = useRef<PointAggregationIndex<TProperties> | null>(null);
  // True when the committed index is the explicit unclustered fallback (runtime `unavailable`).
  const unclusteredFallbackRef = useRef(false);
  const fallbackRef = useRef<FlatUnclusteredFallback<TProperties> | null>(null);
  // The per-feature entry whose hover this layer delivered (pointer entered, not yet left).
  const deliveredHoverKeyRef = useRef<string | null>(null);
  const [indexVersion, setIndexVersion] = useState(0);

  // The index is created and disposed in one effect (never in render), so Strict Mode
  // replays and replaced options release their WASM memory, and layer callbacks only
  // ever read the committed index. While the aggregation runtime is pending there is no
  // index, so the layer renders nothing rather than every point as its own MapLibre layer
  // (#212); the runtime version builds the Rust-clustered index once it is ready.
  useEffect(() => {
    if (aggregationRuntimePending) {
      indexRef.current = null;
      unclusteredFallbackRef.current = false;
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
    unclusteredFallbackRef.current = aggregationRuntimeStatus === "unavailable";
    setIndexVersion((version) => version + 1);
    return () => {
      if (indexRef.current === index) indexRef.current = null;
      index.dispose();
    };
  }, [
    aggregationRuntimePending,
    aggregationRuntimeStatus,
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
      fallbackRef.current = null;
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

        // A removed MapLibre layer never fires `mouseleave`, so when the entry whose hover this
        // layer delivered is dropped (its feature left the frame, or the runtime status changed),
        // the hover is cleared here. A highlight from a controlled `hoveredFeatureId` that this
        // layer never delivered is left alone.
        const clearDroppedHover = () => {
          const deliveredKey = deliveredHoverKeyRef.current;

          if (deliveredKey !== null && !flatFeatureCacheRef.current.has(deliveredKey)) {
            deliveredHoverKeyRef.current = null;
            map.getContainer().style.cursor = "";
            currentSurface.handleFeatureHover(null, null, {
              getFeatureId,
              onHoveredFeatureIdChange,
              onFeatureHover,
              renderFeatureTooltip,
            });
          }
        };

        if (!index) {
          // Pending aggregation runtime: nothing is aggregated yet, so nothing is drawn.
          removeUnclusteredFallback(fallbackRef);
          reconcileFlatLayerEntries<FlatClusterCacheEntry>({
            cache: flatFeatureCacheRef.current,
            layer,
            plans: [],
          });
          clearDroppedHover();
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

        // Without the Rust runtime every visible point is its own feature, so the explicit
        // fallback draws them as one batched MapLibre source and circle layer (#214) instead of
        // a source and layer per point. Rust-clustered output keeps the per-feature path.
        const unclustered = unclusteredFallbackRef.current;
        const batchedPoints = unclustered
          ? renderFrame.features.filter(
              (renderFeature): renderFeature is MapPointClusterRenderFeature<TProperties> & {
                kind: "point";
              } => renderFeature.kind === "point",
            )
          : [];
        const perFeature = unclustered
          ? renderFrame.features.filter((renderFeature) => renderFeature.kind !== "point")
          : renderFrame.features;

        if (unclustered) {
          renderUnclusteredFallback({
            fallbackRef,
            flat,
            getFeatureId,
            hoveredFeatureId,
            isMeasuring,
            layer,
            map,
            onFeatureContextMenu,
            onFeatureHover,
            onFeatureSelect,
            onHoveredFeatureIdChange,
            onSelectedFeatureIdChange,
            points: batchedPoints,
            renderFeatureContextMenu,
            renderFeaturePopup,
            renderFeatureTooltip,
            selectedFeatureId,
            surface: currentSurface,
          });
        } else {
          removeUnclusteredFallback(fallbackRef);
        }

        reconcileFlatLayerEntries<FlatClusterCacheEntry>({
          cache: flatFeatureCacheRef.current,
          layer,
          plans: perFeature.map((renderFeature) => {
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
                        deliveredHoverKeyRef.current = renderFeature.id;
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
                      if (deliveredHoverKeyRef.current === renderFeature.id) {
                        deliveredHoverKeyRef.current = null;
                      }
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
                      deliveredHoverKeyRef.current = renderFeature.id;
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
                    if (deliveredHoverKeyRef.current === renderFeature.id) {
                      deliveredHoverKeyRef.current = null;
                    }
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
        clearDroppedHover();
      },
      {
        onHoverChange: hoveredFeatureId
          ? undefined
          : () => {
              const isHovered = (feature: AggregatedMapFeature<TProperties>) =>
                Boolean(
                  surfaceRef.current?.isFeatureHovered(feature, hoveredFeatureId, getFeatureId),
                );

              updateFlatLayerEntriesHover(flatFeatureCacheRef.current, (feature) =>
                isHovered(feature as AggregatedMapFeature<TProperties>),
              );
              syncUnclusteredFallbackHover(fallbackRef.current, isHovered);
            },
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

type FlatUnclusteredPoint<TProperties> = MapPointClusterRenderFeature<TProperties> & {
  kind: "point";
};

type FlatUnclusteredFallbackHandlers<TProperties> = {
  click(point: FlatUnclusteredPoint<TProperties>, event: FlatPointerEvent): void;
  contextmenu(point: FlatUnclusteredPoint<TProperties>, event: FlatPointerEvent): void;
  mouseout(): void;
  mouseover(point: FlatUnclusteredPoint<TProperties>, event: FlatPointerEvent): void;
};

/** The batched fallback layer, its group, and what its pointer events currently resolve to. */
type FlatUnclusteredFallback<TProperties> = {
  collection: FlatCircleCollectionLayer;
  group: FlatLayerGroup;
  handlers: FlatUnclusteredFallbackHandlers<TProperties> | null;
  /** Whether a fallback circle's hover reached the Map View and still needs its leave. */
  hoverDelivered: boolean;
  pointsByKey: Map<string, FlatUnclusteredPoint<TProperties>>;
};

function renderUnclusteredFallback<TProperties>({
  fallbackRef,
  flat,
  getFeatureId,
  hoveredFeatureId,
  isMeasuring,
  layer,
  map,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onHoveredFeatureIdChange,
  onSelectedFeatureIdChange,
  points,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
  surface,
}: Pick<
  ClusterLayerProps<TProperties>,
  | "getFeatureId"
  | "hoveredFeatureId"
  | "onFeatureContextMenu"
  | "onFeatureHover"
  | "onFeatureSelect"
  | "onHoveredFeatureIdChange"
  | "onSelectedFeatureIdChange"
  | "renderFeatureContextMenu"
  | "renderFeaturePopup"
  | "renderFeatureTooltip"
  | "selectedFeatureId"
> & {
  fallbackRef: MutableRefObject<FlatUnclusteredFallback<TProperties> | null>;
  flat: Pick<FlatLayerFactory, "circleCollection">;
  isMeasuring: boolean;
  layer: FlatLayerGroup;
  map: {
    getContainer(): HTMLElement;
    project: (coordinates: [number, number]) => { x: number; y: number };
  };
  points: readonly FlatUnclusteredPoint<TProperties>[];
  surface: MapSurfaceContextValue;
}) {
  const pointsByKey = new Map<string, FlatUnclusteredPoint<TProperties>>();
  let hoveredKey: string | null = null;
  const features = points.map((point): FlatCircleCollectionFeature => {
    pointsByKey.set(point.id, point);
    const selected = surface.isFeatureSelected(point.feature, selectedFeatureId, getFeatureId);

    if (
      hoveredKey === null &&
      surface.isFeatureHovered(point.feature, hoveredFeatureId, getFeatureId)
    ) {
      hoveredKey = point.id;
    }

    return {
      className: joinClassNames("mb-maps__point-marker", selected && "mb-maps__feature--selected"),
      color: "#ffffff",
      fillColor: point.fillColor,
      fillOpacity: 0.92,
      key: point.id,
      latLng: toLatLng(point.coordinates),
      radius: point.radius,
      weight: selected ? 3 : 2,
    };
  });

  let fallback = fallbackRef.current;

  // The layer group clears its layers on unmount or a map style reload; start over then.
  if (fallback && (fallback.group !== layer || !layer.layers.includes(fallback.collection))) {
    removeUnclusteredFallback(fallbackRef);
    fallback = null;
  }

  if (!fallback) {
    const created: FlatUnclusteredFallback<TProperties> = {
      collection: flat.circleCollection(features),
      group: layer,
      handlers: null,
      hoverDelivered: false,
      pointsByKey,
    };
    const resolve = (event: FlatPointerEvent = {}) =>
      event.featureKey === undefined ? undefined : created.pointsByKey.get(event.featureKey);

    created.collection
      .on("click", (event) => {
        const point = resolve(event);
        if (point) created.handlers?.click(point, event ?? {});
      })
      .on("contextmenu", (event) => {
        const point = resolve(event);
        if (point) created.handlers?.contextmenu(point, event ?? {});
      })
      .on("mouseover", (event) => {
        const point = resolve(event);
        if (point) created.handlers?.mouseover(point, event ?? {});
      })
      .on("mouseout", () => {
        created.handlers?.mouseout();
      });
    created.collection.addTo(layer);
    fallbackRef.current = created;
    fallback = created;
  } else {
    fallback.pointsByKey = pointsByKey;
    fallback.collection.setFeatures(features);
  }

  fallback.collection.setHoveredKey(hoveredKey);
  // Leaving a hovered circle is always delivered (also after measuring started), so hover,
  // tooltip and cursor never outlive the circle; other pointer events are inert while measuring.
  const current = fallback;
  current.handlers = {
    click(point, event) {
      if (isMeasuring) return;
      surface.handleFeatureClick(
        point.feature,
        getFlatFeaturePosition(map, point.coordinates, event),
        { getFeatureId, onFeatureSelect, onSelectedFeatureIdChange, renderFeaturePopup },
      );
    },
    contextmenu(point, event) {
      if (isMeasuring) return;
      suppressNativeContextMenu(event);
      surface.handleFeatureContextMenu(
        point.feature,
        getFlatFeaturePosition(map, point.coordinates, event),
        {
          coordinates: point.coordinates,
          getFeatureId,
          onFeatureContextMenu,
          onFeatureSelect,
          onSelectedFeatureIdChange,
          renderFeatureContextMenu,
          renderFeaturePopup,
        },
      );
    },
    mouseout() {
      if (!current.hoverDelivered) return;
      current.hoverDelivered = false;
      map.getContainer().style.cursor = "";
      surface.handleFeatureHover(null, null, {
        getFeatureId,
        onHoveredFeatureIdChange,
        onFeatureHover,
        renderFeatureTooltip,
      });
    },
    mouseover(point, event) {
      if (isMeasuring) return;
      current.hoverDelivered = true;
      map.getContainer().style.cursor = "pointer";
      surface.handleFeatureHover(
        point.feature,
        getFlatFeaturePosition(map, point.coordinates, event),
        { getFeatureId, onHoveredFeatureIdChange, onFeatureHover, renderFeatureTooltip },
      );
    },
  };
}

function syncUnclusteredFallbackHover<TProperties>(
  fallback: FlatUnclusteredFallback<TProperties> | null,
  isHovered: (feature: AggregatedMapFeature<TProperties>) => boolean,
) {
  if (!fallback) {
    return;
  }

  let hoveredKey: string | null = null;

  for (const [key, point] of fallback.pointsByKey) {
    if (isHovered(point.feature)) {
      hoveredKey = key;
      break;
    }
  }

  fallback.collection.setHoveredKey(hoveredKey);
}

function removeUnclusteredFallback<TProperties>(
  fallbackRef: MutableRefObject<FlatUnclusteredFallback<TProperties> | null>,
) {
  const fallback = fallbackRef.current;

  if (!fallback) {
    return;
  }

  fallbackRef.current = null;
  // Remove first, while the handlers are still attached: a pointer resting on a circle gets its
  // `mouseout`, which clears the hovered feature, tooltip and cursor (#219 review).
  fallback.group.removeLayer(fallback.collection);
  fallback.handlers = null;
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
