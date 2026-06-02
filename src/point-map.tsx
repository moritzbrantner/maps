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
import type { Map as MapLibreMap } from "maplibre-gl";

import {
  getBoundsFromPoints,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
} from "./aggregation";
import {
  createGeoJsonOverlayFeatureCollection,
  createMapPointsFromGeoJson,
  getBoundsFromGeoJson,
  type GeoJsonMapSource,
  type GeoJsonOverlayMode,
  type GeoJsonSourceOptions,
} from "./geojson-source";
import {
  createInitialGlobeViewState,
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
  type GlobeViewState,
  type GlobeBasemapMode,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import type { MapContextMenuContext, MapFeatureInteractionProps } from "./map-interaction";
import { MapView } from "./map-view";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";
import {
  BubbleLayer,
  PointLayer,
  type BubbleLayerFeature,
  type BubbleLayerWeightAccessor,
  type PointLayerFeature,
} from "./point-layer";

export type PointMapFeature<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  PointLayerFeature<TProperties>;

export type PointMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  children?: React.ReactNode;
  className?: string;
  draggable?: boolean | ((feature: PointMapFeature<TProperties>) => boolean);
  filterPoint?: MapPointFilter<TProperties>;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  geoJson?: GeoJsonMapSource<TProperties>;
  geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
  geoJsonOverlay?: GeoJsonOverlayMode;
  geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
  getPointColor?: (feature: PointMapFeature<TProperties>) => string;
  getPointRadius?: (feature: PointMapFeature<TProperties>) => number;
  globeBasemapMode?: GlobeBasemapMode;
  /**
   * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
   */
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  onFeatureDrag?: (
    feature: PointMapFeature<TProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => void;
  onFeatureDragEnd?: (
    feature: PointMapFeature<TProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => void;
  onFeatureSelect?: (feature: PointMapFeature<TProperties> | null) => void;
  onMapContextMenu?: (context: MapContextMenuContext) => void;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: MapLibreMap) => void;
  points?: readonly MapPoint<TProperties>[];
  pointColor?: string;
  pointRadius?: number;
  renderMapContextMenu?: (context: MapContextMenuContext) => React.ReactNode;
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
} & MapMeasurementProps &
  MapViewportProps &
  MapFeatureInteractionProps<PointMapFeature<TProperties>>;

export type BubbleMapWeightAccessor<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  BubbleLayerWeightAccessor<TProperties>;

export type BubbleMapFeature<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  BubbleLayerFeature<TProperties>;

export type BubbleMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = Omit<
  PointMapProps<TProperties>,
  | "draggable"
  | "getPointColor"
  | "getPointRadius"
  | "onFeatureDrag"
  | "onFeatureDragEnd"
  | "onFeatureSelect"
  | "pointColor"
  | "pointRadius"
> & {
  bubbleColor?: string;
  draggable?: boolean | ((feature: BubbleMapFeature<TProperties>) => boolean);
  getBubbleColor?: (feature: BubbleMapFeature<TProperties>) => string;
  getWeight?: BubbleMapWeightAccessor<TProperties>;
  maxRadius?: number;
  maxWeight?: number;
  minRadius?: number;
  onFeatureDrag?: (
    feature: BubbleMapFeature<TProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => void;
  onFeatureDragEnd?: (
    feature: BubbleMapFeature<TProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => void;
  onFeatureSelect?: (feature: BubbleMapFeature<TProperties> | null) => void;
  weightMetric?: string;
};

export function PointMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay = "flat",
  children,
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  globeBasemapMode,
  initialViewState,
  mapLabel = "Interactive point map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  onMapControllerReady,
  onMapContextMenu,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  points,
  geoJson,
  geoJsonOptions,
  geoJsonOverlay,
  geoJsonOverlayProps,
  renderMapContextMenu,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  onViewStateChange,
  ...props
}: PointMapProps<TProperties>) {
  const resolvedPoints = points ?? (geoJson ? createMapPointsFromGeoJson(geoJson, geoJsonOptions) : []);
  const geoJsonOverlayCollection = geoJson
    ? createGeoJsonOverlayFeatureCollection(geoJson, {
        mode: geoJsonOverlay,
        target: "point",
      })
    : null;

  return (
    <MapView
      className={className}
      dataBounds={geoJson ? getBoundsFromGeoJson(geoJson) : getBoundsFromPoints(resolvedPoints)}
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
      onMapContextMenu={onMapContextMenu}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      renderMapContextMenu={renderMapContextMenu}
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
      <PointLayer
        {...(props as React.ComponentProps<typeof PointLayer<TProperties>>)}
        points={resolvedPoints}
      />
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

export function BubbleMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay = "flat",
  children,
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  globeBasemapMode,
  initialViewState,
  mapLabel = "Interactive point map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  onMapControllerReady,
  onMapContextMenu,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  points,
  geoJson,
  geoJsonOptions,
  geoJsonOverlay,
  geoJsonOverlayProps,
  renderMapContextMenu,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  onViewStateChange,
  ...props
}: BubbleMapProps<TProperties>) {
  const resolvedPoints = points ?? (geoJson ? createMapPointsFromGeoJson(geoJson, geoJsonOptions) : []);
  const geoJsonOverlayCollection = geoJson
    ? createGeoJsonOverlayFeatureCollection(geoJson, {
        mode: geoJsonOverlay,
        target: "point",
      })
    : null;

  return (
    <MapView
      className={className}
      dataBounds={geoJson ? getBoundsFromGeoJson(geoJson) : getBoundsFromPoints(resolvedPoints)}
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
      onMapContextMenu={onMapContextMenu}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      renderMapContextMenu={renderMapContextMenu}
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
      <BubbleLayer {...(props as React.ComponentProps<typeof BubbleLayer<TProperties>>)} points={resolvedPoints} />
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

export function FlatBubbleMap<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  props: BubbleMapProps<TProperties>,
) {
  return <FlatPointMap {...useBubbleMapPointProps({ ...props, mapDisplay: "flat" })} />;
}

export function createPointMapFeatures<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
  } = {},
): Array<PointMapFeature<TProperties>> {
  return points
    .map(toIndexedMapPoint)
    .filter(isValidPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      coordinates: [point.longitude, point.latitude],
      point,
    }));
}

