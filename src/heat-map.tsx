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
import { defaultRasterMapStyle, type MapViewState, type RasterMapStyle } from "./clustered-map";

const HEAT_MAP_WEIGHT_METRIC = "__moritzbrantnerHeatMapWeight";

export type HeatMapWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type HeatMapColorStop = readonly [density: number, color: string];

export type HeatMapRadius =
  | number
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

export type HeatMapWeightOptions<TProperties = Record<string, unknown>> = {
  filterPoint?: MapPointFilter<TProperties>;
  getWeight?: HeatMapWeightAccessor<TProperties>;
  maxWeight?: number;
  weightMetric?: string;
};

export type HeatMapDensityIndexOptions<TProperties = Record<string, unknown>> =
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

export type HeatMapProps<TProperties = Record<string, unknown>> =
  HeatMapWeightOptions<TProperties> & {
    className?: string;
    fitBoundsPadding?: number;
    fitToData?: boolean;
    heatmapAggregationMaxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
    heatmapAggregationMinZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
    heatmapAggregationRadius?: PointAggregationIndexOptions<TProperties>["radius"];
    heatmapColorRamp?: readonly HeatMapColorStop[];
    heatmapIntensity?: number;
    heatmapMaxZoom?: number;
    heatmapOpacity?: number;
    heatmapRadius?: HeatMapRadius;
    initialViewState?: MapViewState;
    mapLabel?: string;
    mapStyle?: string | RasterMapStyle;
    onMapReady?: (map: LeafletMap) => void;
    points: readonly MapPoint<TProperties>[];
    showAttributionControl?: boolean;
    style?: React.CSSProperties;
  };

const defaultHeatMapColorRamp = [
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
] as const satisfies readonly HeatMapColorStop[];

export function HeatMap<TProperties = Record<string, unknown>>({
  className,
  filterPoint,
  fitBoundsPadding = 56,
  fitToData = true,
  heatmapAggregationMaxZoom,
  heatmapAggregationMinZoom,
  heatmapAggregationRadius = 56,
  getWeight,
  heatmapColorRamp = defaultHeatMapColorRamp,
  heatmapIntensity = 1,
  heatmapMaxZoom = 16,
  heatmapOpacity = 0.84,
  heatmapRadius = {
    max: 42,
    min: 12,
  },
  initialViewState,
  mapLabel = "Interactive heat map",
  mapStyle = defaultRasterMapStyle,
  maxWeight,
  onMapReady,
  points,
  showAttributionControl = true,
  style,
  weightMetric,
}: HeatMapProps<TProperties>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const heatLayerRef = useRef<LayerGroup | null>(null);
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

  const syncSource = useEffectEvent(() => {
    const map = mapRef.current;
    const heatLayer = heatLayerRef.current;
    const leaflet = leafletRef.current;

    if (!map || !heatLayer || !leaflet) {
      return;
    }

    const bounds = map.getBounds();
    const query: ViewportAggregationQuery = {
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      zoom: map.getZoom(),
    };

    renderHeatOverlay({
      colorRamp: heatmapColorRamp,
      data: densityIndex.getFeatureCollection(query),
      intensity: heatmapIntensity,
      layer: heatLayer,
      leaflet,
      map,
      maxZoom: heatmapMaxZoom,
      opacity: heatmapOpacity,
      radius: heatmapRadius,
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

      heatLayerRef.current = leaflet.layerGroup().addTo(localMap);
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
  }, [deferredPoints, densityIndex, fitBoundsPadding, fitToData, initialViewState, syncSource]);

  return (
    <div
      aria-label={mapLabel}
      className={joinClassNames("mb-maps", className)}
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

export function createHeatMapFeatureCollection<TProperties = Record<string, unknown>>(
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

export function createHeatMapDensityIndex<TProperties = Record<string, unknown>>(
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

export function getHeatMapMaxWeight<TProperties = Record<string, unknown>>(
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

export function resolveHeatMapPointWeight<TProperties = Record<string, unknown>>(
  point: IndexedMapPoint<TProperties>,
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight"> = {},
) {
  const rawWeight = getRawHeatMapPointWeight(point, options);

  if (!Number.isFinite(rawWeight)) {
    return 0;
  }

  return Math.max(0, rawWeight);
}

function renderHeatOverlay({
  colorRamp,
  data,
  intensity,
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
      resolveHeatMapRadius(radius, map.getZoom()) *
      Math.max(0.35, Math.sqrt(normalizedWeight)) *
      Math.max(0, intensity);

    leaflet
      .circleMarker([latitude, longitude], {
        className: "mb-maps__heat-marker",
        color: "transparent",
        fillColor: resolveHeatMapColor(colorRamp, normalizedWeight),
        fillOpacity: safeOpacity * Math.min(1, 0.35 + normalizedWeight * 0.65),
        opacity: 0,
        radius: markerRadius,
        weight: 0,
      })
      .addTo(layer);
  }
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

function getRawHeatMapPointWeight<TProperties>(
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

function resolveTileLayerOptions(mapStyle: string | RasterMapStyle) {
  if (typeof mapStyle === "string") {
    return {
      options: {
        attribution: defaultRasterMapStyle.attribution,
      },
      url: mapStyle,
    };
  }

  const tiles = mapStyle.tiles ?? defaultRasterMapStyle.tiles;

  if (tiles === false) {
    return null;
  }

  const url = Array.isArray(tiles) ? tiles[0] : tiles;

  return {
    options: {
      attribution: mapStyle.attribution ?? defaultRasterMapStyle.attribution,
      maxZoom: typeof mapStyle.maxZoom === "number" ? mapStyle.maxZoom : undefined,
      minZoom: typeof mapStyle.minZoom === "number" ? mapStyle.minZoom : undefined,
      tileSize: typeof mapStyle.tileSize === "number" ? mapStyle.tileSize : undefined,
    },
    url: url ?? String(defaultRasterMapStyle.tiles),
  };
}

function resolveHeatMapRadius(radius: HeatMapRadius, zoom: number) {
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

function toLeafletLatLng([longitude, latitude]: [number, number]) {
  return [latitude, longitude] as [number, number];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
