"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { LayerGroup, Map as FlatMap, PathOptions } from "flat";

import {
  createPointAggregationIndex,
  getBoundsFromPoints,
  type AggregatedMapFeature,
  type MapPointFilter,
  type MapPoint,
  type PointAggregationIndex,
  type PointAggregationIndexOptions,
  type ViewportAggregationQuery,
  type VisibleAggregationSummary,
} from "./aggregation";
import {
  createGeoJsonOverlayFeatureCollection,
  createMapPointsFromGeoJson,
  getBoundsFromGeoJson,
  mergeMapDataBounds,
  type GeoJsonMapSource,
  type GeoJsonOverlayMode,
  type GeoJsonSourceOptions,
} from "./geojson-source";
import { createProjectedClusterVoronoiGeometry } from "./cluster-area";
import {
  assignClusterAreaColors,
  createBoundaryLineColor,
  createClusterAreaSubjects,
  getClusterAreaId,
} from "./cluster-area-visuals";
import {
  createGlobalViewportQuery,
  createGlobeGraticuleLines,
  createInitialGlobeViewState,
  createVisibleSvgPath,
  defaultRasterMapStyle,
  escapeHtml,
  getGlobeDragCenter,
  getGlobeRadius,
  getGlobeZoom,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  joinClassNames,
  projectGlobeCoordinate,
  resolveTileLayerOptions,
  toLatLng,
  type GlobeBasemapMode,
  type GlobeViewState,
  type MapBounds,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeContext,
  type MapViewStateChangeReason,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import { ClusterLayer } from "./cluster-layer";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapView } from "./map-view";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import { useFlatBeeLineMeasurementLayer } from "./measurement-layer";
import type { MapMeasurementProps } from "./measurement";
import type { TemporalGeoJsonGeometryFeatureCollection } from "./temporal-geojson-types";

export type ClusteredMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = {
  children?: React.ReactNode;
  className?: string;
  clusterRadius?: PointAggregationIndexOptions<TProperties>["radius"];
  filterPoint?: MapPointFilter<TProperties>;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  geoJson?: GeoJsonMapSource<TProperties>;
  geoJsonOptions?: GeoJsonSourceOptions<TProperties>;
  geoJsonOverlay?: GeoJsonOverlayMode;
  geoJsonOverlayCollection?: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
  globeBasemapMode?: GlobeBasemapMode;
  initialViewState?: MapViewState;
  mapDisplay?: MapDisplayMode;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
  minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
  onFeatureSelect?: (feature: AggregatedMapFeature<TProperties> | null) => void;
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: import("maplibre-gl").Map) => void;
  onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void;
  points?: readonly MapPoint<TProperties>[];
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
} & MapMeasurementProps &
  Omit<MapViewportProps, "maxZoom"> &
  MapFeatureInteractionProps<AggregatedMapFeature<TProperties>>;

const MAX_CLUSTER_AREA_FEATURES = 160;

type ClusterAreaFeatureResult = {
  areaFeatures: Array<
    ReturnType<typeof createClusterAreaFeature> | ReturnType<typeof createClusterAreaBoundaryFeature>
  >;
  colorsByAreaId: Map<string, string>;
};

type ClusterAreaFeatureCache = {
  key: string;
  result: ClusterAreaFeatureResult;
};

export {
  defaultRasterMapStyle,
  type MapDisplayMode,
  type GlobeBasemapMode,
  type MapBounds,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeContext,
  type MapViewStateChangeReason,
  type MapViewportProps,
  type RasterMapStyle,
};

