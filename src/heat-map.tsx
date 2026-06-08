"use client";

import {
  getBoundsFromPoints,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
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
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import {
  HeatLayer,
  type HeatFieldRenderMode,
  type HeatLayerRenderStrategy,
  type HeatLayerSurfaceMode,
} from "./heat-layer";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { MapView } from "./map-view";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";
import { type HeatFieldMaskGeoJson, type HeatFieldOptions } from "./scalar-field";
import {
  type HeatFieldContourOptions,
  type HeatFieldColorStop,
} from "./scalar-field-render";
import type { TemporalGeoJsonGeometryFeatureCollection } from "./temporal-geojson-types";

export {
  createHeatMapDensityIndex,
  createHeatMapFeatureCollection,
  getHeatMapMaxWeight,
  resolveHeatMapPointWeight,
} from "./heat-core";

export type HeatMapWeightAccessor<TProperties extends Record<string, unknown> = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatMapColorStop = readonly [density: number, color: string];

export type HeatMapSurfaceMode = HeatLayerSurfaceMode;

export type HeatMapRadius =
  | number
  | {
      meters: number;
    }
  | {
      max: number;
      maxZoom?: number;
      min: number;
      minZoom?: number;
    };

export type HeatMapFeatureProperties = {
  kind: "heat-cluster" | "heat-point";
  label: string;
  pointId: string;
  pointCount: number;
  rawWeight: number;
  weight: number;
} & Record<string, number | string>;

export type HeatMapFeature = {
  geometry: {
    coordinates: [longitude: number, latitude: number];
    type: "Point";
  };
  properties: HeatMapFeatureProperties;
  type: "Feature";
};

export type HeatMapFeatureCollection = {
  features: HeatMapFeature[];
  type: "FeatureCollection";
};

export type HeatMapWeightOptions<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  filterPoint?: MapPointFilter<TProperties>;
  getWeight?: HeatMapWeightAccessor<TProperties>;
  maxWeight?: number;
  weightMetric?: string;
};

export type HeatMapDensityIndexOptions<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  HeatMapWeightOptions<TProperties> & {
    maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    radius?: PointAggregationIndexOptions<TProperties>["radius"];
  };

export type HeatMapDensityIndex = {
  getFeatureCollection(query: ViewportAggregationQuery): HeatMapFeatureCollection;
  maxWeight: number;
  pointCount: number;
};

export type HeatMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  HeatMapWeightOptions<TProperties> &
    MapMeasurementProps & {
    children?: React.ReactNode;
    className?: string;
    domainBounds?: HeatFieldOptions<TProperties>["domainBounds"];
    domainPaddingRatio?: HeatFieldOptions<TProperties>["domainPaddingRatio"];
    fieldCellSizeMeters?: HeatFieldOptions<TProperties>["fieldCellSizeMeters"];
    fieldContourColor?: HeatFieldContourOptions["lineColor"];
    fieldContourLevels?: HeatFieldContourOptions["levels"];
    fieldContourLineWidth?: HeatFieldContourOptions["lineWidth"];
    fieldContourOpacity?: HeatFieldContourOptions["opacity"];
    fieldContourValueFormat?: HeatFieldContourOptions["valueFormat"];
    fieldColorRamp?: readonly HeatFieldColorStop[];
    fieldColumns?: HeatFieldOptions<TProperties>["fieldColumns"];
    fieldOpacity?: HeatFieldOptions<TProperties>["opacity"];
    fieldAsyncRender?: boolean;
    fieldRenderMode?: HeatFieldRenderMode;
    fieldRows?: HeatFieldOptions<TProperties>["fieldRows"];
    fieldValueDomain?: HeatFieldOptions<TProperties>["valueDomain"];
    fitBoundsPadding?: number;
    fitToData?: boolean;
    geoJson?: GeoJsonMapSource<TProperties>;
    geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
    geoJsonOverlay?: GeoJsonOverlayMode;
    geoJsonOverlayCollection?: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
    geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
    heatmapAggregationMaxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    heatmapAggregationMinZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    heatmapAggregationRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    heatmapAsyncRender?: boolean;
    heatmapColorRamp?: readonly HeatMapColorStop[];
    heatmapIntensity?: number;
    heatmapMaxRasterPixels?: number;
    heatmapMaxZoom?: number;
    heatmapMinZoomDeltaForRebuild?: number;
    heatmapOpacity?: number;
    heatmapOverscanRatio?: number;
    heatmapRadius?: HeatMapRadius;
    heatmapRenderStrategy?: HeatLayerRenderStrategy;
    heatmapSurfaceMode?: HeatMapSurfaceMode;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    /**
     * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
     */
    initialViewState?: MapViewState;
    interpolationEpsilonMeters?: HeatFieldOptions<TProperties>["interpolationEpsilonMeters"];
    interpolationExtrapolate?: HeatFieldOptions<TProperties>["interpolationExtrapolate"];
    interpolationK?: HeatFieldOptions<TProperties>["interpolationK"];
    interpolationMaxDistanceMeters?: HeatFieldOptions<TProperties>["interpolationMaxDistanceMeters"];
    interpolationPower?: HeatFieldOptions<TProperties>["interpolationPower"];
    mapDisplay?: MapDisplayMode;
    mapLabel?: string;
    mapStyle?: string | RasterMapStyle;
    maskGeoJson?: HeatFieldMaskGeoJson | null;
    onMapControllerReady?: (controller: MapSurfaceController) => void;
    onMapReady?: (map: import("maplibre-gl").Map) => void;
    points?: readonly MapPoint<TProperties>[];
    showAttributionControl?: boolean;
    showDataPoints?: boolean;
    dataPointColor?: string;
    dataPointOpacity?: number;
    dataPointRadius?: number;
    dataPointStrokeColor?: string;
    dataPointStrokeWidth?: number;
    dataPointValueFormat?: (value: number) => string;
    style?: React.CSSProperties;
    valueMetric?: string;
  } & MapViewportProps;

export function HeatMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay = "flat",
  children,
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  initialViewState,
  mapLabel = "Interactive heat map",
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
  points,
  geoJson,
  geoJsonOptions,
  geoJsonOverlay,
  geoJsonOverlayCollection,
  geoJsonOverlayProps,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  onViewStateChange,
  ...props
}: HeatMapProps<TProperties>) {
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
      maxZoom={maxZoom}
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
      <HeatLayer {...(props as React.ComponentProps<typeof HeatLayer<TProperties>>)} points={resolvedPoints} />
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

export type HeatFieldMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = Omit<
  HeatMapProps<TProperties>,
  "heatmapSurfaceMode"
>;

export function HeatFieldMap<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  props: HeatFieldMapProps<TProperties>,
) {
  return <HeatMap {...props} heatmapSurfaceMode="field" />;
}

export function FlatHeatMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay: _mapDisplay,
  ...props
}: HeatMapProps<TProperties>) {
  return <HeatMap {...props} mapDisplay="flat" />;
}

export type FlatHeatFieldMapProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = Omit<HeatMapProps<TProperties>, "heatmapSurfaceMode" | "mapDisplay">;

export function FlatHeatFieldMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(props: FlatHeatFieldMapProps<TProperties>) {
  return <FlatHeatMap {...props} heatmapSurfaceMode="field" />;
}
