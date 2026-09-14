import { useState } from "react";

import {
  MapControls,
  MapView,
  PointLayer,
  type MapSurfaceController,
  type MapViewState,
} from "../src";

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const INITIAL_VIEW_STATE: MapViewState = {
  bearing: 30,
  center: [13.405, 52.52],
  pitch: 45,
  zoom: 7,
};

const ACCEPTANCE_POINTS = [
  {
    id: "oriented-berlin",
    label: "Berlin",
    latitude: 52.52,
    longitude: 13.405,
  },
] as const;

export function MapsOrientedRuntimeAcceptance() {
  const [controller, setController] = useState<MapSurfaceController | null>(null);
  const [contextCoordinate, setContextCoordinate] = useState<[number, number] | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned oriented runtime acceptance</h1>
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="Maps oriented Rust runtime acceptance"
        mapStyle={{
          maxZoom: 19,
          minZoom: 0,
          tileSize: 256,
          tiles: ACCEPTANCE_RASTER_TILE,
        }}
        onMapContextMenu={(context) => {
          setContextCoordinate(context.coordinates);
        }}
        onMapControllerReady={setController}
        onViewStateChange={setViewState}
        viewState={viewState}
      >
        <PointLayer
          onSelectedFeatureIdChange={setSelectedPointId}
          pointColor="#dc2626"
          pointRadius={10}
          points={ACCEPTANCE_POINTS}
          renderFeaturePopup={(feature) => (
            <span data-testid="maps-oriented-feature-popup">Selected {feature.point.label}</span>
          )}
          selectedFeatureId={selectedPointId}
        />
        <MapControls aria-label="Maps oriented runtime acceptance controls">
          <button
            type="button"
            disabled={!controller}
            onClick={() => {
              controller?.setViewState({
                bearing: 55,
                center: [13.405, 52.52],
                pitch: 35,
                zoom: 7.5,
              });
            }}
          >
            Apply oriented state
          </button>
          <output data-testid="maps-oriented-view-state">{formatViewState(viewState)}</output>
          <output data-testid="maps-oriented-context-coordinate">
            {formatCoordinate(contextCoordinate)}
          </output>
          <output data-testid="maps-oriented-selected-point">{selectedPointId ?? "none"}</output>
        </MapControls>
      </MapView>
    </main>
  );
}

function formatViewState(viewState: MapViewState) {
  const [longitude, latitude] = viewState.center;
  return [
    `${longitude.toFixed(5)},${latitude.toFixed(5)}`,
    `zoom ${viewState.zoom.toFixed(5)}`,
    `bearing ${(viewState.bearing ?? 0).toFixed(5)}`,
    `pitch ${(viewState.pitch ?? 0).toFixed(5)}`,
  ].join(" | ");
}

function formatCoordinate(coordinate: [number, number] | null) {
  return coordinate ? `${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}` : "none";
}
