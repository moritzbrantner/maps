"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import {
  canUseAsyncHeatLayerRender,
  createHeatLayerColorRampKey,
  createHeatLayerContourLevelsKey,
  createHeatLayerNumberArrayKey,
  createHeatLayerSourceIndex,
  createHeatLayerValueFeatureCollection,
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
import type { MapsHeatLayerDescriptor } from "./maps-heat-layer-registration";
import { createHeatLayerDataWork, type HeatLayerDataWork } from "./heat-layer-work";
import { prepareHeatLayerColorRamp } from "./heat-surface";
import { createScalarFieldGrid, type ScalarFieldGrid } from "./scalar-field";
import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
  type HeatFieldContourFeatureCollection,
  type HeatFieldImage,
} from "./scalar-field-render";

type AnyRecord = Record<string, unknown>;

const DEFAULT_MAPS_HEAT_LAYER_RADIUS = { meters: DEFAULT_HEAT_LAYER_RADIUS_METERS } as const;

type HeatLayerFieldArtifacts = {
  contourCollection: HeatFieldContourFeatureCollection | null;
  filterPoint: unknown;
  grid: ScalarFieldGrid;
  gridKey: string;
  getValue: unknown;
  getWeight: unknown;
  image: HeatFieldImage | null;
  maskGeoJson: unknown;
  points: readonly unknown[];
};

