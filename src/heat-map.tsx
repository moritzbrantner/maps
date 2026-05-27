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
  createPointAggregationIndex,
  getBoundsFromPoints,
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
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
  createGlobalViewportQuery,
  createGlobeGraticuleLines,
  createInitialGlobeViewState,
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
  type GlobeBasemapMode,
  type GlobeViewState,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import { HeatLayer, type HeatFieldRenderMode, type HeatLayerSurfaceMode } from "./heat-layer";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { MapView } from "./map-view";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import { useLeafletBeeLineMeasurementLayer } from "./measurement-layer";
import type { MapMeasurementProps } from "./measurement";
import {
  createScalarFieldGrid,
  normalizeScalarFieldValue,
  resolveScalarFieldValuePoints,
  type HeatFieldMaskGeoJson,
  type HeatFieldOptions,
} from "./scalar-field";
import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
  type HeatFieldContourOptions,
  type HeatFieldContourFeatureCollection,
  type HeatFieldColorStop,
  type HeatFieldImage,
} from "./scalar-field-render";
import type { TemporalGeoJsonGeometryFeatureCollection } from "./temporal-geojson-types";

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";
const DEFAULT_HEAT_MAP_RADIUS_METERS = 50_000;
const METERS_PER_DEGREE_AT_EQUATOR = 111_320;

export type HeatMapWeightAccessor<TProperties extends Record<string, unknown> = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatMapColorStop = readonly [density: number, color: string];

export type HeatMapSurfaceMode = HeatLayerSurfaceMode;

export type HeatMapRadius =
  | number
  | {
      meters: number;
    }
  | {
      max: number;
      maxZoom?: number;
      min: number;
      minZoom?: number;
    };

export type HeatMapFeatureProperties = {
  kind: "heat-cluster" | "heat-point";
  label: string;
  pointId: string;
  pointCount: number;
  rawWeight: number;
  weight: number;
} & Record<string, number | string>;

export type HeatMapFeature = {
  geometry: {
    coordinates: [longitude: number, latitude: number];
    type: "Point";
  };
  properties: HeatMapFeatureProperties;
  type: "Feature";
};

export type HeatMapFeatureCollection = {
  features: HeatMapFeature[];
  type: "FeatureCollection";
};

export type HeatMapWeightOptions<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  filterPoint?: MapPointFilter<TProperties>;
  getWeight?: HeatMapWeightAccessor<TProperties>;
  maxWeight?: number;
  weightMetric?: string;
};

export type HeatMapDensityIndexOptions<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  HeatMapWeightOptions<TProperties> & {
    maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    radius?: PointAggregationIndexOptions<TProperties>["radius"];
  };

export type HeatMapDensityIndex = {
  getFeatureCollection(query: ViewportAggregationQuery): HeatMapFeatureCollection;
  maxWeight: number;
  pointCount: number;
};

export type HeatMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  HeatMapWeightOptions<TProperties> &
    MapMeasurementProps & {
    className?: string;
    domainBounds?: HeatFieldOptions<TProperties>["domainBounds"];
    domainPaddingRatio?: HeatFieldOptions<TProperties>["domainPaddingRatio"];
    fieldCellSizeMeters?: HeatFieldOptions<TProperties>["fieldCellSizeMeters"];
    fieldContourColor?: HeatFieldContourOptions["lineColor"];
    fieldContourLevels?: HeatFieldContourOptions["levels"];
    fieldContourLineWidth?: HeatFieldContourOptions["lineWidth"];
    fieldContourOpacity?: HeatFieldContourOptions["opacity"];
    fieldContourValueFormat?: HeatFieldContourOptions["valueFormat"];
    fieldColorRamp?: readonly HeatFieldColorStop[];
    fieldColumns?: HeatFieldOptions<TProperties>["fieldColumns"];
    fieldOpacity?: HeatFieldOptions<TProperties>["opacity"];
    fieldRenderMode?: HeatFieldRenderMode;
    fieldRows?: HeatFieldOptions<TProperties>["fieldRows"];
    fieldValueDomain?: HeatFieldOptions<TProperties>["valueDomain"];
    fitBoundsPadding?: number;
    fitToData?: boolean;
    geoJson?: GeoJsonMapSource<TProperties>;
    geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
    geoJsonOverlay?: GeoJsonOverlayMode;
    geoJsonOverlayCollection?: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
    geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
    globeBasemapMode?: GlobeBasemapMode;
    heatmapAggregationMaxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    heatmapAggregationMinZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    heatmapAggregationRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    heatmapColorRamp?: readonly HeatMapColorStop[];
    heatmapIntensity?: number;
    heatmapMaxZoom?: number;
    heatmapOpacity?: number;
    heatmapRadius?: HeatMapRadius;
    heatmapSurfaceMode?: HeatMapSurfaceMode;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    initialViewState?: MapViewState;
    interpolationEpsilonMeters?: HeatFieldOptions<TProperties>["interpolationEpsilonMeters"];
    interpolationExtrapolate?: HeatFieldOptions<TProperties>["interpolationExtrapolate"];
    interpolationK?: HeatFieldOptions<TProperties>["interpolationK"];
    interpolationMaxDistanceMeters?: HeatFieldOptions<TProperties>["interpolationMaxDistanceMeters"];
    interpolationPower?: HeatFieldOptions<TProperties>["interpolationPower"];
    mapDisplay?: MapDisplayMode;
    mapLabel?: string;
    mapStyle?: string | RasterMapStyle;
    maskGeoJson?: HeatFieldMaskGeoJson | null;
    onMapControllerReady?: (controller: MapSurfaceController) => void;
    onMapReady?: (map: LeafletMap) => void;
    points?: readonly MapPoint<TProperties>[];
    showAttributionControl?: boolean;
    showDataPoints?: boolean;
    dataPointColor?: string;
    dataPointOpacity?: number;
    dataPointRadius?: number;
    dataPointStrokeColor?: string;
    dataPointStrokeWidth?: number;
    dataPointValueFormat?: (value: number) => string;
    style?: React.CSSProperties;
    valueMetric?: string;
  } & MapViewportProps;

