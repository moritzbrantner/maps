"use client";

export {
  createMapDensityViewportSummary,
  createPointAggregationIndex,
  getBoundsFromPoints,
  type AggregatedMapCluster,
  type AggregatedMapFeature,
  type AggregatedMapPoint,
  type IndexedMapPoint,
  type MapDensityViewportSummary,
  type MapMetricRecord,
  type MapPointFilter,
  type MapPoint,
  type PointAggregationIndex,
  type PointAggregationIndexOptions,
  type ViewportAggregation,
  type ViewportAggregationQuery,
  type VisibleAggregationSummary,
} from "./aggregation";
export {
  ClusteredMap,
  defaultRasterMapStyle,
  type ClusteredMapProps,
  type MapViewState,
} from "./clustered-map";
export {
  HeatMap,
  createHeatMapDensityIndex,
  createHeatMapFeatureCollection,
  getHeatMapMaxWeight,
  resolveHeatMapPointWeight,
  type HeatMapColorStop,
  type HeatMapDensityIndex,
  type HeatMapDensityIndexOptions,
  type HeatMapFeature,
  type HeatMapFeatureCollection,
  type HeatMapFeatureProperties,
  type HeatMapProps,
  type HeatMapRadius,
  type HeatMapWeightAccessor,
  type HeatMapWeightOptions,
} from "./heat-map";
export {
  getTemporalMapPointsAtTime,
  getTemporalMapTimeRange,
  snapTemporalMapTime,
  type TemporalMapKeyframe,
  type TemporalMapTimeRange,
  type TemporalMapTrack,
} from "./temporal-points";
export {
  createTemporalMapTracksFromGeoJson,
  type TemporalGeoJsonPointFeature,
  type TemporalGeoJsonPointFeatureCollection,
  type TemporalGeoJsonTrackOptions,
} from "./temporal-geojson";
export {
  createTemporalGeoJsonTracksFromGeoJson,
  createTemporalGeoJsonPlaybackIndex,
  getTemporalGeoJsonFeatureCollectionAtTime,
  getTemporalGeoJsonTimeRange,
  interpolateTemporalGeoJsonGeometry,
  type GeoJsonLineStringGeometry,
  type GeoJsonMultiLineStringGeometry,
  type GeoJsonMultiPolygonGeometry,
  type GeoJsonPointGeometry,
  type GeoJsonPolygonGeometry,
  type GeoJsonPosition,
  type TemporalGeoJsonFrame,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonGeometryTrackOptions,
  type TemporalGeoJsonInterpolationOptions,
  type TemporalGeoJsonInterpolationStrategy,
  type TemporalGeoJsonOutputFeature,
  type TemporalGeoJsonOutputFeatureCollection,
  type TemporalGeoJsonPlaybackIndex,
  type TemporalGeoJsonPlaybackIndexOptions,
  type TemporalGeoJsonSupportedGeometry,
  type TemporalGeoJsonTrack,
} from "./temporal-geojson-geometries";
export { TemporalClusteredMap, type TemporalClusteredMapProps } from "./temporal-map";
export {
  TemporalHeatMap,
  getTemporalHeatMapMaxWeight,
  type TemporalHeatMapProps,
} from "./temporal-heat-map";
