"use client";

import { startTransition, useContext, useDeferredValue, useEffect, useMemo, useRef } from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type VisibleAggregationSummary,
} from "./aggregation";
import { escapeHtml, joinClassNames, toLeafletLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";

export type ClusterLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<AggregatedMapFeature<TProperties>> & {
    clusterRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    filterPoint?: MapPointFilter<TProperties>;
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
  maxZoom,
  minZoom,
  onFeatureHover,
  onFeatureSelect,
  onViewportAggregationChange,
  points,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: ClusterLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const deferredPoints = useDeferredValue(points);
  const lastViewportSummaryKeyRef = useRef<string | null>(null);
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
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer("cluster-layer", ({ isMeasuring, layer, leaflet, map }) => {
      layer.clearLayers();

      const bounds = map.getBounds();
      const aggregation = index.getViewportAggregation({
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        zoom: map.getZoom(),
      });

      emitViewportSummary(aggregation.summary, lastViewportSummaryKeyRef, onViewportAggregationChange);

      for (const feature of aggregation.features) {
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);

        if (feature.kind === "cluster") {
          const marker = leaflet.circleMarker(toLeafletLatLng(feature.coordinates), {
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
              map.setView(toLeafletLatLng(feature.coordinates), feature.expansionZoom, {
                animate: false,
              });
              surface.setViewState(
                {
                  center: feature.coordinates,
                  zoom: feature.expansionZoom,
                },
                "cluster-expand",
              );
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
            marker.on("mouseout", () => {
              map.getContainer().style.cursor = "";
              surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
            });
          }

          marker.addTo(layer);
          leaflet
            .marker(toLeafletLatLng(feature.coordinates), {
              icon: leaflet.divIcon({
                className: "mb-maps__cluster-count",
                html: escapeHtml(feature.pointCountAbbreviated),
                iconAnchor: [18, 18],
                iconSize: [36, 36],
              }),
              interactive: false,
            })
            .addTo(layer);
          continue;
        }

        const marker = leaflet.circleMarker(toLeafletLatLng(feature.coordinates), {
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
          marker.on("mouseout", () => {
            map.getContainer().style.cursor = "";
            surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
          });
        }

        marker.addTo(layer);
      }
    });
  }, [
    getFeatureId,
    index,
    onFeatureHover,
    onFeatureSelect,
    onViewportAggregationChange,
    renderFeaturePopup,
    renderFeatureTooltip,
    selectedFeatureId,
    surface,
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
        const hovered = surface.isFeatureHovered(feature, getFeatureId);

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
                    zoom: Math.min(8, Math.max(surface.viewState.zoom + 0.8, feature.expansionZoom)),
                  },
                  "cluster-expand",
                );
                surface.handleFeatureClick(feature, { x: projected.x, y: projected.y }, {
                  onFeatureSelect,
                  renderFeaturePopup,
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

  return map.latLngToContainerPoint?.(toLeafletLatLng(coordinates)) ?? { x: 0, y: 0 };
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