const defaultHeatMapColorRamp = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
] as const satisfies readonly HeatMapColorStop[];

export function HeatMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay = "flat",
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  globeBasemapMode,
  initialViewState,
  mapLabel = "Interactive heat map",
  mapStyle = defaultRasterMapStyle,
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
  points,
  geoJson,
  geoJsonOptions,
  geoJsonOverlay,
  geoJsonOverlayCollection,
  geoJsonOverlayProps,
  showAttributionControl = true,
  style,
  viewState,
  defaultViewState,
  onViewStateChange,
  ...props
}: HeatMapProps<TProperties>) {
  const resolvedPoints = points ?? (geoJson ? createMapPointsFromGeoJson(geoJson, geoJsonOptions) : []);
  const resolvedGeoJsonOverlayCollection =
    geoJsonOverlayCollection ??
    (geoJson
      ? createGeoJsonOverlayFeatureCollection(geoJson, {
          mode: geoJsonOverlay,
          target: "point",
        })
      : null);

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
      onMapControllerReady={onMapControllerReady}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      showAttributionControl={showAttributionControl}
      style={style}
      viewState={viewState}
    >
      {resolvedGeoJsonOverlayCollection && resolvedGeoJsonOverlayCollection.features.length > 0 ? (
        <GeoJsonLayer
          {...(geoJsonOverlayProps as Omit<GeoJsonLayerProps, "featureCollection"> | undefined)}
          featureCollection={resolvedGeoJsonOverlayCollection}
        />
      ) : null}
      <HeatLayer {...(props as React.ComponentProps<typeof HeatLayer<TProperties>>)} points={resolvedPoints} />
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
    </MapView>
  );
}

export type HeatFieldMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = Omit<
  HeatMapProps<TProperties>,
  "heatmapSurfaceMode"
>;

export function HeatFieldMap<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  props: HeatFieldMapProps<TProperties>,
) {
  return <HeatMap {...props} heatmapSurfaceMode="field" />;
}

function isHeatFieldRasterVisible(renderMode: HeatFieldRenderMode) {
  return renderMode === "raster" || renderMode === "raster-contours";
}

function isHeatFieldContoursVisible(renderMode: HeatFieldRenderMode) {
  return renderMode === "contours" || renderMode === "raster-contours";
}

