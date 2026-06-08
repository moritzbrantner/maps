"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Map as FlatMap } from "flat";
import {
  createVizEngine,
  type VizBackendConfig,
  type VizBackendOption,
  type VizDataset,
  type VizGeoAggregationFeature,
  type VizGeoFlow,
  type VizGeoFlowFeature,
  type VizGeoHeatFeature,
  type VizGeoJsonFeatureCollection,
  type VizGeoPoint,
  type VizIndexedGeoPoint,
  type VizRenderFrame,
  type VizRenderLayer,
  type VizEngine,
} from "@moritzbrantner/viz-engine";

import { escapeHtml, joinClassNames, toLatLng, type MapViewState } from "./map-display";
import {
  createFlatGeometryLayers,
  getGeometryCenter,
  resolveFeatureStyle,
  type FlatFeaturePointerEvent,
} from "./geojson-rendering";
import {
  createGeoJsonLayerFeatures,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import type { MapFeatureContextMenuContext, MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext, type MapSurfaceContextValue } from "./map-view";
import type { TemporalGeoJsonSupportedGeometry } from "./temporal-geojson-types";

export type MapEngineProviderProps = {
  backend?: VizBackendOption | VizBackendConfig;
  children: ReactNode;
  engine?: VizEngine;
};

type MapEngineContextValue = {
  engine: VizEngine;
  getDatasetId(publicId: string): string | null;
  registerDataset(publicId: string, dataset: VizDataset): () => void;
  version: number;
};

const MapEngineContext = createContext<MapEngineContextValue | null>(null);

export function MapEngineProvider({ backend = "auto", children, engine }: MapEngineProviderProps) {
  const ownedEngine = useMemo(() => engine ?? createVizEngine({ backend }), [backend, engine]);
  const datasetIdsRef = useRef(new Map<string, string>());
  const [version, setVersion] = useState(0);
  const getDatasetId = useCallback(
    (publicId: string) => datasetIdsRef.current.get(publicId) ?? null,
    [],
  );
  const registerDataset = useCallback(
    (publicId: string, dataset: VizDataset) => {
      const datasetId = ownedEngine.addDataset(dataset);
      datasetIdsRef.current.set(publicId, datasetId);
      setVersion((current) => current + 1);

      return () => {
        ownedEngine.removeDataset(datasetId);
        if (datasetIdsRef.current.get(publicId) === datasetId) {
          datasetIdsRef.current.delete(publicId);
        }
        setVersion((current) => current + 1);
      };
    },
    [ownedEngine],
  );
  const value = useMemo<MapEngineContextValue>(
    () => ({
      engine: ownedEngine,
      getDatasetId,
      registerDataset,
      version,
    }),
    [getDatasetId, ownedEngine, registerDataset, version],
  );

  return <MapEngineContext.Provider value={value}>{children}</MapEngineContext.Provider>;
}

export function useMapEngine() {
  const context = useContext(MapEngineContext);

  if (!context) {
    throw new Error("useMapEngine must be used within a MapEngineProvider.");
  }

  return context;
}

export type MapDatasetProps<TProperties extends Record<string, unknown> = Record<string, unknown>> =
    | {
        id: string;
        kind: "geo-points";
        points: readonly VizGeoPoint<TProperties>[];
      }
    | {
        featureCollection: VizGeoJsonFeatureCollection<TProperties>;
        id: string;
        kind: "geojson";
      }
    | {
        flows: readonly VizGeoFlow<TProperties>[];
        id: string;
        kind: "geo-flows";
      };

export function MapDataset<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  props: MapDatasetProps<TProperties>,
) {
  const { registerDataset } = useMapEngine();

  useEffect(() => {
    if (props.kind !== "geo-points") {
      return;
    }

    return registerDataset(props.id, {
      kind: "geo-points",
      points: props.points,
    });
  }, [props.id, props.kind, props.kind === "geo-points" ? props.points : null, registerDataset]);

  useEffect(() => {
    if (props.kind !== "geojson") {
      return;
    }

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
    if (props.kind !== "geo-flows") {
      return;
    }

    return registerDataset(props.id, {
      flows: props.flows,
      kind: "geo-flows",
    });
  }, [props.id, props.kind, props.kind === "geo-flows" ? props.flows : null, registerDataset]);

  return null;
}

