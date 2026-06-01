"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
} from "./aggregation";
import { toLatLng } from "./map-display";
import type { FlatLayer, FlatLayerFactory, FlatLayerGroup, FlatMapAdapter } from "./maplibre-compat";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import {
  createScalarFieldGrid,
  normalizeScalarFieldValue,
  resolveScalarFieldValuePoints,
  type HeatFieldMaskGeoJson,
  type HeatFieldOptions,
  type ScalarFieldGrid,
} from "./scalar-field";
import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
  type HeatFieldContourOptions,
  type HeatFieldContourFeatureCollection,
  type HeatFieldColorStop,
  type HeatFieldImage,
} from "./scalar-field-render";
import {
  createHeatLayerDataSurfaceDataUrl,
  createHeatLayerDataSurfaceImage,
  createHeatLayerInterpolatedSurfaceDataUrl,
  createHeatLayerInterpolatedSurfaceImage,
  prepareHeatLayerColorRamp,
  resolveHeatLayerColor,
  type HeatLayerMetricPoint,
  type HeatLayerSurfaceImage,
  type HeatLayerSurfaceSource,
  type PreparedHeatLayerColorRamp,
} from "./heat-surface";

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";
const DEFAULT_HEAT_LAYER_RADIUS_METERS = 50_000;
const DEFAULT_HEAT_LAYER_MAX_RASTER_PIXELS = 512_000;
const DEFAULT_HEAT_LAYER_MIN_ZOOM_DELTA_FOR_REBUILD = 1;
const DEFAULT_HEAT_LAYER_OVERSCAN_RATIO = 1;
const METERS_PER_DEGREE_AT_EQUATOR = 111_320;

export type HeatLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatFieldRenderMode = "raster" | "contours" | "raster-contours";

export type HeatLayerSurfaceMode = "data" | "interpolated" | "field";

export type HeatLayerRenderStrategy = "auto" | "stable-raster" | "viewport-raster";

export type HeatLayerRadius =
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

export type HeatLayerFeatureProperties = {
  kind: "heat-cluster" | "heat-point";
  label: string;
  pointId: string;
  pointCount: number;
  rawWeight: number;
  weight: number;
} & Record<string, number | string>;

export type HeatLayerFeature = {
  geometry: {
    coordinates: [longitude: number, latitude: number];
    type: "Point";
  };
  properties: HeatLayerFeatureProperties;
  type: "Feature";
};

export type HeatLayerFeatureCollection = {
  features: HeatLayerFeature[];
  type: "FeatureCollection";
};

export type HeatLayerProps<TProperties = Record<string, unknown>> =
  MapFeatureInteractionProps<HeatLayerFeature> & {
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
    fieldAsyncRender?: boolean;
    fieldRenderMode?: HeatFieldRenderMode;
    fieldRows?: HeatFieldOptions<TProperties>["fieldRows"];
    fieldValueDomain?: HeatFieldOptions<TProperties>["valueDomain"];
    filterPoint?: MapPointFilter<TProperties>;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    heatmapAggregationMaxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    heatmapAggregationMinZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    heatmapAggregationRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    heatmapColorRamp?: readonly HeatLayerColorStop[];
    heatmapIntensity?: number;
    heatmapAsyncRender?: boolean;
    heatmapMaxRasterPixels?: number;
    heatmapMaxZoom?: number;
    heatmapMinZoomDeltaForRebuild?: number;
    heatmapSurfaceMode?: HeatLayerSurfaceMode;
    heatmapOpacity?: number;
    heatmapOverscanRatio?: number;
    heatmapRadius?: HeatLayerRadius;
    heatmapRenderStrategy?: HeatLayerRenderStrategy;
    interpolationEpsilonMeters?: HeatFieldOptions<TProperties>["interpolationEpsilonMeters"];
    interpolationExtrapolate?: HeatFieldOptions<TProperties>["interpolationExtrapolate"];
    interpolationK?: HeatFieldOptions<TProperties>["interpolationK"];
    interpolationMaxDistanceMeters?: HeatFieldOptions<TProperties>["interpolationMaxDistanceMeters"];
    interpolationPower?: HeatFieldOptions<TProperties>["interpolationPower"];
    layerId?: string;
    maskGeoJson?: HeatFieldMaskGeoJson | null;
    maxWeight?: number;
    points: readonly MapPoint<TProperties>[];
    showDataPoints?: boolean;
    dataPointColor?: string;
    dataPointOpacity?: number;
    dataPointRadius?: number;
    dataPointStrokeColor?: string;
    dataPointStrokeWidth?: number;
    dataPointValueFormat?: (value: number) => string;
    valueMetric?: string;
    weightMetric?: string;
  };

const defaultHeatLayerColorRamp = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
] as const satisfies readonly HeatLayerColorStop[];

type HeatLayerManagedLayer = {
  remove?: () => unknown;
};

type HeatLayerImageOverlay = HeatLayerManagedLayer & {
  bounds?: [[number, number], [number, number]];
  options?: Record<string, unknown>;
  setBounds?: (bounds: [[number, number], [number, number]]) => unknown;
  setOpacity?: (opacity: number) => unknown;
  setUrl?: (url: string) => unknown;
  url?: string;
};

type HeatLayerFlatRenderState = {
  contourLayers: HeatLayerManagedLayer[];
  dataLayers: HeatLayerManagedLayer[];
  renderRequestId: number;
  surfaceCache: HeatLayerSurfaceCache | null;
  surfaceClassName: string | null;
  surfaceLayer: HeatLayerImageOverlay | null;
};

type HeatLayerSurfaceCache = {
  bounds: [west: number, south: number, east: number, north: number];
  coverageBounds: [west: number, south: number, east: number, north: number];
  dataSignature: string;
  key: string;
  objectUrl: boolean;
  rasterHeight: number;
  rasterWidth: number;
  strategy: Exclude<HeatLayerRenderStrategy, "auto">;
  url: string;
  zoomBucket: number;
};

type HeatLayerFieldArtifacts = {
  contourCollection: HeatFieldContourFeatureCollection | null;
  filterPoint: unknown;
  grid: ScalarFieldGrid;
  gridKey: string;
  getValue: unknown;
  getWeight: unknown;
  image: HeatFieldImage | null;
  points: readonly unknown[];
  renderKey: string;
};

