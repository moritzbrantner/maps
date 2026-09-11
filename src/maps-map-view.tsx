"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getBoundsFromPoints } from "./aggregation";
import {
  MapsCanvasFlatRuntime,
  type MapsCanvasFlatRuntimeController,
} from "./canvas-flat-runtime";
import { FeatureOverlays, type ContextMenuOverlayState } from "./feature-overlays";
import { getBoundsFromGeoJson, type GeoJsonMapSource } from "./geojson-source";
import { splitMapViewChildren } from "./map-components";
import {
  defaultRasterMapStyle,
  joinClassNames,
  normalizeMapMaxZoom,
  resolveTileLayerOptions,
  type MapBounds,
  type MapFitBoundsOptions,
  type MapFlyToOptions,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeReason,
  type RasterMapStyle,
} from "./map-display";
import type { MapContextMenuContext } from "./map-interaction";
import { MapsOverlayLayers } from "./maps-overlay-layers";
import {
  MapSurfaceContext,
  type MapSurfaceContextValue,
} from "./map-surface-context";
import { useControllableMapViewState } from "./map-view-state";
import type { MapViewProps as LegacyMapViewProps } from "./map-view-maplibre";

export type MapsMapViewProps = Omit<LegacyMapViewProps, "flatRuntime"> & {
  flatRuntime?: "maps";
};

export function MapsMapView({
  children,
  className,
  dataBounds = null,
  defaultViewState,
  fitBoundsPadding = 56,
  fitToData = true,
  flatRuntime = "maps",
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
}: MapsMapViewProps) {
  const resolvedMapStyle = useMemo(() => resolveMapsRuntimeStyle(mapStyle), [mapStyle]);
  const tileSource = useMemo(() => resolveTileLayerOptions(resolvedMapStyle), [resolvedMapStyle]);
  const mapChildren = useMemo(() => splitMapViewChildren(children), [children]);
  const runtimeControllerRef = useRef<MapsCanvasFlatRuntimeController | null>(null);
  const lastFitBoundsKeyRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState<unknown>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuOverlayState | null>(null);
  const {
    controlled,
    setViewState,
    viewState: currentViewState,
  } = useControllableMapViewState({
    defaultViewState,
    display: "flat",
    fallback: { center: [12, 25], zoom: 1.6 },
    initialViewState,
    maxZoom,
    onViewStateChange,
    viewState,
  });
  const resolvedMaxZoom = normalizeMapMaxZoom(maxZoom);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const fitBoundsNow = useCallback(
    (
      bounds: MapBounds | null,
      options: MapFitBoundsOptions & { reason?: MapViewStateChangeReason } = {},
    ) => {
      const runtime = runtimeControllerRef.current;
      if (!bounds || !runtime) {
        return;
      }

      runtime.fitBounds(bounds, {
        ...options,
        maxZoom: options.maxZoom ?? resolvedMaxZoom,
        padding: options.padding ?? fitBoundsPadding,
      });
    },
    [fitBoundsPadding, resolvedMaxZoom],
  );

  const fitToDataNow = useCallback(() => {
    fitBoundsNow(dataBounds, { padding: fitBoundsPadding, reason: "fit-to-data" });
  }, [dataBounds, fitBoundsNow, fitBoundsPadding]);

  const flyToNow = useCallback(
    (next: MapViewState, options: MapFlyToOptions = {}) => {
      void options;
      const runtime = runtimeControllerRef.current;

      if (runtime) {
        runtime.setViewState(next, "fly-to");
        return;
      }

      setViewState(next, "fly-to");
    },
    [setViewState],
  );

  const setSurfaceViewState = useCallback(
    (next: MapViewState, reason: MapViewStateChangeReason = "programmatic") => {
      const runtime = runtimeControllerRef.current;

      if (runtime) {
        runtime.setViewState(next, reason);
        return;
      }

      setViewState(next, reason);
    },
    [setViewState],
  );

  const projectCoordinate = useCallback(
    (coordinates: [longitude: number, latitude: number]) => {
      return runtimeControllerRef.current?.project(coordinates) ?? null;
    },
    [currentViewState.center[0], currentViewState.center[1], currentViewState.zoom, isReady],
  );

  const handleMapContextMenu = useCallback(
    (input: {
      coordinates: [longitude: number, latitude: number];
      position: { x: number; y: number };
    }) => {
      const context: MapContextMenuContext = {
        close: closeContextMenu,
        coordinates: input.coordinates,
        position: input.position,
      };

      startTransition(() => {
        onMapContextMenu?.(context);
      });

      if (!renderMapContextMenu) {
        return;
      }

      setContextMenu({
        context,
        position: input.position,
        render: renderMapContextMenu as (context: unknown) => ReactNode,
      });
    },
    [closeContextMenu, onMapContextMenu, renderMapContextMenu],
  );

  useEffect(() => {
    if (!isReady || !onMapControllerReady) {
      return;
    }

    const controller: MapSurfaceController = {
      display: "flat",
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
      flyTo: flyToNow,
      getViewState: () => currentViewState,
      setViewState: setSurfaceViewState,
    };

    onMapControllerReady(controller);
  }, [
    currentViewState,
    fitBoundsNow,
    fitToDataNow,
    flyToNow,
    isReady,
    onMapControllerReady,
    setSurfaceViewState,
  ]);

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

  const context = useMemo<MapSurfaceContextValue>(
    () => ({
      closeFeaturePopup: () => undefined,
      display: "flat",
      handleBackgroundClick: closeContextMenu,
      handleFeatureClick() {
        throwUnsupportedMapsInteraction();
      },
      handleFeatureContextMenu() {
        throwUnsupportedMapsInteraction();
      },
      handleFeatureHover() {
        throwUnsupportedMapsInteraction();
      },
      isFeatureHovered: () => false,
      isFeatureSelected: () => false,
      isMeasuring: false,
      interactionMode: "none",
      flatMap: null,
      maplibre: null,
      maplibreMap: null,
      registerMapLibreLayer() {
        throwUnsupportedMapsInteraction();
      },
      registerInteractionMode() {
        throwUnsupportedMapsInteraction();
      },
      requestRender: () => undefined,
      setMeasurementActive(active) {
        if (active) {
          throwUnsupportedMapsInteraction();
        }
      },
      setViewState,
      viewState: currentViewState,
    }),
    [closeContextMenu, currentViewState, setViewState],
  );

  if (runtimeError) {
    throw normalizeRuntimeError(runtimeError);
  }
  if (mapDisplay !== "flat" || flatRuntime !== "maps") {
    throw new Error("The Maps runtime only supports flat MapView execution.");
  }
  if (onMapReady) {
    throw new Error(
      'onMapReady is MapLibre-specific and is unavailable with flatRuntime="maps"; use onMapControllerReady instead.',
    );
  }

  const rootClassName = joinClassNames("mb-maps", className);
  const attribution = tileSource?.options.attribution;

  return (
    <MapSurfaceContext.Provider value={context}>
      <div
        aria-label={mapLabel}
        className={rootClassName}
        data-map-ready={isReady ? "true" : "false"}
        data-map-runtime="maps"
        onClick={closeContextMenu}
        style={{
          minHeight: 480,
          position: "relative",
          width: "100%",
          ...style,
        }}
      >
        <MapsCanvasFlatRuntime
          mapStyle={resolvedMapStyle}
          maxBounds={maxBounds}
          maxZoom={resolvedMaxZoom}
          onContextMenu={handleMapContextMenu}
          onControllerReady={(controller) => {
            runtimeControllerRef.current = controller;
            if (!controller) {
              setIsReady(false);
            }
          }}
          onError={(error) => {
            if (!isReady) {
              setRuntimeError(error);
            }
          }}
          onReady={() => {
            setIsReady(true);
          }}
          onViewStateChange={setViewState}
          viewState={currentViewState}
        />
        <MapsOverlayLayers project={projectCoordinate}>{mapChildren.layers}</MapsOverlayLayers>
        {showAttributionControl && attribution ? (
          <div
            className="mb-maps__attribution"
            style={{
              bottom: 4,
              fontSize: 11,
              position: "absolute",
              right: 6,
              zIndex: 2,
            }}
          >
            {attribution}
          </div>
        ) : null}
        {mapChildren.overlays.length > 0 ? (
          <div className="mb-maps__overlays">{mapChildren.overlays}</div>
        ) : null}
        <FeatureOverlays
          contextMenu={contextMenu}
          popup={null}
          tooltip={null}
          onCloseContextMenu={closeContextMenu}
          onClosePopup={() => undefined}
        />
      </div>
    </MapSurfaceContext.Provider>
  );
}

