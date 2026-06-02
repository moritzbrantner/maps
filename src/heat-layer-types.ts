"use client";

import type { HeatFieldContourOptions, HeatFieldColorStop } from "./scalar-field-render";
import type { HeatFieldOptions, HeatFieldMaskGeoJson } from "./scalar-field";
import type {
  IndexedMapPoint,
  MapPoint,
  MapPointFilter,
  PointAggregationIndexOptions,
} from "./aggregation";
import type { MapFeatureInteractionProps } from "./map-interaction";

export const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";
export const DEFAULT_HEAT_LAYER_RADIUS_METERS = 50_000;
export const DEFAULT_HEAT_LAYER_MAX_RASTER_PIXELS = 512_000;
export const DEFAULT_HEAT_LAYER_MIN_ZOOM_DELTA_FOR_REBUILD = 1;
export const DEFAULT_HEAT_LAYER_OVERSCAN_RATIO = 1;
export const METERS_PER_DEGREE_AT_EQUATOR = 111_320;

export type HeatLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatFieldRenderMode = "raster" | "contours" | "raster-contours";

export type HeatLayerSurfaceMode = "data" | "interpolated" | "field";

export type HeatLayerRenderStrategy = "auto" | "stable-raster" | "viewport-raster";

export type HeatLayerRadius =
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

export type HeatLayerFeatureProperties = {
  kind: "heat-cluster" | "heat-point";
  label: string;
  pointId: string;
  pointCount: number;
  rawWeight: number;
  weight: number;
} & Record<string, number | string>;

export type HeatLayerFeature = {
  geometry: {
    coordinates: [longitude: number, latitude: number];
    type: "Point";
  };
  properties: HeatLayerFeatureProperties;
  type: "Feature";
};

export type HeatLayerFeatureCollection = {
  features: HeatLayerFeature[];
  type: "FeatureCollection";
};

export type HeatLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<HeatLayerFeature> & {
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
    filterPoint?: MapPointFilter<TProperties>;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    heatmapAggregationMaxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    heatmapAggregationMinZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    heatmapAggregationRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    heatmapColorRamp?: readonly HeatLayerColorStop[];
    heatmapIntensity?: number;
    heatmapAsyncRender?: boolean;
    heatmapMaxRasterPixels?: number;
    heatmapMaxZoom?: number;
    heatmapMinZoomDeltaForRebuild?: number;
    heatmapSurfaceMode?: HeatLayerSurfaceMode;
    heatmapOpacity?: number;
    heatmapOverscanRatio?: number;
    heatmapRadius?: HeatLayerRadius;
    heatmapRenderStrategy?: HeatLayerRenderStrategy;
    interpolationEpsilonMeters?: HeatFieldOptions<TProperties>["interpolationEpsilonMeters"];
    interpolationExtrapolate?: HeatFieldOptions<TProperties>["interpolationExtrapolate"];
    interpolationK?: HeatFieldOptions<TProperties>["interpolationK"];
    interpolationMaxDistanceMeters?: HeatFieldOptions<TProperties>["interpolationMaxDistanceMeters"];
    interpolationPower?: HeatFieldOptions<TProperties>["interpolationPower"];
    layerId?: string;
    maskGeoJson?: HeatFieldMaskGeoJson | null;
    maxWeight?: number;
    points: readonly MapPoint<TProperties>[];
    showDataPoints?: boolean;
    dataPointColor?: string;
    dataPointOpacity?: number;
    dataPointRadius?: number;
    dataPointStrokeColor?: string;
    dataPointStrokeWidth?: number;
    dataPointValueFormat?: (value: number) => string;
    valueMetric?: string;
    weightMetric?: string;
  };

export const defaultHeatLayerColorRamp = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
] as const satisfies readonly HeatLayerColorStop[];
