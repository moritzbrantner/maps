import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import {
  ClusterLayer,
  FlowLayer,
  GeoJsonLayer,
  MapControls,
  MapView,
  PointLayer,
  type AggregatedMapFeature,
  type MapBounds,
  type MapSurfaceController,
  type MapViewState,
} from "../src";

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** A tile-free base (#170): one constant background layer and no sources. */
const acceptanceBackgroundStyle = (kind: "opaque" | "translucent") =>
  ({
    layers: [
      {
        id: "background",
        paint: { "background-color": kind === "opaque" ? "#2f7d6b" : "rgba(48, 128, 108, 0.5)" },
        type: "background",
      },
    ],
    sources: {},
    version: 8,
  }) as const;

const INITIAL_VIEW_STATE: MapViewState = {
  center: [13.405, 52.52],
  zoom: 6,
};

const ACCEPTANCE_CLUSTER_POINTS = [
  { id: "hamburg-a", label: "Hamburg A", latitude: 53.5511, longitude: 9.9937 },
  { id: "hamburg-b", label: "Hamburg B", latitude: 53.557, longitude: 10.006 },
  { id: "hamburg-c", label: "Hamburg C", latitude: 53.544, longitude: 9.982 },
] as const;
const REPLACED_CLUSTER_POINTS = ACCEPTANCE_CLUSTER_POINTS.slice(0, 2);

const ACCEPTANCE_FLOWS = [
  {
    from: [11.8, 52] as [number, number],
    id: "acceptance-route",
    metrics: { weight: 1 },
    to: [12.8, 52] as [number, number],
  },
] as const;
const REPLACED_FLOWS = [
  {
    from: [11.8, 51.5] as [number, number],
    id: "acceptance-route-b",
    metrics: { weight: 1 },
    to: [12.8, 51.5] as [number, number],
  },
] as const;

const ACCEPTANCE_POINT_DATA = {
  moved: { id: "acceptance-berlin", label: "Berlin moved", latitude: 52.6, longitude: 13.6 },
  original: { id: "acceptance-berlin", label: "Berlin", latitude: 52.52, longitude: 13.405 },
  replaced: { id: "acceptance-potsdam", label: "Potsdam", latitude: 52.2, longitude: 13.0 },
} as const;

function acceptancePolygon(
  id: string,
  [west, south, east, north]: MapBounds,
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    features: [
      {
        geometry: {
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
          type: "Polygon",
        },
        id,
        properties: {},
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };
}
const ACCEPTANCE_POLYGONS = {
  original: acceptancePolygon("acceptance-zone", [13.1, 52.35, 13.72, 52.7]),
  replaced: acceptancePolygon("acceptance-zone-b", [14, 52, 14.6, 52.4]),
};

/**
 * Layer inputs keep their identity across unrelated commits: Map Layers re-prepare an input
 * whose identity changes, so the Fast evidence (#170) can tell unrelated commits apart.
 */
const ACCEPTANCE_POINTS = {
  moved: [ACCEPTANCE_POINT_DATA.moved],
  original: [ACCEPTANCE_POINT_DATA.original],
  replaced: [ACCEPTANCE_POINT_DATA.replaced],
};
const acceptanceFlowFeatureId = () => "acceptance-flow";
const acceptanceClusterFeatureId = (feature: AggregatedMapFeature) =>
  feature.kind === "cluster"
    ? "acceptance-hamburg-cluster"
    : `acceptance-hamburg-point:${feature.point.id}`;

export type MapsRuntimeAcceptanceLayerId = "cluster" | "flow" | "point" | "polygon";

/** Everything the composition sequences change on one mounted acceptance Map View. */
export type MapsRuntimeSequenceFixture = {
  clusterData: "original" | "replaced";
  flowData: "original" | "replaced";
  mapMounted: boolean;
  maxBounds: MapBounds;
  maxZoom: number | undefined;
  order: readonly MapsRuntimeAcceptanceLayerId[];
  pointData: keyof typeof ACCEPTANCE_POINT_DATA;
  polygonData: keyof typeof ACCEPTANCE_POLYGONS;
  polygonFillOpacity: number;
  rasterTileUrl: string | undefined;
};

/** Browser-only handle: sequences drive the public Map View as an application would. */
export type MapsRuntimeSequenceHandle = {
  /**
   * Commits React state the Map Layers do not depend on. The whole acceptance tree re-renders
   * (fresh inline callbacks and arrays included), as an application's unrelated UI would.
   */
  commitUnrelated: () => void;
  controller: () => MapSurfaceController | null;
  /** Ordered `onMapControllerReady` and `onViewStateChange` deliveries. */
  events: string[];
  setControlledViewState: (viewState: MapViewState) => void;
  setFixture: (patch: Partial<MapsRuntimeSequenceFixture>) => void;
};

declare global {
  interface Window {
    mapsRuntimeSequences?: MapsRuntimeSequenceHandle;
  }
}

export type MapsRuntimeAcceptanceProps = {
  background?: "opaque" | "translucent";
  cameraOwner?: "controlled" | "uncontrolled";
  includePolygon?: boolean;
  maxZoom?: number;
  rasterTileUrl?: string;
  /** Publishes {@link MapsRuntimeSequenceHandle} on `window` for the composition sequences. */
  sequences?: boolean;
};

export function MapsRuntimeAcceptance({
  background,
  cameraOwner = "controlled",
  includePolygon = true,
  maxZoom,
  rasterTileUrl,
  sequences = false,
}: MapsRuntimeAcceptanceProps = {}) {
  const [fixture, setFixture] = useState<MapsRuntimeSequenceFixture>({
    clusterData: "original",
    flowData: "original",
    mapMounted: true,
    maxBounds: [-25, 34, 35, 66],
    maxZoom,
    order: ["cluster", "flow", "polygon", "point"],
    pointData: "original",
    polygonData: "original",
    polygonFillOpacity: 0.12,
    rasterTileUrl,
  });
  const [controller, setController] = useState<MapSurfaceController | null>(null);
  const controllerRef = useRef<MapSurfaceController | null>(null);
  const [events] = useState<string[]>(() => []);
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [clusterSelectedId, setClusterSelectedId] = useState<string | null>(null);
  const [clusterSummary, setClusterSummary] = useState("pending");
  const [flowHoveredId, setFlowHoveredId] = useState<string | null>(null);
  const [flowSelectedId, setFlowSelectedId] = useState<string | null>(null);
  const [pointHoveredId, setPointHoveredId] = useState<string | null>("acceptance-berlin");
  const [pointSelectedId, setPointSelectedId] = useState<string | null>(null);
  const [zoneSelectedId, setZoneSelectedId] = useState<string | null>("acceptance-zone");
  const [lastInteraction, setLastInteraction] = useState("none");
  const [unrelatedCommits, setUnrelatedCommits] = useState(0);

  useEffect(() => {
    if (!sequences) return;
    window.mapsRuntimeSequences = {
      commitUnrelated: () => flushSync(() => setUnrelatedCommits((count) => count + 1)),
      controller: () => controllerRef.current,
      events,
      // Synchronous commits let a sequence interleave React updates with camera commands.
      setControlledViewState: (next) => flushSync(() => setViewState(next)),
      setFixture: (patch) => flushSync(() => setFixture((current) => ({ ...current, ...patch }))),
    };
    return () => {
      delete window.mapsRuntimeSequences;
    };
  }, [events, sequences]);

  const handleControllerReady = useCallback(
    (next: MapSurfaceController) => {
      controllerRef.current = next;
      events.push("controller-ready");
      setController(next);
    },
    [events],
  );

  const layers: Record<MapsRuntimeAcceptanceLayerId, ReactNode> = {
    cluster: (
      <ClusterLayer
        clusterRadius={48}
        getFeatureId={acceptanceClusterFeatureId}
        key="cluster"
        onSelectedFeatureIdChange={(featureId, context) => {
          setClusterSelectedId(featureId);
          setLastInteraction(`cluster:${context.source}:${featureId ?? "none"}`);
        }}
        onViewportAggregationChange={(summary) => {
          setClusterSummary(
            `${summary.visibleClusterCount} clusters / ${summary.visiblePointCount} points`,
          );
        }}
        points={
          fixture.clusterData === "replaced" ? REPLACED_CLUSTER_POINTS : ACCEPTANCE_CLUSTER_POINTS
        }
        renderFeaturePopup={(feature) => (
          <span data-testid="maps-runtime-feature-popup">
            {feature.kind === "cluster"
              ? `Cluster ${feature.pointCount}`
              : `Cluster point ${feature.point.label}`}
          </span>
        )}
        selectedFeatureId={clusterSelectedId}
      />
    ),
    flow: (
      <FlowLayer
        flowColor="#0f766e"
        flows={fixture.flowData === "replaced" ? REPLACED_FLOWS : ACCEPTANCE_FLOWS}
        getFeatureId={acceptanceFlowFeatureId}
        hoveredFeatureId={flowHoveredId}
        key="flow"
        maxWidth={8}
        minWidth={8}
        onHoveredFeatureIdChange={(featureId, context) => {
          setFlowHoveredId(featureId);
          setLastInteraction(`flow:${context.source}:${featureId ?? "none"}`);
        }}
        onSelectedFeatureIdChange={(featureId, context) => {
          setFlowSelectedId(featureId);
          setLastInteraction(`flow:${context.source}:${featureId ?? "none"}`);
        }}
        renderFeaturePopup={(feature) => (
          <span data-testid="maps-runtime-feature-popup">Flow {feature.flow.id}</span>
        )}
        renderFeatureTooltip={(feature) => <span>Hover flow {feature.flow.id}</span>}
        selectedFeatureId={flowSelectedId}
        showDirection
        showEndpoints
      />
    ),
    point: (
      <PointLayer
        hoveredFeatureId={pointHoveredId}
        key="point"
        onFeatureContextMenu={(feature) => {
          setLastInteraction(`point:context-menu:${feature.point.id}`);
        }}
        onHoveredFeatureIdChange={(featureId, context) => {
          setPointHoveredId(featureId);
          setLastInteraction(`point:${context.source}:${featureId ?? "none"}`);
        }}
        onSelectedFeatureIdChange={(featureId, context) => {
          setPointSelectedId(featureId);
          setLastInteraction(`point:${context.source}:${featureId ?? "none"}`);
        }}
        pointColor="#dc2626"
        pointRadius={8}
        points={ACCEPTANCE_POINTS[fixture.pointData]}
        renderFeatureContextMenu={(feature, context) => (
          <button type="button">
            Context {feature.point.label} at {context.coordinates[0].toFixed(3)},
            {context.coordinates[1].toFixed(3)}
          </button>
        )}
        renderFeaturePopup={(feature) => (
          <span data-testid="maps-runtime-feature-popup">Selected {feature.point.label}</span>
        )}
        renderFeatureTooltip={(feature) => <span>Hover {feature.point.label}</span>}
        selectedFeatureId={pointSelectedId}
      />
    ),
    polygon: includePolygon ? (
      <GeoJsonLayer
        featureCollection={ACCEPTANCE_POLYGONS[fixture.polygonData]}
        key="polygon"
        onSelectedFeatureIdChange={(featureId, context) => {
          setZoneSelectedId(featureId);
          setLastInteraction(`geojson:${context.source}:${featureId ?? "none"}`);
        }}
        polygonFillColor="#2563eb"
        polygonFillOpacity={fixture.polygonFillOpacity}
        polygonStrokeColor="#2563eb"
        renderFeaturePopup={(feature) => (
          <span data-testid="maps-runtime-feature-popup">GeoJSON {feature.id}</span>
        )}
        selectedFeatureId={zoneSelectedId}
      />
    ) : null,
  };

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned flat runtime acceptance</h1>
      <p>
        This path constructs the Rust/WASM camera, tile, and aggregation runtimes directly. It
        intentionally uses no MapLibre instance. A deterministic embedded raster tile exercises the
        first-party base renderer without external network dependence.
      </p>
      {fixture.mapMounted ? (
        <MapView
          flatRuntime="maps"
          fitToData={false}
          mapLabel="Maps Rust runtime acceptance"
          mapStyle={
            background
              ? acceptanceBackgroundStyle(background)
              : {
                  maxZoom: 19,
                  minZoom: 0,
                  tileSize: 256,
                  tiles: fixture.rasterTileUrl ?? ACCEPTANCE_RASTER_TILE,
                }
          }
          maxBounds={fixture.maxBounds}
          maxZoom={fixture.maxZoom}
          onMapControllerReady={handleControllerReady}
          onViewStateChange={(next, context) => {
            events.push(
              `camera:${context.reason}:${next.center[0].toFixed(4)},${next.center[1].toFixed(4)},${next.zoom.toFixed(4)}`,
            );
            setViewState(next);
          }}
          {...(cameraOwner === "controlled"
            ? { viewState }
            : { initialViewState: INITIAL_VIEW_STATE })}
        >
          {fixture.order.map((id) => layers[id])}
          <MapControls aria-label="Maps runtime acceptance controls">
            <button
              type="button"
              disabled={!controller}
              onClick={() => {
                controller?.fitBounds([-10, 40, 10, 50], { maxZoom: 7 });
              }}
            >
              Fit acceptance bounds
            </button>
            <button
              type="button"
              disabled={!controller}
              onClick={() => {
                controller?.setViewState({ center: [120, 80], zoom: 1 });
              }}
            >
              Request outside bounds
            </button>
            <output data-testid="maps-runtime-view-state">
              {viewState.center[0].toFixed(4)},{viewState.center[1].toFixed(4)} | zoom{" "}
              {viewState.zoom.toFixed(4)}
            </output>
            <output data-testid="maps-runtime-interaction">{lastInteraction}</output>
            <output data-testid="maps-runtime-cluster-summary">{clusterSummary}</output>
            <output data-testid="maps-runtime-unrelated-commits">{unrelatedCommits}</output>
          </MapControls>
        </MapView>
      ) : null}
    </main>
  );
}
