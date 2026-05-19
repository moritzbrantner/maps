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
import type { LayerGroup, Map as LeafletMap, PathOptions, TileLayerOptions } from "leaflet";

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
import { createProjectedClusterVoronoiGeometry } from "./cluster-area";
import {
  assignClusterAreaColors,
  createBoundaryLineColor,
  createClusterAreaSubjects,
  getClusterAreaId,
} from "./cluster-area-visuals";

export type MapViewState = {
  center: [longitude: number, latitude: number];
  zoom: number;
};

export type RasterMapStyle = {
  attribution?: string;
  maxZoom?: number;
  minZoom?: number;
  tileSize?: number;
  tiles?: string | readonly string[] | false;
} & Record<string, unknown>;

export type ClusteredMapProps<TProperties = Record<string, unknown>> = {
  className?: string;
  clusterRadius?: PointAggregationIndexOptions<TProperties>["radius"];
  filterPoint?: MapPointFilter<TProperties>;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  initialViewState?: MapViewState;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  maxZoom?: PointAggregationIndexOptions<TProperties>["maxZoom"];
  minZoom?: PointAggregationIndexOptions<TProperties>["minZoom"];
  onFeatureSelect?: (feature: AggregatedMapFeature<TProperties> | null) => void;
  onMapReady?: (map: LeafletMap) => void;
  onViewportAggregationChange?: (summary: VisibleAggregationSummary) => void;
  points: readonly MapPoint<TProperties>[];
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
};

export const defaultRasterMapStyle: RasterMapStyle = {
  attribution: "\u00a9 OpenStreetMap contributors",
  tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileSize: 256,
};

const MAX_CLUSTER_AREA_FEATURES = 160;

