"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo } from "react";

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

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";
const DEFAULT_HEAT_LAYER_RADIUS_METERS = 50_000;
const METERS_PER_DEGREE_AT_EQUATOR = 111_320;
const INTERPOLATED_HEAT_DENSITY_GAMMA = 0.7;
const INTERPOLATED_HEAT_MIN_DENSITY = 0.08;

export type HeatLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatLayerSurfaceMode = "data" | "interpolated";

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
    filterPoint?: MapPointFilter<TProperties>;
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
    layerId?: string;
    maxWeight?: number;
    points: readonly MapPoint<TProperties>[];
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

export function HeatLayer<TProperties = Record<string, unknown>>({
  filterPoint,
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
  layerId,
  maxWeight,
  points,
  weightMetric,
}: HeatLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `heat-layer-${generatedLayerId}`;
  const deferredPoints = useDeferredValue(points);
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
  const renderVersion =
    heatmapAggregationMaxZoom ?? heatmapAggregationMinZoom ?? heatmapAggregationRadius ?? null;

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer(resolvedLayerId, ({ layer, leaflet, map }) => {
      layer.clearLayers();

      if (map.getZoom() > heatmapMaxZoom) {
        return;
      }

      const data = heatIndex.getFeatureCollection(
        getHeatLayerPaddedBounds(map, heatmapRadius, heatmapIntensity),
      );

      renderHeatLayerSurface({
        colorRamp: heatmapColorRamp,
        data,
        intensity: heatmapIntensity,
        layer,
        leaflet,
        map,
        mode: heatmapSurfaceMode,
        opacity: heatmapOpacity,
        radius: heatmapRadius,
      });
    });
  }, [
    heatIndex,
    heatmapColorRamp,
    heatmapIntensity,
    heatmapMaxZoom,
    heatmapOpacity,
    heatmapRadius,
    heatmapSurfaceMode,
    renderVersion,
    resolvedLayerId,
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
                fill={resolveHeatLayerColor(heatmapColorRamp, normalizedWeight)}
                fillOpacity={safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65)}
                key={feature.properties.pointId}
                r={markerRadius}
                style={{ opacity: 0.34 + projected.scale * 0.66 }}
              >
                <title>{feature.properties.label}</title>
              </circle>
            );
          })
        : null}
    </>
  );
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
}: {
  colorRamp: readonly HeatLayerColorStop[];
  data: HeatLayerFeatureCollection;
  intensity: number;
  layer: import("leaflet").LayerGroup;
  leaflet: typeof import("leaflet");
  map: import("leaflet").Map;
  mode: HeatLayerSurfaceMode;
  opacity: number;
  radius: HeatLayerRadius;
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
          map,
          sources,
          width,
        });

  leaflet
    .imageOverlay(
      createSvgDataUrl(svg),
      [
        [southEast.lat, northWest.lng],
        [northWest.lat, southEast.lng],
      ],
      {
        className: `mb-maps__heat-surface mb-maps__heat-surface--${mode}`,
        interactive: false,
        opacity: safeOpacity,
      },
    )
    .addTo(layer);
}

type HeatLayerSurfaceCell = {
  density: number;
  x: number;
  y: number;
};

function createHeatLayerDataSurfaceSvg({
  colorRamp,
  height,
  sources,
  width,
}: {
  colorRamp: readonly HeatLayerColorStop[];
  height: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}) {
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));
  const blur = Math.max(1, maxInfluenceRadius * 0.16);
  const circles = sources
    .map((source) => {
      const normalizedWeight = clamp(source.weight, 0, 1);
      const radius = source.influenceRadius * (0.42 + Math.sqrt(normalizedWeight) * 0.5);
      const opacity = Math.min(1, 0.22 + normalizedWeight * 0.78);

      return `<circle cx="${roundSvgNumber(source.point.x)}" cy="${roundSvgNumber(
        source.point.y,
      )}" r="${roundSvgNumber(radius)}" fill="${escapeSvgAttribute(
        resolveHeatLayerInterpolatedColor(colorRamp, normalizedWeight),
      )}" opacity="${roundSvgNumber(opacity)}" />`;
    })
    .join("");

  return createHeatLayerSvg({ blur, content: circles, height, width });
}

