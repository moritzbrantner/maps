"use client";

import type { ReactNode } from "react";

import {
  defaultRasterMapStyle,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import {
  FlowLayer,
  type FlowDirectionMarker,
  type FlowLayerFeature,
  type FlowLayerWeightAccessor,
  type FlowShape,
  type IndexedMapFlow as LayerIndexedMapFlow,
  type MapFlow as LayerMapFlow,
} from "./flow-layer";
import {
  createGeoJsonOverlayFeatureCollection,
  createMapFlowsFromGeoJson,
  getBoundsFromGeoJson,
  type GeoJsonMapSource,
  type GeoJsonOverlayMode,
  type GeoJsonSourceOptions,
} from "./geojson-source";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapView } from "./map-view";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";

export type MapFlow<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  LayerMapFlow<TProperties>;

export type IndexedMapFlow<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  LayerIndexedMapFlow<TProperties>;

export type FlowMapFeature<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  FlowLayerFeature<TProperties>;

export type FlowMapWeightAccessor<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  FlowLayerWeightAccessor<TProperties>;

export type FlowMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  children?: ReactNode;
  className?: string;
  directionMarker?: FlowDirectionMarker;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  flowColor?: string;
  flowShape?: FlowShape;
  flowValueFormat?: (value: number, feature: FlowMapFeature<TProperties>) => string;
  flows?: readonly MapFlow<TProperties>[];
  geoJson?: GeoJsonMapSource<TProperties>;
  geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
  geoJsonOverlay?: GeoJsonOverlayMode;
  geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
  getFlowColor?: (feature: FlowMapFeature<TProperties>) => string;
  getFlowLabel?: (feature: FlowMapFeature<TProperties>) => ReactNode;
  getWeight?: FlowMapWeightAccessor<TProperties>;
  hoveredFlowOpacity?: number;
  inactiveFlowOpacity?: number;
  /**
   * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
   */
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxWeight?: number;
  maxWidth?: number;
  minWidth?: number;
  onFeatureSelect?: (feature: FlowMapFeature<TProperties> | null) => void;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: import("maplibre-gl").Map) => void;
  selectedFlowOpacity?: number;
  showAttributionControl?: boolean;
  showDirection?: boolean;
  showEndpoints?: boolean;
  style?: React.CSSProperties;
  weightMetric?: string;
} & MapMeasurementProps &
  MapViewportProps &
  MapFeatureInteractionProps<FlowMapFeature<TProperties>>;

export function FlowMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay = "flat",
  children,
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  initialViewState,
  mapLabel = "Interactive flow map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
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
  flows,
  geoJson,
  geoJsonOptions,
  geoJsonOverlay,
  geoJsonOverlayProps,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  onViewStateChange,
  ...props
}: FlowMapProps<TProperties>) {
  const resolvedFlows = flows ?? (geoJson ? createMapFlowsFromGeoJson(geoJson, geoJsonOptions) : []);
  const geoJsonOverlayCollection = geoJson
    ? createGeoJsonOverlayFeatureCollection(geoJson, {
        mode: geoJsonOverlay,
        target: "flow",
      })
    : null;

  return (
    <MapView
      className={className}
      dataBounds={geoJson ? getBoundsFromGeoJson(geoJson) : getBoundsFromFlows(resolvedFlows)}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      maxZoom={maxZoom}
      onMapControllerReady={onMapControllerReady}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      showAttributionControl={showAttributionControl}
      style={style}
      viewState={viewState}
    >
      {geoJsonOverlayCollection && geoJsonOverlayCollection.features.length > 0 ? (
        <GeoJsonLayer
          {...(geoJsonOverlayProps as Omit<GeoJsonLayerProps, "featureCollection"> | undefined)}
          featureCollection={geoJsonOverlayCollection}
        />
      ) : null}
      <FlowLayer {...(props as React.ComponentProps<typeof FlowLayer<TProperties>>)} flows={resolvedFlows} />
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

export function createFlowMapFeatures<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  flows: readonly MapFlow<TProperties>[],
  options: {
    getWeight?: FlowMapWeightAccessor<TProperties>;
    maxWeight?: number;
    maxWidth?: number;
    minWidth?: number;
    weightMetric?: string;
  } = {},
): Array<FlowMapFeature<TProperties>> {
  const indexedFlows = flows.map(toIndexedFlow).filter(isValidFlow);
  const weightedFlows = indexedFlows
    .map((flow) => ({
      flow,
      rawValue: resolveFlowWeight(flow, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFlows.map((entry) => entry.rawValue));
  const minWidth = Math.max(0, options.minWidth ?? 1.5);
  const maxWidth = Math.max(minWidth, options.maxWidth ?? 12);

  return weightedFlows.map(({ flow, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      flow,
      rawValue,
      value,
      width: minWidth + Math.sqrt(value) * (maxWidth - minWidth),
    };
  });
}

export function FlatFlowMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay: _mapDisplay,
  ...props
}: FlowMapProps<TProperties>) {
  return <FlowMap {...props} mapDisplay="flat" />;
}

function getBoundsFromFlows<TProperties extends Record<string, unknown>>(flows: readonly MapFlow<TProperties>[]) {
  const coordinates = flows
    .flatMap((flow) => [flow.from, flow.to])
    .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));

  if (coordinates.length === 0) {
    return null;
  }

  return coordinates.reduce(
    (bounds, [longitude, latitude]) =>
      [
        Math.min(bounds[0], longitude),
        Math.min(bounds[1], latitude),
        Math.max(bounds[2], longitude),
        Math.max(bounds[3], latitude),
      ] as [number, number, number, number],
    [180, 90, -180, -90] as [number, number, number, number],
  );
}

function resolveFlowWeight<TProperties extends Record<string, unknown>>(
  flow: IndexedMapFlow<TProperties>,
  options: {
    getWeight?: FlowMapWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(flow)
    : options.weightMetric
      ? flow.metrics[options.weightMetric] ?? 0
      : flow.metrics.weight ?? 1;

  if (!Number.isFinite(rawWeight)) {
    return 0;
  }

  return Math.max(0, rawWeight);
}

function toIndexedFlow<TProperties extends Record<string, unknown>>(
  flow: MapFlow<TProperties>,
  index: number,
): IndexedMapFlow<TProperties> {
  return {
    from: flow.from,
    id: String(flow.id ?? index),
    label: flow.label ?? "",
    metrics: flow.metrics ?? {},
    properties: flow.properties ?? ({} as TProperties),
    to: flow.to,
  };
}

function isValidFlow<TProperties extends Record<string, unknown>>(flow: IndexedMapFlow<TProperties>) {
  return (
    Number.isFinite(flow.from[0]) &&
    Number.isFinite(flow.from[1]) &&
    Number.isFinite(flow.to[0]) &&
    Number.isFinite(flow.to[1])
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