export function ClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  {
    children,
    className,
    fitBoundsPadding = 56,
    fitToData = true,
    initialViewState,
    mapDisplay = "flat",
    mapLabel = "Interactive map",
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
    globeBasemapMode,
    maxBounds,
    showAttributionControl = true,
    style,
    viewState,
    defaultViewState,
    onViewStateChange,
    ...props
  }: ClusteredMapProps<TProperties>,
) {
  const resolvedPoints = points ?? (geoJson ? createMapPointsFromGeoJson(geoJson, geoJsonOptions) : []);
  const resolvedGeoJsonOverlayCollection =
    geoJsonOverlayCollection ??
    (geoJson
      ? createGeoJsonOverlayFeatureCollection(geoJson, {
          mode: geoJsonOverlay,
          target: "point",
        })
      : null);
  const dataBounds = mergeMapDataBounds(
    geoJson ? getBoundsFromGeoJson(geoJson) : getBoundsFromPoints(resolvedPoints),
    resolvedGeoJsonOverlayCollection ? getBoundsFromGeoJson(resolvedGeoJsonOverlayCollection) : null,
  );

  return (
    <MapView
      className={className}
      dataBounds={dataBounds}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      globeBasemapMode={globeBasemapMode}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
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
      <ClusterLayer {...(props as React.ComponentProps<typeof ClusterLayer<TProperties>>)} points={resolvedPoints} />
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

export function FlatClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  mapDisplay: _mapDisplay,
  ...props
}: ClusteredMapProps<TProperties>) {
  return <ClusteredMap {...props} mapDisplay="flat" />;
}