function createHeatLayerInterpolatedSurfaceSvg({
  colorRamp,
  height,
  map,
  maxInfluenceRadius,
  sources,
  width,
}: {
  colorRamp: readonly HeatLayerColorStop[];
  height: number;
  map: import("leaflet").Map;
  maxInfluenceRadius: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}) {
  const metricSources = sources.filter(isMetricHeatLayerSurfaceSource);

  if (metricSources.length === sources.length) {
    return createHeatLayerMetricInterpolatedSurfaceSvg({
      colorRamp,
      height,
      map,
      maxInfluenceRadius,
      sources: metricSources,
      width,
    });
  }

  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;

  for (let y = startY; y < endY; y += cellSize) {
    for (let x = startX; x < endX; x += cellSize) {
      const centerX = x + cellSize / 2;
      const centerY = y + cellSize / 2;
      const density = getHeatLayerCellDensity(sources, centerX, centerY);

      cells.push({ density, x: centerX, y: centerY });
    }
  }
  for (const source of sources) {
    if (
      source.point.x < -maxInfluenceRadius ||
      source.point.x > width + maxInfluenceRadius ||
      source.point.y < -maxInfluenceRadius ||
      source.point.y > height + maxInfluenceRadius
    ) {
      continue;
    }

    cells.push({
      density: getHeatLayerCellDensity(sources, source.point.x, source.point.y),
      x: source.point.x,
      y: source.point.y,
    });
  }

  const sampleRadius = cellSize * 1.15;
  const circles = cells
    .map((cell) => {
      const normalizedDensity = resolveHeatLayerAbsoluteDensity(cell.density);

      return `<circle cx="${roundSvgNumber(cell.x)}" cy="${roundSvgNumber(cell.y)}" r="${roundSvgNumber(
        sampleRadius,
      )}" fill="${escapeSvgAttribute(
        resolveHeatLayerInterpolatedColor(colorRamp, normalizedDensity),
      )}" opacity="${roundSvgNumber(Math.min(1, 0.28 + normalizedDensity * 0.72))}" />`;
    })
    .join("");

  return createHeatLayerSvg({
    blur: Math.max(5, cellSize * 0.75),
    content: circles,
    height,
    width,
  });
}

function createHeatLayerMetricInterpolatedSurfaceSvg({
  colorRamp,
  height,
  map,
  maxInfluenceRadius,
  sources,
  width,
}: {
  colorRamp: readonly HeatLayerColorStop[];
  height: number;
  map: import("leaflet").Map;
  maxInfluenceRadius: number;
  sources: readonly MetricHeatLayerSurfaceSource[];
  width: number;
}) {
  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;

  for (let y = startY; y < endY; y += cellSize) {
    for (let x = startX; x < endX; x += cellSize) {
      const centerX = x + cellSize / 2;
      const centerY = y + cellSize / 2;
      const coordinate = map.containerPointToLatLng([centerX, centerY]);
      const metricPoint = coordinateToHeatLayerMetricPoint([coordinate.lng, coordinate.lat]);
      const density = getHeatLayerMetricCellDensity(
        sources,
        metricPoint.x,
        metricPoint.y,
      );

      cells.push({ density, x: centerX, y: centerY });
    }
  }
  for (const source of sources) {
    if (
      source.point.x < -maxInfluenceRadius ||
      source.point.x > width + maxInfluenceRadius ||
      source.point.y < -maxInfluenceRadius ||
      source.point.y > height + maxInfluenceRadius
    ) {
      continue;
    }

    cells.push({
      density: getHeatLayerMetricCellDensity(sources, source.metricPoint.x, source.metricPoint.y),
      x: source.point.x,
      y: source.point.y,
    });
  }

  const sampleRadius = cellSize * 1.15;
  const circles = cells
    .map((cell) => {
      const normalizedDensity = resolveHeatLayerAbsoluteDensity(cell.density);

      return `<circle cx="${roundSvgNumber(cell.x)}" cy="${roundSvgNumber(cell.y)}" r="${roundSvgNumber(
        sampleRadius,
      )}" fill="${escapeSvgAttribute(
        resolveHeatLayerInterpolatedColor(colorRamp, normalizedDensity),
      )}" opacity="${roundSvgNumber(Math.min(1, 0.28 + normalizedDensity * 0.72))}" />`;
    })
    .join("");

  return createHeatLayerSvg({
    blur: Math.max(1, maxInfluenceRadius * 0.04),
    content: circles,
    height,
    width,
  });
}

