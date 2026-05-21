"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

import { FeatureOverlays, type FeatureOverlayState } from "./feature-overlays";
import { GlobeBase } from "./globe-base";
import {
  defaultRasterMapStyle,
  getGlobeDragCenter,
  getGlobeZoom,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  joinClassNames,
  projectGlobeCoordinate,
  resolveTileLayerOptions,
  toLeafletLatLng,
  unprojectGlobePoint,
  type GlobeViewState,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeReason,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import { areMapViewStatesEqual, useControllableMapViewState } from "./map-view-state";
import type { MapCoordinate } from "./measurement";

export type FlatLayerRender = (context: {
  isMeasuring: boolean;
  layer: LayerGroup;
  leaflet: typeof import("leaflet");
  map: LeafletMap;
}) => void;

export type MapSurfaceContextValue = {
  closeFeaturePopup: () => void;
  display: MapDisplayMode;
  getGlobePointerCoordinate: (event: React.PointerEvent<SVGSVGElement>) => MapCoordinate | null;
  handleBackgroundClick: () => void;
  handleFeatureClick: <TFeature>(
    feature: TFeature,
    position: { x: number; y: number },
    options?: {
      onFeatureSelect?: (feature: TFeature | null) => void;
      renderFeaturePopup?: (feature: TFeature) => ReactNode;
      suppress?: boolean;
    },
  ) => void;
  handleFeatureHover: <TFeature>(
    feature: TFeature | null,
    position: { x: number; y: number } | null,
    options?: {
      onFeatureHover?: (feature: TFeature | null) => void;
      renderFeatureTooltip?: (feature: TFeature) => ReactNode;
    },
  ) => void;
  isFeatureHovered: <TFeature>(feature: TFeature, getFeatureId?: (feature: TFeature) => string) => boolean;
  isFeatureSelected: <TFeature>(
    feature: TFeature,
    selectedFeatureId?: string | null,
    getFeatureId?: (feature: TFeature) => string,
  ) => boolean;
  isMeasuring: boolean;
  leaflet: typeof import("leaflet") | null;
  leafletMap: LeafletMap | null;
  projectGlobeCoordinate: typeof projectGlobeCoordinate;
  registerFlatLayer: (id: string, render: FlatLayerRender) => () => void;
  requestRender: () => void;
  setMeasurementActive: (active: boolean) => void;
  setViewState: (next: MapViewState, reason: MapViewStateChangeReason) => void;
  viewState: MapViewState;
};

export type MapViewProps = MapViewportProps & {
  children?: ReactNode;
  className?: string;
  dataBounds?: [west: number, south: number, east: number, north: number] | null;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: LeafletMap) => void;
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
};

type RegisteredFlatLayer = {
  id: string;
  group: LayerGroup | null;
  render: FlatLayerRender;
};

export const MapSurfaceContext = createContext<MapSurfaceContextValue | null>(null);

