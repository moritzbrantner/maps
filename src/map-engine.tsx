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
  type VizBackendOption,
  type VizDataset,
  type VizGeoFlow,
  type VizGeoFlowFeature,
  type VizGeoHeatFeature,
  type VizGeoJsonFeatureCollection,
  type VizGeoPoint,
  type VizRenderFrame,
  type VizRenderLayer,
  type VizEngine,
} from "@moritzbrantner/viz-engine";

import { escapeHtml, joinClassNames, toLatLng } from "./map-display";
import { MapSurfaceContext, type MapSurfaceContextValue } from "./map-view";

export type MapEngineProviderProps = {
  backend?: VizBackendOption;
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

export function MapEngineProvider({
  backend = "auto",
  children,
  engine,
}: MapEngineProviderProps) {
  const ownedEngine = useMemo(
    () => engine ?? createVizEngine({ backend }),
    [backend, engine],
  );
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

  return (
    <MapEngineContext.Provider value={value}>
      {children}
    </MapEngineContext.Provider>
  );
}

export function useMapEngine() {
  const context = useContext(MapEngineContext);

  if (!context) {
    throw new Error("useMapEngine must be used within a MapEngineProvider.");
  }

  return context;
}

export type MapDatasetProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> =
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

export function MapDataset<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(props: MapDatasetProps<TProperties>) {
  const { registerDataset } = useMapEngine();

  useEffect(() => {
    if (props.kind === "geo-points") {
      return registerDataset(props.id, {
        kind: "geo-points",
        points: props.points,
      });
    }

    if (props.kind === "geojson") {
      return registerDataset(props.id, {
        featureCollection: props.featureCollection,
        kind: "geojson",
      });
    }

    return registerDataset(props.id, {
      flows: props.flows,
      kind: "geo-flows",
    });
  }, [props, registerDataset]);

  return null;
}

export function useMapFrame(layer: EngineGeoLayer): VizRenderFrame | null {
  const surface = useContext(MapSurfaceContext);
  const { engine, getDatasetId, version } = useMapEngine();
  const datasetId = getDatasetId(layer.datasetId);

  return useMemo(() => {
    void version;

    if (!surface || !datasetId) {
      return null;
    }

    const layerId = engine.addLayer({ ...layer, datasetId } as Parameters<
      VizEngine["addLayer"]
    >[0]);

    try {
      return engine.computeFrame({
        frameFormat: "objects",
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
    } finally {
      engine.removeLayer(layerId);
    }
  }, [datasetId, engine, layer, surface, version]);
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
  layerId?: string;
  maxZoom?: number;
  minZoom?: number;
  radius?: number;
};

export function GeoClusterLayer(props: GeoClusterLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-clusters" />;
}

export type GeoPointLayerProps = {
  datasetId: string;
  layerId?: string;
};

export function GeoPointLayer(props: GeoPointLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-points" />;
}

export type GeoHeatLayerProps = {
  datasetId: string;
  layerId?: string;
  radiusMeters?: number;
  weightMetric?: string;
};

export function GeoHeatLayer(props: GeoHeatLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-heat" />;
}

export type GeoFlowLayerProps = {
  datasetId: string;
  layerId?: string;
  weightMetric?: string;
};

export function GeoFlowLayer(props: GeoFlowLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geo-flows" />;
}

export type EngineGeoJsonLayerProps = {
  datasetId: string;
  layerId?: string;
};

export function EngineGeoJsonLayer(props: EngineGeoJsonLayerProps) {
  return <EngineGeoLayerRenderer {...props} kind="geojson" />;
}

function EngineGeoLayerRenderer(
  props:
    | (EngineGeoLayer & { layerId?: string })
    | (EngineGeoJsonLayerProps & { kind: "geojson" }),
) {
  const surface = useContext(MapSurfaceContext);
  const { engine, getDatasetId, version } = useMapEngine();
  const resolvedDatasetId = getDatasetId(props.datasetId);
  const registeredLayerId = props.layerId ?? `${props.kind}-${props.datasetId}`;
  const surfaceDisplay = surface?.display;
  const registerFlatLayer = surface?.registerFlatLayer;

  useEffect(() => {
    if (!registerFlatLayer || surfaceDisplay !== "flat" || !resolvedDatasetId) {
      return;
    }

    return registerFlatLayer(
      registeredLayerId,
      ({ layer, flat, map }) => {
        layer.clearLayers();
        const frameLayer = computeEngineLayerForMap(
          engine,
          { ...props, datasetId: resolvedDatasetId } as EngineGeoLayer,
          map,
        );

        if (!frameLayer) {
          return;
        }

        renderFlatEngineLayer(frameLayer, flat, layer);
      },
      {
        renderOnViewStateChange: props.kind === "geo-clusters" || props.kind === "geo-heat",
      },
    );
  }, [engine, props, registeredLayerId, registerFlatLayer, resolvedDatasetId, surfaceDisplay, version]);

  if (!surface || surface.display !== "globe" || !resolvedDatasetId) {
    return null;
  }

  const frameLayer = computeEngineLayerForGlobe(engine, {
    ...props,
    datasetId: resolvedDatasetId,
  } as EngineGeoLayer);

  if (!frameLayer) {
    return null;
  }

  return <>{renderGlobeEngineLayer(frameLayer, surface)}</>;
}

function computeEngineLayerForMap(
  engine: VizEngine,
  layer: EngineGeoLayer,
  map: FlatMap,
): VizRenderLayer | null {
  const layerId = engine.addLayer(
    layer as Parameters<VizEngine["addLayer"]>[0],
  );
  const bounds = map.getBounds();

  try {
    return (
      engine
        .computeFrame({
          frameFormat: "objects",
          viewport: {
            bounds: [
              bounds.getWest(),
              bounds.getSouth(),
              bounds.getEast(),
              bounds.getNorth(),
            ],
            center: [map.getCenter().lng, map.getCenter().lat],
            display: "flat",
            height: map.getSize().y,
            kind: "geo",
            width: map.getSize().x,
            zoom: map.getZoom(),
          },
        })
        .layers.find((candidate) => candidate.layerId === layerId) ?? null
    );
  } finally {
    engine.removeLayer(layerId);
  }
}

function computeEngineLayerForGlobe(engine: VizEngine, layer: EngineGeoLayer) {
  const layerId = engine.addLayer(
    layer as Parameters<VizEngine["addLayer"]>[0],
  );

  try {
    return (
      engine
        .computeFrame({
          frameFormat: "objects",
          viewport: {
            bounds: [-180, -90, 180, 90],
            center: [0, 0],
            display: "globe",
            height: 1,
            kind: "geo",
            width: 1,
            zoom: 1,
          },
        })
        .layers.find((candidate) => candidate.layerId === layerId) ?? null
    );
  } finally {
    engine.removeLayer(layerId);
  }
}

function renderFlatEngineLayer(
  frameLayer: VizRenderLayer,
  flat: typeof import("flat"),
  layer: import("flat").LayerGroup,
) {
  switch (frameLayer.kind) {
    case "geo-clusters":
      for (const feature of frameLayer.features) {
        const radius =
          feature.kind === "cluster"
            ? Math.min(28, 8 + Math.sqrt(feature.pointCount))
            : 5;
        const marker = flat.circleMarker(
          toLatLng(feature.coordinates),
          {
            className: joinClassNames(
              "mb-maps__engine-feature",
              feature.kind === "cluster"
                ? "mb-maps__cluster-marker"
                : "mb-maps__point-marker",
            ),
            color: "#ffffff",
            fillColor: feature.kind === "cluster" ? "#2563eb" : "#0f172a",
            fillOpacity: 0.9,
            radius,
            weight: 2,
          },
        );
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
        flat
          .circleMarker(toLatLng([point.longitude, point.latitude]), {
            className: "mb-maps__point-marker",
            color: "#ffffff",
            fillColor: "#0f172a",
            fillOpacity: 0.92,
            radius: 5,
            weight: 2,
          })
          .addTo(layer);
      }
      break;
    case "geo-heat":
      for (const feature of frameLayer.features) {
        flat
          .circleMarker(toLatLng(feature.coordinates), {
            className: "mb-maps__engine-heat",
            color: "transparent",
            fillColor: resolveHeatColor(feature),
            fillOpacity: 0.72,
            radius: 10 + feature.value * 18,
            weight: 0,
          })
          .addTo(layer);
      }
      break;
    case "geo-flows":
      for (const feature of frameLayer.features) {
        flat
          .polyline(
            [
              toLatLng(feature.flow.from),
              toLatLng(feature.flow.to),
            ],
            {
              className: "mb-maps__engine-flow",
              color: "#0f766e",
              opacity: 0.78,
              weight: 1.5 + feature.value * 8,
            },
          )
          .addTo(layer);
      }
      break;
  }
}

function renderGlobeEngineLayer(
  frameLayer: VizRenderLayer,
  surface: MapSurfaceContextValue,
) {
  if (frameLayer.kind === "geo-clusters") {
    return frameLayer.features.map((feature) => {
      const projected = surface.projectGlobeCoordinate(
        feature.coordinates,
        surface.viewState,
      );
      if (!projected.visible) {
        return null;
      }
      const radius =
        feature.kind === "cluster"
          ? Math.min(24, 7 + Math.sqrt(feature.pointCount))
          : 4;

      return (
        <circle
          className="mb-maps__engine-feature"
          cx={projected.x}
          cy={projected.y}
          fill={feature.kind === "cluster" ? "#2563eb" : "#0f172a"}
          key={
            feature.kind === "cluster"
              ? `cluster-${feature.clusterId}`
              : `point-${feature.point.id}`
          }
          opacity={0.9}
          r={radius}
          stroke="#ffffff"
          strokeWidth={1.5}
        />
      );
    });
  }

  if (frameLayer.kind === "geo-heat") {
    return frameLayer.features.map((feature) =>
      renderGlobeHeatFeature(feature, surface),
    );
  }

  if (frameLayer.kind === "geo-flows") {
    return frameLayer.features.map((feature) =>
      renderGlobeFlowFeature(feature, surface),
    );
  }

  return null;
}

function renderGlobeHeatFeature(
  feature: VizGeoHeatFeature,
  surface: MapSurfaceContextValue,
) {
  const projected = surface.projectGlobeCoordinate(
    feature.coordinates,
    surface.viewState,
  );
  if (!projected.visible) {
    return null;
  }

  return (
    <circle
      cx={projected.x}
      cy={projected.y}
      fill={resolveHeatColor(feature)}
      key={`heat-${feature.id}`}
      opacity={0.72}
      r={5 + feature.value * 14}
    />
  );
}

function renderGlobeFlowFeature(
  feature: VizGeoFlowFeature,
  surface: MapSurfaceContextValue,
) {
  const from = surface.projectGlobeCoordinate(
    feature.flow.from,
    surface.viewState,
  );
  const to = surface.projectGlobeCoordinate(feature.flow.to, surface.viewState);
  if (!from.visible || !to.visible) {
    return null;
  }

  return (
    <line
      key={`flow-${feature.flow.id}`}
      opacity={0.72}
      stroke="#0f766e"
      strokeWidth={1 + feature.value * 5}
      x1={from.x}
      x2={to.x}
      y1={from.y}
      y2={to.y}
    />
  );
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
