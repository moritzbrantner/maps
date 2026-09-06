"use client";

/**
 * Compatibility entrypoint retained for consumers importing map-engine directly.
 * The implementation now lives in the Maps-owned runtime and no longer depends
 * on a generic visualization engine.
 */
export {
  EngineGeoJsonLayer,
  GeoClusterLayer,
  GeoFlowLayer,
  GeoHeatLayer,
  GeoPointLayer,
  MapDataset,
  MapEngineProvider,
  useMapEngine,
  useMapFrame,
  type EngineGeoJsonLayerFeature,
  type EngineGeoJsonLayerProps,
  type GeoClusterLayerProps,
  type GeoFlowLayerProps,
  type GeoHeatLayerProps,
  type GeoPointLayerProps,
  type MapDatasetProps,
  type MapEngineProviderProps,
} from "./map-native-components";