export function ClusteredMap<TProperties = Record<string, unknown>>({
  className,
  clusterRadius,
  filterPoint,
  fitBoundsPadding = 56,
  fitToData = true,
  initialViewState,
  mapLabel = "Interactive map",
  mapStyle = defaultRasterMapStyle,
  maxZoom,
  minZoom,
  onFeatureSelect,
  onMapReady,
  onViewportAggregationChange,
  points,
  showAttributionControl = true,
  style,
}: ClusteredMapProps<TProperties>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const overlayRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const lastViewportSummaryKeyRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const deferredPoints = useDeferredValue(points);
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

  const syncSource = useEffectEvent(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    const leaflet = leafletRef.current;

    if (!map || !overlay || !leaflet) {
      return;
    }

    const bounds = map.getBounds();
    const query: ViewportAggregationQuery = {
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      zoom: map.getZoom(),
    };
    const aggregation = index.getViewportAggregation(query);

    renderAggregationOverlay({
      features: aggregation.features,
      handleClick,
      index,
      leaflet,
      map,
      overlay,
    });

    const nextSummaryKey = serializeVisibleAggregationSummary(aggregation.summary);

    if (lastViewportSummaryKeyRef.current === nextSummaryKey) {
      return;
    }

    lastViewportSummaryKeyRef.current = nextSummaryKey;
    startTransition(() => {
      onViewportAggregationChange?.(aggregation.summary);
    });
  });

  const handleClick = useEffectEvent((feature: AggregatedMapFeature<TProperties> | null) => {
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
      lastViewportSummaryKeyRef.current = null;
      setIsReady(false);

      if (localMap) {
        localMap.off("moveend", syncSource);
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
  }, [deferredPoints, fitBoundsPadding, fitToData, index, initialViewState, syncSource]);

  return (
    <div
      aria-label={mapLabel}
      data-map-ready={isReady ? "true" : "false"}
      className={joinClassNames("mb-maps", className)}
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

function renderAggregationOverlay<TProperties>({
  features,
  handleClick,
  index,
  leaflet,
  map,
  overlay,
}: {
  features: readonly AggregatedMapFeature<TProperties>[];
  handleClick: (feature: AggregatedMapFeature<TProperties> | null) => void;
  index: PointAggregationIndex<TProperties>;
  leaflet: typeof import("leaflet");
  map: LeafletMap;
  overlay: LayerGroup;
}) {
  overlay.clearLayers();

  const areaFeatures = createClusterAreaFeatures(features, index, map);

  for (const areaFeature of areaFeatures.areaFeatures) {
    addClusterAreaLayer(areaFeature, leaflet, overlay);
  }

  for (const feature of features) {
    const clusterColor = areaFeatures.colorsByAreaId.get(getClusterAreaId(feature)) ?? null;

    if (feature.kind === "cluster") {
      addClusterMarker(feature, clusterColor, leaflet, map, overlay, handleClick);
      continue;
    }

    addPointMarker(feature, clusterColor, leaflet, map, overlay, handleClick);
  }
}

function addClusterMarker<TProperties>(
  feature: Extract<AggregatedMapFeature<TProperties>, { kind: "cluster" }>,
  clusterColor: string | null,
  leaflet: typeof import("leaflet"),
  map: LeafletMap,
  overlay: LayerGroup,
  handleClick: (feature: AggregatedMapFeature<TProperties>) => void,
) {
  const marker = leaflet.circleMarker(toLeafletLatLng(feature.coordinates), {
    className: "mb-maps__cluster-marker",
    color: "#ffffff",
    fillColor: clusterColor ?? getClusterColor(feature.pointCount),
    fillOpacity: 0.9,
    opacity: 1,
    radius: getClusterRadius(feature.pointCount),
    weight: 2,
  });

  marker.on("click", () => {
    map.setView(toLeafletLatLng(feature.coordinates), feature.expansionZoom, {
      animate: false,
    });
    handleClick(feature);
  });
  marker.on("mouseover", () => {
    map.getContainer().style.cursor = "pointer";
  });
  marker.on("mouseout", () => {
    map.getContainer().style.cursor = "";
  });
  marker.addTo(overlay);

  leaflet
    .marker(toLeafletLatLng(feature.coordinates), {
      icon: leaflet.divIcon({
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
  leaflet: typeof import("leaflet"),
  map: LeafletMap,
  overlay: LayerGroup,
  handleClick: (feature: AggregatedMapFeature<TProperties>) => void,
) {
  const marker = leaflet.circleMarker(toLeafletLatLng(feature.coordinates), {
    className: "mb-maps__point-marker",
    color: "#ffffff",
    fillColor: clusterColor ?? "#0f172a",
    fillOpacity: 0.92,
    opacity: 1,
    radius: 6,
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

function addClusterAreaLayer(
  feature:
    | ReturnType<typeof createClusterAreaFeature>
    | ReturnType<typeof createClusterAreaBoundaryFeature>,
  leaflet: typeof import("leaflet"),
  overlay: LayerGroup,
) {
  if ("lineColor" in feature.properties) {
    const coordinates = feature.geometry.coordinates as Array<[number, number]>;

    leaflet
      .polyline(coordinates.map(toLeafletLatLng), {
        className: "mb-maps__cluster-area-boundary",
        color: feature.properties.lineColor,
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
    leaflet
      .polygon(
        areaFeature.geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(toLeafletLatLng)),
        ),
        options,
      )
      .addTo(overlay);
    return;
  }

  leaflet
    .polygon(
      areaFeature.geometry.coordinates.map((ring) => ring.map(toLeafletLatLng)),
      options,
    )
    .addTo(overlay);
}

function createClusterAreaFeatures<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  index: PointAggregationIndex<TProperties>,
  map: LeafletMap,
) {
  const viewportWidth = map.getContainer().clientWidth;
  const viewportHeight = map.getContainer().clientHeight;

  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { areaFeatures: [], colorsByAreaId: new Map<string, string>() };
  }

  if (features.length > MAX_CLUSTER_AREA_FEATURES) {
    return { areaFeatures: [], colorsByAreaId: new Map<string, string>() };
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
      const point = map.latLngToContainerPoint(toLeafletLatLng(coordinate));
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

  return {
    areaFeatures: [...areaFeatures, ...boundaryFeatures],
    colorsByAreaId,
  };
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

function resolveTileLayerOptions(mapStyle: string | RasterMapStyle): {
  options: TileLayerOptions;
  url: string;
} | null {
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

function toLeafletLatLng([longitude, latitude]: [number, number]) {
  return [latitude, longitude] as [number, number];
}

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
