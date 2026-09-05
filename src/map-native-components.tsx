"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { IndexedMapPoint, MapPoint } from "./aggregation";
import type { MapFlow } from "./flow-layer";
import {
  GeoJsonLayer,
  type GeoJsonLayerFeature,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import type { GeoJsonMapSource } from "./geojson-source";
import {
  MapDataset as LegacyMapDataset,
  MapEngineProvider as LegacyMapEngineProvider,
  type MapDatasetProps as LegacyMapDatasetProps,
  type MapEngineProviderProps as LegacyMapEngineProviderProps,
} from "./map-engine";
import type {
  MapFeatureContextMenuContext,
  MapFeatureInteractionChange,
  MapFeatureInteractionProps,
} from "./map-interaction";
import { PointLayer, type PointLayerFeature } from "./point-layer";
import type { MapRuntimeDataset } from "./map-runtime";
import type { TemporalGeoJsonSupportedGeometry } from "./temporal-geojson-types";

export type MapEngineProviderProps = LegacyMapEngineProviderProps;

export type MapDatasetProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> =
  | { id: string; kind: "geo-points"; points: readonly MapPoint<TProperties>[] }
  | { featureCollection: GeoJsonMapSource<TProperties>; id: string; kind: "geojson" }
  | { flows: readonly MapFlow<TProperties>[]; id: string; kind: "geo-flows" };

type MapRuntimeContextValue = {
  getDataset(publicId: string): MapRuntimeDataset | null;
  registerDataset(publicId: string, dataset: MapRuntimeDataset): () => void;
  version: number;
};

const MapRuntimeContext = createContext<MapRuntimeContextValue | null>(null);

/**
 * Public map runtime coordinator.
 *
 * Maps-native datasets are the source of truth for migrated layer kinds. The
 * nested legacy provider is temporary and exists only so cluster/heat/flow
 * layers that have not migrated yet continue to work during the vertical
 * cutover from viz-engine.
 */
export function MapEngineProvider({ children, ...legacyProps }: MapEngineProviderProps) {
  const datasetsRef = useRef(new Map<string, MapRuntimeDataset>());
  const [version, setVersion] = useState(0);
  const getDataset = useCallback(
    (publicId: string) => datasetsRef.current.get(publicId) ?? null,
    [],
  );
  const registerDataset = useCallback((publicId: string, dataset: MapRuntimeDataset) => {
    datasetsRef.current.set(publicId, dataset);
    setVersion((current) => current + 1);

    return () => {
      if (datasetsRef.current.get(publicId) === dataset) {
        datasetsRef.current.delete(publicId);
        setVersion((current) => current + 1);
      }
    };
  }, []);
  const value = useMemo<MapRuntimeContextValue>(
    () => ({ getDataset, registerDataset, version }),
    [getDataset, registerDataset, version],
  );

  return (
    <LegacyMapEngineProvider {...legacyProps}>
      <MapRuntimeContext.Provider value={value}>{children}</MapRuntimeContext.Provider>
    </LegacyMapEngineProvider>
  );
}

export function MapDataset<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(props: MapDatasetProps<TProperties>) {
  const { registerDataset } = useMapRuntime();

  useEffect(() => {
    if (props.kind !== "geo-points") return;
    return registerDataset(props.id, { kind: "geo-points", points: props.points });
  }, [props.id, props.kind, props.kind === "geo-points" ? props.points : null, registerDataset]);

  useEffect(() => {
    if (props.kind !== "geojson") return;
    return registerDataset(props.id, {
      featureCollection: props.featureCollection,
      kind: "geojson",
    });
  }, [
    props.id,
    props.kind,
    props.kind === "geojson" ? props.featureCollection : null,
    registerDataset,
  ]);

  useEffect(() => {
    if (props.kind !== "geo-flows") return;
    return registerDataset(props.id, { flows: props.flows, kind: "geo-flows" });
  }, [props.id, props.kind, props.kind === "geo-flows" ? props.flows : null, registerDataset]);

  // Keep not-yet-migrated cluster/heat/flow consumers alive while their
  // computation moves into Maps-owned implementations in the next slice.
  return <LegacyMapDataset {...(props as unknown as LegacyMapDatasetProps)} />;
}

export type GeoPointLayerProps = {
  datasetId: string;
  getFeatureColor?: (feature: IndexedMapPoint) => string;
  getFeatureRadius?: (feature: IndexedMapPoint) => number;
  layerId?: string;
  onFeatureSelect?: (feature: IndexedMapPoint | null) => void;
} & MapFeatureInteractionProps<IndexedMapPoint>;

export function GeoPointLayer(props: GeoPointLayerProps) {
  const { getDataset, version } = useMapRuntime();
  const dataset = getDataset(props.datasetId);
  void version;

  if (dataset?.kind !== "geo-points") return null;

  return (
    <PointLayer
      getFeatureId={(feature) => props.getFeatureId?.(feature.point) ?? feature.point.id}
      getPointColor={
        props.getFeatureColor ? (feature) => props.getFeatureColor?.(feature.point) ?? "#0f172a" : undefined
      }
      getPointRadius={
        props.getFeatureRadius ? (feature) => props.getFeatureRadius?.(feature.point) ?? 5 : undefined
      }
      hoveredFeatureId={props.hoveredFeatureId}
      layerId={props.layerId ?? `geo-points-${props.datasetId}`}
      onFeatureContextMenu={mapPointCallback(props.onFeatureContextMenu)}
      onFeatureHover={mapNullablePointCallback(props.onFeatureHover)}
      onFeatureSelect={mapNullablePointCallback(props.onFeatureSelect)}
      onHoveredFeatureIdChange={mapPointInteractionChange(props.onHoveredFeatureIdChange)}
      onSelectedFeatureIdChange={mapPointInteractionChange(props.onSelectedFeatureIdChange)}
      points={dataset.points}
      pointRadius={5}
      renderFeatureContextMenu={mapPointContextMenu(props.renderFeatureContextMenu)}
      renderFeaturePopup={mapPointRenderer(props.renderFeaturePopup)}
      renderFeatureTooltip={mapPointRenderer(props.renderFeatureTooltip)}
      selectedFeatureId={props.selectedFeatureId}
    />
  );
}

export type EngineGeoJsonLayerFeature<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  geometry: TemporalGeoJsonSupportedGeometry;
  id: string;
  properties: TProperties;
  sourceIndex: number;
  type: "Feature";
};