export function FlatHeatMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  className,
  domainBounds,
  domainPaddingRatio,
  fieldCellSizeMeters,
  fieldContourColor,
  fieldContourLevels,
  fieldContourLineWidth,
  fieldContourOpacity,
  fieldContourValueFormat,
  fieldColorRamp,
  fieldColumns,
  fieldOpacity,
  fieldRenderMode = "raster",
  fieldRows,
  fieldValueDomain,
  filterPoint,
  fitBoundsPadding = 56,
  fitToData = true,
  heatmapAggregationMaxZoom,
  heatmapAggregationMinZoom,
  heatmapAggregationRadius = 56,
  getValue,
  getWeight,
  heatmapColorRamp = defaultHeatMapColorRamp,
  heatmapIntensity = 1,
  heatmapMaxZoom = 16,
  heatmapOpacity = 0.84,
  heatmapRadius = {
    meters: DEFAULT_HEAT_MAP_RADIUS_METERS,
  },
  heatmapSurfaceMode = "interpolated",
  initialViewState,
  interpolationEpsilonMeters,
  interpolationExtrapolate,
  interpolationK,
  interpolationMaxDistanceMeters,
  interpolationPower,
  mapDisplay: _mapDisplay,
  mapLabel = "Interactive heat map",
  mapStyle = defaultRasterMapStyle,
  maskGeoJson,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  maxWeight,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  points = [],
  showDataPoints = false,
  dataPointColor = "#0f172a",
  dataPointOpacity = 0.94,
  dataPointRadius = 4,
  dataPointStrokeColor = "#ffffff",
  dataPointStrokeWidth = 1.5,
  dataPointValueFormat,
  showAttributionControl = true,
  style,
  valueMetric,
  weightMetric,
}: HeatMapProps<TProperties>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const heatLayerRef = useRef<LayerGroup | null>(null);
  const measurementLayerRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [isReady, setIsReady] = useState(false);
  const deferredPoints = useDeferredValue(points);
  const densityIndex = useMemo(
    () =>
      createHeatMapDensityIndex(deferredPoints, {
        filterPoint,
        getWeight,
        maxZoom: heatmapAggregationMaxZoom ?? heatmapMaxZoom,
        maxWeight,
        minZoom: heatmapAggregationMinZoom,
        radius: heatmapAggregationRadius,
        weightMetric,
      }),
    [
      deferredPoints,
      filterPoint,
      getWeight,
      heatmapAggregationMaxZoom,
      heatmapAggregationMinZoom,
      heatmapAggregationRadius,
      heatmapMaxZoom,
      maxWeight,
      weightMetric,
    ],
  );
  const dataPointCollection = useMemo(
    () =>
      createHeatMapFeatureCollection(deferredPoints, {
        filterPoint,
        getWeight,
        maxWeight,
        weightMetric,
      }),
    [deferredPoints, filterPoint, getWeight, maxWeight, weightMetric],
  );
  const fieldDataPointCollection = useMemo(
    () =>
      heatmapSurfaceMode === "field"
        ? createHeatMapValueFeatureCollection(deferredPoints, {
            filterPoint,
            getValue: getValue ?? getWeight,
            valueDomain: fieldValueDomain,
            valueMetric: valueMetric ?? weightMetric,
          })
        : null,
    [
      deferredPoints,
      fieldValueDomain,
      filterPoint,
      getValue,
      getWeight,
      heatmapSurfaceMode,
      valueMetric,
      weightMetric,
    ],
  );
  const fieldGrid = useMemo(
    () =>
      heatmapSurfaceMode === "field"
        ? createScalarFieldGrid(deferredPoints, {
            domainBounds,
            domainPaddingRatio,
            fieldCellSizeMeters,
            fieldColumns,
            fieldRows,
            filterPoint,
            getValue: getValue ?? getWeight,
            interpolationEpsilonMeters,
            interpolationExtrapolate,
            interpolationK,
            interpolationMaxDistanceMeters,
            interpolationPower,
            maskGeoJson,
            valueDomain: fieldValueDomain,
            valueMetric: valueMetric ?? weightMetric,
          })
        : null,
    [
      deferredPoints,
      domainBounds,
      domainPaddingRatio,
      fieldCellSizeMeters,
      fieldColumns,
      fieldRows,
      fieldValueDomain,
      filterPoint,
      getValue,
      getWeight,
      heatmapSurfaceMode,
      interpolationEpsilonMeters,
      interpolationExtrapolate,
      interpolationK,
      interpolationMaxDistanceMeters,
      interpolationPower,
      maskGeoJson,
      valueMetric,
      weightMetric,
    ],
  );
  const fieldImage = useMemo(
    () =>
      fieldGrid && isHeatFieldRasterVisible(fieldRenderMode)
        ? createHeatFieldImage(fieldGrid, {
              colorRamp: fieldColorRamp,
              opacity: fieldOpacity ?? heatmapOpacity,
              valueDomain: fieldValueDomain,
            })
        : null,
    [
      fieldColorRamp,
      fieldGrid,
      fieldOpacity,
      fieldRenderMode,
      fieldValueDomain,
      heatmapOpacity,
    ],
  );
  const fieldContourCollection = useMemo(
    () =>
      fieldGrid && isHeatFieldContoursVisible(fieldRenderMode)
        ? createHeatFieldContourFeatureCollection(fieldGrid, {
            levels: fieldContourLevels,
            valueDomain: fieldValueDomain,
            valueFormat: fieldContourValueFormat,
          })
        : null,
    [
      fieldContourLevels,
      fieldContourValueFormat,
      fieldGrid,
      fieldRenderMode,
      fieldValueDomain,
    ],
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
    const heatLayer = heatLayerRef.current;
    const leaflet = leafletRef.current;

    if (!map || !heatLayer || !leaflet) {
      return;
    }

    if (heatmapSurfaceMode === "field") {
      heatLayer.clearLayers();

      if (map.getZoom() > heatmapMaxZoom) {
        return;
      }

      if (isHeatFieldRasterVisible(fieldRenderMode)) {
        renderHeatMapFieldOverlay({
          clearLayer: false,
          image: fieldImage,
          layer: heatLayer,
          leaflet,
          map,
          maxZoom: heatmapMaxZoom,
          opacity: fieldOpacity ?? heatmapOpacity,
        });
      }

      if (isHeatFieldContoursVisible(fieldRenderMode)) {
        renderHeatMapFieldContours({
          clearLayer: false,
          collection: fieldContourCollection,
          isMeasuring,
          layer: heatLayer,
          leaflet,
          map,
          maxZoom: heatmapMaxZoom,
          lineColor: fieldContourColor,
          lineOpacity: fieldContourOpacity ?? fieldOpacity ?? heatmapOpacity,
          lineWidth: fieldContourLineWidth,
        });
      }

      if (showDataPoints && map.getZoom() <= heatmapMaxZoom) {
        renderHeatMapDataPoints({
          color: dataPointColor,
          data: getHeatMapFeatureCollectionInBounds(
            fieldDataPointCollection ?? dataPointCollection,
            getHeatMapViewportQuery(map).bounds,
          ),
          formatValue: dataPointValueFormat,
          isMeasuring,
          layer: heatLayer,
          leaflet,
          opacity: dataPointOpacity,
          radius: dataPointRadius,
          strokeColor: dataPointStrokeColor,
          strokeWidth: dataPointStrokeWidth,
        });
      }

      return;
    }

    const query = getHeatMapViewportQuery(map);

    renderHeatOverlay({
      colorRamp: heatmapColorRamp,
      data: densityIndex.getFeatureCollection(query),
      intensity: heatmapIntensity,
      isMeasuring,
      layer: heatLayer,
      leaflet,
      map,
      maxZoom: heatmapMaxZoom,
      opacity: heatmapOpacity,
      radius: heatmapRadius,
    });

    if (showDataPoints && map.getZoom() <= heatmapMaxZoom) {
      renderHeatMapDataPoints({
        color: dataPointColor,
        data: getHeatMapFeatureCollectionInBounds(dataPointCollection, query.bounds),
        formatValue: dataPointValueFormat,
        isMeasuring,
        layer: heatLayer,
        leaflet,
        opacity: dataPointOpacity,
        radius: dataPointRadius,
        strokeColor: dataPointStrokeColor,
        strokeWidth: dataPointStrokeWidth,
      });
    }
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

      heatLayerRef.current = leaflet.layerGroup().addTo(localMap);
      measurementLayerRef.current = leaflet.layerGroup().addTo(localMap);
      localMap.on("moveend", syncSource);

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
        localMap.off("moveend", syncSource);
        localMap.remove();
      }

      heatLayerRef.current = null;
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
      const dataBounds = getBoundsFromPoints(deferredPoints);

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
  }, [
    dataPointCollection,
    dataPointColor,
    dataPointOpacity,
    dataPointRadius,
    dataPointStrokeColor,
    dataPointStrokeWidth,
    dataPointValueFormat,
    deferredPoints,
    densityIndex,
    fieldContourCollection,
    fieldContourColor,
    fieldContourLineWidth,
    fieldContourOpacity,
    fieldDataPointCollection,
    fieldImage,
    fieldOpacity,
    fieldRenderMode,
    fitBoundsPadding,
    fitToData,
    heatmapOpacity,
    heatmapSurfaceMode,
    initialViewState,
    isMeasuring,
    showDataPoints,
    syncSource,
  ]);

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

