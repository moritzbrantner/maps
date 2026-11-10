import type {
  HeatFieldRenderMode,
  HeatLayerFeatureCollection,
  HeatLayerRadius,
  HeatLayerRenderStrategy,
  HeatLayerSurfaceMode,
} from "./heat-layer-types";
import type { PreparedHeatLayerColorRamp } from "./heat-surface";
import type { HeatFieldContourFeatureCollection, HeatFieldImage } from "./scalar-field-render";
import type { HeatLayerDataWork } from "./heat-layer-work";

export type MapsHeatLayerSourceIndex = {
  getFeatureCollection(
    bounds: [west: number, south: number, east: number, north: number],
  ): HeatLayerFeatureCollection;
};

export type MapsHeatLayerDescriptor = {
  dataPointColor: string;
  dataPointOpacity: number;
  dataPointRadius: number;
  dataPointStrokeColor: string;
  dataPointStrokeWidth: number;
  dataPointValueFormat?: (value: number) => string;
  fieldContourCollection: HeatFieldContourFeatureCollection | null;
  fieldContourColor?: string;
  fieldContourLineWidth?: number;
  fieldContourOpacity: number;
  fieldDataPointCollection: HeatLayerFeatureCollection | null;
  fieldImage: HeatFieldImage | null;
  fieldOpacity: number;
  fieldRenderMode: HeatFieldRenderMode;
  heatIndex: MapsHeatLayerSourceIndex;
  heatmapAsyncRender: boolean;
  heatmapColorRamp: PreparedHeatLayerColorRamp;
  heatmapIntensity: number;
  heatmapMaxRasterPixels: number;
  heatmapMaxZoom: number;
  heatmapMinZoomDeltaForRebuild: number;
  heatmapOpacity: number;
  heatmapOverscanRatio: number;
  heatmapRadius: HeatLayerRadius;
  heatmapRenderStrategy: HeatLayerRenderStrategy;
  heatmapSurfaceMode: HeatLayerSurfaceMode;
  layerId: string;
  showDataPoints: boolean;
  /** Camera-independent artifact work of the mounted layer, shared by all its descriptors. */
  work: HeatLayerDataWork;
};
