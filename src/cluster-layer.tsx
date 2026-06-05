"use client";

import { startTransition, useContext, useDeferredValue, useEffect, useId, useMemo, useRef } from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type VisibleAggregationSummary,
} from "./aggregation";
import { escapeHtml, GLOBE_MAX_ZOOM, joinClassNames, toLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import type { FlatLayer, FlatLayerGroup } from "./maplibre-compat";

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
  const isFlatSurface = surface?.display === "flat";
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

    return surfaceRef.current?.registerFlatLayer(
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

      const cache = flatFeatureCacheRef.current;
      const seen = new Set<string>();

      for (const feature of aggregation.features) {
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
          removeFlatClusterCacheEntry(layer, cached);
        }

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
            marker.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
              map.getContainer().style.cursor = "pointer";
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
          cache.set(featureKey, {
            coordinatesKey,
            layers: [marker, countMarker],
            signature,
          });
          continue;
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
          marker.on("mouseover", (event: { containerPoint?: { x: number; y: number } } = {}) => {
            map.getContainer().style.cursor = "pointer";
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

          removeFlatClusterCacheEntry(layer, cached);
          cache.delete(featureKey);
        }
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

  if (!surface || surface.display !== "globe") {
    return null;
  }

  const aggregation = index.getViewportAggregation({
    bounds: [-180, -90, 180, 90],
    zoom: surface.viewState.zoom,
  });

  emitViewportSummary(aggregation.summary, lastViewportSummaryKeyRef, onViewportAggregationChange);

  return (
    <>
      {aggregation.features.map((feature) => {
        const projected = surface.projectGlobeCoordinate(feature.coordinates, surface.viewState);

        if (!projected.visible) {
          return null;
        }

        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, hoveredFeatureId, getFeatureId);

        if (feature.kind === "cluster") {
          const radius = getClusterRadius(feature.pointCount) * (0.72 + projected.scale * 0.28);

          return (
            <g
              className={joinClassNames(
                "mb-maps__globe-cluster",
                hovered && "mb-maps__feature--hovered",
                selected && "mb-maps__feature--selected",
              )}
              key={`cluster-${feature.clusterId}`}
              onClick={(event) => {
                event.stopPropagation();

                if (surface.isMeasuring) {
                  return;
                }

                surface.setViewState(
                  {
                    center: feature.coordinates,
                    zoom: Math.min(
                      GLOBE_MAX_ZOOM,
                      Math.max(surface.viewState.zoom + 0.8, feature.expansionZoom),
                    ),
                  },
                  "cluster-expand",
                );
                surface.handleFeatureClick(feature, { x: projected.x, y: projected.y }, {
                  getFeatureId,
                  onFeatureSelect,
                  onSelectedFeatureIdChange,
                  renderFeaturePopup,
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                surface.handleFeatureContextMenu(feature, { x: projected.x, y: projected.y }, {
                  getFeatureId,
                  onFeatureContextMenu,
                  onFeatureSelect,
                  onSelectedFeatureIdChange,
                  renderFeatureContextMenu,
                  renderFeaturePopup,
                  suppress: surface.isMeasuring,
                  coordinates: feature.coordinates,
                });
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
              style={{ opacity: 0.38 + projected.scale * 0.62 }}
            >
              <title>{feature.pointCountAbbreviated}</title>
              <circle
                cx={projected.x}
                cy={projected.y}
                fill={getClusterColor(feature.pointCount)}
                r={radius}
              />
              <text x={projected.x} y={projected.y}>
                {feature.pointCountAbbreviated}
              </text>
            </g>
          );
        }

        return (
          <circle
            className={joinClassNames(
              "mb-maps__globe-point",
              hovered && "mb-maps__feature--hovered",
              selected && "mb-maps__feature--selected",
            )}
            cx={projected.x}
            cy={projected.y}
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
                getFeatureId,
                onFeatureContextMenu,
                onFeatureSelect,
                onSelectedFeatureIdChange,
                renderFeatureContextMenu,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
                coordinates: feature.coordinates,
              });
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
            r={6 * (0.72 + projected.scale * 0.28)}
            style={{ opacity: 0.42 + projected.scale * 0.58 }}
          >
            <title>{feature.point.label}</title>
          </circle>
        );
      })}
    </>
  );
}

function emitViewportSummary(
  summary: VisibleAggregationSummary,
  ref: React.MutableRefObject<string | null>,
  onViewportAggregationChange: ((summary: VisibleAggregationSummary) => void) | undefined,
) {
  const nextSummaryKey = serializeVisibleAggregationSummary(summary);

  if (ref.current === nextSummaryKey) {
    return;
  }

  ref.current = nextSummaryKey;
  startTransition(() => {
    onViewportAggregationChange?.(summary);
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

type FlatFeaturePointerEvent = {
  containerPoint?: { x: number; y: number };
  originalEvent?: {
    preventDefault?: () => void;
  };
};

type FlatClusterCacheEntry = {
  coordinatesKey: string;
  layers: FlatLayer[];
  signature: string;
};

function suppressNativeContextMenu(event: FlatFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
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

function removeFlatClusterCacheEntry(layer: FlatLayerGroup, entry: FlatClusterCacheEntry) {
  for (const cachedLayer of entry.layers) {
    layer.removeLayer(cachedLayer);
  }
}