export function HeatLayer<TProperties = Record<string, unknown>>({
  domainBounds,
  domainPaddingRatio,
  fieldCellSizeMeters,
  fieldContourColor,
  fieldContourLevels,
  fieldContourLineWidth,
  fieldContourOpacity,
  fieldContourValueFormat,
  fieldAsyncRender = false,
  fieldColorRamp,
  fieldColumns,
  fieldOpacity,
  fieldRenderMode = "raster",
  fieldRows,
  fieldValueDomain,
  filterPoint,
  getValue,
  getWeight,
  heatmapAggregationMaxZoom,
  heatmapAggregationMinZoom,
  heatmapAggregationRadius = 56,
  heatmapAsyncRender = canUseAsyncHeatLayerRender(),
  heatmapColorRamp = defaultHeatLayerColorRamp,
  heatmapIntensity = 1,
  heatmapMaxRasterPixels = DEFAULT_HEAT_LAYER_MAX_RASTER_PIXELS,
  heatmapMaxZoom = 16,
  heatmapMinZoomDeltaForRebuild = DEFAULT_HEAT_LAYER_MIN_ZOOM_DELTA_FOR_REBUILD,
  heatmapOpacity = 0.84,
  heatmapOverscanRatio = DEFAULT_HEAT_LAYER_OVERSCAN_RATIO,
  heatmapRadius = {
    meters: DEFAULT_HEAT_LAYER_RADIUS_METERS,
  },
  heatmapRenderStrategy = "auto",
  heatmapSurfaceMode = "interpolated",
  interpolationEpsilonMeters,
  interpolationExtrapolate,
  interpolationK,
  interpolationMaxDistanceMeters,
  interpolationPower,
  layerId,
  maskGeoJson,
  maxWeight,
  points,
  showDataPoints = false,
  dataPointColor = "#0f172a",
  dataPointOpacity = 0.94,
  dataPointRadius = 4,
  dataPointStrokeColor = "#ffffff",
  dataPointStrokeWidth = 1.5,
  dataPointValueFormat,
  valueMetric,
  weightMetric,
}: HeatLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `heat-layer-${generatedLayerId}`;
  const deferredPoints = useDeferredValue(points);
  const flatRenderStateRef = useRef<HeatLayerFlatRenderState>(createHeatLayerFlatRenderState());
  const preparedHeatmapColorRamp = useMemo(
    () => prepareHeatLayerColorRamp(heatmapColorRamp),
    [heatmapColorRamp],
  );
  const heatIndex = useMemo(
    () =>
      createHeatLayerSourceIndex(deferredPoints, {
        filterPoint,
        getWeight,
        maxWeight,
        weightMetric,
      }),
    [deferredPoints, filterPoint, getWeight, maxWeight, weightMetric],
  );
  const domainBoundsKey = createHeatLayerNumberArrayKey(domainBounds);
  const fieldValueDomainKey = createHeatLayerNumberArrayKey(fieldValueDomain);
  const fieldColorRampKey = createHeatLayerColorRampKey(fieldColorRamp);
  const fieldContourLevelsKey = createHeatLayerContourLevelsKey(fieldContourLevels);
  const fieldGridInputKey = [
    domainBoundsKey,
    domainPaddingRatio ?? "",
    fieldCellSizeMeters ?? "",
    fieldColumns ?? "",
    fieldRows ?? "",
    interpolationEpsilonMeters ?? "",
    interpolationExtrapolate ?? "",
    interpolationK ?? "",
    interpolationMaxDistanceMeters ?? "",
    interpolationPower ?? "",
    maskGeoJson ? "mask" : "",
    valueMetric ?? weightMetric ?? "",
  ].join("|");
  const fieldRenderInputKey = [
    fieldColorRampKey,
    fieldContourLevelsKey,
    fieldContourValueFormat ? "format" : "",
    fieldOpacity ?? heatmapOpacity,
    fieldRenderMode,
    fieldValueDomainKey,
  ].join("|");
  const shouldRenderFieldAsync = fieldAsyncRender && typeof setTimeout !== "undefined";
  const syncFieldGrid = useMemo(
    () =>
      heatmapSurfaceMode === "field" && !shouldRenderFieldAsync
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
            valueMetric: valueMetric ?? weightMetric,
          })
        : null,
    [
      deferredPoints,
      domainBoundsKey,
      domainPaddingRatio,
      fieldCellSizeMeters,
      fieldColumns,
      fieldRows,
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
      shouldRenderFieldAsync,
      valueMetric,
      weightMetric,
    ],
  );
  const syncFieldImage = useMemo(
    () =>
      syncFieldGrid && isHeatFieldRasterVisible(fieldRenderMode)
        ? createHeatFieldImage(syncFieldGrid, {
            colorRamp: fieldColorRamp,
            opacity: fieldOpacity ?? heatmapOpacity,
            valueDomain: fieldValueDomain,
          })
        : null,
    [
      fieldColorRampKey,
      fieldOpacity,
      fieldRenderMode,
      fieldValueDomainKey,
      heatmapOpacity,
      syncFieldGrid,
    ],
  );
  const syncFieldContourCollection = useMemo(
    () =>
      syncFieldGrid && isHeatFieldContoursVisible(fieldRenderMode)
        ? createHeatFieldContourFeatureCollection(syncFieldGrid, {
            levels: fieldContourLevels,
            valueDomain: fieldValueDomain,
            valueFormat: fieldContourValueFormat,
          })
        : null,
    [
      fieldContourLevelsKey,
      fieldContourValueFormat,
      fieldRenderMode,
      fieldValueDomainKey,
      syncFieldGrid,
    ],
  );
  const [asyncFieldArtifacts, setAsyncFieldArtifacts] = useState<HeatLayerFieldArtifacts | null>(
    null,
  );
  const asyncFieldArtifactsRef = useRef<HeatLayerFieldArtifacts | null>(null);
  const asyncFieldRequestIdRef = useRef(0);
  const fieldImage = shouldRenderFieldAsync ? asyncFieldArtifacts?.image ?? null : syncFieldImage;
  const fieldContourCollection = shouldRenderFieldAsync
    ? asyncFieldArtifacts?.contourCollection ?? null
    : syncFieldContourCollection;

  useEffect(() => {
    asyncFieldArtifactsRef.current = asyncFieldArtifacts;
  }, [asyncFieldArtifacts]);

  useEffect(() => {
    if (!shouldRenderFieldAsync || heatmapSurfaceMode !== "field") {
      return;
    }

    const requestId = (asyncFieldRequestIdRef.current += 1);
    const timeout = setTimeout(() => {
      const previousArtifacts = asyncFieldArtifactsRef.current;
      const grid =
        previousArtifacts?.gridKey === fieldGridInputKey &&
        previousArtifacts.points === deferredPoints &&
        previousArtifacts.filterPoint === filterPoint &&
        previousArtifacts.getValue === getValue &&
        previousArtifacts.getWeight === getWeight
          ? previousArtifacts.grid
          : createScalarFieldGrid(deferredPoints, {
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
              valueMetric: valueMetric ?? weightMetric,
            });
      const image =
        grid && isHeatFieldRasterVisible(fieldRenderMode)
          ? createHeatFieldImage(grid, {
              colorRamp: fieldColorRamp,
              opacity: fieldOpacity ?? heatmapOpacity,
              valueDomain: fieldValueDomain,
            })
          : null;
      const contourCollection =
        grid && isHeatFieldContoursVisible(fieldRenderMode)
          ? createHeatFieldContourFeatureCollection(grid, {
              levels: fieldContourLevels,
              valueDomain: fieldValueDomain,
              valueFormat: fieldContourValueFormat,
            })
          : null;

      if (asyncFieldRequestIdRef.current !== requestId) {
        return;
      }

      setAsyncFieldArtifacts({
        contourCollection,
        filterPoint,
        grid,
        gridKey: fieldGridInputKey,
        getValue,
        getWeight,
        image,
        points: deferredPoints,
        renderKey: fieldRenderInputKey,
      });
    }, 0);

    return () => {
      clearTimeout(timeout);
    };
  }, [
    deferredPoints,
    domainBoundsKey,
    domainPaddingRatio,
    fieldCellSizeMeters,
    fieldColorRampKey,
    fieldColumns,
    fieldContourLevelsKey,
    fieldContourValueFormat,
    fieldGridInputKey,
    fieldOpacity,
    fieldRenderInputKey,
    fieldRenderMode,
    fieldRows,
    fieldValueDomainKey,
    filterPoint,
    getValue,
    getWeight,
    heatmapOpacity,
    heatmapSurfaceMode,
    interpolationEpsilonMeters,
    interpolationExtrapolate,
    interpolationK,
    interpolationMaxDistanceMeters,
    interpolationPower,
    maskGeoJson,
    shouldRenderFieldAsync,
    valueMetric,
    weightMetric,
  ]);
  const fieldDataPointCollection = useMemo(
    () =>
      heatmapSurfaceMode === "field" && showDataPoints
        ? createHeatLayerValueFeatureCollection(deferredPoints, {
            filterPoint,
            getValue: getValue ?? getWeight,
            valueDomain: fieldValueDomain,
            valueMetric: valueMetric ?? weightMetric,
          })
        : null,
    [
      deferredPoints,
      fieldValueDomainKey,
      filterPoint,
      getValue,
      getWeight,
      heatmapSurfaceMode,
      showDataPoints,
      valueMetric,
      weightMetric,
    ],
  );
  const renderVersion =
    heatmapAggregationMaxZoom ?? heatmapAggregationMinZoom ?? heatmapAggregationRadius ?? null;
  const surfaceDisplay = surface?.display;
  const registerFlatLayer = surface?.registerFlatLayer;

  useEffect(() => {
    if (!registerFlatLayer || surfaceDisplay !== "flat") {
      return;
    }

    const flatRenderState = flatRenderStateRef.current;
    const unregister = registerFlatLayer(resolvedLayerId, ({ isMeasuring, layer, flat, map }) => {
      clearHeatLayerManagedLayers(layer, flatRenderState.dataLayers);
      clearHeatLayerManagedLayers(layer, flatRenderState.contourLayers);
      clearHeatLayerNonSurfaceLayers(layer, flatRenderState);

      if (map.getZoom() > heatmapMaxZoom) {
        removeHeatLayerSurfaceLayer(layer, flatRenderState);
        return;
      }

      if (heatmapSurfaceMode === "field") {
        if (isHeatFieldRasterVisible(fieldRenderMode)) {
          renderHeatLayerFieldSurface({
            image: fieldImage,
            layer,
            flat,
            opacity: fieldOpacity ?? heatmapOpacity,
            state: flatRenderState,
          });
        } else {
          removeHeatLayerSurfaceLayer(layer, flatRenderState);
        }

        if (isHeatFieldContoursVisible(fieldRenderMode)) {
          renderHeatLayerContourSurface({
            collection: fieldContourCollection,
            isMeasuring,
            layer,
            flat,
            lineColor: fieldContourColor,
            lineOpacity: fieldContourOpacity ?? fieldOpacity ?? heatmapOpacity,
            lineWidth: fieldContourLineWidth,
            state: flatRenderState,
          });
        }

        if (showDataPoints) {
          renderHeatLayerDataPoints({
            color: dataPointColor,
            data: getHeatLayerFeatureCollectionInBounds(
              fieldDataPointCollection ?? heatIndex.getFeatureCollection(getHeatLayerViewportBounds(map)),
              getHeatLayerViewportBounds(map),
            ),
            formatValue: dataPointValueFormat,
            isMeasuring,
            layer,
            flat,
            opacity: dataPointOpacity,
            radius: dataPointRadius,
            state: flatRenderState,
            strokeColor: dataPointStrokeColor,
            strokeWidth: dataPointStrokeWidth,
          });
        }

        return;
      }

      const data = heatIndex.getFeatureCollection(
        getHeatLayerSurfaceQueryBounds({
          intensity: heatmapIntensity,
          map,
          maxRasterPixels: heatmapMaxRasterPixels,
          minZoomDeltaForRebuild: heatmapMinZoomDeltaForRebuild,
          overscanRatio: heatmapOverscanRatio,
          radius: heatmapRadius,
          state: flatRenderState,
          strategy: heatmapRenderStrategy,
        }),
      );

      renderHeatLayerSurface({
        asyncRender: heatmapAsyncRender,
        colorRamp: preparedHeatmapColorRamp,
        data,
        intensity: heatmapIntensity,
        layer,
        flat,
        map,
        maxRasterPixels: heatmapMaxRasterPixels,
        minZoomDeltaForRebuild: heatmapMinZoomDeltaForRebuild,
        mode: heatmapSurfaceMode,
        opacity: heatmapOpacity,
        overscanRatio: heatmapOverscanRatio,
        radius: heatmapRadius,
        state: flatRenderState,
        strategy: heatmapRenderStrategy,
      });

      if (showDataPoints) {
        renderHeatLayerDataPoints({
          color: dataPointColor,
          data: heatIndex.getFeatureCollection(getHeatLayerViewportBounds(map)),
          formatValue: dataPointValueFormat,
          isMeasuring,
          layer,
          flat,
          opacity: dataPointOpacity,
          radius: dataPointRadius,
          state: flatRenderState,
          strokeColor: dataPointStrokeColor,
          strokeWidth: dataPointStrokeWidth,
        });
      }
    }, { preserveOnRender: true });

    return () => {
      resetHeatLayerFlatRenderState(flatRenderState);
      unregister();
    };
  }, [
    dataPointColor,
    dataPointOpacity,
    dataPointRadius,
    dataPointStrokeColor,
    dataPointStrokeWidth,
    dataPointValueFormat,
    fieldContourCollection,
    fieldContourColor,
    fieldContourLineWidth,
    fieldContourOpacity,
    fieldDataPointCollection,
    fieldImage,
    fieldOpacity,
    fieldRenderMode,
    heatmapAsyncRender,
    heatIndex,
    heatmapIntensity,
    heatmapMaxRasterPixels,
    heatmapMaxZoom,
    heatmapMinZoomDeltaForRebuild,
    heatmapOpacity,
    heatmapOverscanRatio,
    heatmapRadius,
    heatmapRenderStrategy,
    heatmapSurfaceMode,
    preparedHeatmapColorRamp,
    renderVersion,
    resolvedLayerId,
    showDataPoints,
    shouldRenderFieldAsync,
    registerFlatLayer,
    surfaceDisplay,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  const data = heatIndex.getFeatureCollection([-180, -90, 180, 90]);

  return (
    <>
      {surface.viewState.zoom <= heatmapMaxZoom
        ? data.features.map((feature) => {
            const projected = surface.projectGlobeCoordinate(
              feature.geometry.coordinates,
              surface.viewState,
            );

            if (!projected.visible) {
              return null;
            }

            const normalizedWeight = clamp(feature.properties.weight, 0, 1);
            const projectedRadius = resolveHeatLayerGlobeRadius(
              heatmapRadius,
              feature.geometry.coordinates,
              surface.viewState,
              surface.projectGlobeCoordinate,
            );
            const markerRadius =
              projectedRadius *
              Math.max(0.35, Math.sqrt(normalizedWeight)) *
              Math.max(0, heatmapIntensity) *
              (0.62 + projected.scale * 0.38);
            const safeOpacity = clamp(heatmapOpacity, 0, 1);

            return (
              <circle
                className="mb-maps__globe-heat-marker"
                cx={projected.x}
                cy={projected.y}
                fill={resolveHeatLayerColor(preparedHeatmapColorRamp, normalizedWeight)}
                fillOpacity={safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65)}
                key={feature.properties.pointId}
                r={markerRadius}
                style={{ opacity: 0.34 + projected.scale * 0.66 }}
              >
                <title>{formatHeatLayerFeatureValue(feature, dataPointValueFormat)}</title>
              </circle>
            );
          })
        : null}
      {showDataPoints && surface.viewState.zoom <= heatmapMaxZoom
        ? data.features.map((feature) => {
            const projected = surface.projectGlobeCoordinate(
              feature.geometry.coordinates,
              surface.viewState,
            );

            if (!projected.visible) {
              return null;
            }

            return (
              <circle
                className="mb-maps__globe-heat-data-point"
                cx={projected.x}
                cy={projected.y}
                fill={dataPointColor}
                fillOpacity={clamp(dataPointOpacity, 0, 1)}
                key={`data-point-${feature.properties.pointId}`}
                r={Math.max(0, dataPointRadius) * (0.72 + projected.scale * 0.28)}
                stroke={dataPointStrokeColor}
                strokeWidth={Math.max(0, dataPointStrokeWidth)}
              >
                <title>{feature.properties.label}</title>
              </circle>
            );
          })
        : null}
    </>
  );
}

