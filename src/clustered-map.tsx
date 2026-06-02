"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createPointAggregationIndex,
  getBoundsFromPoints,
  type AggregatedMapFeature,
  type MapPointFilter,
  type MapPoint,
  type PointAggregationIndexOptions,
  type VisibleAggregationSummary,
} from "./aggregation";
import {
  createGeoJsonOverlayFeatureCollection,
  createMapPointsFromGeoJson,
  getBoundsFromGeoJson,
  mergeMapDataBounds,
  type GeoJsonMapSource,
  type GeoJsonOverlayMode,
  type GeoJsonSourceOptions,
} from "./geojson-source";
import {
  createGlobalViewportQuery,
  createGlobeGraticuleLines,
  createInitialGlobeViewState,
  createVisibleSvgPath,
  defaultRasterMapStyle,
  getGlobeDragCenter,
  getGlobeRadius,
  getGlobeZoom,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  joinClassNames,
  projectGlobeCoordinate,
  type GlobeBasemapMode,
  type GlobeViewState,
  type MapBounds,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeContext,
  type MapViewStateChangeReason,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import { ClusterLayer } from "./cluster-layer";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapView } from "./map-view";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";
import type { TemporalGeoJsonGeometryFeatureCollection } from "./temporal-geojson-types";

export type ClusteredMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  children?: React.ReactNode;
  className?: string;
  clusterRadius?: PointAggregationIndexOptions<TProperties>["radius"];
  filterPoint?: MapPointFilter<TProperties>;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  geoJson?: GeoJsonMapSource<TProperties>;
  geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
  geoJsonOverlay?: GeoJsonOverlayMode;
  geoJsonOverlayCollection?: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
  globeBasemapMode?: GlobeBasemapMode;
  /**
   * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
   */
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
  minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
  onFeatureSelect?: (feature: AggregatedMapFeature<TProperties> | null) => void;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: import("maplibre-gl").Map) => void;
  onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void;
  points?: readonly MapPoint<TProperties>[];
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
} & MapMeasurementProps &
  Omit<MapViewportProps, "maxZoom"> &
  MapFeatureInteractionProps<AggregatedMapFeature<TProperties>>;

export {
  defaultRasterMapStyle,
  type MapDisplayMode,
  type GlobeBasemapMode,
  type MapBounds,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeContext,
  type MapViewStateChangeReason,
  type MapViewportProps,
  type RasterMapStyle,
};

export function ClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  {
    children,
    className,
    fitBoundsPadding = 56,
    fitToData = true,
    initialViewState,
    mapDisplay = "flat",
    mapLabel = "Interactive map",
    mapStyle = defaultRasterMapStyle,
    measurementDistanceFormat,
    measurementDraftLineColor,
    measurementLineColor,
    measurementMode,
    measurements,
    onMapControllerReady,
    onMapReady,
    onMeasurementCreate,
    onMeasurementDraftChange,
    onMeasurementSelect,
    points,
    geoJson,
    geoJsonOptions,
    geoJsonOverlay,
    geoJsonOverlayCollection,
    geoJsonOverlayProps,
    globeBasemapMode,
    maxBounds,
    showAttributionControl = true,
    style,
    viewState,
    defaultViewState,
    onViewStateChange,
    ...props
  }: ClusteredMapProps<TProperties>,
) {
  const resolvedPoints = points ?? (geoJson ? createMapPointsFromGeoJson(geoJson, geoJsonOptions) : []);
  const resolvedGeoJsonOverlayCollection =
    geoJsonOverlayCollection ??
    (geoJson
      ? createGeoJsonOverlayFeatureCollection(geoJson, {
          mode: geoJsonOverlay,
          target: "point",
        })
      : null);
  const dataBounds = mergeMapDataBounds(
    geoJson ? getBoundsFromGeoJson(geoJson) : getBoundsFromPoints(resolvedPoints),
    resolvedGeoJsonOverlayCollection ? getBoundsFromGeoJson(resolvedGeoJsonOverlayCollection) : null,
  );

  return (
    <MapView
      className={className}
      dataBounds={dataBounds}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      globeBasemapMode={globeBasemapMode}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      onMapControllerReady={onMapControllerReady}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      showAttributionControl={showAttributionControl}
      style={style}
      viewState={viewState}
    >
      {resolvedGeoJsonOverlayCollection && resolvedGeoJsonOverlayCollection.features.length > 0 ? (
        <GeoJsonLayer
          {...(geoJsonOverlayProps as Omit<GeoJsonLayerProps, "featureCollection"> | undefined)}
          featureCollection={resolvedGeoJsonOverlayCollection}
        />
      ) : null}
      <ClusterLayer {...(props as React.ComponentProps<typeof ClusterLayer<TProperties>>)} points={resolvedPoints} />
      <BeeLineMeasurementLayer
        measurementDistanceFormat={measurementDistanceFormat}
        measurementDraftLineColor={measurementDraftLineColor}
        measurementLineColor={measurementLineColor}
        measurementMode={measurementMode}
        measurements={measurements}
        onMeasurementCreate={onMeasurementCreate}
        onMeasurementDraftChange={onMeasurementDraftChange}
        onMeasurementSelect={onMeasurementSelect}
      />
      {children}
    </MapView>
  );
}

export function FlatClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay: _mapDisplay,
  ...props
}: ClusteredMapProps<TProperties>) {
  return <ClusteredMap {...props} mapDisplay="flat" />;
}

