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
  getBoundsFromPoints,
  type IndexedMapPoint,
  type MapPoint,
  type MapPointFilter,
} from "./aggregation";
import {
  createInitialGlobeViewState,
  createGlobeGraticuleLines,
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
  type GlobeViewState,
  type MapDisplayMode,
  type MapViewState,
  type RasterMapStyle,
} from "./map-display";

export type PointMapFeature<TProperties = Record<string, unknown>> = {
  coordinates: [longitude: number, latitude: number];
  point: IndexedMapPoint<TProperties>;
};

export type PointMapProps<TProperties = Record<string, unknown>> = {
  className?: string;
  filterPoint?: MapPointFilter<TProperties>;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  getPointColor?: (feature: PointMapFeature<TProperties>) => string;
  getPointRadius?: (feature: PointMapFeature<TProperties>) => number;
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  onFeatureSelect?: (feature: PointMapFeature<TProperties> | null) => void;
  onMapReady?: (map: LeafletMap) => void;
  points: readonly MapPoint<TProperties>[];
  pointColor?: string;
  pointRadius?: number;
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
};

export type BubbleMapWeightAccessor<TProperties = Record<string, unknown>> = (
  point: IndexedMapPoint<TProperties>,
) => number;

export type BubbleMapFeature<TProperties = Record<string, unknown>> = PointMapFeature<TProperties> & {
  rawValue: number;
  radius: number;
  value: number;
};

export type BubbleMapProps<TProperties = Record<string, unknown>> = Omit<
  PointMapProps<TProperties>,
  "getPointColor" | "getPointRadius" | "onFeatureSelect" | "pointColor" | "pointRadius"
> & {
  bubbleColor?: string;
  getBubbleColor?: (feature: BubbleMapFeature<TProperties>) => string;
  getWeight?: BubbleMapWeightAccessor<TProperties>;
  maxRadius?: number;
  maxWeight?: number;
  minRadius?: number;
  onFeatureSelect?: (feature: BubbleMapFeature<TProperties> | null) => void;
  weightMetric?: string;
};

export function PointMap<TProperties = Record<string, unknown>>({
  mapDisplay = "flat",
  ...props
}: PointMapProps<TProperties>) {
  if (mapDisplay === "globe") {
    return <GlobePointMap {...props} mapDisplay={mapDisplay} />;
  }

  return <FlatPointMap {...props} mapDisplay={mapDisplay} />;
}

export function BubbleMap<TProperties = Record<string, unknown>>({
  mapDisplay = "flat",
  ...props
}: BubbleMapProps<TProperties>) {
  const pointProps = useBubbleMapPointProps(props);

  if (mapDisplay === "globe") {
    return <GlobePointMap {...pointProps} mapDisplay={mapDisplay} />;
  }

  return <FlatPointMap {...pointProps} mapDisplay={mapDisplay} />;
}

export function createPointMapFeatures<TProperties = Record<string, unknown>>(
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

export function createBubbleMapFeatures<TProperties = Record<string, unknown>>(
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

function FlatPointMap<TProperties = Record<string, unknown>>({
  className,
  filterPoint,
  fitBoundsPadding = 56,
  fitToData = true,
  getPointColor,
  getPointRadius,
  initialViewState,
  mapLabel = "Interactive point map",
  mapStyle = defaultRasterMapStyle,
  onFeatureSelect,
  onMapReady,
  points,
  pointColor = "#0f172a",
  pointRadius = 6,
  showAttributionControl = true,
  style,
}: PointMapProps<TProperties>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const overlayRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [isReady, setIsReady] = useState(false);
  const deferredPoints = useDeferredValue(points);
  const features = useMemo(
    () => createPointMapFeatures(deferredPoints, { filterPoint }),
    [deferredPoints, filterPoint],
  );

  const syncSource = useEffectEvent(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    const leaflet = leafletRef.current;

    if (!map || !overlay || !leaflet) {
      return;
    }

    renderPointOverlay({
      features,
      getPointColor,
      getPointRadius,
      handleClick,
      leaflet,
      map,
      overlay,
      pointColor,
      pointRadius,
    });
  });

  const handleClick = useEffectEvent((feature: PointMapFeature<TProperties> | null) => {
    startTransition(() => {
      onFeatureSelect?.(feature);
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

      overlayRef.current = leaflet.layerGroup().addTo(localMap);

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
        localMap.remove();
      }

      overlayRef.current = null;
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
  }, [deferredPoints, features, fitBoundsPadding, fitToData, initialViewState, syncSource]);

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

function GlobePointMap<TProperties = Record<string, unknown>>({
  className,
  filterPoint,
  fitToData = true,
  getPointColor,
  getPointRadius,
  initialViewState,
  mapLabel = "Interactive point map",
  onFeatureSelect,
  points,
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
            zoom: getGlobeZoom(current.zoom, event.deltaY),
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

function GlobePointFeature<TProperties>({
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

function renderPointOverlay<TProperties>({
  features,
  getPointColor,
  getPointRadius,
  handleClick,
  leaflet,
  map,
  overlay,
  pointColor,
  pointRadius,
}: {
  features: readonly PointMapFeature<TProperties>[];
  getPointColor?: (feature: PointMapFeature<TProperties>) => string;
  getPointRadius?: (feature: PointMapFeature<TProperties>) => number;
  handleClick: (feature: PointMapFeature<TProperties> | null) => void;
  leaflet: typeof import("leaflet");
  map: LeafletMap;
  overlay: LayerGroup;
  pointColor: string;
  pointRadius: number;
}) {
  overlay.clearLayers();

  for (const feature of features) {
    const marker = leaflet.circleMarker(toLeafletLatLng(feature.coordinates), {
      className: "mb-maps__point-marker",
      color: "#ffffff",
      fillColor: getPointColor?.(feature) ?? pointColor,
      fillOpacity: 0.92,
      opacity: 1,
      radius: Math.max(0, getPointRadius?.(feature) ?? pointRadius),
      weight: 2,
    });

    marker.on("click", () => {
      handleClick(feature);
    });
    marker.on("mouseover", () => {
      map.getContainer().style.cursor = "pointer";
    });
    marker.on("mouseout", () => {
      map.getContainer().style.cursor = "";
    });
    marker.addTo(overlay);
  }
}

function useBubbleMapPointProps<TProperties>(
  props: BubbleMapProps<TProperties>,
): PointMapProps<TProperties> {
  const {
    bubbleColor = "#2563eb",
    getBubbleColor,
    getWeight,
    maxRadius = 32,
    maxWeight,
    minRadius = 5,
    onFeatureSelect,
    weightMetric,
    ...pointProps
  } = props;
  const deferredPoints = useDeferredValue(pointProps.points);
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
    getPointColor(feature) {
      const bubbleFeature = featureById.get(feature.point.id);

      return bubbleFeature ? getBubbleColor?.(bubbleFeature) ?? bubbleColor : bubbleColor;
    },
    getPointRadius(feature) {
      return featureById.get(feature.point.id)?.radius ?? minRadius;
    },
    mapLabel: pointProps.mapLabel ?? "Interactive bubble map",
    onFeatureSelect(feature) {
      onFeatureSelect?.(feature ? featureById.get(feature.point.id) ?? null : null);
    },
    points: deferredPoints,
  };
}

function resolveBubbleMapPointWeight<TProperties>(
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