export type HeatFieldLayerProps<TProperties = Record<string, unknown>> = Omit<
  HeatLayerProps<TProperties>,
  "heatmapSurfaceMode"
>;

export function HeatFieldLayer<TProperties = Record<string, unknown>>(
  props: HeatFieldLayerProps<TProperties>,
) {
  return <HeatLayer {...props} heatmapSurfaceMode="field" />;
}

function isHeatFieldRasterVisible(renderMode: HeatFieldRenderMode) {
  return renderMode === "raster" || renderMode === "raster-contours";
}

function isHeatFieldContoursVisible(renderMode: HeatFieldRenderMode) {
  return renderMode === "contours" || renderMode === "raster-contours";
}

function createHeatLayerNumberArrayKey(values: readonly number[] | null | undefined) {
  return values?.map(createHeatLayerNumberKey).join(",") ?? "";
}

function createHeatLayerColorRampKey(colorRamp: readonly HeatFieldColorStop[] | null | undefined) {
  return (
    colorRamp
      ?.map(([value, color]) => `${createHeatLayerNumberKey(value)}:${color}`)
      .join("|") ?? ""
  );
}

function createHeatLayerContourLevelsKey(levels: HeatFieldContourOptions["levels"]) {
  if (Array.isArray(levels)) {
    return createHeatLayerNumberArrayKey(levels);
  }

  return levels ?? "";
}