export type EngineGeoJsonLayerProps = {
  datasetId: string;
  getFeatureStyle?: (feature: EngineGeoJsonLayerFeature) => GeoJsonLayerStyle;
  layerId?: string;
  onFeatureSelect?: (feature: EngineGeoJsonLayerFeature | null) => void;
} & GeoJsonLayerStyle &
  MapFeatureInteractionProps<EngineGeoJsonLayerFeature>;

export function EngineGeoJsonLayer(props: EngineGeoJsonLayerProps) {
  const { getDataset, version } = useMapRuntime();
  const dataset = getDataset(props.datasetId);
  void version;

  if (dataset?.kind !== "geojson") return null;

  return (
    <GeoJsonLayer
      featureCollection={dataset.featureCollection}
      getFeatureId={(feature) => props.getFeatureId?.(toEngineGeoJsonFeature(feature)) ?? feature.id}
      getFeatureStyle={
        props.getFeatureStyle
          ? (feature) => props.getFeatureStyle?.(toEngineGeoJsonFeature(feature)) ?? {}
          : undefined
      }
      hoveredFeatureId={props.hoveredFeatureId}
      layerId={props.layerId ?? `geojson-${props.datasetId}`}
      lineColor={props.lineColor}
      lineOpacity={props.lineOpacity}
      lineWidth={props.lineWidth}
      onFeatureContextMenu={mapGeoJsonCallback(props.onFeatureContextMenu)}
      onFeatureHover={mapNullableGeoJsonCallback(props.onFeatureHover)}
      onFeatureSelect={mapNullableGeoJsonCallback(props.onFeatureSelect)}
      onHoveredFeatureIdChange={mapGeoJsonInteractionChange(props.onHoveredFeatureIdChange)}
      onSelectedFeatureIdChange={mapGeoJsonInteractionChange(props.onSelectedFeatureIdChange)}
      pointColor={props.pointColor}
      pointRadius={props.pointRadius}
      polygonFillColor={props.polygonFillColor}
      polygonFillOpacity={props.polygonFillOpacity}
      polygonStrokeColor={props.polygonStrokeColor}
      polygonStrokeWidth={props.polygonStrokeWidth}
      renderFeatureContextMenu={mapGeoJsonContextMenu(props.renderFeatureContextMenu)}
      renderFeaturePopup={mapGeoJsonRenderer(props.renderFeaturePopup)}
      renderFeatureTooltip={mapGeoJsonRenderer(props.renderFeatureTooltip)}
      selectedFeatureId={props.selectedFeatureId}
    />
  );
}

