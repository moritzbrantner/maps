import { useEffect, useMemo, useState } from "react";

import {
  createMapScopedTimelineClock,
  GeoJsonLayer,
  MapScopedTimelineControls,
  MapView,
  useMapScopedTimelineSnapshot,
  type MapScopedTimelineClock,
} from "../src";
import {
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineSceneAtTime,
} from "../src/entries/timeline";
import type { TemporalGeoJsonGeometryFeatureCollection } from "../src/temporal-geojson-types";
import { createAtlasTileset } from "./atlas-source";

type RegionProperties = { durationMs: number; name: string; startMs: number };

/** Explicitly synthetic geographic snapshots, not historical state boundaries. */
const REGIONS: TemporalGeoJsonGeometryFeatureCollection<RegionProperties> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "original-region",
      properties: { durationMs: 1_000, name: "Original region", startMs: 0 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9.475, 47.09],
            [9.565, 47.09],
            [9.565, 47.165],
            [9.475, 47.165],
            [9.475, 47.09],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: "west-region",
      properties: { durationMs: 1_000, name: "Western successor", startMs: 1_000 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9.455, 47.105],
            [9.52, 47.105],
            [9.52, 47.17],
            [9.455, 47.17],
            [9.455, 47.105],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: "east-region",
      properties: { durationMs: 1_000, name: "Eastern successor", startMs: 1_000 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9.52, 47.08],
            [9.59, 47.08],
            [9.59, 47.145],
            [9.52, 47.145],
            [9.52, 47.08],
          ],
        ],
      },
    },
  ],
};

const DOCUMENT = createGeoJsonTimelineDocument(REGIONS, {
  durationMs: 2_000,
  getItemDurationMs: (feature) => feature.properties?.durationMs ?? 1_000,
  getItemStartMs: (feature) => feature.properties?.startMs ?? 0,
  getTimelineTrackId: () => "synthetic-region-transition",
});

const TRANSITION = {
  defaultTransition: {
    algorithm: "topology-plan" as const,
    durationMs: 750,
    topologyStrategy: "area-overlap" as const,
  },
};

declare global {
  interface Window {
    mapsGeometryTransitionAcceptance?: {
      clock: MapScopedTimelineClock;
      sample(timeMs: number): TemporalGeoJsonGeometryFeatureCollection<RegionProperties>;
    };
  }
}

/** #173: real first-party geographic scene transitions, map-scoped time and picking. */
export function MapsGeometryTransitionAcceptance() {
  const [clock] = useState(() =>
    createMapScopedTimelineClock({
      defaultTime: 0,
      playbackRate: 250,
      timeRange: { start: 0, end: 2_000 },
      timeStep: 50,
    }),
  );
  const timeline = useMapScopedTimelineSnapshot(clock);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const frame = useMemo(
    () => getGeoJsonTimelineSceneAtTime(REGIONS, DOCUMENT, timeline.activeTime, TRANSITION),
    [timeline.activeTime],
  );
  const regionIds = frame.features.map((feature) => String(feature.id));
  const visibleSelection = selectedId && regionIds.includes(selectedId) ? selectedId : null;
  const tileset = useMemo(() => createAtlasTileset("liechtenstein", import.meta.env.BASE_URL), []);

  useEffect(() => {
    window.mapsGeometryTransitionAcceptance = {
      clock,
      sample: (timeMs) => getGeoJsonTimelineSceneAtTime(REGIONS, DOCUMENT, timeMs, TRANSITION),
    };
    return () => {
      delete window.mapsGeometryTransitionAcceptance;
      clock.dispose();
    };
  }, [clock]);

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>First-party geographic transition acceptance</h1>
      <p>
        Synthetic regions for geometry/picking checks. Geographic scene morphing is illustrative,
        not a historical territory reconstruction or the anchored mode of #175.
      </p>
      <MapView
        fitToData={false}
        flatRuntime="maps"
        initialViewState={{ center: [9.52, 47.125], zoom: 11 }}
        mapLabel="Geographic transition acceptance"
        mapStyle={{ tiles: false }}
        style={{ height: 520 }}
        tileset={tileset}
      >
        <GeoJsonLayer
          featureCollection={frame}
          layerId="geojson-transition-regions"
          onSelectedFeatureIdChange={setSelectedId}
          polygonFillColor="#f59e0b"
          polygonFillOpacity={0.6}
          polygonStrokeColor="#9a3412"
          polygonStrokeWidth={2}
          renderFeaturePopup={(feature) => (
            <span data-testid="geographic-transition-popup">
              {feature.properties.name ?? feature.id}
            </span>
          )}
          selectedFeatureId={visibleSelection}
        />
      </MapView>
      <MapScopedTimelineControls timeline={clock} timelineLabel="Geographic transition timeline" />
      <nav aria-label="Transition checkpoints">
        <button onClick={() => clock.seek(0)} type="button">
          Source state
        </button>
        <button onClick={() => clock.seek(625)} type="button">
          Mid-transition
        </button>
        <button onClick={() => clock.seek(1_000)} type="button">
          Destination state
        </button>
      </nav>
      <p>
        OpenStreetMap contributors (ODbL-1.0): actual vector-tile basemap; synthetic regions above.
      </p>
      <ul aria-label="Visible regions">
        {frame.features.map((feature) => (
          <li key={String(feature.id)}>{String(feature.id)}</li>
        ))}
      </ul>
      <output data-testid="geographic-transition-time">{timeline.activeTime}</output>
      <output data-testid="geographic-transition-selection">{visibleSelection ?? "none"}</output>
      <output data-testid="geographic-transition-feature-count">{frame.features.length}</output>
    </main>
  );
}