export function createBubbleMapFeatures<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: BubbleMapWeightAccessor<TProperties>;
    maxRadius?: number;
    maxWeight?: number;
    minRadius?: number;
    weightMetric?: string;
  } = {},
): Array<BubbleMapFeature<TProperties>> {
  const baseFeatures = createPointMapFeatures(points, { filterPoint: options.filterPoint });
  const weightedFeatures = baseFeatures
    .map((feature) => ({
      feature,
      rawValue: resolveBubbleMapPointWeight(feature.point, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFeatures.map((entry) => entry.rawValue));
  const minRadius = Math.max(0, options.minRadius ?? 5);
  const maxRadius = Math.max(minRadius, options.maxRadius ?? 32);

  return weightedFeatures.map(({ feature, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      ...feature,
      rawValue,
      radius: minRadius + Math.sqrt(value) * (maxRadius - minRadius),
      value,
    };
  });
}

export function FlatPointMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay: _mapDisplay,
  ...props
}: PointMapProps<TProperties>) {
  return <PointMap {...props} mapDisplay="flat" />;
}

export function GlobePointMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  className,
  filterPoint,
  fitToData = true,
  getPointColor,
  getPointRadius,
  initialViewState,
  mapLabel = "Interactive point map",
  maxZoom,
  measurementDistanceFormat: _measurementDistanceFormat,
  measurementDraftLineColor: _measurementDraftLineColor,
  measurementLineColor: _measurementLineColor,
  measurementMode: _measurementMode,
  measurements: _measurements,
  onMeasurementCreate: _onMeasurementCreate,
  onMeasurementDraftChange: _onMeasurementDraftChange,
  onMeasurementSelect: _onMeasurementSelect,
  onFeatureSelect,
  points = [],
  pointColor = "#0f172a",
  pointRadius = 6,
  style,
}: PointMapProps<TProperties>) {
  const deferredPoints = useDeferredValue(points);
  const dragRef = useRef<{
    center: [number, number];
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [viewState, setViewState] = useState<GlobeViewState>(() =>
    createInitialGlobeViewState({
      fitToData,
      initialViewState,
      points,
    }),
  );
  const features = useMemo(
    () => createPointMapFeatures(deferredPoints, { filterPoint }),
    [deferredPoints, filterPoint],
  );

  useEffect(() => {
    if (initialViewState || !fitToData) {
      return;
    }

    setViewState(createInitialGlobeViewState({ fitToData, initialViewState, points: deferredPoints }));
  }, [deferredPoints, fitToData, initialViewState]);

  const handleFeatureClick = useEffectEvent((feature: PointMapFeature<TProperties>) => {
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
        <PointGlobeBase viewState={viewState} />
        <g className="mb-maps__globe-features">
          {features.map((feature) => (
            <GlobePointFeature
              feature={feature}
              getPointColor={getPointColor}
              getPointRadius={getPointRadius}
              key={feature.point.id}
              onClick={handleFeatureClick}
              pointColor={pointColor}
              pointRadius={pointRadius}
              viewState={viewState}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function PointGlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
      <defs>
        <radialGradient id="mb-maps-globe-ocean" cx="38%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="58%" stopColor="#bae6fd" />
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

function GlobePointFeature<TProperties extends Record<string, unknown>>({
  feature,
  getPointColor,
  getPointRadius,
  onClick,
  pointColor,
  pointRadius,
  viewState,
}: {
  feature: PointMapFeature<TProperties>;
  getPointColor?: (feature: PointMapFeature<TProperties>) => string;
  getPointRadius?: (feature: PointMapFeature<TProperties>) => number;
  onClick: (feature: PointMapFeature<TProperties>) => void;
  pointColor: string;
  pointRadius: number;
  viewState: GlobeViewState;
}) {
  const projected = projectGlobeCoordinate(feature.coordinates, viewState);

  if (!projected.visible) {
    return null;
  }

  return (
    <circle
      className="mb-maps__globe-point"
      cx={projected.x}
      cy={projected.y}
      fill={getPointColor?.(feature) ?? pointColor}
      onClick={(event) => {
        event.stopPropagation();
        onClick(feature);
      }}
      r={Math.max(0, getPointRadius?.(feature) ?? pointRadius) * (0.72 + projected.scale * 0.28)}
      style={{ opacity: 0.42 + projected.scale * 0.58 }}
    >
      <title>{feature.point.label}</title>
    </circle>
  );
}

function useBubbleMapPointProps<TProperties extends Record<string, unknown>>(
  props: BubbleMapProps<TProperties>,
): PointMapProps<TProperties> {
  const {
    bubbleColor = "#2563eb",
    draggable,
    getBubbleColor,
    getWeight,
    maxRadius = 32,
    maxWeight,
    minRadius = 5,
    onFeatureDrag,
    onFeatureDragEnd,
    onFeatureSelect,
    weightMetric,
    ...pointProps
  } = props;
  const deferredPoints = useDeferredValue(pointProps.points ?? []);
  const bubbleFeatures = useMemo(
    () =>
      createBubbleMapFeatures(deferredPoints, {
        filterPoint: pointProps.filterPoint,
        getWeight,
        maxRadius,
        maxWeight,
        minRadius,
        weightMetric,
      }),
    [
      deferredPoints,
      getWeight,
      maxRadius,
      maxWeight,
      minRadius,
      pointProps.filterPoint,
      weightMetric,
    ],
  );
  const featureById = useMemo(
    () => new Map(bubbleFeatures.map((feature) => [feature.point.id, feature] as const)),
    [bubbleFeatures],
  );

  return {
    ...pointProps,
    filterPoint(point) {
      return featureById.has(point.id);
    },
    draggable(feature) {
      const bubbleFeature = featureById.get(feature.point.id);

      if (!bubbleFeature) {
        return false;
      }

      return typeof draggable === "function" ? draggable(bubbleFeature) : draggable === true;
    },
    getPointColor(feature) {
      const bubbleFeature = featureById.get(feature.point.id);

      return bubbleFeature ? getBubbleColor?.(bubbleFeature) ?? bubbleColor : bubbleColor;
    },
    getPointRadius(feature) {
      return featureById.get(feature.point.id)?.radius ?? minRadius;
    },
    mapLabel: pointProps.mapLabel ?? "Interactive bubble map",
    onFeatureDrag(feature, coordinates) {
      const bubbleFeature = featureById.get(feature.point.id);

      if (bubbleFeature) {
        onFeatureDrag?.(bubbleFeature, coordinates);
      }
    },
    onFeatureDragEnd(feature, coordinates) {
      const bubbleFeature = featureById.get(feature.point.id);

      if (bubbleFeature) {
        onFeatureDragEnd?.(bubbleFeature, coordinates);
      }
    },
    onFeatureSelect(feature) {
      onFeatureSelect?.(feature ? featureById.get(feature.point.id) ?? null : null);
    },
    points: deferredPoints,
  };
}

function resolveBubbleMapPointWeight<TProperties extends Record<string, unknown>>(
  point: IndexedMapPoint<TProperties>,
  options: {
    getWeight?: BubbleMapWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(point)
    : options.weightMetric
      ? point.metrics[options.weightMetric] ?? 0
      : point.metrics.weight ?? 1;

  if (!Number.isFinite(rawWeight)) {
    return 0;
  }

  return Math.max(0, rawWeight);
}

function toIndexedMapPoint<TProperties>(
  point: MapPoint<TProperties>,
  index: number,
): IndexedMapPoint<TProperties> {
  return {
    id: String(point.id ?? index),
    label: point.label ?? "",
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: point.metrics ?? {},
    properties: point.properties ?? ({} as TProperties),
  };
}

function isValidPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
