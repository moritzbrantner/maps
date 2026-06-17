"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  canUseAsyncHeatLayerRender,
  createHeatLayerColorRampKey,
  createHeatLayerContourLevelsKey,
  createHeatLayerNumberArrayKey,
  createHeatLayerSourceIndex,
  createHeatLayerValueFeatureCollection,
  getHeatLayerFeatureCollectionInBounds,
  isHeatFieldContoursVisible,
  isHeatFieldRasterVisible,
} from "./heat-layer-data";
import {
  DEFAULT_HEAT_LAYER_MAX_RASTER_PIXELS,
  DEFAULT_HEAT_LAYER_MIN_ZOOM_DELTA_FOR_REBUILD,
  DEFAULT_HEAT_LAYER_OVERSCAN_RATIO,
  DEFAULT_HEAT_LAYER_RADIUS_METERS,
  defaultHeatLayerColorRamp,
  type HeatLayerProps,
} from "./heat-layer-types";
import {
  clearHeatLayerContourLayers,
  clearHeatLayerDataPointLayers,
  createHeatLayerFlatRenderState,
  getHeatLayerSurfaceQueryBounds,
  getHeatLayerViewportBounds,
  removeHeatLayerSurfaceLayer,
  renderHeatLayerContourSurface,
  renderHeatLayerDataPoints,
  renderHeatLayerFieldSurface,
  renderHeatLayerSurface,
  resetHeatLayerFlatRenderState,
  type HeatLayerFlatRenderState,
} from "./heat-layer-rendering";
import { prepareHeatLayerColorRamp } from "./heat-surface";
import { MapSurfaceContext } from "./map-view";
import { createScalarFieldGrid, type ScalarFieldGrid } from "./scalar-field";
import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
  type HeatFieldContourFeatureCollection,
  type HeatFieldImage,
} from "./scalar-field-render";

export { createHeatLayerDensityIndex } from "./heat-layer-data";
export type {
  HeatFieldRenderMode,
  HeatLayerColorStop,
  HeatLayerFeature,
  HeatLayerFeatureCollection,
  HeatLayerFeatureProperties,
  HeatLayerProps,
  HeatLayerRadius,
  HeatLayerRenderStrategy,
  HeatLayerSurfaceMode,
  HeatLayerWeightAccessor,
} from "./heat-layer-types";

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
  const fieldImage = shouldRenderFieldAsync ? (asyncFieldArtifacts?.image ?? null) : syncFieldImage;
  const fieldContourCollection = shouldRenderFieldAsync
    ? (asyncFieldArtifacts?.contourCollection ?? null)
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
  const registerMapLibreLayer = surface?.registerMapLibreLayer;

  useEffect(() => {
    const flatRenderState = flatRenderStateRef.current;

    return () => {
      resetHeatLayerFlatRenderState(flatRenderState);
    };
  }, []);

  useEffect(() => {
    if (!registerMapLibreLayer || (surfaceDisplay !== "flat" && surfaceDisplay !== "globe")) {
      return;
    }

    const flatRenderState = flatRenderStateRef.current;
    const unregister = registerMapLibreLayer(
      resolvedLayerId,
      ({ isMeasuring, layer, flat, map }) => {
        if (map.getZoom() > heatmapMaxZoom) {
          clearHeatLayerDataPointLayers(layer, flatRenderState);
          clearHeatLayerContourLayers(layer, flatRenderState);
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
          } else {
            clearHeatLayerContourLayers(layer, flatRenderState);
          }

          if (showDataPoints) {
            renderHeatLayerDataPoints({
              color: dataPointColor,
              data: getHeatLayerFeatureCollectionInBounds(
                fieldDataPointCollection ??
                  heatIndex.getFeatureCollection(getHeatLayerViewportBounds(map)),
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
          } else {
            clearHeatLayerDataPointLayers(layer, flatRenderState);
          }

          return;
        }

        clearHeatLayerContourLayers(layer, flatRenderState);

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
        } else {
          clearHeatLayerDataPointLayers(layer, flatRenderState);
        }
      },
      { preserveOnRender: true },
    );

    return () => {
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
    registerMapLibreLayer,
    surfaceDisplay,
  ]);

  return null;
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
