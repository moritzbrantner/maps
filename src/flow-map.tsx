"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

import {
  createGlobeGraticuleLines,
  createVisibleSvgPath,
  defaultRasterMapStyle,
  getGlobeDragCenter,
  getGlobeRadius,
  getGlobeZoom,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  joinClassNames,
  projectGlobeCoordinate,
  resolveTileLayerOptions,
  toLeafletLatLng,
  type GlobeViewState,
  type MapDisplayMode,
  type MapViewState,
  type RasterMapStyle,
} from "./map-display";
import { useLeafletBeeLineMeasurementLayer } from "./measurement-layer";
import type { MapMeasurementProps } from "./measurement";

export type MapFlow<TProperties = Record<string, unknown>> = {
  from: [longitude: number, latitude: number];
  id: string;
  label?: string;
  metrics?: Record<string, number>;
  properties?: TProperties;
  to: [longitude: number, latitude: number];
};

export type IndexedMapFlow<TProperties = Record<string, unknown>> = {
  from: [longitude: number, latitude: number];
  id: string;
  label: string;
  metrics: Record<string, number>;
  properties: TProperties;
  to: [longitude: number, latitude: number];
};

export type FlowMapFeature<TProperties = Record<string, unknown>> = {
  flow: IndexedMapFlow<TProperties>;
  rawValue: number;
  value: number;
  width: number;
};

export type FlowMapWeightAccessor<TProperties = Record<string, unknown>> = (
  flow: IndexedMapFlow<TProperties>,
) => number;

export type FlowMapProps<TProperties = Record<string, unknown>> = {
  className?: string;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  flowColor?: string;
  flows: readonly MapFlow<TProperties>[];
  getFlowColor?: (feature: FlowMapFeature<TProperties>) => string;
  getWeight?: FlowMapWeightAccessor<TProperties>;
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxWeight?: number;
  maxWidth?: number;
  minWidth?: number;
  onFeatureSelect?: (feature: FlowMapFeature<TProperties> | null) => void;
  onMapReady?: (map: LeafletMap) => void;
  showAttributionControl?: boolean;
  showEndpoints?: boolean;
  style?: React.CSSProperties;
  weightMetric?: string;
} & MapMeasurementProps;

export function FlowMap<TProperties = Record<string, unknown>>({
  mapDisplay = "flat",
  ...props
}: FlowMapProps<TProperties>) {
  if (mapDisplay === "globe") {
    return <GlobeFlowMap {...props} mapDisplay={mapDisplay} />;
  }

  return <FlatFlowMap {...props} mapDisplay={mapDisplay} />;
}

