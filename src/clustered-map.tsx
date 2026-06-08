"use client";

import {
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
  defaultRasterMapStyle,
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
