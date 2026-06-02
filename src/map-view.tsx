"use client";

import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import {
  FeatureOverlays,
  type ContextMenuOverlayState,
  type FeatureOverlayState,
} from "./feature-overlays";
import { splitMapViewChildren } from "./map-components";
import {
  defaultRasterMapStyle,
  getBoundedGlobeZoom,
  getGlobeDragCenter,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  joinClassNames,
  normalizeMapBounds,
  normalizeMapMaxZoom,
  projectGlobeCoordinate,
  resolveMapLibreStyle,
  toMapLibreBounds,
  unprojectGlobePoint,
  type GlobeBasemapMode,
  type GlobeViewState,
  type MapDisplayMode,
  type MapBounds,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeReason,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import {
  attachMapLibreMarkerConstructor,
  createMapLibreFlatLayerFactory,
  createMapLibreFlatMapAdapter,
  type FlatLayerFactory,
  type FlatLayerGroup,
  type FlatMapAdapter,
} from "./maplibre-compat";
import {
  areMapViewStatesEqual,
  serializeMapViewState,
  useControllableMapViewState,
} from "./map-view-state";
import { WebGlFlatRuntime, type FlatMapRuntime } from "./webgl-flat-runtime";
import type {
  MapContextMenuContext,
  MapFeatureContextMenuContext,
} from "./map-interaction";
import {
  MapSurfaceContext,
  type FlatLayerRegistrationOptions,
  type FlatLayerRender,
  type MapInteractionMode,
  type MapSurfaceContextValue,
} from "./map-surface-context";

export {
  MapSurfaceContext,
  type FlatLayerRegistrationOptions,
  type FlatLayerRender,
  type MapInteractionMode,
  type MapSurfaceContextValue,
} from "./map-surface-context";

const GLOBE_TILE_MIN_ZOOM = 4;
const GlobeBase = lazy(() =>
  import("./globe-base").then((module) => ({ default: module.GlobeBase })),
);
const GlobeSvgOverlayBase = lazy(() =>
  import("./globe-base").then((module) => ({ default: module.GlobeSvgOverlayBase })),
);

export type MapViewProps = MapViewportProps & {
  children?: ReactNode;
  className?: string;
  dataBounds?: [west: number, south: number, east: number, north: number] | null;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  flatRuntime?: FlatMapRuntime;
  globeBasemapMode?: GlobeBasemapMode;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapContextMenu?: (context: MapContextMenuContext) => void;
  onMapReady?: (map: MapLibreMap) => void;
  renderMapContextMenu?: (context: MapContextMenuContext) => ReactNode;
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
};

type RegisteredFlatLayer = {
  cleanup: (() => void) | null;
  id: string;
  group: FlatLayerGroup | null;
  preserveOnRender: boolean;
  render: FlatLayerRender;
  renderOnViewStateChange: boolean;
};

export function MapView({
  children,
  className,
  dataBounds = null,
  defaultViewState,
  fitBoundsPadding = 56,
  fitToData = true,
  flatRuntime = "maplibre",
  globeBasemapMode = "vector",
  initialViewState,
  mapDisplay = "flat",
  mapLabel = "Interactive map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  onMapControllerReady,
  onMapContextMenu,
  onMapReady,
  onViewStateChange,
  renderMapContextMenu,
  showAttributionControl = true,
  style,
  viewState,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const maplibreRef = useRef<typeof import("maplibre-gl") | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const flatMapAdapterRef = useRef<FlatMapAdapter | null>(null);
  const flatLayerFactoryRef = useRef<FlatLayerFactory | null>(null);
  const mapContextMenuOptionsRef = useRef<{
    onMapContextMenu?: (context: MapContextMenuContext) => void;
    renderMapContextMenu?: (context: MapContextMenuContext) => ReactNode;
  }>({});
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
  const lastFlatFullRenderKeyRef = useRef<string | null>(null);
  const lastFlatViewportRenderKeyRef = useRef<string | null>(null);
  const blockedHoverPositionRef = useRef<{ x: number; y: number } | null>(null);
  const isFlatStyleReadyRef = useRef(false);
  const [isReady, setIsReady] = useState(mapDisplay === "globe");
  const [renderVersion, setRenderVersion] = useState(0);
  const interactionModesRef = useRef<Map<string, Exclude<MapInteractionMode, "none">>>(new Map());
  const [interactionMode, setInteractionMode] = useState<MapInteractionMode>("none");
  const isMeasuring = interactionMode === "measurement";
  const isEditing = interactionMode === "editing";
  const [hovered, setHovered] = useState<{ feature: unknown; id: string | null } | null>(null);
  const [tooltip, setTooltip] = useState<FeatureOverlayState | null>(null);
  const [popup, setPopup] = useState<FeatureOverlayState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuOverlayState | null>(null);
  const [boundsMinZoom, setBoundsMinZoom] = useState<number | undefined>(undefined);
  const resolvedMaxBounds = normalizeMapBounds(maxBounds);
  const { controlled, setViewState, viewState: currentViewState } = useControllableMapViewState({
    defaultViewState,
    display: mapDisplay,
    fallback: { center: [12, 25], zoom: mapDisplay === "globe" ? 1.35 : 1.6 },
    initialViewState,
    maxBounds: resolvedMaxBounds ?? undefined,
    maxZoom,
    minZoom: boundsMinZoom,
    onViewStateChange,
    viewState,
  });
  const resolvedMaxZoom = normalizeMapMaxZoom(maxZoom);
  const currentViewStateKey = serializeMapViewState(currentViewState);
  const flatViewportRenderKey = [
    controlled ? "controlled" : "uncontrolled",
    currentViewStateKey,
    flatRuntime,
    mapDisplay,
  ].join(":");
  const flatFullRenderKey = [
    flatRuntime,
    interactionMode,
    isMeasuring ? "measuring" : "idle",
    mapDisplay,
    resolvedMaxBounds?.join(",") ?? "unbounded",
    renderVersion,
  ].join(":");
  const mapChildren = useMemo(() => splitMapViewChildren(children), [children]);

  const requestRender = useCallback(() => {
    setRenderVersion((version) => version + 1);
  }, []);

  const syncInteractionMode = useCallback(() => {
    const modes = Array.from(interactionModesRef.current.values());
    const nextMode = modes.includes("editing")
      ? "editing"
      : modes.includes("measurement")
        ? "measurement"
        : "none";

    setInteractionMode(nextMode);
  }, []);

  const registerInteractionMode = useCallback(
    (id: string, mode: Exclude<MapInteractionMode, "none">) => {
      interactionModesRef.current.set(id, mode);
      syncInteractionMode();

      return () => {
        interactionModesRef.current.delete(id);
        syncInteractionMode();
      };
    },
    [syncInteractionMode],
  );

  const setMeasurementActive = useCallback(
    (active: boolean) => {
      if (active) {
        interactionModesRef.current.set("__measurement", "measurement");
      } else {
        interactionModesRef.current.delete("__measurement");
      }

      syncInteractionMode();
    },
    [syncInteractionMode],
  );

  useEffect(() => {
    mapContextMenuOptionsRef.current = {
      onMapContextMenu,
      renderMapContextMenu,
    };
  }, [onMapContextMenu, renderMapContextMenu]);

  const renderFlatLayers = useEffectEvent((options: { viewportOnly: boolean }) => {
    const flat = flatLayerFactoryRef.current;
    const map = flatMapAdapterRef.current;
    const maplibre = maplibreRef.current;
    const maplibreMap = mapRef.current;

    if (!flat || !map || !maplibre || !maplibreMap || !isFlatStyleReadyRef.current) {
      return;
    }

    for (const layer of layersRef.current.values()) {
      if (options.viewportOnly && !layer.renderOnViewStateChange) {
        continue;
      }

      if (!layer.group) {
        layer.group = flat.layerGroup().addTo(maplibreMap);
      }

      layer.cleanup?.();
      if (!layer.preserveOnRender) {
        layer.group.clearLayers();
      }
      layer.cleanup = null;
      layer.render({
        flat,
        interactionMode,
        isMeasuring,
        layer: layer.group,
        map,
        maplibre,
        maplibreMap,
      });
    }
  });

  const clearFeatureHover = useEffectEvent(() => {
    blockedHoverPositionRef.current = null;
    setHovered(null);
    setTooltip(null);
  });

  const fitFlatToData = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map || !dataBounds) {
      return;
    }

    const fitOptions = {
      animate: false,
      padding: fitBoundsPadding,
      ...(resolvedMaxZoom === undefined ? {} : { maxZoom: resolvedMaxZoom }),
    };

    map.fitBounds(toMapLibreBounds(dataBounds), fitOptions);
    const next = getMapLibreViewState(map);

    lastCommittedFlatStateRef.current = next;
    setViewState(next, "fit-to-data");
  });

  const syncFlatBoundsConstraints = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map || mapDisplay !== "flat" || flatRuntime !== "maplibre") {
      return;
    }

    const bounds = resolvedMaxBounds;

    map.setMaxBounds?.(bounds ? toMapLibreBounds(bounds) : null);

    if (!bounds) {
      map.setMinZoom?.(0);
      setBoundsMinZoom(undefined);
      return;
    }

    const camera = map.cameraForBounds?.(toMapLibreBounds(bounds), {
      padding: 0,
    });
    const nextMinZoom = typeof camera?.zoom === "number" && Number.isFinite(camera.zoom)
      ? Math.max(0, camera.zoom)
      : undefined;

    if (nextMinZoom !== undefined) {
      map.setMinZoom?.(nextMinZoom);
      setBoundsMinZoom(nextMinZoom);

      if (map.getZoom() < nextMinZoom) {
        map.jumpTo({ zoom: nextMinZoom });
      }
    }
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

    const current = getMapLibreViewState(map);

    if (areMapViewStatesEqual(current, currentViewState)) {
      return;
    }

    lastCommittedFlatStateRef.current = currentViewState;
    map.jumpTo({ center: currentViewState.center, zoom: currentViewState.zoom });
  });

  const emitFlatMoveEnd = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    clearFeatureHover();

    const next = getMapLibreViewState(map);
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
  });

  const handleMapReady = useEffectEvent((map: MapLibreMap) => {
    startTransition(() => {
      onMapReady?.(map);
    });
  });

  useEffect(() => {
    if (mapDisplay !== "flat" || flatRuntime !== "maplibre") {
      setIsReady(true);
      return;
    }

    let isCancelled = false;
    let localMap: MapLibreMap | null = null;

    async function initializeMap() {
      if (!containerRef.current) {
        return;
      }

      const maplibre = await import("maplibre-gl");

      if (isCancelled || !containerRef.current) {
        return;
      }

      maplibreRef.current = maplibre;
      isFlatStyleReadyRef.current = false;
      localMap = new maplibre.Map({
        attributionControl: showAttributionControl ? {} : false,
        center: currentViewState.center,
        container: containerRef.current,
        ...(resolvedMaxBounds ? { maxBounds: toMapLibreBounds(resolvedMaxBounds) } : {}),
        ...(resolvedMaxZoom === undefined ? {} : { maxZoom: resolvedMaxZoom }),
        style: resolveMapLibreStyle(mapStyle),
        zoom: currentViewState.zoom,
      });
      localMap.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-left");
      attachMapLibreMarkerConstructor(localMap, maplibre.Marker);
      flatMapAdapterRef.current = createMapLibreFlatMapAdapter(localMap);
      flatLayerFactoryRef.current = createMapLibreFlatLayerFactory(maplibre, localMap);
      mapRef.current = localMap;
      lastFlatMoveStateRef.current = currentViewState;

      localMap.on("moveend", emitFlatMoveEnd);
      localMap.on("movestart", clearFeatureHover);
      localMap.on("zoomstart", clearFeatureHover);
      localMap.on("dragstart", clearFeatureHover);
      localMap.on("resize", syncFlatBoundsConstraints);
      localMap.on("click", () => {
        clearFeatureHover();
        setPopup(null);
        setContextMenu(null);
      });
      localMap.on("contextmenu", (event: MapLibreMapContextMenuEvent) => {
        if (isMapLibreOriginalEventPrevented(event)) {
          return;
        }

        suppressNativeContextMenu(event);
        handleMapContextMenu(getFlatContextMenuContext(localMap!, event), mapContextMenuOptionsRef.current);
      });

      localMap.once("load", () => {
        if (isCancelled || !localMap) {
          return;
        }

        isFlatStyleReadyRef.current = true;
        syncFlatBoundsConstraints();
        renderFlatLayers({ viewportOnly: false });
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
        layer.cleanup?.();
        layer.cleanup = null;
      }

      if (localMap) {
        localMap.off("moveend", emitFlatMoveEnd);
        localMap.off("movestart", clearFeatureHover);
        localMap.off("zoomstart", clearFeatureHover);
        localMap.off("dragstart", clearFeatureHover);
        localMap.off("resize", syncFlatBoundsConstraints);
        localMap.remove();
      }

      mapRef.current = null;
      flatMapAdapterRef.current = null;
      flatLayerFactoryRef.current = null;
      maplibreRef.current = null;
      isFlatStyleReadyRef.current = false;
    };
  }, [flatRuntime, mapDisplay]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || mapDisplay !== "flat" || flatRuntime !== "maplibre") {
      return;
    }

    map.setMaxZoom?.(resolvedMaxZoom ?? 22);
    syncFlatBoundsConstraints();

    if (map.getZoom() > currentViewState.zoom) {
      lastCommittedFlatStateRef.current = currentViewState;
      map.jumpTo({ zoom: currentViewState.zoom });
    }
  }, [currentViewState, flatRuntime, mapDisplay, resolvedMaxZoom, syncFlatBoundsConstraints]);

  useEffect(() => {
    if (mapDisplay !== "flat" || flatRuntime !== "maplibre") {
      return;
    }

    if (lastFlatFullRenderKeyRef.current === flatFullRenderKey) {
      return;
    }

    lastFlatFullRenderKeyRef.current = flatFullRenderKey;

    renderFlatLayers({ viewportOnly: false });
  }, [flatFullRenderKey, flatRuntime, mapDisplay]);

  useEffect(() => {
    if (mapDisplay !== "flat" || flatRuntime !== "maplibre") {
      return;
    }

    if (lastFlatViewportRenderKeyRef.current === flatViewportRenderKey) {
      return;
    }

    lastFlatViewportRenderKeyRef.current = flatViewportRenderKey;

    if (controlled) {
      syncFlatControlledView();
    }

    renderFlatLayers({ viewportOnly: true });
  }, [controlled, flatRuntime, flatViewportRenderKey, mapDisplay]);

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
    (id: string, render: FlatLayerRender, options: FlatLayerRegistrationOptions = {}) => {
      const flat = flatLayerFactoryRef.current;
      const map = flatMapAdapterRef.current;
      const maplibre = maplibreRef.current;
      const maplibreMap = mapRef.current;
      const previous = layersRef.current.get(id);
      const group = previous?.group ?? (flat && maplibreMap ? flat.layerGroup().addTo(maplibreMap) : null);
      const preserveOnRender = options.preserveOnRender === true;
      const renderOnViewStateChange = options.renderOnViewStateChange !== false;

      layersRef.current.set(id, {
        cleanup: previous?.cleanup ?? null,
        id,
        group,
        preserveOnRender,
        render,
        renderOnViewStateChange,
      });

      if (flat && map && maplibre && maplibreMap && group && isFlatStyleReadyRef.current) {
        previous?.cleanup?.();
        if (!preserveOnRender) {
          group.clearLayers();
        }
        render({ flat, interactionMode, isMeasuring, layer: group, map, maplibre, maplibreMap });
      }

      return () => {
        const layer = layersRef.current.get(id);

        layer?.cleanup?.();

        if (!layer) {
          return;
        }

        const clearRender: FlatLayerRender = ({ layer: currentLayer }) => {
          currentLayer.clearLayers();
        };

        layersRef.current.set(id, {
          ...layer,
          cleanup: null,
          preserveOnRender: false,
          render: clearRender,
          renderOnViewStateChange: false,
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
    [interactionMode, isMeasuring],
  );

  const getGlobePointerCoordinate = useCallback(
    (event: { clientX: number; clientY: number }) => {
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

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const createMapContextMenuContext = useCallback(
    (input: {
      coordinates: [longitude: number, latitude: number];
      position: { x: number; y: number };
    }): MapContextMenuContext => ({
      close: closeContextMenu,
      coordinates: input.coordinates,
      position: input.position,
    }),
    [closeContextMenu],
  );

  const handleMapContextMenu = useEffectEvent(
    (
      input: {
        coordinates: [longitude: number, latitude: number];
        position: { x: number; y: number };
      },
      options?: {
        onMapContextMenu?: (context: MapContextMenuContext) => void;
        renderMapContextMenu?: (context: MapContextMenuContext) => ReactNode;
      },
    ) => {
      if (interactionMode !== "none") {
        return;
      }

      const context = createMapContextMenuContext(input);

      startTransition(() => {
        options?.onMapContextMenu?.(context);
      });

      if (options?.renderMapContextMenu) {
        setPopup(null);
        setTooltip(null);
        setContextMenu({
          context,
          position: input.position,
          render: options.renderMapContextMenu as (context: unknown) => ReactNode,
        });
      }
    },
  );

  const context = useMemo<MapSurfaceContextValue>(
    () => ({
      closeFeaturePopup: () => setPopup(null),
      display: mapDisplay,
      getGlobePointerCoordinate,
      handleBackgroundClick: () => {
        blockedHoverPositionRef.current = null;
        setHovered(null);
        setTooltip(null);
        setPopup(null);
        setContextMenu(null);
      },
      handleFeatureClick(feature, position, options) {
        if (options?.suppress) {
          return;
        }

        setContextMenu(null);
        setHovered(null);
        setTooltip(null);
        blockedHoverPositionRef.current = position;

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
      handleFeatureContextMenu(feature, position, options) {
        if (options?.suppress) {
          return;
        }

        const coordinates = options?.coordinates ?? getFeatureCoordinate(feature);
        const context: MapFeatureContextMenuContext<typeof feature> = {
          close: closeContextMenu,
          coordinates,
          feature,
          position,
        };

        startTransition(() => {
          options?.onFeatureContextMenu?.(feature);
          options?.onFeatureSelect?.(feature);
        });

        if (options?.renderFeatureContextMenu) {
          setPopup(null);
          setTooltip(null);
          setContextMenu({
            context,
            position,
            render: (value) =>
              options.renderFeatureContextMenu!(
                (value as MapFeatureContextMenuContext<typeof feature>).feature,
                value as MapFeatureContextMenuContext<typeof feature>,
              ),
          });
          return;
        }

        setContextMenu(null);

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
          blockedHoverPositionRef.current = null;
          setHovered(null);
          setTooltip(null);
          return;
        }

        if (isBlockedHoverPosition(blockedHoverPositionRef.current, position)) {
          return;
        }

        blockedHoverPositionRef.current = null;
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
      interactionMode,
      flatMap: flatMapAdapterRef.current,
      maplibre: maplibreRef.current,
      maplibreMap: mapRef.current,
      projectGlobeCoordinate,
      registerFlatLayer,
      registerInteractionMode,
      requestRender,
      setMeasurementActive,
      setViewState,
      viewState: currentViewState,
    }),
    [
      currentViewState,
      getFeatureId,
      getGlobePointerCoordinate,
      hovered,
      interactionMode,
      isReady,
      isMeasuring,
      mapDisplay,
      registerFlatLayer,
      registerInteractionMode,
      requestRender,
      setMeasurementActive,
      setViewState,
    ],
  );

  const rootClassName = joinClassNames(
    "mb-maps",
    mapDisplay === "globe" && "mb-maps--globe",
    isMeasuring && "mb-maps--measuring",
    isEditing && "mb-maps--editing",
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
            setContextMenu(null);
          }
        }}
      >
        {mapDisplay === "flat" && flatRuntime === "maplibre" ? (
          <div ref={containerRef} className="mb-maps__canvas" />
        ) : null}
        {mapDisplay === "flat" && flatRuntime === "webgl" ? (
          <WebGlFlatRuntime
            mapStyle={mapStyle}
            maxBounds={resolvedMaxBounds ?? undefined}
            maxZoom={resolvedMaxZoom}
            viewState={currentViewState}
            onContextMenu={(context) => {
              handleMapContextMenu(context, {
                onMapContextMenu,
                renderMapContextMenu,
              });
            }}
            onReady={() => {
              setIsReady(true);
            }}
            onViewStateChange={setViewState}
          />
        ) : null}
        {mapDisplay === "globe" ? (
          <>
            <Suspense fallback={null}>
              <GlobeBase
                basemapMode={globeBasemapMode}
                mapStyle={mapStyle}
                viewState={currentViewState as GlobeViewState}
              />
            </Suspense>
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
                    zoom: getBoundedGlobeZoom(currentViewState.zoom, event.deltaY, resolvedMaxZoom),
                  },
                  "zoom",
                );
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();

                const coordinate = getGlobePointerCoordinate(event);

                if (!coordinate) {
                  return;
                }

                const rect = event.currentTarget.getBoundingClientRect();

                handleMapContextMenu(
                  {
                    coordinates: coordinate,
                    position: {
                      x: event.clientX - rect.left,
                      y: event.clientY - rect.top,
                    },
                  },
                  {
                    onMapContextMenu,
                    renderMapContextMenu,
                  },
                );
              }}
            >
              <Suspense fallback={null}>
                <GlobeSvgOverlayBase
                  showVectorBasemap={
                    globeBasemapMode !== "tiles" || currentViewState.zoom < GLOBE_TILE_MIN_ZOOM
                  }
                  viewState={currentViewState as GlobeViewState}
                />
              </Suspense>
              <g className="mb-maps__globe-features">{mapChildren.layers}</g>
            </svg>
          </>
        ) : (
          mapChildren.layers
        )}
        {mapChildren.overlays.length > 0 ? (
          <div className="mb-maps__overlays">{mapChildren.overlays}</div>
        ) : null}
        <FeatureOverlays
          contextMenu={contextMenu}
          popup={popup}
          tooltip={tooltip}
          onCloseContextMenu={() => {
            setContextMenu(null);
          }}
          onClosePopup={() => {
            setPopup(null);
          }}
        />
      </div>
    </MapSurfaceContext.Provider>
  );
}