export function GlobeClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  className,
  clusterRadius,
  filterPoint,
  fitToData = true,
  initialViewState,
  mapLabel = "Interactive map",
  measurementDistanceFormat: _measurementDistanceFormat,
  measurementDraftLineColor: _measurementDraftLineColor,
  measurementLineColor: _measurementLineColor,
  measurementMode: _measurementMode,
  measurements: _measurements,
  maxZoom,
  minZoom,
  onFeatureSelect,
  onMeasurementCreate: _onMeasurementCreate,
  onMeasurementDraftChange: _onMeasurementDraftChange,
  onMeasurementSelect: _onMeasurementSelect,
  onViewportAggregationChange,
  points = [],
  style,
}: ClusteredMapProps<TProperties>) {
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
  const lastViewportSummaryKeyRef = useRef<string | null>(null);
  const index = useMemo(
    () =>
      createPointAggregationIndex(deferredPoints, {
        filterPoint,
        maxZoom,
        minZoom,
        radius: clusterRadius,
      }),
    [clusterRadius, deferredPoints, filterPoint, maxZoom, minZoom],
  );
  const query = useMemo(() => createGlobalViewportQuery(viewState.zoom), [viewState.zoom]);
  const aggregation = useMemo(() => index.getViewportAggregation(query), [index, query]);

  useEffect(() => {
    if (initialViewState || !fitToData) {
      return;
    }

    setViewState(createInitialGlobeViewState({ fitToData, initialViewState, points: deferredPoints }));
  }, [deferredPoints, fitToData, initialViewState]);

  useEffect(() => {
    const nextSummaryKey = serializeVisibleAggregationSummary(aggregation.summary);

    if (lastViewportSummaryKeyRef.current === nextSummaryKey) {
      return;
    }

    lastViewportSummaryKeyRef.current = nextSummaryKey;
    startTransition(() => {
      onViewportAggregationChange?.(aggregation.summary);
    });
  }, [aggregation.summary, onViewportAggregationChange]);

  const handleFeatureClick = useEffectEvent((feature: AggregatedMapFeature<TProperties>) => {
    if (feature.kind === "cluster") {
      setViewState((current) => ({
        center: feature.coordinates,
        zoom: Math.min(8, Math.max(current.zoom + 0.8, feature.expansionZoom)),
      }));
    }

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
        <GlobeBase viewState={viewState} />
        <g className="mb-maps__globe-features">
          {aggregation.features.map((feature) => (
            <GlobeAggregationFeature
              feature={feature}
              key={feature.kind === "cluster" ? `cluster-${feature.clusterId}` : feature.point.id}
              onClick={handleFeatureClick}
              viewState={viewState}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function GlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
      <defs>
        <radialGradient id="mb-maps-globe-ocean" cx="38%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#dbeafe" />
          <stop offset="58%" stopColor="#67e8f9" />
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

function GlobeAggregationFeature<TProperties>({
  feature,
  onClick,
  viewState,
}: {
  feature: AggregatedMapFeature<TProperties>;
  onClick: (feature: AggregatedMapFeature<TProperties>) => void;
  viewState: GlobeViewState;
}) {
  const projected = projectGlobeCoordinate(feature.coordinates, viewState);

  if (!projected.visible) {
    return null;
  }

  if (feature.kind === "cluster") {
    const radius = getClusterRadius(feature.pointCount) * (0.72 + projected.scale * 0.28);

    return (
      <g
        className="mb-maps__globe-cluster"
        onClick={(event) => {
          event.stopPropagation();
          onClick(feature);
        }}
        style={{ opacity: 0.38 + projected.scale * 0.62 }}
      >
        <title>{feature.pointCountAbbreviated}</title>
        <circle
          cx={projected.x}
          cy={projected.y}
          fill={getClusterColor(feature.pointCount)}
          r={radius}
        />
        <text x={projected.x} y={projected.y}>
          {feature.pointCountAbbreviated}
        </text>
      </g>
    );
  }

  return (
    <circle
      className="mb-maps__globe-point"
      cx={projected.x}
      cy={projected.y}
      onClick={(event) => {
        event.stopPropagation();
        onClick(feature);
      }}
      r={6 * (0.72 + projected.scale * 0.28)}
      style={{ opacity: 0.42 + projected.scale * 0.58 }}
    >
      <title>{feature.point.label}</title>
    </circle>
  );
}

function renderAggregationOverlay<TProperties>({
  clusterAreaCache,
  features,
  handleClick,
  index,
  isMeasuring,
  flat,
  map,
  overlay,
}: {
  clusterAreaCache: MutableRefObject<ClusterAreaFeatureCache | null>;
  features: readonly AggregatedMapFeature<TProperties>[];
  handleClick: (feature: AggregatedMapFeature<TProperties> | null) => void;
  index: PointAggregationIndex<TProperties>;
  isMeasuring: boolean;
  flat: typeof import("flat");
  map: FlatMap;
  overlay: LayerGroup;
}) {
  overlay.clearLayers();

  const areaFeatures = createClusterAreaFeatures(features, index, map, clusterAreaCache);

  for (const areaFeature of areaFeatures.areaFeatures) {
    addClusterAreaLayer(areaFeature, isMeasuring, flat, overlay);
  }

  for (const feature of features) {
    const clusterColor = areaFeatures.colorsByAreaId.get(getClusterAreaId(feature)) ?? null;

    if (feature.kind === "cluster") {
      addClusterMarker(feature, clusterColor, isMeasuring, flat, map, overlay, handleClick);
      continue;
    }

    addPointMarker(feature, clusterColor, isMeasuring, flat, map, overlay, handleClick);
  }
}

function addClusterMarker<TProperties>(
  feature: Extract<AggregatedMapFeature<TProperties>, { kind: "cluster" }>,
  clusterColor: string | null,
  isMeasuring: boolean,
  flat: typeof import("flat"),
  map: FlatMap,
  overlay: LayerGroup,
  handleClick: (feature: AggregatedMapFeature<TProperties>) => void,
) {
  const marker = flat.circleMarker(toLatLng(feature.coordinates), {
    className: "mb-maps__cluster-marker",
    color: "#ffffff",
    fillColor: clusterColor ?? getClusterColor(feature.pointCount),
    fillOpacity: 0.9,
    interactive: !isMeasuring,
    opacity: 1,
    radius: getClusterRadius(feature.pointCount),
    weight: 2,
  });

  if (!isMeasuring) {
    marker.on("click", () => {
      map.setView(toLatLng(feature.coordinates), feature.expansionZoom);
      handleClick(feature);
    });
    marker.on("mouseover", () => {
      map.getContainer().style.cursor = "pointer";
    });
    marker.on("mouseout", () => {
      map.getContainer().style.cursor = "";
    });
  }
  marker.addTo(overlay);

  flat
    .marker(toLatLng(feature.coordinates), {
      icon: flat.divIcon({
        className: "mb-maps__cluster-count",
        html: escapeHtml(feature.pointCountAbbreviated),
        iconAnchor: [18, 18],
        iconSize: [36, 36],
      }),
      interactive: false,
    })
    .addTo(overlay);
}

function addPointMarker<TProperties>(
  feature: Extract<AggregatedMapFeature<TProperties>, { kind: "point" }>,
  clusterColor: string | null,
  isMeasuring: boolean,
  flat: typeof import("flat"),
  map: FlatMap,
  overlay: LayerGroup,
  handleClick: (feature: AggregatedMapFeature<TProperties>) => void,
) {
  const marker = flat.circleMarker(toLatLng(feature.coordinates), {
    className: "mb-maps__point-marker",
    color: "#ffffff",
    fillColor: clusterColor ?? "#0f172a",
    fillOpacity: 0.92,
    interactive: !isMeasuring,
    opacity: 1,
    radius: 6,
    weight: 2,
  });

  if (!isMeasuring) {
    marker.on("click", () => {
      handleClick(feature);
    });
    marker.on("mouseover", () => {
      map.getContainer().style.cursor = "pointer";
    });
    marker.on("mouseout", () => {
      map.getContainer().style.cursor = "";
    });
  }
  marker.addTo(overlay);
}

function addClusterAreaLayer(
  feature:
    | ReturnType<typeof createClusterAreaFeature>
    | ReturnType<typeof createClusterAreaBoundaryFeature>,
  isMeasuring: boolean,
  flat: typeof import("flat"),
  overlay: LayerGroup,
) {
  if ("lineColor" in feature.properties) {
    const coordinates = feature.geometry.coordinates as Array<[number, number]>;

    flat
      .polyline(coordinates.map(toLatLng), {
        className: "mb-maps__cluster-area-boundary",
        color: feature.properties.lineColor,
        interactive: !isMeasuring,
        opacity: 0.9,
        weight: 2,
      })
      .addTo(overlay);
    return;
  }

  const areaFeature = feature as ReturnType<typeof createClusterAreaFeature>;
  const options: PathOptions = {
    className: "mb-maps__cluster-area",
    color: "transparent",
    fillColor: areaFeature.properties.clusterColor,
    fillOpacity: 0.56,
    interactive: false,
    weight: 0,
  };

  if (areaFeature.geometry.type === "MultiPolygon") {
    flat
      .polygon(
        areaFeature.geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(toLatLng)),
        ),
        options,
      )
      .addTo(overlay);
    return;
  }

  flat
    .polygon(
      areaFeature.geometry.coordinates.map((ring) => ring.map(toLatLng)),
      options,
    )
    .addTo(overlay);
}

function createClusterAreaFeatures<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  index: PointAggregationIndex<TProperties>,
  map: FlatMap,
  cache: MutableRefObject<ClusterAreaFeatureCache | null>,
): ClusterAreaFeatureResult {
  const viewportWidth = map.getContainer().clientWidth;
  const viewportHeight = map.getContainer().clientHeight;

  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { areaFeatures: [], colorsByAreaId: new Map<string, string>() };
  }

  if (features.length > MAX_CLUSTER_AREA_FEATURES) {
    return { areaFeatures: [], colorsByAreaId: new Map<string, string>() };
  }

  const cacheKey = serializeClusterAreaFeatureCacheKey(features, map, viewportWidth, viewportHeight);
  const cached = cache.current;

  if (cached?.key === cacheKey) {
    return cached.result;
  }

  const subjects = createClusterAreaSubjects(features, index);

  if (subjects.length === 0) {
    return { areaFeatures: [], colorsByAreaId: new Map<string, string>() };
  }

  const subjectByAreaId = new globalThis.Map(
    subjects.map((subject) => [subject.areaId, subject] as const),
  );
  const projectedInputs = subjects.flatMap((subject) =>
    subject.sampleCoordinates.map((coordinates) => ({
      clusterId: subject.areaId,
      coordinates,
    })),
  );
  const geometry = createProjectedClusterVoronoiGeometry(projectedInputs, {
    includeOuterEdges: false,
    project(coordinate) {
      const point = map.latLngToContainerPoint(toLatLng(coordinate));
      return [point.x, point.y];
    },
    unproject(coordinate) {
      const point = map.containerPointToLatLng(coordinate);
      return [point.lng, point.lat];
    },
    viewportBounds: [-24, -24, viewportWidth + 24, viewportHeight + 24],
  });
  const colorsByAreaId = assignClusterAreaColors(
    subjects.map((subject) => subject.areaId),
    geometry.boundarySegments,
  );
  const areaFeatures = geometry.regions
    .map((region) => {
      const subject = subjectByAreaId.get(String(region.clusterId));

      if (!subject || region.polygons.length === 0) {
        return null;
      }

      return createClusterAreaFeature(
        subject,
        region.polygons,
        colorsByAreaId.get(subject.areaId) ?? "#2563eb",
      );
    })
    .filter(isDefined);
  const boundaryFeatures = geometry.boundarySegments.map((segment) =>
    createClusterAreaBoundaryFeature(
      segment.coordinates,
      segment.clusterIds
        .filter((clusterId): clusterId is string => typeof clusterId === "string")
        .map((clusterId) => subjectByAreaId.get(clusterId)?.pointCount ?? 0),
      createBoundaryLineColor(segment.clusterIds, colorsByAreaId),
    ),
  );

  const result = {
    areaFeatures: [...areaFeatures, ...boundaryFeatures],
    colorsByAreaId,
  };

  cache.current = {
    key: cacheKey,
    result,
  };

  return result;
}

function serializeClusterAreaFeatureCacheKey<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  map: FlatMap,
  viewportWidth: number,
  viewportHeight: number,
) {
  return JSON.stringify({
    features: features.map((feature) => {
      if (feature.kind === "cluster") {
        return [
          "cluster",
          feature.clusterId,
          Number(feature.coordinates[0].toFixed(6)),
          Number(feature.coordinates[1].toFixed(6)),
          feature.pointCount,
          feature.expansionZoom,
        ];
      }

      return [
        "point",
        feature.point.id,
        Number(feature.coordinates[0].toFixed(6)),
        Number(feature.coordinates[1].toFixed(6)),
      ];
    }),
    viewportHeight,
    viewportWidth,
    zoom: Number(map.getZoom().toFixed(6)),
  });
}

function createClusterAreaFeature(
  feature: {
    areaId: string;
    pointCount: number;
  },
  polygons: Array<Array<Array<[number, number]>>>,
  clusterColor: string,
) {
  if (polygons.length > 1) {
    return {
      type: "Feature" as const,
      properties: {
        kind: "cluster-area",
        clusterColor,
        clusterId: feature.areaId,
        pointCount: feature.pointCount,
      },
      geometry: {
        type: "MultiPolygon" as const,
        coordinates: polygons,
      },
    };
  }

  return {
    type: "Feature" as const,
    properties: {
      kind: "cluster-area",
      clusterColor,
      clusterId: feature.areaId,
      pointCount: feature.pointCount,
    },
    geometry: {
      type: "Polygon" as const,
      coordinates: polygons[0]!,
    },
  };
}

function createClusterAreaBoundaryFeature(
  coordinates: Array<[number, number]>,
  pointCounts: readonly number[],
  lineColor: string,
) {
  return {
    type: "Feature" as const,
    properties: {
      kind: "cluster-area-boundary",
      lineColor,
      pointCount: Math.max(...pointCounts, 0),
    },
    geometry: {
      type: "LineString" as const,
      coordinates,
    },
  };
}

function getClusterColor(pointCount: number) {
  if (pointCount >= 2_500) {
    return "#ea580c";
  }

  if (pointCount >= 250) {
    return "#7c3aed";
  }

  if (pointCount >= 25) {
    return "#0284c7";
  }

  return "#0f766e";
}

function getClusterRadius(pointCount: number) {
  if (pointCount >= 2_500) {
    return 42;
  }

  if (pointCount >= 250) {
    return 32;
  }

  if (pointCount >= 25) {
    return 24;
  }

  return 18;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function serializeVisibleAggregationSummary(summary: VisibleAggregationSummary) {
  return JSON.stringify({
    bounds: summary.bounds.map((value) => Number(value.toFixed(6))),
    metrics: Object.entries(summary.metrics)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, Number(value.toFixed(6))]),
    visibleClusterCount: summary.visibleClusterCount,
    visiblePointCount: summary.visiblePointCount,
    visibleUnclusteredCount: summary.visibleUnclusteredCount,
    zoom: Number(summary.zoom.toFixed(6)),
  });
}
