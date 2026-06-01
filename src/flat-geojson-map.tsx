"use client";

import type { Map as MapLibreMap } from "maplibre-gl";

import { getBoundsFromGeoJson, type GeoJsonMapSource } from "./geojson-source";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import {
  defaultRasterMapStyle,
  type MapBounds,
  type MapViewState,
  type RasterMapStyle,
} from "./map-display";
import { MapView } from "./map-view";

export type FlatGeoJsonMapProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
  GeoJsonLayerProps<TProperties>,
  | "featureCollection"
  | "onFeatureContextMenu"
  | "onFeatureHover"
  | "renderFeatureContextMenu"
  | "renderFeaturePopup"
  | "renderFeatureTooltip"
> & {
  className?: string;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  geoJson: GeoJsonMapSource<TProperties>;
  initialViewState?: MapViewState;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxBounds?: MapBounds;
  maxZoom?: number;
  onMapReady?: (map: MapLibreMap) => void;
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
};

export function FlatGeoJsonMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  geoJson,
  initialViewState,
  mapLabel = "Interactive GeoJSON map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  onMapReady,
  showAttributionControl = true,
  style,
  ...layerProps
}: FlatGeoJsonMapProps<TProperties>) {
  return (
    <MapView
      className={className}
      dataBounds={getBoundsFromGeoJson(geoJson)}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      initialViewState={initialViewState}
      mapDisplay="flat"
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      maxZoom={maxZoom}
      onMapReady={onMapReady}
      showAttributionControl={showAttributionControl}
      style={style}
    >
      <GeoJsonLayer {...layerProps} featureCollection={geoJson} />
    </MapView>
  );
}