export type FlatHeatFieldMapProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = Omit<HeatMapProps<TProperties>, "heatmapSurfaceMode" | "mapDisplay">;

export function FlatHeatFieldMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(props: FlatHeatFieldMapProps<TProperties>) {
  return <FlatHeatMap {...props} heatmapSurfaceMode="field" />;
}

export function GlobeHeatMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  className,
  dataPointColor = "#0f172a",
  dataPointOpacity = 0.94,
  dataPointRadius = 4,
  dataPointStrokeColor = "#ffffff",
  dataPointStrokeWidth = 1.5,
  dataPointValueFormat,
  filterPoint,
  fitToData = true,
  getWeight,
  heatmapAggregationMaxZoom,
  heatmapAggregationMinZoom,
  heatmapAggregationRadius = 56,
  heatmapColorRamp = defaultHeatMapColorRamp,
  heatmapIntensity = 1,
  heatmapMaxZoom = 16,
  heatmapOpacity = 0.84,
  heatmapRadius = {
    meters: DEFAULT_HEAT_MAP_RADIUS_METERS,
  },
  initialViewState,
  mapLabel = "Interactive heat map",
  measurementDistanceFormat: _measurementDistanceFormat,
  measurementDraftLineColor: _measurementDraftLineColor,
  measurementLineColor: _measurementLineColor,
  measurementMode: _measurementMode,
  measurements: _measurements,
  maxWeight,
  onMeasurementCreate: _onMeasurementCreate,
  onMeasurementDraftChange: _onMeasurementDraftChange,
  onMeasurementSelect: _onMeasurementSelect,
  points = [],
  showDataPoints = false,
  style,
  weightMetric,
}: HeatMapProps<TProperties>) {
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
  const densityIndex = useMemo(
    () =>
      createHeatMapDensityIndex(deferredPoints, {
        filterPoint,
        getWeight,
        maxZoom: heatmapAggregationMaxZoom ?? heatmapMaxZoom,
        maxWeight,
        minZoom: heatmapAggregationMinZoom,
        radius: heatmapAggregationRadius,
        weightMetric,
      }),
    [
      deferredPoints,
      filterPoint,
      getWeight,
      heatmapAggregationMaxZoom,
      heatmapAggregationMinZoom,
      heatmapAggregationRadius,
      heatmapMaxZoom,
      maxWeight,
      weightMetric,
    ],
  );
  const query = useMemo(() => createGlobalViewportQuery(viewState.zoom), [viewState.zoom]);
  const data = useMemo(() => densityIndex.getFeatureCollection(query), [densityIndex, query]);
  const dataPointCollection = useMemo(
    () =>
      createHeatMapFeatureCollection(deferredPoints, {
        filterPoint,
        getWeight,
        maxWeight,
        weightMetric,
      }),
    [deferredPoints, filterPoint, getWeight, maxWeight, weightMetric],
  );

  useEffect(() => {
    if (initialViewState || !fitToData) {
      return;
    }

    setViewState(createInitialGlobeViewState({ fitToData, initialViewState, points: deferredPoints }));
  }, [deferredPoints, fitToData, initialViewState]);

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
        <HeatGlobeBase viewState={viewState} />
        <g className="mb-maps__globe-features">
          {viewState.zoom <= heatmapMaxZoom
            ? data.features.map((feature) => (
                <GlobeHeatFeature
                  colorRamp={heatmapColorRamp}
                  feature={feature}
                  intensity={heatmapIntensity}
                  key={feature.properties.pointId}
                  opacity={heatmapOpacity}
                  radius={heatmapRadius}
                  viewState={viewState}
                />
              ))
            : null}
          {showDataPoints && viewState.zoom <= heatmapMaxZoom
            ? dataPointCollection.features.map((feature) => (
                <GlobeHeatDataPoint
                  color={dataPointColor}
                  feature={feature}
                  key={`data-point-${feature.properties.pointId}`}
                  opacity={dataPointOpacity}
                  radius={dataPointRadius}
                  strokeColor={dataPointStrokeColor}
                  strokeWidth={dataPointStrokeWidth}
                  valueFormat={dataPointValueFormat}
                  viewState={viewState}
                />
              ))
            : null}
        </g>
      </svg>
    </div>
  );
}

function HeatGlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
      <defs>
        <radialGradient id="mb-maps-globe-ocean" cx="38%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#e0f2fe" />
          <stop offset="62%" stopColor="#a7f3d0" />
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

function GlobeHeatFeature({
  colorRamp,
  feature,
  intensity,
  opacity,
  radius,
  viewState,
}: {
  colorRamp: readonly HeatMapColorStop[];
  feature: HeatMapFeature;
  intensity: number;
  opacity: number;
  radius: HeatMapRadius;
  viewState: GlobeViewState;
}) {
  const projected = projectGlobeCoordinate(feature.geometry.coordinates, viewState);

  if (!projected.visible) {
    return null;
  }

  const normalizedWeight = clamp(feature.properties.weight, 0, 1);
  const markerRadius =
    resolveHeatMapGlobeRadius(radius, feature.geometry.coordinates, viewState) *
    Math.max(0.35, Math.sqrt(normalizedWeight)) *
    Math.max(0, intensity) *
    (0.62 + projected.scale * 0.38);
  const safeOpacity = clamp(opacity, 0, 1);

  return (
    <circle
      className="mb-maps__globe-heat-marker"
      cx={projected.x}
      cy={projected.y}
      fill={resolveHeatMapColor(colorRamp, normalizedWeight)}
      fillOpacity={safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65)}
      r={markerRadius}
      style={{ opacity: 0.34 + projected.scale * 0.66 }}
    >
      <title>{feature.properties.label}</title>
    </circle>
  );
}

function GlobeHeatDataPoint({
  color,
  feature,
  opacity,
  radius,
  strokeColor,
  strokeWidth,
  valueFormat,
  viewState,
}: {
  color: string;
  feature: HeatMapFeature;
  opacity: number;
  radius: number;
  strokeColor: string;
  strokeWidth: number;
  valueFormat?: (value: number) => string;
  viewState: GlobeViewState;
}) {
  const projected = projectGlobeCoordinate(feature.geometry.coordinates, viewState);

  if (!projected.visible) {
    return null;
  }

  return (
    <circle
      className="mb-maps__globe-heat-data-point"
      cx={projected.x}
      cy={projected.y}
      fill={color}
      fillOpacity={clamp(opacity, 0, 1)}
      r={Math.max(0, radius) * (0.72 + projected.scale * 0.28)}
      stroke={strokeColor}
      strokeWidth={Math.max(0, strokeWidth)}
    >
      <title>{formatHeatMapFeatureValue(feature, valueFormat)}</title>
    </circle>
  );
}

