"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createGlobeGraticuleLines,
  createVisibleSvgPath,
  defaultRasterMapStyle,
  getBoundedGlobeZoom,
  getGlobeDragCenter,
  getGlobeRadius,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  joinClassNames,
  projectGlobeCoordinate,
  type GlobeBasemapMode,
  type GlobeViewState,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import {
  FlowLayer,
  createFlowPathCoordinates,
  type FlowDirectionMarker,
  type FlowLayerFeature,
  type FlowLayerWeightAccessor,
  type FlowShape,
  type IndexedMapFlow as LayerIndexedMapFlow,
  type MapFlow as LayerMapFlow,
} from "./flow-layer";
import {
  createGeoJsonOverlayFeatureCollection,
  createMapFlowsFromGeoJson,
  getBoundsFromGeoJson,
  type GeoJsonMapSource,
  type GeoJsonOverlayMode,
  type GeoJsonSourceOptions,
} from "./geojson-source";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapView } from "./map-view";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";

export type MapFlow<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  LayerMapFlow<TProperties>;

export type IndexedMapFlow<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  LayerIndexedMapFlow<TProperties>;

export type FlowMapFeature<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  FlowLayerFeature<TProperties>;

export type FlowMapWeightAccessor<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  FlowLayerWeightAccessor<TProperties>;

export type FlowMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  children?: ReactNode;
  className?: string;
  directionMarker?: FlowDirectionMarker;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  flowColor?: string;
  flowShape?: FlowShape;
  flowValueFormat?: (value: number, feature: FlowMapFeature<TProperties>) => string;
  flows?: readonly MapFlow<TProperties>[];
  geoJson?: GeoJsonMapSource<TProperties>;
  geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
  geoJsonOverlay?: GeoJsonOverlayMode;
  geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
  getFlowColor?: (feature: FlowMapFeature<TProperties>) => string;
  getFlowLabel?: (feature: FlowMapFeature<TProperties>) => ReactNode;
  getWeight?: FlowMapWeightAccessor<TProperties>;
  globeBasemapMode?: GlobeBasemapMode;
  hoveredFlowOpacity?: number;
  inactiveFlowOpacity?: number;
  /**
   * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
   */
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxWeight?: number;
  maxWidth?: number;
  minWidth?: number;
  onFeatureSelect?: (feature: FlowMapFeature<TProperties> | null) => void;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: import("maplibre-gl").Map) => void;
  selectedFlowOpacity?: number;
  showAttributionControl?: boolean;
  showDirection?: boolean;
  showEndpoints?: boolean;
  style?: React.CSSProperties;
  weightMetric?: string;
} & MapMeasurementProps &
  MapViewportProps &
  MapFeatureInteractionProps<FlowMapFeature<TProperties>>;

export function FlowMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay = "flat",
  children,
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  globeBasemapMode,
  initialViewState,
  mapLabel = "Interactive flow map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  onMapControllerReady,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  flows,
  geoJson,
  geoJsonOptions,
  geoJsonOverlay,
  geoJsonOverlayProps,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  onViewStateChange,
  ...props
}: FlowMapProps<TProperties>) {
  const resolvedFlows = flows ?? (geoJson ? createMapFlowsFromGeoJson(geoJson, geoJsonOptions) : []);
  const geoJsonOverlayCollection = geoJson
    ? createGeoJsonOverlayFeatureCollection(geoJson, {
        mode: geoJsonOverlay,
        target: "flow",
      })
    : null;

  return (
    <MapView
      className={className}
      dataBounds={geoJson ? getBoundsFromGeoJson(geoJson) : getBoundsFromFlows(resolvedFlows)}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      globeBasemapMode={globeBasemapMode}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      maxZoom={maxZoom}
      onMapControllerReady={onMapControllerReady}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      showAttributionControl={showAttributionControl}
      style={style}
      viewState={viewState}
    >
      {geoJsonOverlayCollection && geoJsonOverlayCollection.features.length > 0 ? (
        <GeoJsonLayer
          {...(geoJsonOverlayProps as Omit<GeoJsonLayerProps, "featureCollection"> | undefined)}
          featureCollection={geoJsonOverlayCollection}
        />
      ) : null}
      <FlowLayer {...(props as React.ComponentProps<typeof FlowLayer<TProperties>>)} flows={resolvedFlows} />
      <BeeLineMeasurementLayer
        measurementDistanceFormat={measurementDistanceFormat}
        measurementDraftLineColor={measurementDraftLineColor}
        measurementLineColor={measurementLineColor}
        measurementMode={measurementMode}
        measurements={measurements}
        onMeasurementCreate={onMeasurementCreate}
        onMeasurementDraftChange={onMeasurementDraftChange}
        onMeasurementSelect={onMeasurementSelect}
      />
      {children}
    </MapView>
  );
}

export function createFlowMapFeatures<TProperties extends Record<string, unknown> = Record<string, unknown>>(
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

export function FlatFlowMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay: _mapDisplay,
  ...props
}: FlowMapProps<TProperties>) {
  return <FlowMap {...props} mapDisplay="flat" />;
}

export function GlobeFlowMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  className,
  fitToData = true,
  flowColor = "#0f766e",
  flowShape = "straight",
  flows = [],
  getFlowColor,
  getWeight,
  initialViewState,
  mapLabel = "Interactive flow map",
  maxZoom,
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
            zoom: getBoundedGlobeZoom(current.zoom, event.deltaY, maxZoom),
          }));
        }}
      >
        <FlowGlobeBase viewState={viewState} />
        <g className="mb-maps__globe-features">
          {features.map((feature) => (
            <GlobeFlowFeature
              feature={feature}
              flowColor={flowColor}
              flowShape={flowShape}
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

function GlobeFlowFeature<TProperties extends Record<string, unknown>>({
  feature,
  flowColor,
  flowShape,
  getFlowColor,
  onClick,
  showEndpoints,
  viewState,
}: {
  feature: FlowMapFeature<TProperties>;
  flowColor: string;
  flowShape: FlowShape;
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
  const projectedPath = createFlowPathCoordinates(feature, flowShape)
    .map((coordinate, index) => {
      const projected = projectGlobeCoordinate(coordinate, viewState);
      const command = index === 0 ? "M" : "L";

      return `${command}${projected.x.toFixed(2)} ${projected.y.toFixed(2)}`;
    })
    .join("");

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
        d={projectedPath}
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

function createInitialFlowGlobeViewState<TProperties extends Record<string, unknown>>({
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

function getBoundsFromFlows<TProperties extends Record<string, unknown>>(flows: readonly MapFlow<TProperties>[]) {
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

function resolveFlowWeight<TProperties extends Record<string, unknown>>(
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

function toIndexedFlow<TProperties extends Record<string, unknown>>(
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

function isValidFlow<TProperties extends Record<string, unknown>>(flow: IndexedMapFlow<TProperties>) {
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
