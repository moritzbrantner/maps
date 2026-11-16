import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import {
  GeoJsonLayer,
  MapView,
  PointLayer,
  type MapFlyToOptions,
  type MapSurfaceController,
  type MapViewState,
  type MapViewStateChangeContext,
  type RasterMapStyle,
} from "../../src";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import type { MapsRendererStats } from "../../src/maps-browser-runtime";
import { createStaticRegionGrid } from "./temporal-playback-workloads";

/**
 * `camera-transition-journey-v1` (#433, Fast): the public `MapView` on `flatRuntime="maps"`,
 * controlled the way an application keeps its camera in React state, flying between European
 * cities and across the antimeridian over 2,000 points and a static 48-polygon GeoJSON grid.
 *
 * Every presented camera frame is recorded with its animation-frame time, so the journey can
 * count presented flight frames, the gaps between them (stalls) and frames after an
 * interruption.
 */

configureMapsWasmPackage("/wasm/maps_wasm.js");

const WHITE_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const MAP_STYLE: RasterMapStyle = { maxZoom: 19, minZoom: 0, tileSize: 256, tiles: WHITE_TILE };

export const CAMERA_JOURNEY_VIEWS = {
  berlin: { bearing: 40, center: [13.405, 52.52], pitch: 0, zoom: 9 },
  fiji: { bearing: 0, center: [178.44, -18.14], pitch: 0, zoom: 6 },
  paris: { bearing: 0, center: [2.3522, 48.8566], pitch: 0, zoom: 7 },
  rome: { bearing: -20, center: [12.4964, 41.9028], pitch: 0, zoom: 8 },
  samoa: { bearing: 0, center: [-171.76, -13.83], pitch: 0, zoom: 6 },
  vienna: { bearing: 15, center: [16.3738, 48.2082], pitch: 0, zoom: 10 },
} satisfies Record<string, MapViewState>;
export type CameraJourneyView = keyof typeof CAMERA_JOURNEY_VIEWS;

/** 2,000 deterministic points over Europe (a phyllotaxis spiral around 10°E 50°N). */
function createEuropePoints() {
  return Array.from({ length: 2_000 }, (_, index) => {
    const radius = 0.3 * Math.sqrt(index);
    const angle = index * 2.399963229728653;
    return {
      id: `journey-point-${index}`,
      latitude: 50 + radius * 0.6 * Math.sin(angle),
      longitude: 10 + radius * Math.cos(angle),
    };
  });
}

const POINTS = createEuropePoints();
const REGIONS = createStaticRegionGrid();

type TraceEntry = {
  /** The animation-frame time the camera was presented for (see `MapsFlyToAcceptance`). */
  frameTime: number;
  reason: MapViewStateChangeContext["reason"];
  viewState: MapViewState;
};

type Controller = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };

declare global {
  interface Window {
    cameraJourney: {
      controller: Controller | null;
      /** `performance.now()` when the last flyTo command was issued. */
      commandTime: number;
      fly(view: CameraJourneyView, options?: MapFlyToOptions): void;
      /** Trace length when the last pointer press reached the page (capture phase). */
      pointerDownTraceLength: number | null;
      /** Mounts or unmounts the Map View synchronously; returns the trace length then. */
      setMounted(mounted: boolean): number;
      setWidth(width: number): void;
      stats(): MapsRendererStats | null;
      targets: typeof CAMERA_JOURNEY_VIEWS;
      trace: TraceEntry[];
    };
  }
}

window.cameraJourney = {
  commandTime: 0,
  controller: null,
  fly(view, options) {
    window.cameraJourney.commandTime = performance.now();
    window.cameraJourney.controller?.flyTo(CAMERA_JOURNEY_VIEWS[view], options);
  },
  pointerDownTraceLength: null,
  setMounted: () => 0,
  setWidth: () => undefined,
  stats: () => window.cameraJourney.controller?.getRendererStats() ?? null,
  targets: CAMERA_JOURNEY_VIEWS,
  trace: [],
};
window.addEventListener(
  "pointerdown",
  () => {
    window.cameraJourney.pointerDownTraceLength = window.cameraJourney.trace.length;
  },
  { capture: true },
);

function CameraTransitionJourney() {
  const [mounted, setMounted] = useState(true);
  const [width, setWidth] = useState(1280);
  const [viewState, setViewState] = useState<MapViewState>(CAMERA_JOURNEY_VIEWS.paris);
  window.cameraJourney.setMounted = (next) => {
    // A remount is ready only once the new Map View hands over its controller.
    if (!next) window.cameraJourney.controller = null;
    flushSync(() => setMounted(next));
    return window.cameraJourney.trace.length;
  };
  window.cameraJourney.setWidth = setWidth;

  return (
    <main>
      {mounted ? (
        <MapView
          fitToData={false}
          flatRuntime="maps"
          mapLabel="Camera transition journey"
          mapStyle={MAP_STYLE}
          onMapControllerReady={(controller) => {
            window.cameraJourney.controller = controller as Controller;
          }}
          onViewStateChange={(next, context) => {
            const frameTime = document.timeline.currentTime;
            window.cameraJourney.trace.push({
              frameTime: typeof frameTime === "number" ? frameTime : performance.now(),
              reason: context.reason,
              viewState: next,
            });
            setViewState(next);
          }}
          style={{ height: 600, width }}
          viewState={viewState}
        >
          <GeoJsonLayer
            featureCollection={REGIONS}
            layerId="journey-static-regions"
            polygonFillColor="#2563eb"
            polygonFillOpacity={0.08}
            polygonStrokeColor="#1d4ed8"
            polygonStrokeWidth={1}
          />
          <PointLayer pointColor="#dc2626" pointRadius={3} points={POINTS} />
        </MapView>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<CameraTransitionJourney />);
