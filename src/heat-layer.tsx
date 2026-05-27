"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, useRef } from "react";

import {
  createPointAggregationIndex,
  type AggregatedMapFeature,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
} from "./aggregation";
import { toLeafletLatLng } from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
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
import {
  createHeatLayerDataSurfaceSvg,
  createHeatLayerInterpolatedSurfaceSvg,
  createSvgDataUrl,
  prepareHeatLayerColorRamp,
  resolveHeatLayerColor,
  type HeatLayerMetricPoint,
  type HeatLayerSurfaceSource,
  type PreparedHeatLayerColorRamp,
} from "./heat-surface";

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";
const DEFAULT_HEAT_LAYER_RADIUS_METERS = 50_000;
const METERS_PER_DEGREE_AT_EQUATOR = 111_320;

export type HeatLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatFieldRenderMode = "raster" | "contours";

export type HeatLayerSurfaceMode = "data" | "interpolated" | "field";

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
    heatmapMaxZoom?: number;
    heatmapSurfaceMode?: HeatLayerSurfaceMode;
    heatmapOpacity?: number;
    heatmapRadius?: HeatLayerRadius;
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
  surfaceClassName: string | null;
  surfaceLayer: HeatLayerImageOverlay | null;
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
  heatmapColorRamp = defaultHeatLayerColorRamp,
  heatmapIntensity = 1,
  heatmapMaxZoom = 16,
  heatmapOpacity = 0.84,
  heatmapRadius = {
    meters: DEFAULT_HEAT_LAYER_RADIUS_METERS,
  },
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
      fieldGrid && fieldRenderMode === "raster"
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
      fieldGrid && fieldRenderMode === "contours"
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
  const fieldDataPointCollection = useMemo(
    () =>
      heatmapSurfaceMode === "field"
        ? createHeatLayerValueFeatureCollection(deferredPoints, {
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
  const renderVersion =
    heatmapAggregationMaxZoom ?? heatmapAggregationMinZoom ?? heatmapAggregationRadius ?? null;

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    const flatRenderState = flatRenderStateRef.current;
    const unregister = surface.registerFlatLayer(resolvedLayerId, ({ isMeasuring, layer, leaflet, map }) => {
      clearHeatLayerManagedLayers(layer, flatRenderState.dataLayers);
      clearHeatLayerManagedLayers(layer, flatRenderState.contourLayers);

      if (map.getZoom() > heatmapMaxZoom) {
        removeHeatLayerSurfaceLayer(layer, flatRenderState);
        return;
      }

      if (heatmapSurfaceMode === "field") {
        if (fieldRenderMode === "contours") {
          removeHeatLayerSurfaceLayer(layer, flatRenderState);
          renderHeatLayerContourSurface({
            collection: fieldContourCollection,
            isMeasuring,
            layer,
            leaflet,
            lineColor: fieldContourColor,
            lineOpacity: fieldContourOpacity ?? fieldOpacity ?? heatmapOpacity,
            lineWidth: fieldContourLineWidth,
            state: flatRenderState,
          });
        } else {
          renderHeatLayerFieldSurface({
            image: fieldImage,
            layer,
            leaflet,
            opacity: fieldOpacity ?? heatmapOpacity,
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
            leaflet,
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
        getHeatLayerPaddedBounds(map, heatmapRadius, heatmapIntensity),
      );

      renderHeatLayerSurface({
        colorRamp: preparedHeatmapColorRamp,
        data,
        intensity: heatmapIntensity,
        layer,
        leaflet,
        map,
        mode: heatmapSurfaceMode,
        opacity: heatmapOpacity,
        radius: heatmapRadius,
        state: flatRenderState,
      });

      if (showDataPoints) {
        renderHeatLayerDataPoints({
          color: dataPointColor,
          data: heatIndex.getFeatureCollection(getHeatLayerViewportBounds(map)),
          formatValue: dataPointValueFormat,
          isMeasuring,
          layer,
          leaflet,
          opacity: dataPointOpacity,
          radius: dataPointRadius,
          state: flatRenderState,
          strokeColor: dataPointStrokeColor,
          strokeWidth: dataPointStrokeWidth,
        });
      }
    });

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
    heatIndex,
    heatmapIntensity,
    heatmapMaxZoom,
    heatmapOpacity,
    heatmapRadius,
    heatmapSurfaceMode,
    preparedHeatmapColorRamp,
    renderVersion,
    resolvedLayerId,
    showDataPoints,
    surface,
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

  return {
    getFeatureCollection(query: ViewportAggregationQuery) {
      return createHeatLayerFeatureCollectionFromAggregates(
        index.getViewportAggregation(query).features,
        effectiveMaxWeight,
      );
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

  return {
    getFeatureCollection(bounds: [west: number, south: number, east: number, north: number]) {
      const [west, south, east, north] = bounds;

      return {
        features: features.filter((feature) => {
          const [longitude, latitude] = feature.geometry.coordinates;

          return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
        }),
        type: "FeatureCollection" as const,
      };
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
  leaflet,
  opacity,
  state,
}: {
  image: HeatFieldImage | null;
  layer: import("leaflet").LayerGroup;
  leaflet: typeof import("leaflet");
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
    leaflet,
    opacity,
    state,
    url: image.url,
  });
}

function renderHeatLayerContourSurface({
  collection,
  isMeasuring,
  layer,
  leaflet,
  lineColor,
  lineOpacity,
  lineWidth,
  state,
}: {
  collection: HeatFieldContourFeatureCollection | null;
  isMeasuring: boolean;
  layer: import("leaflet").LayerGroup;
  leaflet: typeof import("leaflet");
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
  leaflet,
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
  layer: import("leaflet").LayerGroup;
  leaflet: typeof import("leaflet");
  opacity: number;
  radius: number;
  state: HeatLayerFlatRenderState;
  strokeColor: string;
  strokeWidth: number;
}) {
  for (const feature of data.features) {
    const [longitude, latitude] = feature.geometry.coordinates;
    const marker = leaflet.circleMarker(toLeafletLatLng([longitude, latitude]), {
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
  colorRamp,
  data,
  intensity,
  layer,
  leaflet,
  map,
  mode,
  opacity,
  radius,
  state,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  data: HeatLayerFeatureCollection;
  intensity: number;
  layer: import("leaflet").LayerGroup;
  leaflet: typeof import("leaflet");
  map: import("leaflet").Map;
  mode: HeatLayerSurfaceMode;
  opacity: number;
  radius: HeatLayerRadius;
  state: HeatLayerFlatRenderState;
}) {
  const viewport = map.getContainer();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const safeOpacity = clamp(opacity, 0, 1);
  const sources = data.features
    .map((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      const point = map.latLngToContainerPoint(toLeafletLatLng([longitude, latitude]));
      const baseRadius =
        resolveHeatLayerProjectedRadius(radius, feature.geometry.coordinates, map) *
        Math.max(0, intensity);
      const metricPoint = coordinateToHeatLayerMetricPoint(feature.geometry.coordinates);
      const dataInfluenceRadius = getHeatLayerDataInfluenceRadius(radius, intensity);

      return {
        coordinate: feature.geometry.coordinates,
        dataInfluenceRadius,
        influenceRadius: baseRadius * 2.6,
        metricPoint,
        point,
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));

  if (width <= 0 || height <= 0 || sources.length === 0 || maxInfluenceRadius <= 0) {
    removeHeatLayerSurfaceLayer(layer, state);
    return;
  }

  const northWest = map.containerPointToLatLng([0, 0]);
  const southEast = map.containerPointToLatLng([width, height]);
  const svg =
    mode === "data"
      ? createHeatLayerDataSurfaceSvg({
          colorRamp,
          height,
          sources,
          width,
        })
      : createHeatLayerInterpolatedSurfaceSvg({
          colorRamp,
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
          sources,
          width,
        });

  renderOrUpdateHeatLayerImageOverlay({
    bounds: [
      [southEast.lat, northWest.lng],
      [northWest.lat, southEast.lng],
    ],
    className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
    layer,
    leaflet,
    opacity: safeOpacity,
    state,
    url: createSvgDataUrl(svg),
  });
}

function createHeatLayerFlatRenderState(): HeatLayerFlatRenderState {
  return {
    contourLayers: [],
    dataLayers: [],
    surfaceClassName: null,
    surfaceLayer: null,
  };
}

function resetHeatLayerFlatRenderState(state: HeatLayerFlatRenderState) {
  state.contourLayers = [];
  state.dataLayers = [];
  state.surfaceClassName = null;
  state.surfaceLayer = null;
}

function renderOrUpdateHeatLayerImageOverlay({
  bounds,
  className,
  layer,
  leaflet,
  opacity,
  state,
  url,
}: {
  bounds: [[number, number], [number, number]];
  className: string;
  layer: import("leaflet").LayerGroup;
  leaflet: typeof import("leaflet");
  opacity: number;
  state: HeatLayerFlatRenderState;
  url: string;
}) {
  const safeOpacity = clamp(opacity, 0, 1);

  if (!state.surfaceLayer || state.surfaceClassName !== className) {
    removeHeatLayerSurfaceLayer(layer, state);
    state.surfaceLayer = leaflet
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
  parent: import("leaflet").LayerGroup,
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
  parent: import("leaflet").LayerGroup,
  layers: HeatLayerManagedLayer[],
) {
  for (const layer of layers) {
    removeHeatLayerManagedLayer(parent, layer);
  }

  layers.length = 0;
}

function removeHeatLayerManagedLayer(
  parent: import("leaflet").LayerGroup,
  layer: HeatLayerManagedLayer,
) {
  const removableParent = parent as import("leaflet").LayerGroup & {
    layers?: unknown[];
  };

  if (typeof removableParent.removeLayer === "function") {
    removableParent.removeLayer(layer as import("leaflet").Layer);
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
  map: import("leaflet").Map,
) {
  if (typeof radius === "object" && "meters" in radius) {
    return getProjectedMetersRadius(radius.meters, coordinate, (nextCoordinate) =>
      map.latLngToContainerPoint(toLeafletLatLng(nextCoordinate)),
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
  map: import("leaflet").Map,
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
  map: import("leaflet").Map,
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
