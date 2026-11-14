import { useEffect, useRef, useState } from "react";

import {
  MapControls,
  MapView,
  PointLayer,
  type MapFlyToOptions,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeContext,
} from "../src";
import type { MapsRendererStats } from "../src/maps-browser-runtime";

// Animated first-party flyTo (#433): a controlled `flatRuntime="maps"` Map View flies across
// center, zoom and bearing on MapLibre's trajectory, with an instant (`animate: false`)
// opt-out. Every presented camera frame is recorded for the browser acceptance test.

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const FLY_TO_PARIS: MapViewState = {
  bearing: 0,
  center: [2.3522, 48.8566],
  pitch: 0,
  zoom: 7,
};
export const FLY_TO_BERLIN: MapViewState = {
  bearing: 40,
  center: [13.405, 52.52],
  pitch: 0,
  zoom: 9,
};
const FLY_TO_FIJI: MapViewState = { bearing: 0, center: [178.44, -18.14], pitch: 0, zoom: 6 };
const FLY_TO_SAMOA: MapViewState = { bearing: 0, center: [-171.76, -13.83], pitch: 0, zoom: 6 };

const ACCEPTANCE_POINTS = [
  { id: "flyto-berlin", label: "Berlin", latitude: 52.52, longitude: 13.405 },
  { id: "flyto-paris", label: "Paris", latitude: 48.8566, longitude: 2.3522 },
] as const;

type Controller = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };

type FlyToTraceEntry = {
  reason: MapViewStateChangeContext["reason"];
  time: number;
  viewState: MapViewState;
};

declare global {
  interface Window {
    mapsFlyToAcceptance?: {
      clearTrace(): void;
      /** `performance.now()` when the last flyTo command was issued. */
      commandTime(): number;
      stats(): MapsRendererStats | null;
      trace: FlyToTraceEntry[];
    };
  }
}

export function MapsFlyToAcceptance() {
  const [controller, setController] = useState<Controller | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(FLY_TO_PARIS);
  const [flightFrames, setFlightFrames] = useState(0);
  const traceRef = useRef<FlyToTraceEntry[]>([]);
  const controllerRef = useRef<Controller | null>(null);
  controllerRef.current = controller;
  const commandTimeRef = useRef(0);
  const fly = (target: MapViewState, options?: MapFlyToOptions) => {
    commandTimeRef.current = performance.now();
    controller?.flyTo(target, options);
  };

  useEffect(() => {
    window.mapsFlyToAcceptance = {
      commandTime: () => commandTimeRef.current,
      clearTrace: () => {
        traceRef.current.length = 0;
        setFlightFrames(0);
      },
      stats: () => controllerRef.current?.getRendererStats() ?? null,
      trace: traceRef.current,
    };
    return () => {
      delete window.mapsFlyToAcceptance;
    };
  }, []);

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned animated flyTo acceptance</h1>
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="Maps flyTo Rust runtime acceptance"
        mapStyle={{ maxZoom: 19, minZoom: 0, tileSize: 256, tiles: ACCEPTANCE_RASTER_TILE }}
        onMapControllerReady={(next) => setController(next as Controller)}
        onViewStateChange={(next, context) => {
          traceRef.current.push({
            reason: context.reason,
            time: performance.now(),
            viewState: next,
          });
          if (context.reason === "fly-to") setFlightFrames((count) => count + 1);
          setViewState(next);
        }}
        viewState={viewState}
      >
        <PointLayer
          onSelectedFeatureIdChange={setSelectedPointId}
          pointColor="#dc2626"
          pointRadius={10}
          points={ACCEPTANCE_POINTS}
          selectedFeatureId={selectedPointId}
        />
        <MapControls aria-label="Maps flyTo acceptance controls">
          <button type="button" disabled={!controller} onClick={() => fly(FLY_TO_BERLIN)}>
            Fly to Berlin
          </button>
          <button
            type="button"
            disabled={!controller}
            onClick={() => fly(FLY_TO_PARIS, { animate: false })}
          >
            Jump to Paris
          </button>
          <button type="button" disabled={!controller} onClick={() => fly(FLY_TO_PARIS)}>
            Fly to Paris
          </button>
          <button
            type="button"
            disabled={!controller}
            onClick={() => fly(FLY_TO_FIJI, { animate: false })}
          >
            Jump to Fiji
          </button>
          <button
            type="button"
            disabled={!controller}
            onClick={() => fly(FLY_TO_SAMOA, { durationMs: 1200 })}
          >
            Fly across the dateline to Samoa
          </button>
          <output data-testid="maps-flyto-view-state">{formatViewState(viewState)}</output>
          <output data-testid="maps-flyto-frames">{flightFrames}</output>
          <output data-testid="maps-flyto-selected-point">{selectedPointId ?? "none"}</output>
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