export function createFlowMapFeatures<TProperties = Record<string, unknown>>(
  flows: readonly MapFlow<TProperties>[],
  options: {
    getWeight?: FlowMapWeightAccessor<TProperties>;
    maxWeight?: number;
    maxWidth?: number;
    minWidth?: number;
    weightMetric?: string;
  } = {},
): Array<FlowMapFeature<TProperties>> {
  const indexedFlows = flows.map(toIndexedFlow).filter(isValidFlow);
  const weightedFlows = indexedFlows
    .map((flow) => ({
      flow,
      rawValue: resolveFlowWeight(flow, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFlows.map((entry) => entry.rawValue));
  const minWidth = Math.max(0, options.minWidth ?? 1.5);
  const maxWidth = Math.max(minWidth, options.maxWidth ?? 12);

  return weightedFlows.map(({ flow, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      flow,
      rawValue,
      value,
      width: minWidth + Math.sqrt(value) * (maxWidth - minWidth),
    };
  });
}

function FlatFlowMap<TProperties = Record<string, unknown>>({
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  flowColor = "#0f766e",
  flows,
  getFlowColor,
  getWeight,
  initialViewState,
  mapLabel = "Interactive flow map",
  mapStyle = defaultRasterMapStyle,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  maxWeight,
  maxWidth,
  minWidth,
  onFeatureSelect,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  showAttributionControl = true,
  showEndpoints = true,
  style,
  weightMetric,
}: FlowMapProps<TProperties>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const overlayRef = useRef<LayerGroup | null>(null);
  const measurementLayerRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [isReady, setIsReady] = useState(false);
  const deferredFlows = useDeferredValue(flows);
  const features = useMemo(
    () =>
      createFlowMapFeatures(deferredFlows, {
        getWeight,
        maxWeight,
        maxWidth,
        minWidth,
        weightMetric,
      }),
    [deferredFlows, getWeight, maxWeight, maxWidth, minWidth, weightMetric],
  );
  const { isMeasuring } = useLeafletBeeLineMeasurementLayer({
    layerRef: measurementLayerRef,
    leafletRef,
    mapRef,
    measurementDistanceFormat,
    measurementDraftLineColor,
    measurementLineColor,
    measurementMode,
    measurements,
    onMeasurementCreate,
    onMeasurementDraftChange,
    onMeasurementSelect,
  });

  const syncSource = useEffectEvent(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    const leaflet = leafletRef.current;

    if (!map || !overlay || !leaflet) {
      return;
    }

    renderFlowOverlay({
      features,
      flowColor,
      getFlowColor,
      handleClick,
      isMeasuring,
      leaflet,
      map,
      overlay,
      showEndpoints,
    });
  });

  const handleClick = useEffectEvent((feature: FlowMapFeature<TProperties> | null) => {
    startTransition(() => {
      onFeatureSelect?.(feature);
    });
  });

  const handleMapReady = useEffectEvent((map: LeafletMap) => {
    setIsReady(true);
    startTransition(() => {
      onMapReady?.(map);
    });
  });

  useEffect(() => {
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
        center: toLeafletLatLng(initialViewState?.center ?? [12, 25]),
        zoom: initialViewState?.zoom ?? 1.6,
        zoomControl: true,
      });
      mapRef.current = localMap;

      const tileLayerOptions = resolveTileLayerOptions(mapStyle);

      if (tileLayerOptions) {
        leaflet.tileLayer(tileLayerOptions.url, tileLayerOptions.options).addTo(localMap);
      }

      overlayRef.current = leaflet.layerGroup().addTo(localMap);
      measurementLayerRef.current = leaflet.layerGroup().addTo(localMap);

      queueMicrotask(() => {
        if (isCancelled || !localMap) {
          return;
        }

        syncSource();
        handleMapReady(localMap);
      });
    }

    initializeMap();

    return () => {
      isCancelled = true;
      setIsReady(false);

      if (localMap) {
        localMap.remove();
      }

      overlayRef.current = null;
      measurementLayerRef.current = null;
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    if (fitToData && !initialViewState) {
      const dataBounds = getBoundsFromFlows(deferredFlows);

      if (dataBounds) {
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
      }
    }

    syncSource();
  }, [deferredFlows, features, fitBoundsPadding, fitToData, initialViewState, isMeasuring, syncSource]);

  return (
    <div
      aria-label={mapLabel}
      className={joinClassNames("mb-maps", isMeasuring && "mb-maps--measuring", className)}
      data-map-ready={isReady ? "true" : "false"}
      style={{
        minHeight: 480,
        width: "100%",
        ...style,
      }}
    >
      <div ref={containerRef} className="mb-maps__canvas" />
    </div>
  );
}