export function MapView({
  children,
  className,
  dataBounds = null,
  defaultViewState,
  fitBoundsPadding = 56,
  fitToData = true,
  initialViewState,
  mapDisplay = "flat",
  mapLabel = "Interactive map",
  mapStyle = defaultRasterMapStyle,
  onMapControllerReady,
  onMapReady,
  onViewStateChange,
  showAttributionControl = true,
  style,
  viewState,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<Map<string, RegisteredFlatLayer>>(new Map());
  const dragRef = useRef<{
    center: [number, number];
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const lastCommittedFlatStateRef = useRef<MapViewState | null>(null);
  const lastFlatMoveStateRef = useRef<MapViewState | null>(null);
  const lastFitBoundsKeyRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(mapDisplay === "globe");
  const [renderVersion, setRenderVersion] = useState(0);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [hovered, setHovered] = useState<{ feature: unknown; id: string | null } | null>(null);
  const [tooltip, setTooltip] = useState<FeatureOverlayState | null>(null);
  const [popup, setPopup] = useState<FeatureOverlayState | null>(null);
  const { controlled, setViewState, viewState: currentViewState } = useControllableMapViewState({
    defaultViewState,
    display: mapDisplay,
    fallback: { center: [12, 25], zoom: mapDisplay === "globe" ? 1.35 : 1.6 },
    initialViewState,
    onViewStateChange,
    viewState,
  });

  const requestRender = useCallback(() => {
    setRenderVersion((version) => version + 1);
  }, []);

  const renderFlatLayers = useEffectEvent(() => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;

    if (!leaflet || !map) {
      return;
    }

    for (const layer of layersRef.current.values()) {
      if (!layer.group) {
        layer.group = leaflet.layerGroup().addTo(map);
      }

      layer.render({
        isMeasuring,
        layer: layer.group,
        leaflet,
        map,
      });
    }
  });

  const fitFlatToData = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map || !dataBounds) {
      return;
    }

    map.fitBounds(
      [
        [dataBounds[1], dataBounds[0]],
        [dataBounds[3], dataBounds[2]],
      ],
      {
        animate: false,
        padding: [fitBoundsPadding, fitBoundsPadding],
      },
    );
    const next = getLeafletViewState(map);

    lastCommittedFlatStateRef.current = next;
    setViewState(next, "fit-to-data");
  });

  const fitGlobeToData = useEffectEvent(() => {
    if (!dataBounds) {
      return;
    }

    setViewState(
      {
        center: [(dataBounds[0] + dataBounds[2]) / 2, (dataBounds[1] + dataBounds[3]) / 2],
        zoom: 1.8,
      },
      "fit-to-data",
    );
  });

  const fitToDataNow = useEffectEvent(() => {
    if (mapDisplay === "flat") {
      fitFlatToData();
      return;
    }

    fitGlobeToData();
  });

  const syncFlatControlledView = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    const current = getLeafletViewState(map);

    if (areMapViewStatesEqual(current, currentViewState)) {
      return;
    }

    lastCommittedFlatStateRef.current = currentViewState;
    map.setView(toLeafletLatLng(currentViewState.center), currentViewState.zoom, {
      animate: false,
    });
  });

  const emitFlatMoveEnd = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    const next = getLeafletViewState(map);
    const previous = lastFlatMoveStateRef.current;
    const reason =
      previous && Math.abs(previous.zoom - next.zoom) > 1e-8 ? "zoom" : "pan";

    lastFlatMoveStateRef.current = next;

    if (
      lastCommittedFlatStateRef.current &&
      areMapViewStatesEqual(lastCommittedFlatStateRef.current, next)
    ) {
      lastCommittedFlatStateRef.current = null;
      return;
    }

    setViewState(next, reason);
    renderFlatLayers();
  });

  const handleMapReady = useEffectEvent((map: LeafletMap) => {
    startTransition(() => {
      onMapReady?.(map);
    });
  });

  useEffect(() => {
    if (mapDisplay !== "flat") {
      setIsReady(true);
      return;
    }

    let isCancelled = false;
    let localMap: LeafletMap | null = null;

    async function initializeMap() {
      if (!containerRef.current) {
        return;
      }

      const leaflet = await import("leaflet");

      if (isCancelled || !containerRef.current) {
        return;
      }

      leafletRef.current = leaflet;
      localMap = leaflet.map(containerRef.current, {
        attributionControl: showAttributionControl,
        center: toLeafletLatLng(currentViewState.center),
        zoom: currentViewState.zoom,
        zoomControl: true,
      });
      mapRef.current = localMap;
      lastFlatMoveStateRef.current = currentViewState;

      const tileLayerOptions = resolveTileLayerOptions(mapStyle);

      if (tileLayerOptions) {
        leaflet.tileLayer(tileLayerOptions.url, tileLayerOptions.options).addTo(localMap);
      }

      localMap.on("moveend", emitFlatMoveEnd);
      localMap.on("click", () => {
        setPopup(null);
      });

      queueMicrotask(() => {
        if (isCancelled || !localMap) {
          return;
        }

        renderFlatLayers();
        setIsReady(true);
        handleMapReady(localMap);
      });
    }

    initializeMap();

    return () => {
      isCancelled = true;
      setIsReady(false);

      for (const layer of layersRef.current.values()) {
        layer.group?.clearLayers();
        layer.group = null;
      }

      if (localMap) {
        localMap.off("moveend", emitFlatMoveEnd);
        localMap.remove();
      }

      mapRef.current = null;
      leafletRef.current = null;
    };
  }, [mapDisplay]);

  useEffect(() => {
    if (mapDisplay !== "flat") {
      return;
    }

    if (controlled) {
      syncFlatControlledView();
    }

    renderFlatLayers();
  }, [controlled, currentViewState, isMeasuring, mapDisplay, renderVersion]);

  useEffect(() => {
    if (!isReady || !fitToData || controlled || initialViewState || defaultViewState || viewState) {
      return;
    }

    const boundsKey = dataBounds?.map((value) => Number(value.toFixed(6))).join(",") ?? null;

    if (!boundsKey || lastFitBoundsKeyRef.current === boundsKey) {
      return;
    }

    lastFitBoundsKeyRef.current = boundsKey;
    fitToDataNow();
  }, [controlled, dataBounds, defaultViewState, fitToData, fitToDataNow, initialViewState, isReady, viewState]);

  useEffect(() => {
    const controller: MapSurfaceController = {
      display: mapDisplay,
      fitToData: fitToDataNow,
      getViewState: () => currentViewState,
      setViewState: (next, reason = "programmatic") => {
        setViewState(next, reason);
      },
    };

    onMapControllerReady?.(controller);
  }, [currentViewState, fitToDataNow, mapDisplay, onMapControllerReady, setViewState]);

  const registerFlatLayer = useCallback(
    (id: string, render: FlatLayerRender) => {
      const leaflet = leafletRef.current;
      const map = mapRef.current;
      const previous = layersRef.current.get(id);
      const group = previous?.group ?? (leaflet && map ? leaflet.layerGroup().addTo(map) : null);

      layersRef.current.set(id, {
        id,
        group,
        render,
      });

      if (leaflet && map && group) {
        render({ isMeasuring, layer: group, leaflet, map });
      }

      return () => {
        const layer = layersRef.current.get(id);

        if (layer?.group) {
          layer.group.clearLayers();
        }

        if (!layer) {
          return;
        }

        const clearRender: FlatLayerRender = ({ layer: currentLayer }) => {
          currentLayer.clearLayers();
        };

        layersRef.current.set(id, {
          ...layer,
          render: clearRender,
        });

        queueMicrotask(() => {
          const current = layersRef.current.get(id);

          if (current?.render !== clearRender) {
            return;
          }

          current.group?.clearLayers();
          current.group?.remove?.();
          layersRef.current.delete(id);
        });
      };
    },
    [isMeasuring],
  );

  const getGlobePointerCoordinate = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;

      if (!svg) {
        return null;
      }

      const rect = svg.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * GLOBE_VIEWBOX_WIDTH;
      const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * GLOBE_VIEWBOX_HEIGHT;

      return unprojectGlobePoint({ x, y }, currentViewState as GlobeViewState);
    },
    [currentViewState],
  );

  const getFeatureId = useCallback((feature: unknown, getId?: (feature: never) => string) => {
    if (getId) {
      return getId(feature as never);
    }

    if (feature && typeof feature === "object") {
      const record = feature as Record<string, unknown>;
      const point = record.point as Record<string, unknown> | undefined;
      const flow = record.flow as Record<string, unknown> | undefined;

      return String(point?.id ?? flow?.id ?? record.id ?? record.clusterId ?? "");
    }

    return "";
  }, []);

  const context = useMemo<MapSurfaceContextValue>(
    () => ({
      closeFeaturePopup: () => setPopup(null),
      display: mapDisplay,
      getGlobePointerCoordinate,
      handleBackgroundClick: () => {
        setPopup(null);
      },
      handleFeatureClick(feature, position, options) {
        if (options?.suppress) {
          return;
        }

        startTransition(() => {
          options?.onFeatureSelect?.(feature);
        });

        if (options?.renderFeaturePopup) {
          setPopup({
            feature,
            position,
            render: options.renderFeaturePopup as (feature: unknown) => ReactNode,
          });
        }
      },
      handleFeatureHover(feature, position, options) {
        startTransition(() => {
          options?.onFeatureHover?.(feature);
        });

        if (!feature || !position) {
          setHovered(null);
          setTooltip(null);
          return;
        }

        setHovered({ feature, id: getFeatureId(feature) || null });

        if (options?.renderFeatureTooltip) {
          setTooltip({
            feature,
            position,
            render: options.renderFeatureTooltip as (feature: unknown) => ReactNode,
          });
        }
      },
      isFeatureHovered(feature, getId) {
        if (!hovered) {
          return false;
        }

        const id = getFeatureId(feature, getId as never);

        return id ? hovered.id === id : hovered.feature === feature;
      },
      isFeatureSelected(feature, selectedFeatureId, getId) {
        if (!selectedFeatureId) {
          return false;
        }

        return getFeatureId(feature, getId as never) === selectedFeatureId;
      },
      isMeasuring,
      leaflet: leafletRef.current,
      leafletMap: mapRef.current,
      projectGlobeCoordinate,
      registerFlatLayer,
      requestRender,
      setMeasurementActive: setIsMeasuring,
      setViewState,
      viewState: currentViewState,
    }),
    [
      currentViewState,
      getFeatureId,
      getGlobePointerCoordinate,
      hovered,
      isReady,
      isMeasuring,
      mapDisplay,
      registerFlatLayer,
      requestRender,
      setViewState,
    ],
  );

  const rootClassName = joinClassNames(
    "mb-maps",
    mapDisplay === "globe" && "mb-maps--globe",
    isMeasuring && "mb-maps--measuring",
    className,
  );

  return (
    <MapSurfaceContext.Provider value={context}>
      <div
        aria-label={mapLabel}
        className={rootClassName}
        data-map-ready={isReady ? "true" : "false"}
        style={{
          minHeight: 480,
          position: "relative",
          width: "100%",
          ...style,
        }}
        onClick={() => {
          if (mapDisplay === "globe") {
            setPopup(null);
          }
        }}
      >
        {mapDisplay === "flat" ? <div ref={containerRef} className="mb-maps__canvas" /> : null}
        {mapDisplay === "globe" ? (
          <svg
            ref={svgRef}
            className="mb-maps__globe"
            viewBox={`0 0 ${GLOBE_VIEWBOX_WIDTH} ${GLOBE_VIEWBOX_HEIGHT}`}
            role="img"
            onPointerDown={(event) => {
              dragRef.current = {
                center: currentViewState.center,
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;

              if (!drag || drag.pointerId !== event.pointerId) {
                return;
              }

              setViewState(
                {
                  ...currentViewState,
                  center: getGlobeDragCenter(
                    drag.center,
                    event.clientX - drag.x,
                    event.clientY - drag.y,
                    currentViewState.zoom,
                  ),
                },
                "pan",
              );
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) {
                dragRef.current = null;
              }
            }}
            onWheel={(event) => {
              event.preventDefault();
              setViewState(
                {
                  ...currentViewState,
                  zoom: getGlobeZoom(currentViewState.zoom, event.deltaY),
                },
                "zoom",
              );
            }}
          >
            <GlobeBase viewState={currentViewState as GlobeViewState} />
            <g className="mb-maps__globe-features">{children}</g>
          </svg>
        ) : (
          children
        )}
        <FeatureOverlays
          popup={popup}
          tooltip={tooltip}
          onClosePopup={() => {
            setPopup(null);
          }}
        />
      </div>
    </MapSurfaceContext.Provider>
  );
}

function getLeafletViewState(map: LeafletMap): MapViewState {
  const center = map.getCenter?.() ?? { lat: 25, lng: 12 };

  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
  };
}

export type {
  MapSurfaceController,
  MapViewportProps,
  MapViewStateChangeContext,
  MapViewStateChangeReason,
} from "./map-display";