export function GlobeClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  className,
  clusterRadius,
  filterPoint,
  fitToData = true,
  initialViewState,
  mapLabel = "Interactive map",
  measurementDistanceFormat: _measurementDistanceFormat,
  measurementDraftLineColor: _measurementDraftLineColor,
  measurementLineColor: _measurementLineColor,
  measurementMode: _measurementMode,
  measurements: _measurements,
  maxZoom,
  minZoom,
  onFeatureSelect,
  onMeasurementCreate: _onMeasurementCreate,
  onMeasurementDraftChange: _onMeasurementDraftChange,
  onMeasurementSelect: _onMeasurementSelect,
  onViewportAggregationChange,
  points = [],
  style,
}: ClusteredMapProps<TProperties>) {
  const deferredPoints = useDeferredValue(points);
  const dragRef = useRef<{
    center: [number, number];
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [viewState, setViewState] = useState<GlobeViewState>(() =>
    createInitialGlobeViewState({
      fitToData,
      initialViewState,
      points,
    }),
  );
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
  const query = useMemo(() => createGlobalViewportQuery(viewState.zoom), [viewState.zoom]);
  const aggregation = useMemo(() => index.getViewportAggregation(query), [index, query]);

  useEffect(() => {
    if (initialViewState || !fitToData) {
      return;
    }

    setViewState(createInitialGlobeViewState({ fitToData, initialViewState, points: deferredPoints }));
  }, [deferredPoints, fitToData, initialViewState]);

  useEffect(() => {
    const nextSummaryKey = serializeVisibleAggregationSummary(aggregation.summary);

    if (lastViewportSummaryKeyRef.current === nextSummaryKey) {
      return;
    }

    lastViewportSummaryKeyRef.current = nextSummaryKey;
    startTransition(() => {
      onViewportAggregationChange?.(aggregation.summary);
    });
  }, [aggregation.summary, onViewportAggregationChange]);

  const handleFeatureClick = useEffectEvent((feature: AggregatedMapFeature<TProperties>) => {
    if (feature.kind === "cluster") {
      setViewState((current) => ({
        center: feature.coordinates,
        zoom: Math.min(8, Math.max(current.zoom + 0.8, feature.expansionZoom)),
      }));
    }

    startTransition(() => {
      onFeatureSelect?.(feature);
    });
  });

  return (
    <div
      aria-label={mapLabel}
      className={joinClassNames("mb-maps", "mb-maps--globe", className)}
      data-map-ready="true"
      style={{
        minHeight: 480,
        width: "100%",
        ...style,
      }}
    >
      <svg
        className="mb-maps__globe"
        viewBox={`0 0 ${GLOBE_VIEWBOX_WIDTH} ${GLOBE_VIEWBOX_HEIGHT}`}
        role="img"
        onPointerDown={(event) => {
          dragRef.current = {
            center: viewState.center,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;

          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }

          setViewState((current) => ({
            ...current,
            center: getGlobeDragCenter(
              drag.center,
              event.clientX - drag.x,
              event.clientY - drag.y,
              current.zoom,
            ),
          }));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
          }
        }}
        onWheel={(event) => {
          event.preventDefault();
          setViewState((current) => ({
            ...current,
            zoom: getGlobeZoom(current.zoom, event.deltaY),
          }));
        }}
      >
        <GlobeBase viewState={viewState} />
        <g className="mb-maps__globe-features">
          {aggregation.features.map((feature) => (
            <GlobeAggregationFeature
              feature={feature}
              key={feature.kind === "cluster" ? `cluster-${feature.clusterId}` : feature.point.id}
              onClick={handleFeatureClick}
              viewState={viewState}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function GlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
      <defs>
        <radialGradient id="mb-maps-globe-ocean" cx="38%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#dbeafe" />
          <stop offset="58%" stopColor="#67e8f9" />
          <stop offset="100%" stopColor="#0f766e" />
        </radialGradient>
      </defs>
      <circle
        className="mb-maps__globe-ocean"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
      <g className="mb-maps__globe-graticule">
        {createGlobeGraticuleLines(viewState).map((line, index) => {
          const path = createVisibleSvgPath(line);

          return path ? <path d={path} key={index} /> : null;
        })}
      </g>
      <circle
        className="mb-maps__globe-rim"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
    </>
  );
}

function GlobeAggregationFeature<TProperties>({
  feature,
  onClick,
  viewState,
}: {
  feature: AggregatedMapFeature<TProperties>;
  onClick: (feature: AggregatedMapFeature<TProperties>) => void;
  viewState: GlobeViewState;
}) {
  const projected = projectGlobeCoordinate(feature.coordinates, viewState);

  if (!projected.visible) {
    return null;
  }

  if (feature.kind === "cluster") {
    const radius = getClusterRadius(feature.pointCount) * (0.72 + projected.scale * 0.28);

    return (
      <g
        className="mb-maps__globe-cluster"
        onClick={(event) => {
          event.stopPropagation();
          onClick(feature);
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
      className="mb-maps__globe-point"
      cx={projected.x}
      cy={projected.y}
      onClick={(event) => {
        event.stopPropagation();
        onClick(feature);
      }}
      r={6 * (0.72 + projected.scale * 0.28)}
      style={{ opacity: 0.42 + projected.scale * 0.58 }}
    >
      <title>{feature.point.label}</title>
    </circle>
  );
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