function GlobeFlowMap<TProperties = Record<string, unknown>>({
  className,
  fitToData = true,
  flowColor = "#0f766e",
  flows,
  getFlowColor,
  getWeight,
  initialViewState,
  mapLabel = "Interactive flow map",
  measurementDistanceFormat: _measurementDistanceFormat,
  measurementDraftLineColor: _measurementDraftLineColor,
  measurementLineColor: _measurementLineColor,
  measurementMode: _measurementMode,
  measurements: _measurements,
  maxWeight,
  maxWidth,
  minWidth,
  onFeatureSelect,
  onMeasurementCreate: _onMeasurementCreate,
  onMeasurementDraftChange: _onMeasurementDraftChange,
  onMeasurementSelect: _onMeasurementSelect,
  showEndpoints = true,
  style,
  weightMetric,
}: FlowMapProps<TProperties>) {
  const deferredFlows = useDeferredValue(flows);
  const dragRef = useRef<{
    center: [number, number];
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [viewState, setViewState] = useState<GlobeViewState>(() =>
    createInitialFlowGlobeViewState({
      fitToData,
      flows,
      initialViewState,
    }),
  );
  const features = useMemo(
    () =>
      createFlowMapFeatures(deferredFlows, {
        getWeight,
        maxWeight,
        maxWidth,
        minWidth,
        weightMetric,
      }),
    [deferredFlows, getWeight, maxWeight, maxWidth, minWidth, weightMetric],
  );

  useEffect(() => {
    if (initialViewState || !fitToData) {
      return;
    }

    setViewState(createInitialFlowGlobeViewState({ fitToData, flows: deferredFlows, initialViewState }));
  }, [deferredFlows, fitToData, initialViewState]);

  const handleFeatureClick = useEffectEvent((feature: FlowMapFeature<TProperties>) => {
    startTransition(() => {
      onFeatureSelect?.(feature);
    });
  });

  return (
    <div
      aria-label={mapLabel}
      className={joinClassNames("mb-maps", "mb-maps--globe", className)}
      data-map-ready="true"
      style={{
        minHeight: 480,
        width: "100%",
        ...style,
      }}
    >
      <svg
        className="mb-maps__globe"
        viewBox={`0 0 ${GLOBE_VIEWBOX_WIDTH} ${GLOBE_VIEWBOX_HEIGHT}`}
        role="img"
        onPointerDown={(event) => {
          dragRef.current = {
            center: viewState.center,
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

          setViewState((current) => ({
            ...current,
            center: getGlobeDragCenter(
              drag.center,
              event.clientX - drag.x,
              event.clientY - drag.y,
              current.zoom,
            ),
          }));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
          }
        }}
        onWheel={(event) => {
          event.preventDefault();
          setViewState((current) => ({
            ...current,
            zoom: getGlobeZoom(current.zoom, event.deltaY),
          }));
        }}
      >
        <FlowGlobeBase viewState={viewState} />
        <g className="mb-maps__globe-features">
          {features.map((feature) => (
            <GlobeFlowFeature
              feature={feature}
              flowColor={flowColor}
              getFlowColor={getFlowColor}
              key={feature.flow.id}
              onClick={handleFeatureClick}
              showEndpoints={showEndpoints}
              viewState={viewState}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function FlowGlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
      <defs>
        <radialGradient id="mb-maps-globe-ocean" cx="38%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="58%" stopColor="#a7f3d0" />
          <stop offset="100%" stopColor="#0f766e" />
        </radialGradient>
      </defs>
      <circle
        className="mb-maps__globe-ocean"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
      <g className="mb-maps__globe-graticule">
        {createGlobeGraticuleLines(viewState).map((line, index) => {
          const path = createVisibleSvgPath(line);

          return path ? <path d={path} key={index} /> : null;
        })}
      </g>
      <circle
        className="mb-maps__globe-rim"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
    </>
  );
}

function GlobeFlowFeature<TProperties>({
  feature,
  flowColor,
  getFlowColor,
  onClick,
  showEndpoints,
  viewState,
}: {
  feature: FlowMapFeature<TProperties>;
  flowColor: string;
  getFlowColor?: (feature: FlowMapFeature<TProperties>) => string;
  onClick: (feature: FlowMapFeature<TProperties>) => void;
  showEndpoints: boolean;
  viewState: GlobeViewState;
}) {
  const from = projectGlobeCoordinate(feature.flow.from, viewState);
  const to = projectGlobeCoordinate(feature.flow.to, viewState);

  if (!from.visible && !to.visible) {
    return null;
  }

  const color = getFlowColor?.(feature) ?? flowColor;
  const opacity = clamp(0.28 + Math.min(from.scale, to.scale) * 0.72, 0.18, 0.92);

  return (
    <g
      className="mb-maps__globe-flow"
      onClick={(event) => {
        event.stopPropagation();
        onClick(feature);
      }}
      style={{ opacity }}
    >
      <path
        d={`M${from.x.toFixed(2)} ${from.y.toFixed(2)}L${to.x.toFixed(2)} ${to.y.toFixed(2)}`}
        stroke={color}
        strokeWidth={feature.width}
      >
        <title>{feature.flow.label}</title>
      </path>
      {showEndpoints && from.visible ? (
        <circle cx={from.x} cy={from.y} fill={color} r={Math.max(2.5, feature.width * 0.52)} />
      ) : null}
      {showEndpoints && to.visible ? (
        <circle cx={to.x} cy={to.y} fill={color} r={Math.max(3.5, feature.width * 0.72)} />
      ) : null}
    </g>
  );
}

function renderFlowOverlay<TProperties>({
  features,
  flowColor,
  getFlowColor,
  handleClick,
  isMeasuring,
  leaflet,
  map,
  overlay,
  showEndpoints,
}: {
  features: readonly FlowMapFeature<TProperties>[];
  flowColor: string;
  getFlowColor?: (feature: FlowMapFeature<TProperties>) => string;
  handleClick: (feature: FlowMapFeature<TProperties> | null) => void;
  isMeasuring: boolean;
  leaflet: typeof import("leaflet");
  map: LeafletMap;
  overlay: LayerGroup;
  showEndpoints: boolean;
}) {
  overlay.clearLayers();

  for (const feature of features) {
    const color = getFlowColor?.(feature) ?? flowColor;
    const line = leaflet.polyline([toLeafletLatLng(feature.flow.from), toLeafletLatLng(feature.flow.to)], {
      className: "mb-maps__flow-line",
      color,
      interactive: !isMeasuring,
      opacity: 0.72,
      weight: feature.width,
    });

    if (!isMeasuring) {
      line.on("click", () => {
        handleClick(feature);
      });
      line.on("mouseover", () => {
        map.getContainer().style.cursor = "pointer";
      });
      line.on("mouseout", () => {
        map.getContainer().style.cursor = "";
      });
    }
    line.addTo(overlay);

    if (showEndpoints) {
      leaflet
        .circleMarker(toLeafletLatLng(feature.flow.from), {
          className: "mb-maps__flow-endpoint mb-maps__flow-endpoint--from",
          color: "#ffffff",
          fillColor: color,
          fillOpacity: 0.9,
          interactive: false,
          opacity: 1,
          radius: Math.max(3, feature.width * 0.55),
          weight: 1.5,
        })
        .addTo(overlay);
      leaflet
        .circleMarker(toLeafletLatLng(feature.flow.to), {
          className: "mb-maps__flow-endpoint mb-maps__flow-endpoint--to",
          color: "#ffffff",
          fillColor: color,
          fillOpacity: 0.95,
          interactive: false,
          opacity: 1,
          radius: Math.max(4, feature.width * 0.75),
          weight: 1.5,
        })
        .addTo(overlay);
    }
  }
}

function createInitialFlowGlobeViewState<TProperties>({
  fitToData,
  flows,
  initialViewState,
}: {
  fitToData: boolean;
  flows: readonly MapFlow<TProperties>[];
  initialViewState?: MapViewState;
}): GlobeViewState {
  if (initialViewState) {
    return initialViewState;
  }

  const bounds = fitToData ? getBoundsFromFlows(flows) : null;

  if (bounds) {
    return {
      center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
      zoom: 1.8,
    };
  }

  return {
    center: [12, 25],
    zoom: 1.35,
  };
}

function getBoundsFromFlows<TProperties>(flows: readonly MapFlow<TProperties>[]) {
  const coordinates = flows
    .flatMap((flow) => [flow.from, flow.to])
    .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));

  if (coordinates.length === 0) {
    return null;
  }

  return coordinates.reduce(
    (bounds, [longitude, latitude]) =>
      [
        Math.min(bounds[0], longitude),
        Math.min(bounds[1], latitude),
        Math.max(bounds[2], longitude),
        Math.max(bounds[3], latitude),
      ] as [number, number, number, number],
    [180, 90, -180, -90] as [number, number, number, number],
  );
}

function resolveFlowWeight<TProperties>(
  flow: IndexedMapFlow<TProperties>,
  options: {
    getWeight?: FlowMapWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(flow)
    : options.weightMetric
      ? flow.metrics[options.weightMetric] ?? 0
      : flow.metrics.weight ?? 1;

  if (!Number.isFinite(rawWeight)) {
    return 0;
  }

  return Math.max(0, rawWeight);
}

function toIndexedFlow<TProperties>(
  flow: MapFlow<TProperties>,
  index: number,
): IndexedMapFlow<TProperties> {
  return {
    from: flow.from,
    id: String(flow.id ?? index),
    label: flow.label ?? "",
    metrics: flow.metrics ?? {},
    properties: flow.properties ?? ({} as TProperties),
    to: flow.to,
  };
}

function isValidFlow<TProperties>(flow: IndexedMapFlow<TProperties>) {
  return (
    Number.isFinite(flow.from[0]) &&
    Number.isFinite(flow.from[1]) &&
    Number.isFinite(flow.to[0]) &&
    Number.isFinite(flow.to[1])
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
