import { useEffect, useState } from "react";

import {
  createMapScopedTimelineClock,
  GeoJsonLayer,
  MapScopedTimelineControls,
  TemporalClusteredMap,
  useMapScopedTimelineSnapshot,
  type MapScopedTimelineClock,
  type MapViewState,
} from "../src";
import {
  TEMPORAL_ACCEPTANCE_ANTIMERIDIAN_TRACKS,
  TEMPORAL_ACCEPTANCE_REPLACEMENT_TRACKS,
  TEMPORAL_ACCEPTANCE_TRACKS,
} from "./temporal-acceptance-data";

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const INITIAL_VIEW_STATE: MapViewState = { center: [13, 52], zoom: 6 };
/** `&scene=antimeridian`: a track that crosses 180° inside the viewport. */
const ANTIMERIDIAN_VIEW_STATE: MapViewState = { center: [178, 10], zoom: 6 };

/** Static regions keep their identity, so a time change must not re-prepare them. */
const STATIC_REGIONS: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
  features: [
    {
      geometry: {
        coordinates: [
          [
            [12.4, 51.4],
            [13.6, 51.4],
            [13.6, 52.0],
            [12.4, 52.0],
            [12.4, 51.4],
          ],
        ],
        type: "Polygon",
      },
      id: "static-region",
      properties: {},
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
};

declare global {
  interface Window {
    mapsTemporalAcceptance?: { clock: MapScopedTimelineClock };
  }
}

/** Temporal points over static regions on `flatRuntime="maps"`, driven by one shared clock. */
export function MapsTemporalRuntimeAcceptance() {
  const [clock] = useState(() => createMapScopedTimelineClock({ playbackRate: 20 }));
  const snapshot = useMapScopedTimelineSnapshot(clock);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [regionSelectedId, setRegionSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<"initial" | "replacement">("initial");
  const antimeridian = new URLSearchParams(window.location.search).get("scene") === "antimeridian";
  const tracks = antimeridian
    ? TEMPORAL_ACCEPTANCE_ANTIMERIDIAN_TRACKS
    : source === "initial"
      ? TEMPORAL_ACCEPTANCE_TRACKS
      : TEMPORAL_ACCEPTANCE_REPLACEMENT_TRACKS;

  useEffect(() => {
    window.mapsTemporalAcceptance = { clock };
    return () => {
      delete window.mapsTemporalAcceptance;
      clock.dispose();
    };
  }, [clock]);

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned temporal runtime acceptance</h1>
      <button
        onClick={() => setSource((current) => (current === "initial" ? "replacement" : "initial"))}
        type="button"
      >
        Replace source
      </button>
      <TemporalClusteredMap
        defaultViewState={antimeridian ? ANTIMERIDIAN_VIEW_STATE : INITIAL_VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        mapLabel="Maps temporal runtime acceptance"
        mapStyle={{ maxZoom: 19, minZoom: 0, tileSize: 256, tiles: ACCEPTANCE_RASTER_TILE }}
        onSelectedFeatureIdChange={setSelectedId}
        pointColor="#dc2626"
        pointRadius={10}
        renderFeaturePopup={(feature) => (
          <span data-testid="temporal-runtime-popup">
            {feature.kind === "cluster"
              ? `Cluster ${feature.pointCount}`
              : `Selected ${feature.point.label}`}
          </span>
        )}
        selectedFeatureId={selectedId}
        showPlaybackControls={false}
        style={{ height: 520 }}
        timeline={clock}
        tracks={tracks}
      >
        <GeoJsonLayer
          featureCollection={STATIC_REGIONS}
          onSelectedFeatureIdChange={setRegionSelectedId}
          polygonFillColor="#2563eb"
          polygonFillOpacity={0.2}
          polygonStrokeColor="#2563eb"
          selectedFeatureId={regionSelectedId}
        />
      </TemporalClusteredMap>
      <MapScopedTimelineControls timeline={clock} timelineLabel="Acceptance timeline" />
      <output data-testid="temporal-runtime-source">{source}</output>
      <output data-testid="temporal-runtime-time">{snapshot.activeTime}</output>
      <output data-testid="temporal-runtime-playing">
        {snapshot.isPlaying ? "playing" : "paused"}
      </output>
      <output data-testid="temporal-runtime-selection">{selectedId ?? "none"}</output>
      <output data-testid="temporal-runtime-region">{regionSelectedId ?? "none"}</output>
    </main>
  );
}
