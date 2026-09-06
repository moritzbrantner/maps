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

import {
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
} from "./aggregation";
import { ClusterLayer, type ClusterLayerProps } from "./cluster-layer";
import { FlowLayer, type FlowLayerFeature, type FlowLayerProps, type MapFlow } from "./flow-layer";
import {
  GeoJsonLayer,
  type GeoJsonLayerFeature,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import type { GeoJsonMapSource } from "./geojson-source";
import { HeatLayer } from "./heat-layer";
import type { HeatLayerFeature, HeatLayerProps } from "./heat-layer-types";
import type {
  MapFeatureContextMenuContext,
  MapFeatureInteractionChange,
  MapFeatureInteractionProps,
} from "./map-interaction";
import { PointLayer, type PointLayerFeature } from "./point-layer";
import type { MapRuntimeDataset } from "./map-runtime";
import { MapSurfaceContext } from "./map-view";
import type { TemporalGeoJsonSupportedGeometry } from "./temporal-geojson-types";

type CompatibilityEngine = {
  addDataset?: unknown;
  addLayer?: unknown;
  computeFrame?: unknown;
  removeDataset?: unknown;
  removeLayer?: unknown;
};

/**
 * Provider options for the Maps-owned dataset runtime.
 *
 * `backend` and `engine` are retained as deprecated compatibility inputs for
 * pre-runtime consumers. Maps does not instantiate or depend on a generic
 * visualization engine anymore; an explicitly supplied `engine` is observed
 * only by the narrow migration bridge below.
 */
export type MapEngineProviderProps = {
  backend?: unknown;
  children: ReactNode;
  engine?: CompatibilityEngine;
};

export type MapDatasetProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> =
  | { id: string; kind: "geo-points"; points: readonly MapPoint<TProperties>[] }
  | { featureCollection: GeoJsonMapSource<TProperties>; id: string; kind: "geojson" }
  | { flows: readonly MapFlow<TProperties>[]; id: string; kind: "geo-flows" };

type MapRuntimeContextValue = {
  compatibilityEngine: CompatibilityEngine | null;
  getCompatibilityDatasetId(publicId: string): string | null;
  getDataset(publicId: string): MapRuntimeDataset | null;
  registerDataset(publicId: string, dataset: MapRuntimeDataset): () => void;
  version: number;
};

const MapRuntimeContext = createContext<MapRuntimeContextValue | null>(null);

export function MapEngineProvider({ children, engine }: MapEngineProviderProps) {
  const datasetsRef = useRef(new Map<string, MapRuntimeDataset>());
  const compatibilityDatasetIdsRef = useRef(new Map<string, string>());
  const [version, setVersion] = useState(0);
  const getDataset = useCallback(
    (publicId: string) => datasetsRef.current.get(publicId) ?? null,
    [],
  );
  const getCompatibilityDatasetId = useCallback(
    (publicId: string) => compatibilityDatasetIdsRef.current.get(publicId) ?? null,
    [],
  );
  const registerDataset = useCallback(
    (publicId: string, dataset: MapRuntimeDataset) => {
      datasetsRef.current.set(publicId, dataset);
      const compatibilityDatasetId = callCompatibilityEngine(engine, "addDataset", dataset);

      if (typeof compatibilityDatasetId === "string") {
        compatibilityDatasetIdsRef.current.set(publicId, compatibilityDatasetId);
      }
      setVersion((current) => current + 1);

      return () => {
        if (datasetsRef.current.get(publicId) === dataset) {
          datasetsRef.current.delete(publicId);
        }
        const currentCompatibilityId = compatibilityDatasetIdsRef.current.get(publicId);
        if (currentCompatibilityId && currentCompatibilityId === compatibilityDatasetId) {
          compatibilityDatasetIdsRef.current.delete(publicId);
          callCompatibilityEngine(engine, "removeDataset", currentCompatibilityId);
        }
        setVersion((current) => current + 1);
      };
    },
    [engine],
  );
  const value = useMemo<MapRuntimeContextValue>(
    () => ({
      compatibilityEngine: engine ?? null,
      getCompatibilityDatasetId,
      getDataset,
      registerDataset,
      version,
    }),
    [engine, getCompatibilityDatasetId, getDataset, registerDataset, version],
  );

  return <MapRuntimeContext.Provider value={value}>{children}</MapRuntimeContext.Provider>;
}

export function useMapEngine() {
  return useMapRuntime();
}

/**
 * Compatibility hook for consumers that previously inspected a generic engine
 * frame. It now exposes the Maps-owned dataset plus current map viewport and is
 * intentionally map-domain specific. Renderer frames remain private until a
 * second renderer proves the contract in #58/#59.
 */
export function useMapFrame(layer: { datasetId: string; kind: string }) {
  const surface = useContext(MapSurfaceContext);
  const { getDataset, version } = useMapRuntime();
  const dataset = getDataset(layer.datasetId);
  void version;

  return useMemo(
    () =>
      dataset
        ? {
            dataset,
            datasetId: layer.datasetId,
            kind: layer.kind,
            viewport: surface
              ? {
                  center: surface.viewState.center,
                  display: surface.display,
                  zoom: surface.viewState.zoom,
                }
              : null,
          }
        : null,
    [dataset, layer.datasetId, layer.kind, surface],
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

  return null;
}

export type GeoClusterLayerProps = Omit<
  ClusterLayerProps<Record<string, unknown>>,
  "clusterRadius" | "points"
> & {
  datasetId: string;
  getFeatureColor?: (feature: AggregatedMapFeature) => string;
  getFeatureRadius?: (feature: AggregatedMapFeature) => number;
  radius?: number;
};

export function GeoClusterLayer({
  datasetId,
  getFeatureColor: _getFeatureColor,
  getFeatureRadius: _getFeatureRadius,
  radius,
  ...layerProps
}: GeoClusterLayerProps) {
  const { getDataset, version } = useMapRuntime();
  const dataset = getDataset(datasetId);
  useCompatibilityLayer("geo-clusters", datasetId, {
    maxZoom: layerProps.maxZoom,
    minZoom: layerProps.minZoom,
    radius,
  });
  void version;

  if (dataset?.kind !== "geo-points") return null;

  return <ClusterLayer {...layerProps} clusterRadius={radius} points={dataset.points} />;
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
  useCompatibilityLayer("geo-points", props.datasetId);
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

export type GeoHeatLayerProps = Omit<HeatLayerProps, "heatmapRadius" | "points"> & {
  datasetId: string;
  getFeatureColor?: (feature: HeatLayerFeature) => string;
  getFeatureRadius?: (feature: HeatLayerFeature) => number;
  radiusMeters?: number;
};

export function GeoHeatLayer({
  datasetId,
  getFeatureColor: _getFeatureColor,
  getFeatureRadius: _getFeatureRadius,
  radiusMeters,
  ...layerProps
}: GeoHeatLayerProps) {
  const { getDataset, version } = useMapRuntime();
  const dataset = getDataset(datasetId);
  useCompatibilityLayer("geo-heat", datasetId, {
    radiusMeters,
    weightMetric: layerProps.weightMetric,
  });
  void version;

  if (dataset?.kind !== "geo-points") return null;

  return (
    <HeatLayer
      {...layerProps}
      heatmapRadius={radiusMeters === undefined ? undefined : { meters: radiusMeters }}
      points={dataset.points}
    />
  );
}

export type GeoFlowLayerProps = Omit<FlowLayerProps, "flows"> & {
  datasetId: string;
};

export function GeoFlowLayer({ datasetId, ...layerProps }: GeoFlowLayerProps) {
  const { getDataset, version } = useMapRuntime();
  const dataset = getDataset(datasetId);
  useCompatibilityLayer("geo-flows", datasetId, { weightMetric: layerProps.weightMetric });
  void version;

  if (dataset?.kind !== "geo-flows") return null;

  return <FlowLayer {...layerProps} flows={dataset.flows} />;
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
  useCompatibilityLayer("geojson", props.datasetId);
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

function callCompatibilityEngine(
  engine: CompatibilityEngine | null | undefined,
  method: keyof CompatibilityEngine,
  ...args: unknown[]
) {
  const candidate = engine?.[method];
  return typeof candidate === "function"
    ? (candidate as (...values: unknown[]) => unknown)(...args)
    : undefined;
}

function useCompatibilityLayer(
  kind: "geo-clusters" | "geo-flows" | "geo-heat" | "geo-points" | "geojson",
  publicDatasetId: string,
  options: Record<string, unknown> = {},
) {
  const surface = useContext(MapSurfaceContext);
  const { compatibilityEngine, getCompatibilityDatasetId, version } = useMapRuntime();
  const compatibilityLayerIdRef = useRef<string | null>(null);
  const compatibilityDatasetId = getCompatibilityDatasetId(publicDatasetId);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!compatibilityEngine || !compatibilityDatasetId) return;

    const compatibilityLayerId = callCompatibilityEngine(compatibilityEngine, "addLayer", {
      ...JSON.parse(optionsKey),
      datasetId: compatibilityDatasetId,
      kind,
    });

    if (typeof compatibilityLayerId !== "string") return;
    compatibilityLayerIdRef.current = compatibilityLayerId;

    return () => {
      if (compatibilityLayerIdRef.current === compatibilityLayerId) {
        compatibilityLayerIdRef.current = null;
      }
      callCompatibilityEngine(compatibilityEngine, "removeLayer", compatibilityLayerId);
    };
  }, [compatibilityDatasetId, compatibilityEngine, kind, optionsKey]);

  useEffect(() => {
    const compatibilityLayerId = compatibilityLayerIdRef.current;
    if (!compatibilityEngine || !compatibilityLayerId || !surface) return;

    compatibilityEngine.computeFrame({
      layerIds: [compatibilityLayerId],
      viewport: {
        bounds: [-180, -90, 180, 90],
        center: surface.viewState.center,
        display: surface.display,
        height: 1,
        kind: "geo",
        width: 1,
        zoom: surface.viewState.zoom,
      },
    });
  }, [compatibilityEngine, surface, version]);
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

export type { FlowLayerFeature, HeatLayerFeature };