export function createHeatMapFeatureCollection<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: HeatMapWeightOptions<TProperties> = {},
): HeatMapFeatureCollection {
  const indexedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatMapPoint)
    .filter((point) => options.filterPoint?.(point) ?? true);
  const rawWeights = indexedPoints.map((point) => resolveHeatMapPointWeight(point, options));
  const effectiveMaxWeight = getEffectiveMaxWeight(rawWeights, options.maxWeight);
  const features = indexedPoints
    .map((point, index) => {
      const rawWeight = rawWeights[index] ?? 0;

      if (rawWeight <= 0) {
        return null;
      }

      return {
        geometry: {
          coordinates: [point.longitude, point.latitude] as [number, number],
          type: "Point" as const,
        },
        properties: {
          ...point.metrics,
          kind: "heat-point" as const,
          label: point.label,
          pointId: point.id,
          pointCount: 1,
          rawWeight,
          weight: clamp(rawWeight / effectiveMaxWeight, 0, 1),
        },
        type: "Feature" as const,
      };
    })
    .filter(isDefined);

  return {
    features,
    type: "FeatureCollection",
  };
}

export function createHeatMapDensityIndex<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: HeatMapDensityIndexOptions<TProperties> = {},
): HeatMapDensityIndex {
  const weightedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatMapPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      point,
      rawWeight: resolveHeatMapPointWeight(point, options),
    }))
    .filter((entry) => entry.rawWeight > 0);
  const effectiveMaxWeight = getEffectiveMaxWeight(
    weightedPoints.map((entry) => entry.rawWeight),
    options.maxWeight,
  );
  const index = createPointAggregationIndex(
    weightedPoints.map(({ point, rawWeight }) => ({
      id: point.id,
      label: point.label,
      latitude: point.latitude,
      longitude: point.longitude,
      metrics: {
        ...point.metrics,
        [HEAT_MAP_WEIGHT_METRIC]: rawWeight,
      },
      properties: point.properties,
    })),
    {
      maxZoom: options.maxZoom,
      minZoom: options.minZoom,
      radius: options.radius,
    },
  );

  return {
    getFeatureCollection(query) {
      return createHeatMapFeatureCollectionFromAggregates(
        index.getViewportAggregation(query).features,
        effectiveMaxWeight,
      );
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

export function getHeatMapMaxWeight<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight"> = {},
) {
  return Math.max(
    0,
    ...points
      .map(toIndexedMapPoint)
      .filter(isValidHeatMapPoint)
      .filter((point) => options.filterPoint?.(point) ?? true)
      .map((point) => resolveHeatMapPointWeight(point, options)),
  );
}

export function resolveHeatMapPointWeight<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  point: IndexedMapPoint<TProperties>,
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight"> = {},
) {
  const rawWeight = getRawHeatMapPointWeight(point, options);

  if (!Number.isFinite(rawWeight)) {
    return 0;
  }

  return Math.max(0, rawWeight);
}

function createHeatMapValueFeatureCollection<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    valueDomain?: HeatFieldOptions<TProperties>["valueDomain"];
    valueMetric?: string;
  },
): HeatMapFeatureCollection {
  const valuePoints = resolveScalarFieldValuePoints(points, options);
  const valueDomain = options.valueDomain ?? getHeatMapValueDomain(valuePoints.map((entry) => entry.value));

  return {
    features: valuePoints.map((entry) => {
      const normalizedValue = normalizeScalarFieldValue(entry.value, valueDomain) ?? 1;

      return {
        geometry: {
          coordinates: [entry.point.longitude, entry.point.latitude] as [number, number],
          type: "Point" as const,
        },
        properties: {
          ...entry.point.metrics,
          kind: "heat-point" as const,
          label: entry.point.label,
          pointCount: 1,
          pointId: entry.point.id,
          rawWeight: entry.value,
          weight: normalizedValue,
        },
        type: "Feature" as const,
      };
    }),
    type: "FeatureCollection",
  };
}

function getHeatMapValueDomain(values: readonly number[]): [min: number, max: number] | null {
  const finiteValues = values.filter((value) => Number.isFinite(value));

  if (finiteValues.length === 0) {
    return null;
  }

  return [Math.min(...finiteValues), Math.max(...finiteValues)];
}

function renderHeatMapFieldOverlay({
  clearLayer = true,
  image,
  layer,
  leaflet,
  map,
  maxZoom,
  opacity,
}: {
  clearLayer?: boolean;
  image: HeatFieldImage | null;
  layer: LayerGroup;
  leaflet: typeof import("leaflet");
  map: LeafletMap;
  maxZoom: number;
  opacity: number;
}) {
  if (clearLayer) {
    layer.clearLayers();
  }

  if (!image || map.getZoom() > maxZoom) {
    return;
  }

  const [west, south, east, north] = image.bounds;

  leaflet
    .imageOverlay(
      image.url,
      [
        [south, west],
        [north, east],
      ],
      {
        className: "mb-maps__heat-surface mb-maps__heat-surface--field",
        interactive: false,
        opacity: clamp(opacity, 0, 1),
      },
    )
    .addTo(layer);
}