export function MapsHeatLayerMount({
  layerKey,
  props,
  publish,
}: {
  layerKey: string;
  props: HeatLayerProps<AnyRecord>;
  publish: (layerKey: string, descriptor: MapsHeatLayerDescriptor | null) => void;
}) {
  const {
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
    heatmapColorRamp = defaultHeatLayerColorRamp,
    heatmapIntensity = 1,
    heatmapAsyncRender = canUseAsyncHeatLayerRender(),
    heatmapMaxRasterPixels = DEFAULT_HEAT_LAYER_MAX_RASTER_PIXELS,
    heatmapMaxZoom = 16,
    heatmapMinZoomDeltaForRebuild = DEFAULT_HEAT_LAYER_MIN_ZOOM_DELTA_FOR_REBUILD,
    heatmapOpacity = 0.84,
    heatmapOverscanRatio = DEFAULT_HEAT_LAYER_OVERSCAN_RATIO,
    heatmapRadius = DEFAULT_MAPS_HEAT_LAYER_RADIUS,
    heatmapRenderStrategy = "auto",
    heatmapSurfaceMode = "interpolated",
    interpolationEpsilonMeters,
    interpolationExtrapolate,
    interpolationK,
    interpolationMaxDistanceMeters,
    interpolationPower,
    layerId = layerKey,
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
  } = props;
  const deferredPoints = useDeferredValue(points);
  // One counter set per mounted layer; artifact builds below count into it.
  const [work] = useState(createHeatLayerDataWork);
  const preparedHeatmapColorRamp = useMemo(
    () => prepareHeatLayerColorRamp(heatmapColorRamp),
    [heatmapColorRamp],
  );
  const heatIndex = useMemo(
    () =>
      // Field mode prepares scalar values below; density features are unused.
      createHeatLayerSourceIndex(heatmapSurfaceMode === "field" ? [] : deferredPoints, {
        filterPoint,
        getWeight,
        maxWeight,
        weightMetric,
        work,
      }),
    [deferredPoints, filterPoint, getWeight, heatmapSurfaceMode, maxWeight, weightMetric, work],
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
  const shouldRenderFieldAsync = fieldAsyncRender && typeof setTimeout !== "undefined";
  const syncFieldGrid = useMemo(
    () =>
      heatmapSurfaceMode === "field" && !shouldRenderFieldAsync
        ? countFieldGridBuild(
            work,
            createScalarFieldGrid(deferredPoints, {
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
            }),
          )
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
      work,
    ],
  );
  const syncFieldImage = useMemo(
    () =>
      syncFieldGrid && isHeatFieldRasterVisible(fieldRenderMode)
        ? countFieldImageBuild(
            work,
            createHeatFieldImage(syncFieldGrid, {
              colorRamp: fieldColorRamp,
              opacity: fieldOpacity ?? heatmapOpacity,
              valueDomain: fieldValueDomain,
            }),
          )
        : null,
    [
      fieldColorRampKey,
      fieldOpacity,
      fieldRenderMode,
      fieldValueDomainKey,
      heatmapOpacity,
      syncFieldGrid,
      work,
    ],
  );
  const syncFieldContourCollection = useMemo(
    () =>
      syncFieldGrid && isHeatFieldContoursVisible(fieldRenderMode)
        ? countFieldContourBuild(
            work,
            createHeatFieldContourFeatureCollection(syncFieldGrid, {
              levels: fieldContourLevels,
              valueDomain: fieldValueDomain,
              valueFormat: fieldContourValueFormat,
            }),
          )
        : null,
    [
      fieldContourLevelsKey,
      fieldContourValueFormat,
      fieldRenderMode,
      fieldValueDomainKey,
      syncFieldGrid,
      work,
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
    if (!shouldRenderFieldAsync || heatmapSurfaceMode !== "field") return;

    const requestId = (asyncFieldRequestIdRef.current += 1);
    const timeout = setTimeout(() => {
      const previousArtifacts = asyncFieldArtifactsRef.current;
      const canReuseGrid =
        previousArtifacts?.gridKey === fieldGridInputKey &&
        previousArtifacts.points === deferredPoints &&
        previousArtifacts.filterPoint === filterPoint &&
        previousArtifacts.getValue === getValue &&
        previousArtifacts.getWeight === getWeight &&
        previousArtifacts.maskGeoJson === maskGeoJson;
      if (canReuseGrid) work.fieldGridReuses += 1;
      const grid = canReuseGrid
        ? previousArtifacts.grid
        : countFieldGridBuild(
            work,
            createScalarFieldGrid(deferredPoints, {
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
            }),
          );
      const image =
        grid && isHeatFieldRasterVisible(fieldRenderMode)
          ? countFieldImageBuild(
              work,
              createHeatFieldImage(grid, {
                colorRamp: fieldColorRamp,
                opacity: fieldOpacity ?? heatmapOpacity,
                valueDomain: fieldValueDomain,
              }),
            )
          : null;
      const contourCollection =
        grid && isHeatFieldContoursVisible(fieldRenderMode)
          ? countFieldContourBuild(
              work,
              createHeatFieldContourFeatureCollection(grid, {
                levels: fieldContourLevels,
                valueDomain: fieldValueDomain,
                valueFormat: fieldContourValueFormat,
              }),
            )
          : null;

      if (asyncFieldRequestIdRef.current !== requestId) {
        work.fieldResultsDiscarded += 1;
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
        maskGeoJson,
        points: deferredPoints,
      });
    }, 0);

    return () => clearTimeout(timeout);
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
    work,
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

  useEffect(() => {
    publish(layerKey, {
      dataPointColor,
      dataPointOpacity,
      dataPointRadius,
      dataPointStrokeColor,
      dataPointStrokeWidth,
      dataPointValueFormat,
      fieldContourCollection,
      fieldContourColor,
      fieldContourLineWidth,
      fieldContourOpacity: fieldContourOpacity ?? fieldOpacity ?? heatmapOpacity,
      fieldDataPointCollection,
      fieldImage,
      fieldOpacity: fieldOpacity ?? heatmapOpacity,
      fieldRenderMode,
      heatIndex,
      heatmapAsyncRender,
      heatmapColorRamp: preparedHeatmapColorRamp,
      heatmapIntensity,
      heatmapMaxRasterPixels,
      heatmapMaxZoom,
      heatmapMinZoomDeltaForRebuild,
      heatmapOpacity,
      heatmapOverscanRatio,
      heatmapRadius,
      heatmapRenderStrategy,
      heatmapSurfaceMode,
      layerId,
      showDataPoints,
      work,
    });

    return () => publish(layerKey, null);
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
    heatIndex,
    heatmapAsyncRender,
    heatmapIntensity,
    heatmapMaxRasterPixels,
    heatmapMaxZoom,
    heatmapMinZoomDeltaForRebuild,
    heatmapOpacity,
    heatmapOverscanRatio,
    heatmapRadius,
    heatmapRenderStrategy,
    heatmapSurfaceMode,
    layerId,
    layerKey,
    preparedHeatmapColorRamp,
    publish,
    showDataPoints,
    work,
  ]);

  return null;
}

function countFieldGridBuild(work: HeatLayerDataWork, grid: ScalarFieldGrid) {
  work.fieldGridBuilds += 1;
  work.fieldGridCells += grid.columns * grid.rows;
  return grid;
}

function countFieldImageBuild(work: HeatLayerDataWork, image: HeatFieldImage | null) {
  if (image) {
    work.fieldImageBuilds += 1;
    work.fieldImagePixels += image.width * image.height;
  }
  return image;
}

function countFieldContourBuild(
  work: HeatLayerDataWork,
  collection: HeatFieldContourFeatureCollection,
) {
  work.fieldContourBuilds += 1;
  return collection;
}
