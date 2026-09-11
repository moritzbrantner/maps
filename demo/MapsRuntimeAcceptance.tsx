import { useState } from "react";

import {
  MapControls,
  MapView,
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

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned flat runtime acceptance</h1>
      <p>
        This path constructs the Rust/WASM camera and tile runtime directly. It intentionally uses no
        MapLibre instance and no raster network source so interaction evidence stays deterministic.
      </p>
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="Maps Rust runtime acceptance"
        mapStyle={{ tiles: false }}
        onMapControllerReady={setController}
        onViewStateChange={(next) => {
          setViewState(next);
        }}
        viewState={viewState}
      >
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
          <output data-testid="maps-runtime-view-state">
            {viewState.center[0].toFixed(4)},{viewState.center[1].toFixed(4)} | zoom{" "}
            {viewState.zoom.toFixed(4)}
          </output>
        </MapControls>
      </MapView>
    </main>
  );
}