function createHeatLayerNumberKey(value: number) {
  return Number.isFinite(value) ? String(value) : "NaN";
}

export function createHeatLayerDensityIndex<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    maxWeight?: number;
    maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    radius?: PointAggregationIndexOptions<TProperties>["radius"];
    weightMetric?: string;
  } = {},
) {
  const weightedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatLayerPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      point,
      rawWeight: resolveHeatLayerPointWeight(point, options),
    }))
    .filter((entry) => entry.rawWeight > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedPoints.map((entry) => entry.rawWeight));
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
  let cachedQueryKey: string | null = null;
  let cachedFeatureCollection: HeatLayerFeatureCollection | null = null;

  return {
    getFeatureCollection(query: ViewportAggregationQuery) {
      const queryKey = getHeatLayerViewportQueryCacheKey(query);

      if (cachedQueryKey === queryKey && cachedFeatureCollection) {
        return cachedFeatureCollection;
      }

      cachedQueryKey = queryKey;
      cachedFeatureCollection = createHeatLayerFeatureCollectionFromAggregates(
        index.getViewportAggregation(query).features,
        effectiveMaxWeight,
      );

      return cachedFeatureCollection;
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

function createHeatLayerSourceIndex<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    maxWeight?: number;
    weightMetric?: string;
  } = {},
) {
  const weightedPoints = points
    .map(toIndexedMapPoint)
    .filter(isValidHeatLayerPoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point) => ({
      point,
      rawWeight: resolveHeatLayerPointWeight(point, options),
    }))
    .filter((entry) => entry.rawWeight > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedPoints.map((entry) => entry.rawWeight));
  const features = weightedPoints.map(({ point, rawWeight }): HeatLayerFeature => {
    const properties: HeatLayerFeatureProperties = {
      ...Object.fromEntries(
        Object.entries(point.metrics).filter(([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC),
      ),
      kind: "heat-point",
      label: point.label,
      pointCount: 1,
      pointId: point.id,
      rawWeight,
      weight: Math.max(0, rawWeight / effectiveMaxWeight),
    };

    return {
      geometry: {
        coordinates: [point.longitude, point.latitude],
        type: "Point",
      },
      properties,
      type: "Feature",
    };
  });
  let cachedBoundsKey: string | null = null;
  let cachedFeatureCollection: HeatLayerFeatureCollection | null = null;

  return {
    getFeatureCollection(bounds: [west: number, south: number, east: number, north: number]) {
      const boundsKey = getHeatLayerBoundsCacheKey(bounds);

      if (cachedBoundsKey === boundsKey && cachedFeatureCollection) {
        return cachedFeatureCollection;
      }

      const [west, south, east, north] = bounds;

      cachedBoundsKey = boundsKey;
      cachedFeatureCollection = {
        features: features.filter((feature) => {
          const [longitude, latitude] = feature.geometry.coordinates;

          return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
        }),
        type: "FeatureCollection" as const,
      };

      return cachedFeatureCollection;
    },
    maxWeight: effectiveMaxWeight,
    pointCount: weightedPoints.length,
  };
}

function createHeatLayerValueFeatureCollection<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: {
    filterPoint?: MapPointFilter<TProperties>;
    getValue?: HeatFieldOptions<TProperties>["getValue"];
    valueDomain?: HeatFieldOptions<TProperties>["valueDomain"];
    valueMetric?: string;
  },
): HeatLayerFeatureCollection {
  const valuePoints = resolveScalarFieldValuePoints(points, options);
  const valueDomain = options.valueDomain ?? getHeatLayerValueDomain(valuePoints.map((entry) => entry.value));

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

function getHeatLayerValueDomain(values: readonly number[]): [min: number, max: number] | null {
  const finiteValues = values.filter((value) => Number.isFinite(value));

  if (finiteValues.length === 0) {
    return null;
  }

  return [Math.min(...finiteValues), Math.max(...finiteValues)];
}

function renderHeatLayerFieldSurface({
  image,
  layer,
  flat,
  opacity,
  state,
}: {
  image: HeatFieldImage | null;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  opacity: number;
  state: HeatLayerFlatRenderState;
}) {
  if (!image) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const [west, south, east, north] = image.bounds;

  renderOrUpdateHeatLayerImageOverlay({
    bounds: [
      [south, west],
      [north, east],
    ],
    className: "mb-maps__heat-surface mb-maps__heat-surface--field",
    layer,
    flat,
    opacity,
    state,
    url: image.url,
  });
}

function renderHeatLayerContourSurface({
  collection,
  isMeasuring,
  layer,
  flat,
  lineColor,
  lineOpacity,
  lineWidth,
  state,
}: {
  collection: HeatFieldContourFeatureCollection | null;
  isMeasuring: boolean;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  lineColor?: string;
  lineOpacity: number;
  lineWidth?: number;
  state: HeatLayerFlatRenderState;
}) {
  if (!collection) {
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

    const polyline = flat.polyline(
      lines.map((line) => line.map(toLatLng)),
      {
        bubblingMouseEvents: false,
        className: "mb-maps__heat-contour",
        color: lineColor ?? "#111827",
        interactive: !isMeasuring,
        opacity: safeOpacity,
        weight: safeLineWidth,
      },
    );

    bindHeatLayerTooltip(polyline, feature.properties?.valueLabel ?? String(feature.properties?.value ?? ""));
    polyline.addTo(layer);
    state.contourLayers.push(polyline);
  }
}

function renderHeatLayerDataPoints({
  color,
  data,
  formatValue,
  isMeasuring,
  layer,
  flat,
  opacity,
  radius,
  state,
  strokeColor,
  strokeWidth,
}: {
  color: string;
  data: HeatLayerFeatureCollection;
  formatValue?: (value: number) => string;
  isMeasuring: boolean;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  opacity: number;
  radius: number;
  state: HeatLayerFlatRenderState;
  strokeColor: string;
  strokeWidth: number;
}) {
  for (const feature of data.features) {
    const [longitude, latitude] = feature.geometry.coordinates;
    const marker = flat.circleMarker(toLatLng([longitude, latitude]), {
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

    bindHeatLayerTooltip(marker, formatHeatLayerFeatureValue(feature, formatValue));
    marker.addTo(layer);
    state.dataLayers.push(marker);
  }
}

function bindHeatLayerTooltip(layer: unknown, content: string) {
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

function formatHeatLayerFeatureValue(
  feature: HeatLayerFeature,
  formatValue: ((value: number) => string) | undefined,
) {
  const value = feature.properties.rawWeight;
  const valueLabel = formatValue?.(value) ?? formatHeatLayerValue(value);

  return feature.properties.label ? `${feature.properties.label}: ${valueLabel}` : valueLabel;
}

function formatHeatLayerValue(value: number) {
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

function renderHeatLayerSurface({
  asyncRender,
  colorRamp,
  data,
  intensity,
  layer,
  flat,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  mode,
  opacity,
  overscanRatio,
  radius,
  state,
  strategy,
}: {
  asyncRender: boolean;
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  intensity: number;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  mode: HeatLayerSurfaceMode;
  opacity: number;
  overscanRatio: number;
  radius: HeatLayerRadius;
  state: HeatLayerFlatRenderState;
  strategy: HeatLayerRenderStrategy;
}) {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const safeOpacity = clamp(opacity, 0, 1);
  const resolvedStrategy = resolveHeatLayerRenderStrategy(strategy, radius);
  const renderOptions =
    resolvedStrategy === "stable-raster" && isMeterHeatLayerRadius(radius)
      ? createStableHeatLayerSurfaceRenderOptions({
          colorRamp,
          data,
          height,
          intensity,
          map,
          maxRasterPixels,
          minZoomDeltaForRebuild,
          mode,
          overscanRatio,
          radius,
          state,
          width,
        })
      : createViewportHeatLayerSurfaceRenderOptions({
          colorRamp,
          data,
          height,
          intensity,
          map,
          mode,
          radius,
          width,
        });

  if (!renderOptions) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const cachedUrl = state.surfaceCache?.key === renderOptions.cacheKey ? state.surfaceCache.url : null;

  if (cachedUrl) {
    renderOrUpdateHeatLayerImageOverlay({
      bounds: heatLayerBoundsToLatLngBounds(renderOptions.overlayBounds),
      className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
      layer,
      flat,
      opacity: safeOpacity,
      state,
      url: cachedUrl,
    });
    return;
  }

  state.renderRequestId += 1;
  const requestId = state.renderRequestId;
  const cacheMetadata = {
    bounds: renderOptions.overlayBounds,
    coverageBounds: renderOptions.coverageBounds,
    dataSignature: renderOptions.dataSignature,
    key: renderOptions.cacheKey,
    rasterHeight: renderOptions.height,
    rasterWidth: renderOptions.width,
    strategy: resolvedStrategy,
    zoomBucket: renderOptions.zoomBucket,
  };

  if (asyncRender) {
    createHeatLayerSurfaceImage(renderOptions).then((image) => {
      if (state.renderRequestId !== requestId) {
        revokeHeatLayerSurfaceImage(image);
        return;
      }

      setHeatLayerSurfaceCache(state, {
        ...cacheMetadata,
        objectUrl: image.objectUrl,
        url: image.url,
      });

      renderOrUpdateHeatLayerImageOverlay({
        bounds: heatLayerBoundsToLatLngBounds(renderOptions.overlayBounds),
        className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
        layer,
        flat,
        opacity: safeOpacity,
        state,
        url: image.url,
      });
    });
    return;
  }

  const image = createHeatLayerSurfaceDataImage(renderOptions);

  setHeatLayerSurfaceCache(state, {
    ...cacheMetadata,
    objectUrl: image.objectUrl,
    url: image.url,
  });

  renderOrUpdateHeatLayerImageOverlay({
    bounds: heatLayerBoundsToLatLngBounds(renderOptions.overlayBounds),
    className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
    layer,
    flat,
    opacity: safeOpacity,
    state,
    url: image.url,
  });
}

type HeatLayerSurfaceRenderOptions = {
  cacheKey: string;
  colorRamp: PreparedHeatLayerColorRamp;
  coverageBounds: [west: number, south: number, east: number, north: number];
  dataSignature: string;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: {
    getMetricPoint: (x: number, y: number) => HeatLayerMetricPoint;
    getMetricX?: (x: number) => number;
    getMetricY?: (y: number) => number;
  };
  mode: Exclude<HeatLayerSurfaceMode, "field">;
  overlayBounds: [west: number, south: number, east: number, north: number];
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
  zoomBucket: number;
};

function createViewportHeatLayerSurfaceRenderOptions({
  colorRamp,
  data,
  height,
  intensity,
  map,
  mode,
  radius,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  height: number;
  intensity: number;
  map: FlatMapAdapter;
  mode: HeatLayerSurfaceMode;
  radius: HeatLayerRadius;
  width: number;
}): HeatLayerSurfaceRenderOptions | null {
  const sources = data.features
    .map((feature) => {
      const point = map.latLngToContainerPoint(toLatLng(feature.geometry.coordinates));
      const baseRadius =
        resolveHeatLayerProjectedRadius(radius, feature.geometry.coordinates, map) *
        Math.max(0, intensity);

      return {
        coordinate: feature.geometry.coordinates,
        dataInfluenceRadius: getHeatLayerDataInfluenceRadius(radius, intensity),
        influenceRadius: baseRadius * 2.6,
        metricPoint: coordinateToHeatLayerMetricPoint(feature.geometry.coordinates),
        point,
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));

  if (width <= 0 || height <= 0 || sources.length === 0 || maxInfluenceRadius <= 0) {
    return null;
  }

  const northWest = map.containerPointToLatLng([0, 0]);
  const southEast = map.containerPointToLatLng([width, height]);
  const overlayBounds = [
    Math.min(northWest.lng, southEast.lng),
    Math.min(northWest.lat, southEast.lat),
    Math.max(northWest.lng, southEast.lng),
    Math.max(northWest.lat, southEast.lat),
  ] as [number, number, number, number];
  const dataSignature = createHeatLayerSurfaceDataSignature(sources);
  const cacheKey = createHeatLayerSurfaceCacheKey({
    colorRamp,
    dataSignature,
    height,
    maxInfluenceRadius,
    mode,
    overlayBounds,
    strategy: "viewport-raster",
    width,
    zoomBucket: Number.NaN,
  });

  return {
    cacheKey,
    colorRamp,
    coverageBounds: overlayBounds,
    dataSignature,
    height,
    maxInfluenceRadius,
    metricProjection: {
      getMetricPoint(x, y) {
        const coordinate = map.containerPointToLatLng([x, y]);

        return coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]);
      },
      getMetricX(x) {
        const coordinate = map.containerPointToLatLng([x, height / 2]);

        return coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]).x;
      },
      getMetricY(y) {
        const coordinate = map.containerPointToLatLng([width / 2, y]);

        return coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]).y;
      },
    },
    mode: mode as Exclude<HeatLayerSurfaceMode, "field">,
    overlayBounds,
    sources,
    width,
    zoomBucket: Number.NaN,
  };
}