function resolveHeatLayerSampleSize(width: number, height: number, influenceRadius: number) {
  const preferredCellSize = clamp(Math.round(influenceRadius / 7), 8, 18);
  const maxSamples = 8_000;
  const estimatedSamples =
    Math.ceil((width + preferredCellSize * 2) / preferredCellSize) *
    Math.ceil((height + preferredCellSize * 2) / preferredCellSize);

  if (estimatedSamples <= maxSamples) {
    return preferredCellSize;
  }

  return Math.ceil(
    Math.sqrt(((width + preferredCellSize * 2) * (height + preferredCellSize * 2)) / maxSamples),
  );
}

function resolveHeatLayerAbsoluteDensity(density: number) {
  return clamp(
    INTERPOLATED_HEAT_MIN_DENSITY +
      Math.pow(Math.max(0, density), INTERPOLATED_HEAT_DENSITY_GAMMA) *
        (1 - INTERPOLATED_HEAT_MIN_DENSITY),
    0,
    1,
  );
}

type HeatLayerSurfaceSource = {
  coordinate: [longitude: number, latitude: number];
  dataInfluenceRadius: number | null;
  influenceRadius: number;
  metricPoint: HeatLayerMetricPoint;
  point: {
    x: number;
    y: number;
  };
  weight: number;
};

type MetricHeatLayerSurfaceSource = HeatLayerSurfaceSource & {
  dataInfluenceRadius: number;
};

type HeatLayerMetricPoint = {
  x: number;
  y: number;
};

function isMetricHeatLayerSurfaceSource(
  source: HeatLayerSurfaceSource,
): source is MetricHeatLayerSurfaceSource {
  return source.dataInfluenceRadius !== null && source.dataInfluenceRadius > 0;
}

function getHeatLayerCellDensity(
  sources: readonly HeatLayerSurfaceSource[],
  x: number,
  y: number,
) {
  let density = 0;

  for (const source of sources) {
    const dx = source.point.x - x;
    const dy = source.point.y - y;
    const distanceSquared = dx * dx + dy * dy;
    const localRadiusSquared = source.influenceRadius * source.influenceRadius;

    if (localRadiusSquared > 0 && distanceSquared <= localRadiusSquared) {
      density += source.weight * Math.exp((-3 * distanceSquared) / localRadiusSquared);
    }
  }

  return density;
}

function getHeatLayerMetricCellDensity(
  sources: readonly MetricHeatLayerSurfaceSource[],
  x: number,
  y: number,
) {
  let density = 0;

  for (const source of sources) {
    const dx = source.metricPoint.x - x;
    const dy = source.metricPoint.y - y;
    const distanceSquared = dx * dx + dy * dy;
    const localRadiusSquared = source.dataInfluenceRadius * source.dataInfluenceRadius;

    if (localRadiusSquared > 0 && distanceSquared <= localRadiusSquared) {
      density += source.weight * Math.exp((-3 * distanceSquared) / localRadiusSquared);
    }
  }

  return density;
}

