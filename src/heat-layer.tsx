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

export type HeatLayerWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatLayerSurfaceMode = "data" | "interpolated";

export type HeatLayerRadius =
  | number
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
    max: 42,
    min: 12,
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
  const densityIndex = useMemo(
    () =>
      createHeatLayerDensityIndex(deferredPoints, {
        filterPoint,
        getWeight,
        maxWeight,
        maxZoom: heatmapAggregationMaxZoom ?? heatmapMaxZoom,
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

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer(resolvedLayerId, ({ layer, leaflet, map }) => {
      layer.clearLayers();

      if (map.getZoom() > heatmapMaxZoom) {
        return;
      }

      const bounds = map.getBounds();
      const data = densityIndex.getFeatureCollection({
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        zoom: map.getZoom(),
      });

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
    densityIndex,
    heatmapColorRamp,
    heatmapIntensity,
    heatmapMaxZoom,
    heatmapOpacity,
    heatmapRadius,
    heatmapSurfaceMode,
    resolvedLayerId,
    surface,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  const data = densityIndex.getFeatureCollection({
    bounds: [-180, -90, 180, 90],
    zoom: surface.viewState.zoom,
  });

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
            const markerRadius =
              resolveHeatLayerRadius(heatmapRadius, surface.viewState.zoom) *
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
  const baseRadius = resolveHeatLayerRadius(radius, map.getZoom()) * Math.max(0, intensity);
  const influenceRadius = Math.max(24, baseRadius * 2.6);
  const safeOpacity = clamp(opacity, 0, 1);
  const sources = data.features
    .map((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      const point = map.latLngToContainerPoint(toLeafletLatLng([longitude, latitude]));

      return {
        point,
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0);

  if (width <= 0 || height <= 0 || sources.length === 0 || influenceRadius <= 0) {
    return;
  }

  const northWest = map.containerPointToLatLng([0, 0]);
  const southEast = map.containerPointToLatLng([width, height]);
  const svg =
    mode === "data"
      ? createHeatLayerDataSurfaceSvg({
          colorRamp,
          height,
          influenceRadius,
          sources,
          width,
        })
      : createHeatLayerInterpolatedSurfaceSvg({
          colorRamp,
          height,
          influenceRadius,
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
  influenceRadius,
  sources,
  width,
}: {
  colorRamp: readonly HeatLayerColorStop[];
  height: number;
  influenceRadius: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}) {
  const blur = Math.max(6, influenceRadius * 0.16);
  const circles = sources
    .map((source) => {
      const normalizedWeight = clamp(source.weight, 0, 1);
      const radius = influenceRadius * (0.42 + Math.sqrt(normalizedWeight) * 0.5);
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
  influenceRadius,
  sources,
  width,
}: {
  colorRamp: readonly HeatLayerColorStop[];
  height: number;
  influenceRadius: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}) {
  const cellSize = resolveHeatLayerSampleSize(width, height, influenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;

  for (let y = startY; y < endY; y += cellSize) {
    for (let x = startX; x < endX; x += cellSize) {
      const centerX = x + cellSize / 2;
      const centerY = y + cellSize / 2;
      const density = getHeatLayerCellDensity(sources, centerX, centerY, influenceRadius);

      if (density > 0) {
        cells.push({ density, x: centerX, y: centerY });
      }
    }
  }

  const maxDensity = Math.max(1, ...cells.map((cell) => cell.density));
  const sampleRadius = cellSize * 1.15;
  const circles = cells
    .map((cell) => {
      const normalizedDensity = clamp(cell.density / maxDensity, 0, 1);

      if (normalizedDensity < 0.015) {
        return "";
      }

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

type HeatLayerSurfaceSource = {
  point: {
    x: number;
    y: number;
  };
  weight: number;
};

function getHeatLayerCellDensity(
  sources: readonly HeatLayerSurfaceSource[],
  x: number,
  y: number,
  influenceRadius: number,
) {
  const radiusSquared = influenceRadius * influenceRadius;
  let density = 0;

  for (const source of sources) {
    const dx = source.point.x - x;
    const dy = source.point.y - y;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared > radiusSquared) {
      continue;
    }

    const falloff = Math.exp((-3 * distanceSquared) / radiusSquared);
    density += source.weight * falloff;
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
      next[0] <= previous[0] ? 1 : clamp((normalizedWeight - previous[0]) / (next[0] - previous[0]), 0, 1);

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
        Object.entries(feature.metrics).filter(([metricKey]) => metricKey !== HEAT_MAP_WEIGHT_METRIC),
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
      ? point.metrics[options.weightMetric] ?? 0
      : point.metrics.weight ?? 1;

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
}

function resolveHeatLayerRadius(radius: HeatLayerRadius, zoom: number) {
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