function createStableHeatLayerSurfaceRenderOptions({
  colorRamp,
  data,
  height,
  intensity,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  mode,
  overscanRatio,
  radius,
  state,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  height: number;
  intensity: number;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  mode: HeatLayerSurfaceMode;
  overscanRatio: number;
  radius: { meters: number };
  state: HeatLayerFlatRenderState;
  width: number;
}): HeatLayerSurfaceRenderOptions | null {
  const coverageBounds = getHeatLayerStableCoverageBounds(map, radius, intensity, overscanRatio);
  const zoomBucket = getHeatLayerZoomBucket(map.getZoom(), minZoomDeltaForRebuild);
  const dimensions = resolveStableHeatLayerRasterDimensions({
    bounds: coverageBounds,
    maxRasterPixels,
    viewportHeight: height,
    viewportWidth: width,
  });

  if (dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }

  if (
    state.surfaceCache &&
    state.surfaceCache.strategy === "stable-raster" &&
    state.surfaceCache.zoomBucket === zoomBucket &&
    heatLayerBoundsContain(state.surfaceCache.coverageBounds, getHeatLayerPaddedBounds(map, radius, intensity))
  ) {
    return {
      cacheKey: state.surfaceCache.key,
      colorRamp,
      coverageBounds: state.surfaceCache.coverageBounds,
      dataSignature: state.surfaceCache.dataSignature,
      height: state.surfaceCache.rasterHeight,
      maxInfluenceRadius: 1,
      metricProjection: createStableHeatLayerMetricProjection(state.surfaceCache.coverageBounds, {
        height: state.surfaceCache.rasterHeight,
        width: state.surfaceCache.rasterWidth,
      }),
      mode: mode as Exclude<HeatLayerSurfaceMode, "field">,
      overlayBounds: state.surfaceCache.bounds,
      sources: [],
      width: state.surfaceCache.rasterWidth,
      zoomBucket,
    };
  }

  const metricBounds = getHeatLayerMetricBounds(coverageBounds);
  const metersPerPixel = Math.max(
    (metricBounds.east - metricBounds.west) / Math.max(1, dimensions.width),
    (metricBounds.north - metricBounds.south) / Math.max(1, dimensions.height),
  );
  const dataInfluenceRadius = getHeatLayerDataInfluenceRadius(radius, intensity) ?? 0;
  const influenceRadius = dataInfluenceRadius / Math.max(1, metersPerPixel);
  const sources = data.features
    .map((feature) => {
      const metricPoint = coordinateToHeatLayerMetricPoint(feature.geometry.coordinates);

      return {
        coordinate: feature.geometry.coordinates,
        dataInfluenceRadius,
        influenceRadius,
        metricPoint,
        point: {
          x:
            ((metricPoint.x - metricBounds.west) /
              Math.max(Number.EPSILON, metricBounds.east - metricBounds.west)) *
            dimensions.width,
          y:
            ((metricBounds.north - metricPoint.y) /
              Math.max(Number.EPSILON, metricBounds.north - metricBounds.south)) *
            dimensions.height,
        },
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));

  if (sources.length === 0 || maxInfluenceRadius <= 0) {
    return null;
  }

  const dataSignature = createHeatLayerSurfaceDataSignature(sources);
  const cacheKey = createHeatLayerSurfaceCacheKey({
    colorRamp,
    dataSignature,
    height: dimensions.height,
    maxInfluenceRadius,
    mode,
    overlayBounds: coverageBounds,
    strategy: "stable-raster",
    width: dimensions.width,
    zoomBucket,
  });

  return {
    cacheKey,
    colorRamp,
    coverageBounds,
    dataSignature,
    height: dimensions.height,
    maxInfluenceRadius,
    metricProjection: createStableHeatLayerMetricProjection(coverageBounds, dimensions),
    mode: mode as Exclude<HeatLayerSurfaceMode, "field">,
    overlayBounds: coverageBounds,
    sources,
    width: dimensions.width,
    zoomBucket,
  };
}

function createHeatLayerSurfaceDataImage(options: HeatLayerSurfaceRenderOptions): HeatLayerSurfaceImage {
  return {
    objectUrl: false,
    url:
      options.mode === "data"
        ? createHeatLayerDataSurfaceDataUrl(options)
        : createHeatLayerInterpolatedSurfaceDataUrl(options),
  };
}

function createHeatLayerSurfaceImage(options: HeatLayerSurfaceRenderOptions) {
  return options.mode === "data"
    ? createHeatLayerDataSurfaceImage(options)
    : createHeatLayerInterpolatedSurfaceImage(options);
}

function createHeatLayerSurfaceCacheKey({
  colorRamp,
  dataSignature,
  height,
  maxInfluenceRadius,
  mode,
  overlayBounds,
  strategy,
  width,
  zoomBucket,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  dataSignature: string;
  height: number;
  maxInfluenceRadius: number;
  mode: HeatLayerSurfaceMode;
  overlayBounds: [west: number, south: number, east: number, north: number];
  strategy: Exclude<HeatLayerRenderStrategy, "auto">;
  width: number;
  zoomBucket: number;
}) {
  return [
    strategy,
    mode,
    roundHeatLayerCacheNumber(width),
    roundHeatLayerCacheNumber(height),
    roundHeatLayerCacheNumber(zoomBucket),
    roundHeatLayerCacheNumber(maxInfluenceRadius),
    overlayBounds.map(roundHeatLayerCacheNumber).join(","),
    colorRamp.stops
      .map((stop) => `${roundHeatLayerCacheNumber(stop.density)}:${stop.color}`)
      .join(","),
    dataSignature,
  ].join("|");
}

function createHeatLayerSurfaceDataSignature(sources: readonly HeatLayerSurfaceSource[]) {
  return sources
    .map((source) =>
      [
        roundHeatLayerCacheNumber(source.coordinate[0]),
        roundHeatLayerCacheNumber(source.coordinate[1]),
        roundHeatLayerCacheNumber(source.influenceRadius),
        roundHeatLayerCacheNumber(source.dataInfluenceRadius ?? -1),
        roundHeatLayerCacheNumber(source.weight),
      ].join(","),
    )
    .join("|");
}

function getHeatLayerSurfaceQueryBounds({
  intensity,
  map,
  maxRasterPixels,
  minZoomDeltaForRebuild,
  overscanRatio,
  radius,
  state,
  strategy,
}: {
  intensity: number;
  map: FlatMapAdapter;
  maxRasterPixels: number;
  minZoomDeltaForRebuild: number;
  overscanRatio: number;
  radius: HeatLayerRadius;
  state: HeatLayerFlatRenderState;
  strategy: HeatLayerRenderStrategy;
}) {
  const resolvedStrategy = resolveHeatLayerRenderStrategy(strategy, radius);

  if (resolvedStrategy !== "stable-raster" || !isMeterHeatLayerRadius(radius)) {
    return getHeatLayerPaddedBounds(map, radius, intensity);
  }

  const zoomBucket = getHeatLayerZoomBucket(map.getZoom(), minZoomDeltaForRebuild);
  const paddedBounds = getHeatLayerPaddedBounds(map, radius, intensity);

  if (
    state.surfaceCache &&
    state.surfaceCache.strategy === "stable-raster" &&
    state.surfaceCache.zoomBucket === zoomBucket &&
    heatLayerBoundsContain(state.surfaceCache.coverageBounds, paddedBounds)
  ) {
    return state.surfaceCache.coverageBounds;
  }

  void maxRasterPixels;

  return getHeatLayerStableCoverageBounds(map, radius, intensity, overscanRatio);
}

function resolveHeatLayerRenderStrategy(
  strategy: HeatLayerRenderStrategy,
  radius: HeatLayerRadius,
): Exclude<HeatLayerRenderStrategy, "auto"> {
  if (strategy !== "auto") {
    return strategy;
  }

  return isMeterHeatLayerRadius(radius) ? "stable-raster" : "viewport-raster";
}

function isMeterHeatLayerRadius(radius: HeatLayerRadius): radius is { meters: number } {
  return typeof radius === "object" && "meters" in radius;
}

function getHeatLayerStableCoverageBounds(
  map: FlatMapAdapter,
  radius: { meters: number },
  intensity: number,
  overscanRatio: number,
): [west: number, south: number, east: number, north: number] {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const center = map.containerPointToLatLng([width / 2, height / 2]);
  const paddingPixels =
    Math.max(width, height) * Math.max(0, overscanRatio) +
    resolveHeatLayerProjectedRadius(radius, [center.lng, center.lat], map) * 2.6 * Math.max(0, intensity);
  const northWest = map.containerPointToLatLng([-paddingPixels, -paddingPixels]);
  const southEast = map.containerPointToLatLng([width + paddingPixels, height + paddingPixels]);

  return normalizeHeatLayerBounds([
    Math.min(northWest.lng, southEast.lng),
    Math.min(northWest.lat, southEast.lat),
    Math.max(northWest.lng, southEast.lng),
    Math.max(northWest.lat, southEast.lat),
  ]);
}

function normalizeHeatLayerBounds(
  bounds: [west: number, south: number, east: number, north: number],
): [west: number, south: number, east: number, north: number] {
  return [
    clamp(bounds[0], -180, 180),
    clamp(bounds[1], -90, 90),
    clamp(bounds[2], -180, 180),
    clamp(bounds[3], -90, 90),
  ];
}

function heatLayerBoundsContain(
  outer: [west: number, south: number, east: number, north: number],
  inner: [west: number, south: number, east: number, north: number],
) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function heatLayerBoundsToLatLngBounds([
  west,
  south,
  east,
  north,
]: [west: number, south: number, east: number, north: number]): [[number, number], [number, number]] {
  return [
    [south, west],
    [north, east],
  ];
}

function resolveStableHeatLayerRasterDimensions({
  bounds,
  maxRasterPixels,
  viewportHeight,
  viewportWidth,
}: {
  bounds: [west: number, south: number, east: number, north: number];
  maxRasterPixels: number;
  viewportHeight: number;
  viewportWidth: number;
}) {
  const metricBounds = getHeatLayerMetricBounds(bounds);
  const aspectRatio = Math.max(
    0.05,
    (metricBounds.east - metricBounds.west) / Math.max(1, metricBounds.north - metricBounds.south),
  );
  const safeMaxPixels = Math.max(1, Math.floor(maxRasterPixels));
  const viewportPixels = Math.max(1, viewportWidth * viewportHeight);
  const targetPixels = Math.min(safeMaxPixels, Math.max(1, viewportPixels));
  const width = Math.max(1, Math.round(Math.sqrt(targetPixels * aspectRatio)));
  const height = Math.max(1, Math.round(width / aspectRatio));

  if (width * height <= safeMaxPixels) {
    return { height, width };
  }

  const scale = Math.sqrt(safeMaxPixels / (width * height));

  return {
    height: Math.max(1, Math.floor(height * scale)),
    width: Math.max(1, Math.floor(width * scale)),
  };
}

function createStableHeatLayerMetricProjection(
  bounds: [west: number, south: number, east: number, north: number],
  dimensions: { height: number; width: number },
) {
  const metricBounds = getHeatLayerMetricBounds(bounds);

  return {
    getMetricPoint(x: number, y: number) {
      return {
        x:
          metricBounds.west +
          (x / Math.max(1, dimensions.width)) * (metricBounds.east - metricBounds.west),
        y:
          metricBounds.north -
          (y / Math.max(1, dimensions.height)) * (metricBounds.north - metricBounds.south),
      };
    },
    getMetricX(x: number) {
      return metricBounds.west + (x / Math.max(1, dimensions.width)) * (metricBounds.east - metricBounds.west);
    },
    getMetricY(y: number) {
      return metricBounds.north - (y / Math.max(1, dimensions.height)) * (metricBounds.north - metricBounds.south);
    },
  };
}

function getHeatLayerMetricBounds([
  west,
  south,
  east,
  north,
]: [west: number, south: number, east: number, north: number]) {
  const southWest = coordinateToHeatLayerMetricPoint([west, south]);
  const northEast = coordinateToHeatLayerMetricPoint([east, north]);

  return {
    east: Math.max(southWest.x, northEast.x),
    north: Math.max(southWest.y, northEast.y),
    south: Math.min(southWest.y, northEast.y),
    west: Math.min(southWest.x, northEast.x),
  };
}

function getHeatLayerZoomBucket(zoom: number, minZoomDeltaForRebuild: number) {
  const interval = Math.max(0.000001, minZoomDeltaForRebuild);

  return Math.floor((Number.isFinite(zoom) ? zoom : 0) / interval);
}

function roundHeatLayerCacheNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(3) : "0";
}