function renderHeatMapFieldContours({
  clearLayer = true,
  collection,
  isMeasuring,
  layer,
  leaflet,
  lineColor,
  lineOpacity,
  lineWidth,
  map,
  maxZoom,
}: {
  clearLayer?: boolean;
  collection: HeatFieldContourFeatureCollection | null;
  isMeasuring: boolean;
  layer: LayerGroup;
  leaflet: typeof import("leaflet");
  lineColor?: string;
  lineOpacity: number;
  lineWidth?: number;
  map: LeafletMap;
  maxZoom: number;
}) {
  if (clearLayer) {
    layer.clearLayers();
  }

  if (!collection || map.getZoom() > maxZoom) {
    return;
  }

  const safeOpacity = clamp(lineOpacity, 0, 1);
  const safeLineWidth = Math.max(0.25, lineWidth ?? 1);

  for (const feature of collection.features) {
    const geometry = feature.geometry;

    if (geometry?.type !== "MultiLineString") {
      continue;
    }

    const lines = (geometry.coordinates as Array<Array<[number, number]>>).filter(
      (line) => line.length >= 2,
    );

    if (lines.length === 0) {
      continue;
    }

    const polyline = leaflet.polyline(
      lines.map((line) => line.map(toLeafletLatLng)),
      {
        bubblingMouseEvents: false,
        className: "mb-maps__heat-contour",
        color: lineColor ?? "#111827",
        interactive: !isMeasuring,
        opacity: safeOpacity,
        weight: safeLineWidth,
      },
    );

    bindHeatMapTooltip(polyline, feature.properties?.valueLabel ?? String(feature.properties?.value ?? ""));
    polyline.addTo(layer);
  }
}

function renderHeatOverlay({
  colorRamp,
  data,
  intensity,
  isMeasuring,
  layer,
  leaflet,
  map,
  maxZoom,
  opacity,
  radius,
}: {
  colorRamp: readonly HeatMapColorStop[];
  data: HeatMapFeatureCollection;
  intensity: number;
  isMeasuring: boolean;
  layer: LayerGroup;
  leaflet: typeof import("leaflet");
  map: LeafletMap;
  maxZoom: number;
  opacity: number;
  radius: HeatMapRadius;
}) {
  layer.clearLayers();

  if (map.getZoom() > maxZoom) {
    return;
  }

  const safeOpacity = clamp(opacity, 0, 1);

  for (const feature of data.features) {
    const [longitude, latitude] = feature.geometry.coordinates;
    const weight = clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY);
    const normalizedWeight = clamp(weight, 0, 1);
    const markerRadius =
      resolveHeatMapProjectedRadius(radius, feature.geometry.coordinates, map) *
      Math.max(0.35, Math.sqrt(normalizedWeight)) *
      Math.max(0, intensity);

    leaflet
      .circleMarker([latitude, longitude], {
        className: "mb-maps__heat-marker",
        color: "transparent",
        fillColor: resolveHeatMapColor(colorRamp, normalizedWeight),
        fillOpacity: safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65),
        interactive: !isMeasuring,
        opacity: 0,
        radius: markerRadius,
        weight: 0,
      })
      .addTo(layer);
  }
}

function renderHeatMapDataPoints({
  color,
  data,
  formatValue,
  isMeasuring,
  layer,
  leaflet,
  opacity,
  radius,
  strokeColor,
  strokeWidth,
}: {
  color: string;
  data: HeatMapFeatureCollection;
  formatValue?: (value: number) => string;
  isMeasuring: boolean;
  layer: LayerGroup;
  leaflet: typeof import("leaflet");
  opacity: number;
  radius: number;
  strokeColor: string;
  strokeWidth: number;
}) {
  for (const feature of data.features) {
    const [longitude, latitude] = feature.geometry.coordinates;
    const marker = leaflet.circleMarker([latitude, longitude], {
      bubblingMouseEvents: false,
      className: "mb-maps__heat-data-point",
      color: strokeColor,
      fillColor: color,
      fillOpacity: clamp(opacity, 0, 1),
      interactive: !isMeasuring,
      opacity: clamp(opacity, 0, 1),
      radius: Math.max(0, radius),
      weight: Math.max(0, strokeWidth),
    });

    bindHeatMapTooltip(marker, formatHeatMapFeatureValue(feature, formatValue));
    marker.addTo(layer);
  }
}

function bindHeatMapTooltip(layer: unknown, content: string) {
  const target = layer as {
    bindTooltip?: (content: string, options?: Record<string, unknown>) => unknown;
  };

  if (!content || typeof target.bindTooltip !== "function") {
    return;
  }

  target.bindTooltip(content, {
    className: "mb-maps__heat-tooltip",
    direction: "top",
    sticky: true,
  });
}

function formatHeatMapFeatureValue(
  feature: HeatMapFeature,
  formatValue: ((value: number) => string) | undefined,
) {
  const value = feature.properties.rawWeight;
  const valueLabel = formatValue?.(value) ?? formatHeatMapValue(value);

  return feature.properties.label ? `${feature.properties.label}: ${valueLabel}` : valueLabel;
}

