import { useState } from "react";

import {
  ClusterLayer,
  GeoJsonLayer,
  MapControls,
  MapView,
  PointLayer,
  type MapSurfaceController,
  type MapViewState,
} from "../src";

const INITIAL_VIEW_STATE: MapViewState = {
  center: [13.405, 52.52],
  zoom: 6,
};

export function MapsRuntimeAcceptance() {
  const [controller, setController] = useState<MapSurfaceController | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [pointHoveredId, setPointHoveredId] = useState<string | null>("acceptance-berlin");
  const [pointSelectedId, setPointSelectedId] = useState<string | null>(null);
  const [zoneSelectedId, setZoneSelectedId] = useState<string | null>("acceptance-zone");
  const [clusterSummary, setClusterSummary] = useState("pending");
  const [lastInteraction, setLastInteraction] = useState("none");

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned flat runtime acceptance</h1>
      <p>
        This path constructs the Rust/WASM camera, tile, and aggregation runtimes directly. It
        intentionally uses no MapLibre instance and no raster network source so interaction evidence
        stays deterministic.
      </p>
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="Maps Rust runtime acceptance"
        mapStyle={{ tiles: false }}
        maxBounds={[-25, 34, 35, 66]}
        onMapControllerReady={setController}
        onViewStateChange={(next) => {
          setViewState(next);
        }}
        viewState={viewState}
      >
        <GeoJsonLayer
          featureCollection={{
            features: [
              {
                geometry: {
                  coordinates: [
                    [
                      [13.1, 52.35],
                      [13.72, 52.35],
                      [13.72, 52.7],
                      [13.1, 52.7],
                      [13.1, 52.35],
                    ],
                  ],
                  type: "Polygon",
                },
                id: "acceptance-zone",
                properties: {},
                type: "Feature",
              },
            ],
            type: "FeatureCollection",
          }}
          onSelectedFeatureIdChange={(featureId, context) => {
            setZoneSelectedId(featureId);
            setLastInteraction(`geojson:${context.source}:${featureId ?? "none"}`);
          }}
          polygonFillColor="#2563eb"
          polygonFillOpacity={0.12}
          polygonStrokeColor="#2563eb"
          renderFeaturePopup={(feature) => (
            <span data-testid="maps-runtime-feature-popup">GeoJSON {feature.id}</span>
          )}
          selectedFeatureId={zoneSelectedId}
        />
        <ClusterLayer
          clusterRadius={96}
          getFeatureId={(feature) =>
            feature.kind === "cluster" ? "acceptance-cluster" : feature.point.id
          }
          layerId="acceptance-clusters"
          onSelectedFeatureIdChange={(featureId, context) => {
            setLastInteraction(`cluster:${context.source}:${featureId ?? "none"}`);
          }}
          onViewportAggregationChange={(summary) => {
            setClusterSummary(
              `${summary.visibleClusterCount}/${summary.visibleUnclusteredCount}/${summary.visiblePointCount}`,
            );
          }}
          points={[
            { id: "cluster-a", latitude: 51.0, longitude: 15.0 },
            { id: "cluster-b", latitude: 51.004, longitude: 15.006 },
            { id: "cluster-c", latitude: 50.996, longitude: 14.994 },
          ]}
          renderFeaturePopup={(feature) => (
            <span data-testid="maps-runtime-feature-popup">
              Cluster {feature.kind === "cluster" ? feature.pointCount : feature.point.id}
            </span>
          )}
        />
        <PointLayer
          hoveredFeatureId={pointHoveredId}
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
          points={[
            {
              id: "acceptance-berlin",
              label: "Berlin",
              latitude: 52.52,
              longitude: 13.405,
            },
          ]}
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
        <MapControls aria-label="Maps runtime acceptance controls">
          <button
            type="button"
            disabled={!controller}
            onClick={() => {
              controller?.setViewState(INITIAL_VIEW_STATE);
            }}
          >
            Reset acceptance view
          </button>
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
          <output data-testid="maps-runtime-cluster-summary">{clusterSummary}</output>
          <output data-testid="maps-runtime-interaction">{lastInteraction}</output>
        </MapControls>
      </MapView>
    </main>
  );
}