export function useMapFrame(layer: EngineGeoLayer): VizRenderFrame | null {
  const surface = useContext(MapSurfaceContext);
  const { engine, getDatasetId } = useMapEngine();
  const datasetId = getDatasetId(layer.datasetId);
  const engineLayer = useResolvedEngineGeoLayer(layer, datasetId);
  const { layerId, version } = useRegisteredEngineLayer(engine, engineLayer);

  return useMemo(() => {
    void version;

    if (!surface || !layerId) {
      return null;
    }

    return engine.computeFrame({
      frameFormat: "objects",
      layerIds: [layerId],
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
  }, [engine, layerId, surface, version]);
}

type EngineGeoLayer =
  | {
      datasetId: string;
      kind: "geo-clusters";
      maxZoom?: number;
      minZoom?: number;
      radius?: number;
    }
  | {
      datasetId: string;
      kind: "geo-points";
    }
  | {
      datasetId: string;
      kind: "geo-heat";
      radiusMeters?: number;
      weightMetric?: string;
    }
  | {
      datasetId: string;
      kind: "geojson";
    }
  | {
      datasetId: string;
      kind: "geo-flows";
      weightMetric?: string;
    };

export type GeoClusterLayerProps = {
  datasetId: string;
  getFeatureColor?: (feature: VizGeoAggregationFeature) => string;
  getFeatureRadius?: (feature: VizGeoAggregationFeature) => number;
  layerId?: string;
  maxZoom?: number;
  minZoom?: number;
  onFeatureSelect?: (feature: VizGeoAggregationFeature | null) => void;
  radius?: number;
} & MapFeatureInteractionProps<VizGeoAggregationFeature>;

export function GeoClusterLayer(props: GeoClusterLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-clusters" />;
}

export type GeoPointLayerProps = {
  datasetId: string;
  getFeatureColor?: (feature: VizIndexedGeoPoint) => string;
  getFeatureRadius?: (feature: VizIndexedGeoPoint) => number;
  layerId?: string;
  onFeatureSelect?: (feature: VizIndexedGeoPoint | null) => void;
} & MapFeatureInteractionProps<VizIndexedGeoPoint>;

export function GeoPointLayer(props: GeoPointLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-points" />;
}

export type GeoHeatLayerProps = {
  datasetId: string;
  getFeatureColor?: (feature: VizGeoHeatFeature) => string;
  getFeatureRadius?: (feature: VizGeoHeatFeature) => number;
  layerId?: string;
  onFeatureSelect?: (feature: VizGeoHeatFeature | null) => void;
  radiusMeters?: number;
  weightMetric?: string;
} & MapFeatureInteractionProps<VizGeoHeatFeature>;

export function GeoHeatLayer(props: GeoHeatLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-heat" />;
}

export type GeoFlowLayerProps = {
  datasetId: string;
  getFlowColor?: (feature: VizGeoFlowFeature) => string;
  layerId?: string;
  onFeatureSelect?: (feature: VizGeoFlowFeature | null) => void;
  weightMetric?: string;
} & MapFeatureInteractionProps<VizGeoFlowFeature>;

export function GeoFlowLayer(props: GeoFlowLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-flows" />;
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
  return <EngineGeoLayerRenderer {...props} kind="geojson" />;
}

function EngineGeoLayerRenderer(props: EngineGeoLayerRendererProps) {
  const surface = useContext(MapSurfaceContext);
  const { engine, getDatasetId } = useMapEngine();
  const resolvedDatasetId = getDatasetId(props.datasetId);
  const registeredLayerId = props.layerId ?? `${props.kind}-${props.datasetId}`;
  const engineLayer = useResolvedEngineGeoLayer(props, resolvedDatasetId);
  const { layerId: engineLayerId, version } = useRegisteredEngineLayer(engine, engineLayer);
  const surfaceDisplay = surface?.display;
  const registerMapLibreLayer = surface?.registerMapLibreLayer;
  const interactionOptions = useEngineLayerInteractionOptions(props);

  useEffect(() => {
    if (
      !registerMapLibreLayer ||
      (surfaceDisplay !== "flat" && surfaceDisplay !== "globe") ||
      !engineLayerId
    ) {
      return;
    }

    return registerMapLibreLayer(
      registeredLayerId,
      ({ interactionMode, layer, flat, map }) => {
        layer.clearLayers();
        const display = surface?.display ?? "flat";
        const frameLayer = computeEngineLayerForMap(
          engine,
          engineLayerId,
          map,
          display,
          display === "globe" ? surface?.viewState : undefined,
        );

        if (!frameLayer) {
          return;
        }

        renderFlatEngineLayer(frameLayer, flat, layer, {
          interactionMode,
          interactionOptions,
          map,
          surface,
        });
      },
      {
        renderOnViewStateChange: true,
      },
    );
  }, [
    engine,
    engineLayerId,
    interactionOptions,
    registeredLayerId,
    registerMapLibreLayer,
    surface,
    surfaceDisplay,
    version,
  ]);

  return null;
}

type EngineGeoLayerRendererProps =
  | (GeoClusterLayerProps & { kind: "geo-clusters" })
  | (GeoPointLayerProps & { kind: "geo-points" })
  | (GeoHeatLayerProps & { kind: "geo-heat" })
  | (GeoFlowLayerProps & { kind: "geo-flows" })
  | (EngineGeoJsonLayerProps & { kind: "geojson" });

type EngineLayerInteractionOptions = {
  getFeatureColor?: (feature: unknown) => string;
  getFeatureId?: (feature: unknown) => string;
  getFeatureRadius?: (feature: unknown) => number;
  getFeatureStyle?: (feature: EngineGeoJsonLayerFeature) => GeoJsonLayerStyle;
  getFlowColor?: (feature: VizGeoFlowFeature) => string;
  hoveredFeatureId?: string | null;
  onFeatureContextMenu?: (feature: unknown) => void;
  onFeatureHover?: (feature: unknown | null) => void;
  onFeatureSelect?: (feature: unknown | null) => void;
  onHoveredFeatureIdChange?: MapFeatureInteractionProps<unknown>["onHoveredFeatureIdChange"];
  onSelectedFeatureIdChange?: MapFeatureInteractionProps<unknown>["onSelectedFeatureIdChange"];
  renderFeatureContextMenu?: (
    feature: unknown,
    context: MapFeatureContextMenuContext<unknown>,
  ) => ReactNode;
  renderFeaturePopup?: (feature: unknown) => ReactNode;
  renderFeatureTooltip?: (feature: unknown) => ReactNode;
  selectedFeatureId?: string | null;
  style: GeoJsonLayerStyle;
};

function useEngineLayerInteractionOptions(
  props: EngineGeoLayerRendererProps,
): EngineLayerInteractionOptions {
  return useMemo(
    () => ({
      getFeatureColor:
        "getFeatureColor" in props
          ? (props.getFeatureColor as (feature: unknown) => string)
          : undefined,
      getFeatureId: props.getFeatureId as (feature: unknown) => string,
      getFeatureRadius:
        "getFeatureRadius" in props
          ? (props.getFeatureRadius as (feature: unknown) => number)
          : undefined,
      getFeatureStyle: "getFeatureStyle" in props ? props.getFeatureStyle : undefined,
      getFlowColor: "getFlowColor" in props ? props.getFlowColor : undefined,
      hoveredFeatureId: props.hoveredFeatureId,
      onFeatureContextMenu: props.onFeatureContextMenu as (feature: unknown) => void,
      onFeatureHover: props.onFeatureHover as (feature: unknown | null) => void,
      onFeatureSelect: props.onFeatureSelect as (feature: unknown | null) => void,
      onHoveredFeatureIdChange:
        props.onHoveredFeatureIdChange as MapFeatureInteractionProps<unknown>["onHoveredFeatureIdChange"],
      onSelectedFeatureIdChange:
        props.onSelectedFeatureIdChange as MapFeatureInteractionProps<unknown>["onSelectedFeatureIdChange"],
      renderFeatureContextMenu: props.renderFeatureContextMenu as (
        feature: unknown,
        context: MapFeatureContextMenuContext<unknown>,
      ) => ReactNode,
      renderFeaturePopup: props.renderFeaturePopup as (feature: unknown) => ReactNode,
      renderFeatureTooltip: props.renderFeatureTooltip as (feature: unknown) => ReactNode,
      selectedFeatureId: props.selectedFeatureId,
      style: props.kind === "geojson" ? extractGeoJsonStyle(props) : {},
    }),
    [props],
  );
}

function extractGeoJsonStyle(props: EngineGeoJsonLayerProps): GeoJsonLayerStyle {
  return {
    lineColor: props.lineColor,
    lineOpacity: props.lineOpacity,
    lineWidth: props.lineWidth,
    pointColor: props.pointColor,
    pointRadius: props.pointRadius,
    polygonFillColor: props.polygonFillColor,
    polygonFillOpacity: props.polygonFillOpacity,
    polygonStrokeColor: props.polygonStrokeColor,
    polygonStrokeWidth: props.polygonStrokeWidth,
  };
}

function useResolvedEngineGeoLayer(
  layer: EngineGeoLayer,
  datasetId: string | null,
): EngineGeoLayer | null {
  return useMemo(() => {
    if (!datasetId) {
      return null;
    }

    switch (layer.kind) {
      case "geo-clusters":
        return {
          datasetId,
          kind: layer.kind,
          maxZoom: layer.maxZoom,
          minZoom: layer.minZoom,
          radius: layer.radius,
        };
      case "geo-points":
        return {
          datasetId,
          kind: layer.kind,
        };
      case "geo-heat":
        return {
          datasetId,
          kind: layer.kind,
          radiusMeters: layer.radiusMeters,
          weightMetric: layer.weightMetric,
        };
      case "geojson":
        return {
          datasetId,
          kind: layer.kind,
        };
      case "geo-flows":
        return {
          datasetId,
          kind: layer.kind,
          weightMetric: layer.weightMetric,
        };
    }
  }, [
    datasetId,
    layer.kind,
    layer.kind === "geo-clusters" ? layer.maxZoom : null,
    layer.kind === "geo-clusters" ? layer.minZoom : null,
    layer.kind === "geo-clusters" ? layer.radius : null,
    layer.kind === "geo-heat" ? layer.radiusMeters : null,
    layer.kind === "geo-heat" ? layer.weightMetric : null,
    layer.kind === "geo-flows" ? layer.weightMetric : null,
  ]);
}

function useRegisteredEngineLayer(engine: VizEngine, layer: EngineGeoLayer | null) {
  const registrationRef = useRef<{ engine: VizEngine; layerId: string } | null>(null);
  const [state, setState] = useState<{ layerId: string | null; version: number }>({
    layerId: null,
    version: 0,
  });

  useEffect(() => {
    const current = registrationRef.current;

    if (!layer) {
      if (current) {
        current.engine.removeLayer(current.layerId);
        registrationRef.current = null;
        setState((previous) => ({
          layerId: null,
          version: previous.version + 1,
        }));
      }
      return;
    }

    if (!current || current.engine !== engine) {
      current?.engine.removeLayer(current.layerId);
      const layerId = engine.addLayer(layer as Parameters<VizEngine["addLayer"]>[0]);

      registrationRef.current = { engine, layerId };
      setState((previous) => ({
        layerId,
        version: previous.version + 1,
      }));
      return;
    }

    const updated = engine.updateLayer(
      current.layerId,
      layer as Parameters<VizEngine["updateLayer"]>[1],
    );

    if (updated) {
      setState((previous) => ({
        layerId: current.layerId,
        version: previous.version + 1,
      }));
      return;
    }

    current.engine.removeLayer(current.layerId);
    const layerId = engine.addLayer(layer as Parameters<VizEngine["addLayer"]>[0]);

    registrationRef.current = { engine, layerId };
    setState((previous) => ({
      layerId,
      version: previous.version + 1,
    }));
  }, [engine, layer]);

  useEffect(
    () => () => {
      const current = registrationRef.current;

      if (current) {
        current.engine.removeLayer(current.layerId);
        registrationRef.current = null;
      }
    },
    [],
  );

  return state;
}

function computeEngineLayerForMap(
  engine: VizEngine,
  layerId: string,
  map: FlatMap,
  display: "flat" | "globe",
  viewState?: MapViewState,
): VizRenderLayer | null {
  const bounds = map.getBounds();

  return (
    engine
      .computeFrame({
        frameFormat: "objects",
        layerIds: [layerId],
        viewport: {
          bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          center: viewState?.center ?? [map.getCenter().lng, map.getCenter().lat],
          display,
          height: map.getSize().y,
          kind: "geo",
          width: map.getSize().x,
          zoom: viewState?.zoom ?? map.getZoom(),
        },
      })
      .layers.find((candidate) => candidate.layerId === layerId) ?? null
  );
}

function renderFlatEngineLayer(
  frameLayer: VizRenderLayer,
  flat: typeof import("flat"),
  layer: import("flat").LayerGroup,
  options: {
    interactionMode: string;
    interactionOptions: EngineLayerInteractionOptions;
    map: FlatMap;
    surface: MapSurfaceContextValue | null;
  },
) {
  const { interactionOptions, map, surface } = options;
  const interactive = options.interactionMode === "none" && surface?.isMeasuring !== true;

  switch (frameLayer.kind) {
    case "geo-clusters":
      for (const feature of frameLayer.features) {
        const selected =
          surface?.isFeatureSelected(
            feature,
            interactionOptions.selectedFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const hovered =
          surface?.isFeatureHovered(
            feature,
            interactionOptions.hoveredFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const radius =
          interactionOptions.getFeatureRadius?.(feature) ??
          (feature.kind === "cluster" ? Math.min(28, 8 + Math.sqrt(feature.pointCount)) : 5);
        const marker = flat.circleMarker(toLatLng(feature.coordinates), {
          bubblingMouseEvents: false,
          className: joinClassNames(
            "mb-maps__engine-feature",
            feature.kind === "cluster" ? "mb-maps__cluster-marker" : "mb-maps__point-marker",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color: "#ffffff",
          fillColor:
            interactionOptions.getFeatureColor?.(feature) ??
            (feature.kind === "cluster" ? "#2563eb" : "#0f172a"),
          fillOpacity: 0.9,
          interactive,
          radius,
          weight: selected ? 3 : 2,
        });
        bindFlatEngineFeatureInteraction(marker, feature, feature.coordinates, {
          interactionOptions,
          map,
          surface,
        });
        marker.addTo(layer);
        if (feature.kind === "cluster") {
          flat
            .marker(toLatLng(feature.coordinates), {
              icon: flat.divIcon({
                className: "mb-maps__cluster-count",
                html: escapeHtml(feature.pointCountAbbreviated),
                iconAnchor: [18, 18],
                iconSize: [36, 36],
              }),
              interactive: false,
            })
            .addTo(layer);
        }
      }
      break;
    case "geo-points":
      for (const point of frameLayer.features) {
        const selected =
          surface?.isFeatureSelected(
            point,
            interactionOptions.selectedFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const hovered =
          surface?.isFeatureHovered(
            point,
            interactionOptions.hoveredFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const coordinates: [number, number] = [point.longitude, point.latitude];
        const marker = flat.circleMarker(toLatLng(coordinates), {
          bubblingMouseEvents: false,
          className: joinClassNames(
            "mb-maps__point-marker",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color: "#ffffff",
          fillColor: interactionOptions.getFeatureColor?.(point) ?? "#0f172a",
          fillOpacity: 0.92,
          interactive,
          radius: interactionOptions.getFeatureRadius?.(point) ?? 5,
          weight: selected ? 3 : 2,
        });
        bindFlatEngineFeatureInteraction(marker, point, coordinates, {
          interactionOptions,
          map,
          surface,
        });
        marker.addTo(layer);
      }
      break;
    case "geo-heat":
      for (const feature of frameLayer.features) {
        const selected =
          surface?.isFeatureSelected(
            feature,
            interactionOptions.selectedFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const hovered =
          surface?.isFeatureHovered(
            feature,
            interactionOptions.hoveredFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const marker = flat.circleMarker(toLatLng(feature.coordinates), {
          bubblingMouseEvents: false,
          className: joinClassNames(
            "mb-maps__engine-heat",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color: "transparent",
          fillColor: interactionOptions.getFeatureColor?.(feature) ?? resolveHeatColor(feature),
          fillOpacity: 0.72,
          interactive,
          radius: interactionOptions.getFeatureRadius?.(feature) ?? 10 + feature.value * 18,
          weight: 0,
        });
        bindFlatEngineFeatureInteraction(marker, feature, feature.coordinates, {
          interactionOptions,
          map,
          surface,
        });
        marker.addTo(layer);
      }
      break;
    case "geo-flows":
      for (const feature of frameLayer.features) {
        const selected =
          surface?.isFeatureSelected(
            feature,
            interactionOptions.selectedFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const hovered =
          surface?.isFeatureHovered(
            feature,
            interactionOptions.hoveredFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const line = flat.polyline([toLatLng(feature.flow.from), toLatLng(feature.flow.to)], {
          className: joinClassNames(
            "mb-maps__engine-flow",
            "mb-maps__flow-line",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          color: interactionOptions.getFlowColor?.(feature) ?? "#0f766e",
          interactive,
          opacity: 0.78,
          weight: selected ? 3 + feature.value * 8 : 1.5 + feature.value * 8,
        });
        bindFlatEngineFeatureInteraction(line, feature, getFlowCenter(feature), {
          interactionOptions,
          map,
          surface,
        });
        line.addTo(layer);
      }
      break;
    case "geojson":
      for (const feature of createEngineGeoJsonLayerFeatures(frameLayer.featureCollection)) {
        const selected =
          surface?.isFeatureSelected(
            feature,
            interactionOptions.selectedFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const hovered =
          surface?.isFeatureHovered(
            feature,
            interactionOptions.hoveredFeatureId,
            interactionOptions.getFeatureId,
          ) ?? false;
        const geometryLayers = createFlatGeometryLayers(feature.geometry, {
          bubblingMouseEvents: false,
          className: joinClassNames(
            "mb-maps__geojson-feature",
            "mb-maps__engine-geojson",
            hovered && "mb-maps__feature--hovered",
            selected && "mb-maps__feature--selected",
          ),
          flat,
          interactive,
          selected,
          style: resolveFeatureStyle(
            feature,
            interactionOptions.style,
            interactionOptions.getFeatureStyle as never,
          ),
        });

        for (const geometryLayer of geometryLayers) {
          bindFlatEngineFeatureInteraction(
            geometryLayer,
            feature,
            getGeometryCenter(feature.geometry),
            {
              interactionOptions,
              map,
              surface,
            },
          );
          geometryLayer.addTo(layer);
        }
      }
      break;
  }
}

function bindFlatEngineFeatureInteraction<TFeature>(
  layer: {
    on: (event: string, handler: (event?: FlatFeaturePointerEvent) => void) => unknown;
  },
  feature: TFeature,
  coordinates: [number, number],
  options: {
    interactionOptions: EngineLayerInteractionOptions;
    map: FlatMap;
    surface: MapSurfaceContextValue | null;
  },
) {
  const { interactionOptions, map, surface } = options;

  if (!surface || surface.isMeasuring) {
    return;
  }

  const getPosition = (event: FlatFeaturePointerEvent = {}) => {
    if (event.containerPoint) {
      return event.containerPoint;
    }

    return map.latLngToContainerPoint?.(toLatLng(coordinates)) ?? { x: 0, y: 0 };
  };

  layer.on("click", (event = {}) => {
    surface.handleFeatureClick(feature, getPosition(event), {
      getFeatureId: interactionOptions.getFeatureId,
      onFeatureSelect: interactionOptions.onFeatureSelect,
      onSelectedFeatureIdChange: interactionOptions.onSelectedFeatureIdChange,
      renderFeaturePopup: interactionOptions.renderFeaturePopup,
    });
  });
  layer.on("contextmenu", (event = {}) => {
    event.originalEvent?.preventDefault?.();
    surface.handleFeatureContextMenu(feature, getPosition(event), {
      coordinates,
      getFeatureId: interactionOptions.getFeatureId,
      onFeatureContextMenu: interactionOptions.onFeatureContextMenu,
      onFeatureSelect: interactionOptions.onFeatureSelect,
      onSelectedFeatureIdChange: interactionOptions.onSelectedFeatureIdChange,
      renderFeatureContextMenu: interactionOptions.renderFeatureContextMenu,
      renderFeaturePopup: interactionOptions.renderFeaturePopup,
    });
  });
  layer.on("mouseover", (event = {}) => {
    map.getContainer().style.cursor = "pointer";
    surface.handleFeatureHover(feature, getPosition(event), {
      getFeatureId: interactionOptions.getFeatureId,
      onHoveredFeatureIdChange: interactionOptions.onHoveredFeatureIdChange,
      onFeatureHover: interactionOptions.onFeatureHover,
      renderFeatureTooltip: interactionOptions.renderFeatureTooltip,
    });
  });
  layer.on("mousemove", (event = {}) => {
    surface.handleFeatureHover(feature, getPosition(event), {
      getFeatureId: interactionOptions.getFeatureId,
      onHoveredFeatureIdChange: interactionOptions.onHoveredFeatureIdChange,
      onFeatureHover: interactionOptions.onFeatureHover,
      renderFeatureTooltip: interactionOptions.renderFeatureTooltip,
    });
  });
  layer.on("mouseout", () => {
    map.getContainer().style.cursor = "";
    surface.handleFeatureHover(null, null, {
      getFeatureId: interactionOptions.getFeatureId,
      onHoveredFeatureIdChange: interactionOptions.onHoveredFeatureIdChange,
      onFeatureHover: interactionOptions.onFeatureHover,
      renderFeatureTooltip: interactionOptions.renderFeatureTooltip,
    });
  });
}

function createEngineGeoJsonLayerFeatures(
  featureCollection: VizGeoJsonFeatureCollection,
): EngineGeoJsonLayerFeature[] {
  return createGeoJsonLayerFeatures(featureCollection as never).map((feature) => ({
    geometry: feature.geometry,
    id: feature.id,
    properties: feature.properties,
    sourceIndex: feature.sourceIndex,
    type: "Feature" as const,
  }));
}

function getFlowCenter(feature: VizGeoFlowFeature): [number, number] {
  return [
    (feature.flow.from[0] + feature.flow.to[0]) / 2,
    (feature.flow.from[1] + feature.flow.to[1]) / 2,
  ];
}

function resolveHeatColor(feature: VizGeoHeatFeature) {
  if (feature.value > 0.75) {
    return "#dc2626";
  }
  if (feature.value > 0.45) {
    return "#f59e0b";
  }
  if (feature.value > 0.2) {
    return "#22c55e";
  }
  return "#67e8f9";
}