function createHeatLayerFlatRenderState(): HeatLayerFlatRenderState {
  return {
    contourLayers: [],
    dataLayers: [],
    renderRequestId: 0,
    surfaceCache: null,
    surfaceClassName: null,
    surfaceLayer: null,
  };
}

function resetHeatLayerFlatRenderState(state: HeatLayerFlatRenderState) {
  state.renderRequestId += 1;
  state.contourLayers = [];
  state.dataLayers = [];
  revokeHeatLayerSurfaceCache(state.surfaceCache);
  state.surfaceCache = null;
  state.surfaceClassName = null;
  state.surfaceLayer = null;
}

function setHeatLayerSurfaceCache(state: HeatLayerFlatRenderState, cache: HeatLayerSurfaceCache) {
  if (state.surfaceCache?.url !== cache.url) {
    revokeHeatLayerSurfaceCache(state.surfaceCache);
  }

  state.surfaceCache = cache;
}

function revokeHeatLayerSurfaceCache(cache: HeatLayerSurfaceCache | null) {
  if (!cache?.objectUrl) {
    return;
  }

  revokeHeatLayerSurfaceObjectUrl(cache.url);
}

function revokeHeatLayerSurfaceImage(image: HeatLayerSurfaceImage) {
  if (image.objectUrl) {
    revokeHeatLayerSurfaceObjectUrl(image.url);
  }
}