type MapLibreMapContextMenuEvent = {
  lngLat?: { lat: number; lng: number };
  originalEvent?: {
    defaultPrevented?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
  point?: { x: number; y: number };
};

function getFlatContextMenuContext(
  map: MapLibreMap,
  event: MapLibreMapContextMenuEvent,
) {
  const position = event.point ?? { x: 0, y: 0 };
  const lngLat = event.lngLat ?? map.unproject([position.x, position.y]) ?? map.getCenter?.() ?? { lat: 25, lng: 12 };

  return {
    coordinates: [lngLat.lng, lngLat.lat] as [number, number],
    position,
  };
}

function getFeatureCoordinate(feature: unknown): [longitude: number, latitude: number] {
  if (feature && typeof feature === "object") {
    const record = feature as Record<string, unknown>;
    const coordinates = record.coordinates;

    if (isCoordinate(coordinates)) {
      return coordinates;
    }

    const point = record.point as Record<string, unknown> | undefined;
    const flow = record.flow as Record<string, unknown> | undefined;

    if (typeof point?.longitude === "number" && typeof point.latitude === "number") {
      return [point.longitude, point.latitude];
    }

    if (isCoordinate(flow?.from) && isCoordinate(flow?.to)) {
      return [(flow.from[0] + flow.to[0]) / 2, (flow.from[1] + flow.to[1]) / 2];
    }
  }

  return [0, 0];
}

function isBlockedHoverPosition(
  blocked: { x: number; y: number } | null,
  position: { x: number; y: number },
) {
  return Boolean(
    blocked &&
      Math.abs(blocked.x - position.x) <= 1 &&
      Math.abs(blocked.y - position.y) <= 1,
  );
}

function isCoordinate(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function isMapLibreOriginalEventPrevented(event: MapLibreMapContextMenuEvent) {
  return event.originalEvent?.defaultPrevented === true;
}

function suppressNativeContextMenu(event: MapLibreMapContextMenuEvent) {
  event.originalEvent?.preventDefault?.();
  event.originalEvent?.stopPropagation?.();
}

function getMapLibreViewState(map: MapLibreMap): MapViewState {
  const center = map.getCenter?.() ?? { lat: 25, lng: 12 };

  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
  };
}

export type {
  FlatMapRuntime,
} from "./webgl-flat-runtime";

export type {
  MapSurfaceController,
  MapBounds,
  MapViewportProps,
  MapViewStateChangeContext,
  MapViewStateChangeReason,
} from "./map-display";