function useMapRuntime() {
  const context = useContext(MapRuntimeContext);
  if (!context) {
    throw new Error("Maps-native dataset components must be used within a MapEngineProvider.");
  }
  return context;
}

function mapPointCallback(
  callback: ((feature: IndexedMapPoint) => void) | undefined,
): ((feature: PointLayerFeature) => void) | undefined {
  return callback ? (feature) => callback(feature.point) : undefined;
}

function mapNullablePointCallback(
  callback: ((feature: IndexedMapPoint | null) => void) | undefined,
): ((feature: PointLayerFeature | null) => void) | undefined {
  return callback ? (feature) => callback(feature?.point ?? null) : undefined;
}

function mapPointRenderer(
  renderer: ((feature: IndexedMapPoint) => ReactNode) | undefined,
): ((feature: PointLayerFeature) => ReactNode) | undefined {
  return renderer ? (feature) => renderer(feature.point) : undefined;
}

function mapPointContextMenu(
  renderer:
    | ((feature: IndexedMapPoint, context: MapFeatureContextMenuContext<IndexedMapPoint>) => ReactNode)
    | undefined,
):
  | ((feature: PointLayerFeature, context: MapFeatureContextMenuContext<PointLayerFeature>) => ReactNode)
  | undefined {
  return renderer
    ? (feature, context) => renderer(feature.point, { ...context, feature: feature.point })
    : undefined;
}

function mapPointInteractionChange(
  callback:
    | ((featureId: string | null, context: MapFeatureInteractionChange<IndexedMapPoint>) => void)
    | undefined,
):
  | ((featureId: string | null, context: MapFeatureInteractionChange<PointLayerFeature>) => void)
  | undefined {
  return callback
    ? (featureId, context) =>
        callback(featureId, { ...context, feature: context.feature?.point ?? null })
    : undefined;
}

function toEngineGeoJsonFeature(feature: GeoJsonLayerFeature): EngineGeoJsonLayerFeature {
  return { ...feature, type: "Feature" };
}

function mapGeoJsonCallback(
  callback: ((feature: EngineGeoJsonLayerFeature) => void) | undefined,
): ((feature: GeoJsonLayerFeature) => void) | undefined {
  return callback ? (feature) => callback(toEngineGeoJsonFeature(feature)) : undefined;
}

function mapNullableGeoJsonCallback(
  callback: ((feature: EngineGeoJsonLayerFeature | null) => void) | undefined,
): ((feature: GeoJsonLayerFeature | null) => void) | undefined {
  return callback
    ? (feature) => callback(feature ? toEngineGeoJsonFeature(feature) : null)
    : undefined;
}

function mapGeoJsonRenderer(
  renderer: ((feature: EngineGeoJsonLayerFeature) => ReactNode) | undefined,
): ((feature: GeoJsonLayerFeature) => ReactNode) | undefined {
  return renderer ? (feature) => renderer(toEngineGeoJsonFeature(feature)) : undefined;
}

function mapGeoJsonContextMenu(
  renderer:
    | ((
        feature: EngineGeoJsonLayerFeature,
        context: MapFeatureContextMenuContext<EngineGeoJsonLayerFeature>,
      ) => ReactNode)
    | undefined,
):
  | ((feature: GeoJsonLayerFeature, context: MapFeatureContextMenuContext<GeoJsonLayerFeature>) => ReactNode)
  | undefined {
  return renderer
    ? (feature, context) => {
        const engineFeature = toEngineGeoJsonFeature(feature);
        return renderer(engineFeature, { ...context, feature: engineFeature });
      }
    : undefined;
}

function mapGeoJsonInteractionChange(
  callback:
    | ((featureId: string | null, context: MapFeatureInteractionChange<EngineGeoJsonLayerFeature>) => void)
    | undefined,
):
  | ((featureId: string | null, context: MapFeatureInteractionChange<GeoJsonLayerFeature>) => void)
  | undefined {
  return callback
    ? (featureId, context) =>
        callback(featureId, {
          ...context,
          feature: context.feature ? toEngineGeoJsonFeature(context.feature) : null,
        })
    : undefined;
}
