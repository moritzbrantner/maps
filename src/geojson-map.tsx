"use client";

import type { Map as MapLibreMap } from "maplibre-gl";

import {
  getBoundsFromGeoJson,
  type GeoJsonMapSource,
} from "./geojson-source";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import {
  defaultRasterMapStyle,
  type GlobeBasemapMode,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import type { MapContextMenuContext } from "./map-interaction";
import { MapView } from "./map-view";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";

export type GeoJsonMapProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = Omit<GeoJsonLayerProps<TProperties>, "featureCollection"> &
  MapMeasurementProps &
  MapViewportProps & {
    children?: React.ReactNode;
    className?: string;
    fitBoundsPadding?: number;
    fitToData?: boolean;
    geoJson: GeoJsonMapSource<TProperties>;
    globeBasemapMode?: GlobeBasemapMode;
    /**
     * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
     */
    initialViewState?: MapViewState;
    mapDisplay?: MapDisplayMode;
    mapLabel?: string;
    mapStyle?: string | RasterMapStyle;
    onMapControllerReady?: (controller: MapSurfaceController) => void;
    onMapContextMenu?: (context: MapContextMenuContext) => void;
    onMapReady?: (map: MapLibreMap) => void;
    renderMapContextMenu?: (context: MapContextMenuContext) => React.ReactNode;
    showAttributionControl?: boolean;
    style?: React.CSSProperties;
  };

export function GeoJsonMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  className,
  children,
  fitBoundsPadding = 56,
  fitToData = true,
  geoJson,
  globeBasemapMode,
  initialViewState,
  mapDisplay = "flat",
  mapLabel = "Interactive GeoJSON map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  onMapControllerReady,
  onMapContextMenu,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  onViewStateChange,
  renderMapContextMenu,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  ...layerProps
}: GeoJsonMapProps<TProperties>) {
  return (
    <MapView
      className={className}
      dataBounds={getBoundsFromGeoJson(geoJson)}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      globeBasemapMode={globeBasemapMode}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      maxZoom={maxZoom}
      onMapControllerReady={onMapControllerReady}
      onMapContextMenu={onMapContextMenu}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      renderMapContextMenu={renderMapContextMenu}
      showAttributionControl={showAttributionControl}
      style={style}
      viewState={viewState}
    >
      <GeoJsonLayer
        {...(layerProps as Omit<GeoJsonLayerProps<TProperties>, "featureCollection">)}
        featureCollection={geoJson}
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
