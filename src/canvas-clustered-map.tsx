"use client";

import { getBoundsFromPoints } from "./aggregation";
import { CanvasPointClusterLayer } from "./canvas-point-cluster-layer";
import type { ClusteredMapProps } from "./clustered-map";
import { defaultRasterMapStyle } from "./map-display";
import { MapView } from "./map-view";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";

/** Private reference composition used by the showcase to prove the renderer boundary. */
export function CanvasClusteredMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  children,
  className,
  clusterRadius,
  defaultViewState,
  filterPoint,
  fitBoundsPadding = 56,
  fitToData = true,
  getFeatureId,
  hoveredFeatureId,
  initialViewState,
  mapLabel = "Interactive map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  minZoom,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onHoveredFeatureIdChange,
  onMapControllerReady,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  onSelectedFeatureIdChange,
  onViewStateChange,
  onViewportAggregationChange,
  points = [],
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
  showAttributionControl = true,
  style,
  viewState,
}: ClusteredMapProps<TProperties>) {
  return (
    <MapView
      className={className}
      dataBounds={getBoundsFromPoints(points)}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      initialViewState={initialViewState}
      mapDisplay="flat"
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
      <CanvasPointClusterLayer
        clusterRadius={clusterRadius}
        filterPoint={filterPoint}
        getFeatureId={getFeatureId}
        hoveredFeatureId={hoveredFeatureId}
        maxZoom={maxZoom}
        minZoom={minZoom}
        onFeatureContextMenu={onFeatureContextMenu}
        onFeatureHover={onFeatureHover}
        onFeatureSelect={onFeatureSelect}
        onHoveredFeatureIdChange={onHoveredFeatureIdChange}
        onSelectedFeatureIdChange={onSelectedFeatureIdChange}
        onViewportAggregationChange={onViewportAggregationChange}
        points={points}
        renderFeatureContextMenu={renderFeatureContextMenu}
        renderFeaturePopup={renderFeaturePopup}
        renderFeatureTooltip={renderFeatureTooltip}
        selectedFeatureId={selectedFeatureId}
      />
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
