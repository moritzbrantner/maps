"use client";

import {
  startTransition,
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
  getBoundsFromPoints,
} from "./aggregation";
import {
  FeatureOverlays,
  type ContextMenuOverlayState,
  type FeatureOverlayState,
} from "./feature-overlays";
import { getBoundsFromGeoJson, type GeoJsonMapSource } from "./geojson-source";
import { splitMapViewChildren } from "./map-components";
import {
  defaultRasterMapStyle,
  joinClassNames,
  normalizeMapBounds,
  normalizeMapMaxZoom,
  resolveMapLibreDisplayStyle,
  toMapLibreBounds,
  type MapBounds,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapFitBoundsOptions,
  type MapFlyToOptions,
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
import type { MapContextMenuContext, MapFeatureContextMenuContext } from "./map-interaction";
import {
  MapSurfaceContext,
  type MapLibreLayerRegistrationOptions,
  type MapLibreLayerRender,
  type MapInteractionMode,
  type MapSurfaceContextValue,
} from "./map-surface-context";
import {
  getFeatureCoordinate,
  getFlatContextMenuContext,
  getMapLibreViewState,
  isBlockedHoverPosition,
  isMapLibreOriginalEventPrevented,
  suppressNativeContextMenu,
  type MapLibreMapContextMenuEvent,
} from "./map-view-utils";

export {
  MapSurfaceContext,
  type MapLibreLayerRegistrationOptions,
  type MapLibreLayerRender,
  type MapInteractionMode,
  type MapSurfaceContextValue,
} from "./map-surface-context";

export type MapViewProps = MapViewportProps & {
  children?: ReactNode;
  className?: string;
  dataBounds?: [west: number, south: number, east: number, north: number] | null;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  flatRuntime?: FlatMapRuntime;
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
  render: MapLibreLayerRender;
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
  const usesMapLibreRuntime = mapDisplay === "globe" || (mapDisplay === "flat" && flatRuntime === "maplibre");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const maplibreRef = useRef<typeof import("maplibre-gl") | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const flatMapAdapterRef = useRef<FlatMapAdapter | null>(null);
  const flatLayerFactoryRef = useRef<FlatLayerFactory | null>(null);
  const mapContextMenuOptionsRef = useRef<{
    onMapContextMenu?: (context: MapContextMenuContext) => void;
    renderMapContextMenu?: (context: MapContextMenuContext) => ReactNode;
  }>({});
  const layersRef = useRef<Map<string, RegisteredFlatLayer>>(new Map());
  const lastCommittedFlatStateRef = useRef<MapViewState | null>(null);
  const lastFlatMoveStateRef = useRef<MapViewState | null>(null);
  const lastFitBoundsKeyRef = useRef<string | null>(null);
  const lastFlatFullRenderKeyRef = useRef<string | null>(null);
  const lastFlatViewportRenderKeyRef = useRef<string | null>(null);
  const blockedHoverPositionRef = useRef<{ x: number; y: number } | null>(null);
  const isFlatStyleReadyRef = useRef(false);
  const [mapLibreReady, setMapLibreReady] = useState(false);
  const isReady = !usesMapLibreRuntime || mapLibreReady;
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
  const {
    controlled,
    setViewState,
    viewState: currentViewState,
  } = useControllableMapViewState({
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

  const fitFlatToBounds = useEffectEvent((
    bounds: MapBounds,
    options: MapFitBoundsOptions & { reason?: MapViewStateChangeReason } = {},
  ) => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    const effectiveMaxZoom = options.maxZoom ?? resolvedMaxZoom;
    const fitOptions = {
      animate: options.animate ?? false,
      padding: options.padding ?? fitBoundsPadding,
      ...(options.durationMs === undefined ? {} : { duration: options.durationMs }),
      ...(effectiveMaxZoom === undefined ? {} : { maxZoom: effectiveMaxZoom }),
    };

    map.fitBounds(toMapLibreBounds(bounds), fitOptions);
    const next = getMapLibreViewState(map);

    lastCommittedFlatStateRef.current = next;
    setViewState(next, options.reason ?? "fit-bounds");
  });

  const syncFlatBoundsConstraints = useEffectEvent(() => {
    const map = mapRef.current;

    if (!map || !usesMapLibreRuntime) {
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
    const nextMinZoom =
      typeof camera?.zoom === "number" && Number.isFinite(camera.zoom)
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

  const fitBoundsNow = useEffectEvent((
    bounds: MapBounds | null,
    options: MapFitBoundsOptions & { reason?: MapViewStateChangeReason } = {},
  ) => {
    if (!bounds) {
      return;
    }

    if (usesMapLibreRuntime) {
      fitFlatToBounds(bounds, options);
    }
  });

  const fitToDataNow = useEffectEvent(() => {
    fitBoundsNow(dataBounds, { padding: fitBoundsPadding, reason: "fit-to-data" });
  });

  const flyToNow = useEffectEvent((next: MapViewState, options: MapFlyToOptions = {}) => {
    const map = mapRef.current;

    if (usesMapLibreRuntime && map) {
      const camera = {
        center: next.center,
        zoom: next.zoom,
        ...(options.durationMs === undefined ? {} : { duration: options.durationMs }),
      };

      if (options.animate === false) {
        map.jumpTo(camera);
      } else {
        map.flyTo?.(camera);
      }

      lastCommittedFlatStateRef.current = next;
    }

    setViewState(next, "fly-to");
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
    const reason = previous && Math.abs(previous.zoom - next.zoom) > 1e-8 ? "zoom" : "pan";

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
    if (!usesMapLibreRuntime) {
      return;
    }

    let isCancelled = false;
    let handleStyleLoad: (() => void) | null = null;
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
        style: resolveMapLibreDisplayStyle(mapStyle, mapDisplay),
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
        handleMapContextMenu(
          getFlatContextMenuContext(localMap!, event),
          mapContextMenuOptionsRef.current,
        );
      });

      handleStyleLoad = () => {
        if (isCancelled || !localMap) {
          return;
        }

        if (mapDisplay === "globe") {
          localMap.setProjection?.({ type: "globe" });
        }
        isFlatStyleReadyRef.current = true;
        syncFlatBoundsConstraints();
        renderFlatLayers({ viewportOnly: false });
      };

      localMap.on("style.load", handleStyleLoad);
      localMap.once("load", () => {
        if (isCancelled || !localMap) {
          return;
        }

        setMapLibreReady(true);
        handleMapReady(localMap);
      });
    }

    initializeMap();

    return () => {
      isCancelled = true;
      setMapLibreReady(false);

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
        if (handleStyleLoad) {
          localMap.off("style.load", handleStyleLoad);
        }
        localMap.remove();
      }

      mapRef.current = null;
      flatMapAdapterRef.current = null;
      flatLayerFactoryRef.current = null;
      maplibreRef.current = null;
      isFlatStyleReadyRef.current = false;
    };
  }, [mapDisplay, usesMapLibreRuntime]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !usesMapLibreRuntime) {
      return;
    }

    map.setMaxZoom?.(resolvedMaxZoom ?? 22);
    syncFlatBoundsConstraints();

    if (resolvedMaxZoom !== undefined && map.getZoom() > resolvedMaxZoom) {
      lastCommittedFlatStateRef.current = currentViewState;
      map.jumpTo({ zoom: currentViewState.zoom });
    }
  }, [currentViewState, resolvedMaxZoom, syncFlatBoundsConstraints, usesMapLibreRuntime]);

  useEffect(() => {
    if (!usesMapLibreRuntime) {
      return;
    }

    if (lastFlatFullRenderKeyRef.current === flatFullRenderKey) {
      return;
    }

    lastFlatFullRenderKeyRef.current = flatFullRenderKey;

    renderFlatLayers({ viewportOnly: false });
  }, [flatFullRenderKey, usesMapLibreRuntime]);

  useEffect(() => {
    if (!usesMapLibreRuntime) {
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
  }, [controlled, flatViewportRenderKey, usesMapLibreRuntime]);

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
  }, [
    controlled,
    dataBounds,
    defaultViewState,
    fitToData,
    fitToDataNow,
    initialViewState,
    isReady,
    viewState,
  ]);

  useEffect(() => {
    const controller: MapSurfaceController = {
      display: mapDisplay,
      fitToData: fitToDataNow,
      fitBounds: (bounds, options) => {
        fitBoundsNow(bounds, options);
      },
      fitPoints: (points, options) => {
        fitBoundsNow(getBoundsFromPoints(points), options);
      },
      fitGeoJson: (source, options) => {
        fitBoundsNow(getBoundsFromGeoJson(source as GeoJsonMapSource), options);
      },
      flyTo: (next, options) => {
        flyToNow(next, options);
      },
      getViewState: () => currentViewState,
      setViewState: (next, reason = "programmatic") => {
        setViewState(next, reason);
      },
    };

    onMapControllerReady?.(controller);
  }, [
    currentViewState,
    fitBoundsNow,
    fitToDataNow,
    flyToNow,
    mapDisplay,
    onMapControllerReady,
    setViewState,
  ]);

  const registerMapLibreLayer = useCallback(
    (id: string, render: MapLibreLayerRender, options: MapLibreLayerRegistrationOptions = {}) => {
      const flat = flatLayerFactoryRef.current;
      const map = flatMapAdapterRef.current;
      const maplibre = maplibreRef.current;
      const maplibreMap = mapRef.current;
      const previous = layersRef.current.get(id);
      const group =
        previous?.group ?? (flat && maplibreMap ? flat.layerGroup().addTo(maplibreMap) : null);
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

        const clearRender: MapLibreLayerRender = ({ layer: currentLayer }) => {
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

        const featureId = getFeatureId(feature, options?.getFeatureId as never) || null;

        setContextMenu(null);
        setHovered(null);
        setTooltip(null);
        blockedHoverPositionRef.current = position;

        startTransition(() => {
          options?.onFeatureSelect?.(feature);
          options?.onSelectedFeatureIdChange?.(featureId, {
            feature,
            featureId,
            source: "click",
          });
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

        const featureId = getFeatureId(feature, options?.getFeatureId as never) || null;
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
          options?.onSelectedFeatureIdChange?.(featureId, {
            feature,
            featureId,
            source: "context-menu",
          });
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
        const featureId = feature ? getFeatureId(feature, options?.getFeatureId as never) || null : null;

        startTransition(() => {
          options?.onFeatureHover?.(feature);
          options?.onHoveredFeatureIdChange?.(featureId, {
            feature,
            featureId,
            source: feature ? "hover" : "clear",
          });
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
        setHovered({ feature, id: featureId });

        if (options?.renderFeatureTooltip) {
          setTooltip({
            feature,
            position,
            render: options.renderFeatureTooltip as (feature: unknown) => ReactNode,
          });
        }
      },
      isFeatureHovered(feature, hoveredFeatureId, getId) {
        if (hoveredFeatureId) {
          return getFeatureId(feature, getId as never) === hoveredFeatureId;
        }

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
      registerMapLibreLayer,
      registerInteractionMode,
      requestRender,
      setMeasurementActive,
      setViewState,
      viewState: currentViewState,
    }),
    [
      currentViewState,
      getFeatureId,
      hovered,
      interactionMode,
      isReady,
      isMeasuring,
      mapDisplay,
      registerMapLibreLayer,
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
      >
        {usesMapLibreRuntime ? (
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
              setMapLibreReady(true);
            }}
            onViewStateChange={setViewState}
          />
        ) : null}
        {mapChildren.layers}
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

export type { FlatMapRuntime } from "./webgl-flat-runtime";

export type {
  MapSurfaceController,
  MapBounds,
  MapViewportProps,
  MapViewStateChangeContext,
  MapViewStateChangeReason,
} from "./map-display";
