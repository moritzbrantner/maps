import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import {
  createMapScopedTimelineClock,
  GeoJsonLayer,
  getMapsTemporalRuntimeStatus,
  MapScopedTimelineControls,
  TemporalClusteredMap,
  type MapScopedTimelineClock,
  type MapSurfaceController,
  type MapViewState,
  type RasterMapStyle,
} from "../../src";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import {
  getMapsTemporalRuntimeVersion,
  subscribeMapsTemporalRuntime,
} from "../../src/temporal-points-wasm";
import { observeTemporalWork, type TemporalWorkTotals } from "../../src/temporal-work";
import {
  createEuropeCourierTracks,
  createStaticRegionGrid,
} from "./temporal-playback-workloads";

/**
 * `temporal-playback-journey-v1` (#172 phase E): the public temporal Convenience Map on
 * `flatRuntime="maps"`, sampling 2,000 moving tracks (24 keyframes each) from one shared
 * Map-Scoped Timeline over a static GeoJSON region grid, with the public timeline controls.
 *
 * Observation of the temporal work counters is installed before the first render, so the
 * journey reads every track preparation, sample and bridge byte from page load on.
 */

configureMapsWasmPackage("/wasm/maps_wasm.js");
const workObservation = observeTemporalWork();

const WHITE_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const MAP_STYLE: RasterMapStyle = { maxZoom: 12, minZoom: 0, tileSize: 256, tiles: WHITE_TILE };
const VIEW: MapViewState = { bearing: 0, center: [10, 50], pitch: 0, zoom: 4.4 };
const REGIONS = createStaticRegionGrid();
const SOURCES = [createEuropeCourierTracks(), createEuropeCourierTracks(undefined, undefined, 1)];
const REGION_STYLE = {
  polygonFillColor: "#2563eb",
  polygonFillOpacity: 0.08,
  polygonStrokeColor: "#1d4ed8",
  polygonStrokeWidth: 1,
};

// One clock for the whole page: it outlives Map View remounts, as an application's would.
const clock = createMapScopedTimelineClock({ playbackRate: 50 });

declare global {
  interface Window {
    temporalJourney: {
      clock: MapScopedTimelineClock;
      commitUnrelated(): void;
      controller: MapSurfaceController | null;
      /** Replaces the tracks with source `variant % 2` (new track and keyframe objects). */
      replaceSource(variant: number): void;
      runtimeStatus(): string;
      setMounted(mounted: boolean): void;
      totals(): TemporalWorkTotals;
    };
  }
}

window.temporalJourney = {
  clock,
  commitUnrelated: () => undefined,
  controller: null,
  replaceSource: () => undefined,
  runtimeStatus: getMapsTemporalRuntimeStatus,
  setMounted: () => undefined,
  totals: () => workObservation.totals(),
};

function TemporalPlaybackJourney() {
  const [source, setSource] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [unrelated, setUnrelated] = useState(0);
  useSyncExternalStore(subscribeMapsTemporalRuntime, getMapsTemporalRuntimeVersion);
  window.temporalJourney.replaceSource = (variant) => setSource(variant % SOURCES.length);
  window.temporalJourney.setMounted = setMounted;
  window.temporalJourney.commitUnrelated = () => setUnrelated((value) => value + 1);

  return (
    <main data-unrelated={unrelated}>
      {mounted ? (
        <TemporalClusteredMap
          defaultViewState={VIEW}
          fitToData={false}
          flatRuntime="maps"
          mapLabel="Temporal playback journey"
          mapStyle={MAP_STYLE}
          onMapControllerReady={(controller) => {
            window.temporalJourney.controller = controller;
          }}
          showPlaybackControls={false}
          style={{ height: 600, width: 1280 }}
          timeline={clock}
          tracks={SOURCES[source]}
        >
          <GeoJsonLayer
            featureCollection={REGIONS}
            layerId="journey-static-regions"
            {...REGION_STYLE}
          />
        </TemporalClusteredMap>
      ) : null}
      <MapScopedTimelineControls timeline={clock} timelineLabel="Journey timeline" />
      <output data-testid="temporal-journey-sampler">{getMapsTemporalRuntimeStatus()}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<TemporalPlaybackJourney />);