function revokeHeatLayerSurfaceObjectUrl(url: string) {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

function renderOrUpdateHeatLayerImageOverlay({
  bounds,
  className,
  layer,
  flat,
  opacity,
  state,
  url,
}: {
  bounds: [[number, number], [number, number]];
  className: string;
  layer: FlatLayerGroup;
  flat: FlatLayerFactory;
  opacity: number;
  state: HeatLayerFlatRenderState;
  url: string;
}) {
  const safeOpacity = clamp(opacity, 0, 1);

  if (!state.surfaceLayer || state.surfaceClassName !== className) {
    removeHeatLayerSurfaceLayer(layer, state);
    state.surfaceLayer = flat
      .imageOverlay(url, bounds, {
        className,
        interactive: false,
        opacity: safeOpacity,
      })
      .addTo(layer) as unknown as HeatLayerImageOverlay;
    state.surfaceClassName = className;
    return;
  }

  updateHeatLayerImageOverlay(state.surfaceLayer, {
    bounds,
    opacity: safeOpacity,
    url,
  });
}

function updateHeatLayerImageOverlay(
  overlay: HeatLayerImageOverlay,
  {
    bounds,
    opacity,
    url,
  }: {
    bounds: [[number, number], [number, number]];
    opacity: number;
    url: string;
  },
) {
  if (typeof overlay.setUrl === "function") {
    overlay.setUrl(url);
  } else {
    overlay.url = url;
  }

  if (typeof overlay.setBounds === "function") {
    overlay.setBounds(bounds);
  } else {
    overlay.bounds = bounds;
  }

  if (typeof overlay.setOpacity === "function") {
    overlay.setOpacity(opacity);
  } else {
    overlay.options = {
      ...overlay.options,
      opacity,
    };
  }
}

function removeHeatLayerSurfaceLayer(
  parent: FlatLayerGroup,
  state: HeatLayerFlatRenderState,
) {
  if (!state.surfaceLayer) {
    return;
  }

  removeHeatLayerManagedLayer(parent, state.surfaceLayer);
  state.surfaceLayer = null;
  state.surfaceClassName = null;
}

function clearHeatLayerManagedLayers(
  parent: FlatLayerGroup,
  layers: HeatLayerManagedLayer[],
) {
  for (const layer of layers) {
    removeHeatLayerManagedLayer(parent, layer);
  }

  layers.length = 0;
}

function removeHeatLayerManagedLayer(
  parent: FlatLayerGroup,
  layer: HeatLayerManagedLayer,
) {
  const removableParent = parent as FlatLayerGroup & {
    layers?: unknown[];
  };

  if (typeof removableParent.removeLayer === "function") {
    removableParent.removeLayer(layer as FlatLayer);
    return;
  }

  if (typeof layer.remove === "function") {
    layer.remove();
  }

  if (Array.isArray(removableParent.layers)) {
    const index = removableParent.layers.indexOf(layer);

    if (index >= 0) {
      removableParent.layers.splice(index, 1);
    }
  }
}

function clearHeatLayerNonSurfaceLayers(parent: FlatLayerGroup, state: HeatLayerFlatRenderState) {
  const layers = (parent as FlatLayerGroup & { layers?: HeatLayerManagedLayer[] }).layers;

  if (!Array.isArray(layers)) {
    return;
  }

  for (const layer of [...layers]) {
    if (layer !== state.surfaceLayer) {
      removeHeatLayerManagedLayer(parent, layer);
    }
  }
}

function createHeatLayerFeatureCollectionFromAggregates<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  effectiveMaxWeight: number,
): HeatLayerFeatureCollection {
  return {
    features: features
      .map((feature) => createHeatLayerFeatureFromAggregate(feature, effectiveMaxWeight))
      .filter(isDefined),
    type: "FeatureCollection",
  };
}