function createHeatLayerSvg({
  blur,
  content,
  height,
  width,
}: {
  blur: number;
  content: string;
  height: number;
  width: number;
}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(
    height,
  )}" viewBox="0 0 ${roundSvgNumber(width)} ${roundSvgNumber(
    height,
  )}" preserveAspectRatio="none"><defs><filter id="heat-soften" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${roundSvgNumber(
    blur,
  )}" /></filter></defs><rect width="100%" height="100%" fill="transparent" /><g filter="url(#heat-soften)">${content}</g></svg>`;
}

function createSvgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function resolveHeatLayerInterpolatedColor(
  colorRamp: readonly HeatLayerColorStop[],
  weight: number,
) {
  if (colorRamp.length === 0) {
    return "#dc2626";
  }

  const sortedRamp = [...colorRamp].sort(([left], [right]) => left - right);
  const normalizedWeight = clamp(weight, 0, 1);
  const first = sortedRamp[0];

  if (!first || normalizedWeight <= first[0]) {
    return first?.[1] ?? "#dc2626";
  }

  for (let index = 1; index < sortedRamp.length; index += 1) {
    const previous = sortedRamp[index - 1]!;
    const next = sortedRamp[index]!;

    if (normalizedWeight > next[0]) {
      continue;
    }

    const previousColor = parseHeatLayerColor(previous[1]);
    const nextColor = parseHeatLayerColor(next[1]);

    if (!previousColor || !nextColor) {
      return resolveHeatLayerColor(colorRamp, normalizedWeight);
    }

    const progress =
      next[0] <= previous[0]
        ? 1
        : clamp((normalizedWeight - previous[0]) / (next[0] - previous[0]), 0, 1);

    return formatHeatLayerColor({
      alpha: previousColor.alpha + (nextColor.alpha - previousColor.alpha) * progress,
      blue: previousColor.blue + (nextColor.blue - previousColor.blue) * progress,
      green: previousColor.green + (nextColor.green - previousColor.green) * progress,
      red: previousColor.red + (nextColor.red - previousColor.red) * progress,
    });
  }

  return sortedRamp[sortedRamp.length - 1]?.[1] ?? "#dc2626";
}

type HeatLayerParsedColor = {
  alpha: number;
  blue: number;
  green: number;
  red: number;
};

function parseHeatLayerColor(color: string): HeatLayerParsedColor | null {
  const trimmedColor = color.trim();

  if (trimmedColor === "transparent") {
    return {
      alpha: 0,
      blue: 0,
      green: 0,
      red: 0,
    };
  }

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmedColor);

  if (hexMatch?.[1]) {
    const hex = hexMatch[1];
    const normalizedHex =
      hex.length === 3
        ? hex
            .split("")
            .map((channel) => `${channel}${channel}`)
            .join("")
        : hex;

    return {
      alpha: 1,
      blue: Number.parseInt(normalizedHex.slice(4, 6), 16),
      green: Number.parseInt(normalizedHex.slice(2, 4), 16),
      red: Number.parseInt(normalizedHex.slice(0, 2), 16),
    };
  }

  const rgbMatch =
    /^rgba?\(\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:(?:,|\s*\/\s*)\s*([0-9.]+))?\s*\)$/i.exec(
      trimmedColor,
    );

  if (!rgbMatch) {
    return null;
  }

  return {
    alpha: rgbMatch[4] === undefined ? 1 : clamp(Number(rgbMatch[4]), 0, 1),
    blue: clamp(Number(rgbMatch[3]), 0, 255),
    green: clamp(Number(rgbMatch[2]), 0, 255),
    red: clamp(Number(rgbMatch[1]), 0, 255),
  };
}

function formatHeatLayerColor(color: HeatLayerParsedColor) {
  return `rgba(${Math.round(clamp(color.red, 0, 255))}, ${Math.round(
    clamp(color.green, 0, 255),
  )}, ${Math.round(clamp(color.blue, 0, 255))}, ${roundSvgNumber(clamp(color.alpha, 0, 1))})`;
}

function escapeSvgAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function roundSvgNumber(value: number) {
  return Number(value.toFixed(3));
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

function resolveHeatLayerColor(colorRamp: readonly HeatLayerColorStop[], weight: number) {
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