function resolveMapsRuntimeStyle(mapStyle: string | RasterMapStyle): RasterMapStyle {
  if (typeof mapStyle === "string") {
    throw new Error(
      'flatRuntime="maps" requires an explicit raster tile style; MapLibre style URLs are not interpreted as tile templates.',
    );
  }

  if (!("version" in mapStyle)) {
    return mapStyle;
  }

  const style = mapStyle as unknown as {
    layers?: readonly { source?: unknown; type?: unknown }[];
    sources?: Record<string, unknown>;
  };
  const layers = style.layers ?? [];
  const sources = style.sources ?? {};
  const rasterSources = Object.entries(sources).filter(([, source]) => {
    return Boolean(source && typeof source === "object" && "type" in source && source.type === "raster");
  });

  if (layers.length === 0 && Object.keys(sources).length === 0) {
    return mapStyle;
  }

  if (layers.length !== 1 || layers[0]?.type !== "raster" || rasterSources.length !== 1) {
    throw new Error(
      'flatRuntime="maps" currently accepts exactly one explicit raster layer/source; vector or multi-layer MapLibre styles remain MapLibre-owned.',
    );
  }

  const [sourceId, source] = rasterSources[0]!;
  const rasterSource = source as { tiles?: unknown };

  if (typeof layers[0].source === "string" && layers[0].source !== sourceId) {
    throw new Error('flatRuntime="maps" raster layer must reference its single raster source directly.');
  }
  if (!Array.isArray(rasterSource.tiles) || typeof rasterSource.tiles[0] !== "string") {
    throw new Error(
      'flatRuntime="maps" requires an explicit raster tiles array; TileJSON and other indirect source forms are not supported yet.',
    );
  }

  return mapStyle;
}

function throwUnsupportedMapsInteraction(): never {
  throw new Error(
    'flatRuntime="maps" does not support MapLibre-backed interaction/editing layers yet; use display-only PointLayer/GeoJsonLayer overlays until the Maps interaction overlay slice lands.',
  );
}

function normalizeRuntimeError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error(`Maps flat runtime initialization failed: ${String(error)}`);
}