function createHeatLayerFeatureFromAggregate<TProperties>(
  feature: AggregatedMapFeature<TProperties>,
  effectiveMaxWeight: number,
): HeatLayerFeature | null {
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
      ...Object.fromEntries(
        Object.entries(feature.metrics).filter(
          ([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC,
        ),
      ),
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

function resolveHeatLayerPointWeight<TProperties>(
  point: IndexedMapPoint<TProperties>,
  options: {
    getWeight?: HeatLayerWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(point)
    : options.weightMetric
      ? (point.metrics[options.weightMetric] ?? 0)
      : (point.metrics.weight ?? 1);

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
}

function resolveHeatLayerProjectedRadius(
  radius: HeatLayerRadius,
  coordinate: [longitude: number, latitude: number],
  map: FlatMapAdapter,
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      map.latLngToContainerPoint(toLatLng(nextCoordinate)),
    );
  }

  return resolveHeatLayerDisplayRadius(radius, map.getZoom());
}

function getHeatLayerDataInfluenceRadius(radius: HeatLayerRadius, intensity: number) {
  if (typeof radius === "object" && "meters" in radius) {
    return Math.max(0, radius.meters * 2.6 * Math.max(0, intensity));
  }

  return null;
}

function getHeatLayerPaddedBounds(
  map: FlatMapAdapter,
  radius: HeatLayerRadius,
  intensity: number,
): [west: number, south: number, east: number, north: number] {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const center = map.containerPointToLatLng([width / 2, height / 2]);
  const centerCoordinate: [number, number] = [center.lng, center.lat];
  const padding =
    resolveHeatLayerProjectedRadius(radius, centerCoordinate, map) * 2.6 * Math.max(0, intensity);
  const northWest = map.containerPointToLatLng([-padding, -padding]);
  const southEast = map.containerPointToLatLng([width + padding, height + padding]);

  return [
    clamp(Math.min(northWest.lng, southEast.lng), -180, 180),
    clamp(Math.min(northWest.lat, southEast.lat), -90, 90),
    clamp(Math.max(northWest.lng, southEast.lng), -180, 180),
    clamp(Math.max(northWest.lat, southEast.lat), -90, 90),
  ];
}

function getHeatLayerViewportBounds(
  map: FlatMapAdapter,
): [west: number, south: number, east: number, north: number] {
  const bounds = map.getBounds();

  return [
    clamp(bounds.getWest(), -180, 180),
    clamp(bounds.getSouth(), -90, 90),
    clamp(bounds.getEast(), -180, 180),
    clamp(bounds.getNorth(), -90, 90),
  ];
}

function getHeatLayerFeatureCollectionInBounds(
  data: HeatLayerFeatureCollection,
  [west, south, east, north]: [west: number, south: number, east: number, north: number],
): HeatLayerFeatureCollection {
  return {
    features: data.features.filter((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;

      return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
    }),
    type: "FeatureCollection",
  };
}

function getHeatLayerViewportQueryCacheKey(query: ViewportAggregationQuery) {
  return `${roundHeatLayerCacheNumber(query.zoom)}:${getHeatLayerBoundsCacheKey(query.bounds)}`;
}

function getHeatLayerBoundsCacheKey(bounds: readonly number[]) {
  return bounds.map(roundHeatLayerCacheNumber).join(",");
}

function resolveHeatLayerGlobeRadius(
  radius: HeatLayerRadius,
  coordinate: [longitude: number, latitude: number],
  viewState: { center: [number, number]; zoom: number },
  projectCoordinate: (
    coordinate: [longitude: number, latitude: number],
    viewState: { center: [number, number]; zoom: number },
  ) => { visible: boolean; x: number; y: number },
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      projectCoordinate(nextCoordinate, viewState),
    );
  }

  return resolveHeatLayerDisplayRadius(radius, viewState.zoom);
}

function getProjectedMetersRadius(
  meters: number,
  [longitude, latitude]: [longitude: number, latitude: number],
  projectCoordinate: (coordinate: [longitude: number, latitude: number]) => {
    x: number;
    y: number;
  },
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

function coordinateToHeatLayerMetricPoint([longitude, latitude]: [
  longitude: number,
  latitude: number,
]): HeatLayerMetricPoint {
  const clampedLatitude = clamp(latitude, -85.05112878, 85.05112878);
  const latitudeRadians = (clampedLatitude * Math.PI) / 180;

  return {
    x: longitude * METERS_PER_DEGREE_AT_EQUATOR,
    y:
      (Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) *
        (METERS_PER_DEGREE_AT_EQUATOR * 180)) /
      Math.PI,
  };
}

function resolveHeatLayerDisplayRadius(
  radius: Exclude<HeatLayerRadius, { meters: number }>,
  zoom: number,
) {
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

function isValidHeatLayerPoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function canUseAsyncHeatLayerRender() {
  return (
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent)
  );
}