function formatHeatMapValue(value: number) {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 100) {
    return value.toFixed(0);
  }

  if (absoluteValue >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function createHeatMapFeatureCollectionFromAggregates<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  effectiveMaxWeight: number,
): HeatMapFeatureCollection {
  return {
    features: features
      .map((feature) => createHeatMapFeatureFromAggregate(feature, effectiveMaxWeight))
      .filter(isDefined),
    type: "FeatureCollection",
  };
}

function createHeatMapFeatureFromAggregate<TProperties>(
  feature: AggregatedMapFeature<TProperties>,
  effectiveMaxWeight: number,
): HeatMapFeature | null {
  const rawWeight = feature.metrics[HEAT_MAP_WEIGHT_METRIC] ?? 0;

  if (rawWeight <= 0) {
    return null;
  }

  return {
    geometry: {
      coordinates: feature.coordinates,
      type: "Point",
    },
    properties: {
      ...copyPublicHeatMapMetrics(feature.metrics),
      kind: feature.kind === "cluster" ? "heat-cluster" : "heat-point",
      label: feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.label,
      pointId: feature.kind === "cluster" ? `cluster-${feature.clusterId}` : feature.point.id,
      pointCount: feature.kind === "cluster" ? feature.pointCount : 1,
      rawWeight,
      weight: Math.max(0, rawWeight / effectiveMaxWeight),
    },
    type: "Feature",
  };
}

function copyPublicHeatMapMetrics(metrics: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(metrics).filter(([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC),
  );
}

function getRawHeatMapPointWeight<TProperties extends Record<string, unknown>>(
  point: IndexedMapPoint<TProperties>,
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight">,
) {
  if (options.getWeight) {
    return options.getWeight(point);
  }

  if (options.weightMetric) {
    return point.metrics[options.weightMetric] ?? 0;
  }

  return point.metrics.weight ?? 1;
}

function resolveHeatMapProjectedRadius(
  radius: HeatMapRadius,
  coordinate: [longitude: number, latitude: number],
  map: LeafletMap,
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      map.latLngToContainerPoint(toLeafletLatLng(nextCoordinate)),
    );
  }

  return resolveHeatMapDisplayRadius(radius, map.getZoom());
}

function resolveHeatMapGlobeRadius(
  radius: HeatMapRadius,
  coordinate: [longitude: number, latitude: number],
  viewState: GlobeViewState,
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      projectGlobeCoordinate(nextCoordinate, viewState),
    );
  }

  return resolveHeatMapDisplayRadius(radius, viewState.zoom);
}

function getProjectedMetersRadius(
  meters: number,
  [longitude, latitude]: [longitude: number, latitude: number],
  projectCoordinate: (coordinate: [longitude: number, latitude: number]) => { x: number; y: number },
) {
  if (!Number.isFinite(meters) || meters <= 0) {
    return 0;
  }

  const center = projectCoordinate([longitude, latitude]);
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeScale = Math.max(0.000001, Math.abs(Math.cos(latitudeRadians)));
  const longitudeOffset = meters / (METERS_PER_DEGREE_AT_EQUATOR * longitudeScale);
  const edge = projectCoordinate([longitude + longitudeOffset, latitude]);

  return Math.hypot(edge.x - center.x, edge.y - center.y);
}

function resolveHeatMapDisplayRadius(radius: Exclude<HeatMapRadius, { meters: number }>, zoom: number) {
  if (typeof radius === "number") {
    return Math.max(0, radius);
  }

  const minZoom = radius.minZoom ?? 0;
  const maxZoom = radius.maxZoom ?? 9;

  if (maxZoom <= minZoom) {
    return Math.max(0, radius.max);
  }

  const progress = clamp((zoom - minZoom) / (maxZoom - minZoom), 0, 1);

  return Math.max(0, radius.min + (radius.max - radius.min) * progress);
}

function getHeatMapViewportQuery(map: LeafletMap): ViewportAggregationQuery {
  const bounds = map.getBounds();

  return {
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    zoom: map.getZoom(),
  };
}

function getHeatMapFeatureCollectionInBounds(
  data: HeatMapFeatureCollection,
  [west, south, east, north]: ViewportAggregationQuery["bounds"],
): HeatMapFeatureCollection {
  return {
    features: data.features.filter((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;

      return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
    }),
    type: "FeatureCollection",
  };
}

function resolveHeatMapColor(colorRamp: readonly HeatMapColorStop[], weight: number) {
  if (colorRamp.length === 0) {
    return "#dc2626";
  }

  const sortedRamp = [...colorRamp].sort(([left], [right]) => left - right);
  const fallback = sortedRamp[sortedRamp.length - 1];

  for (const [density, color] of sortedRamp) {
    if (weight <= density) {
      return color;
    }
  }

  return fallback?.[1] ?? "#dc2626";
}

function getEffectiveMaxWeight(rawWeights: readonly number[], maxWeight: number | undefined) {
  if (Number.isFinite(maxWeight) && (maxWeight ?? 0) > 0) {
    return maxWeight!;
  }

  return Math.max(1, ...rawWeights);
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

function isValidHeatMapPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
