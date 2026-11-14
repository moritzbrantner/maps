import { useEffect, useState } from "react";

import {
  createMapScopedTimelineClock,
  createPointAggregationIndex,
  GeoJsonLayer,
  MapScopedTimelineControls,
  TemporalClusteredMap,
  TemporalHeatMap,
  useMapScopedTimelineSnapshot,
  type MapScopedTimelineClock,
  type MapViewState,
  type VisibleAggregationSummary,
} from "../src";
import { sampleTemporalPointsNaively } from "../src/test-temporal-oracle";
import { TEMPORAL_COMPOSITION_TRACKS } from "./temporal-acceptance-data";

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MAP_STYLE = {
  maxZoom: 19,
  minZoom: 0,
  tileSize: 256,
  tiles: ACCEPTANCE_RASTER_TILE,
};
const VIEW_STATE: MapViewState = { center: [13, 52], zoom: 6 };

/** A static region away from the couriers' paths; it keeps its identity across time changes. */
const STATIC_REGIONS: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
  features: [
    {
      geometry: {
        coordinates: [
          [
            [10.5, 52.6],
            [12.0, 52.6],
            [12.0, 53.2],
            [10.5, 53.2],
            [10.5, 52.6],
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

export type TemporalClusterSummary = {
  cargo: number;
  visibleClusterCount: number;
  visiblePointCount: number;
  visibleUnclusteredCount: number;
};

declare global {
  interface Window {
    mapsTemporalComposition?: {
      clock: MapScopedTimelineClock;
      /** Clustering of the independently sampled couriers at `time` over the cluster viewport. */
      expectedClusters(time: number): TemporalClusterSummary | null;
    };
  }
}

function comparableSummary(summary: VisibleAggregationSummary): TemporalClusterSummary {
  return {
    cargo: Number((summary.metrics.cargo ?? 0).toFixed(6)),
    visibleClusterCount: summary.visibleClusterCount,
    visiblePointCount: summary.visiblePointCount,
    visibleUnclusteredCount: summary.visibleUnclusteredCount,
  };
}

/**
 * #172 phase D: temporal clustering and heat over static regions on `flatRuntime="maps"`,
 * both sampled from one shared Map-Scoped Timeline clock.
 */
export function MapsTemporalCompositionAcceptance() {
  const [clock] = useState(() => createMapScopedTimelineClock({ playbackRate: 20 }));
  const snapshot = useMapScopedTimelineSnapshot(clock);
  const [summary, setSummary] = useState<VisibleAggregationSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [regionSelectedId, setRegionSelectedId] = useState<string | null>(null);

  useEffect(() => {
    window.mapsTemporalComposition = {
      clock,
      expectedClusters(time) {
        if (!summary) return null;
        const index = createPointAggregationIndex(
          sampleTemporalPointsNaively(TEMPORAL_COMPOSITION_TRACKS, time),
        );
        try {
          return comparableSummary(
            index.getViewportAggregation({
              bounds: summary.bounds,
              zoom: summary.zoom,
            }).summary,
          );
        } finally {
          index.dispose();
        }
      },
    };
  }, [clock, summary]);
  useEffect(
    () => () => {
      delete window.mapsTemporalComposition;
      clock.dispose();
    },
    [clock],
  );

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned temporal cluster and heat acceptance</h1>
      <TemporalClusteredMap
        defaultViewState={VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        mapLabel="Temporal clusters"
        mapStyle={MAP_STYLE}
        onSelectedFeatureIdChange={setSelectedId}
        onViewportAggregationChange={setSummary}
        renderFeaturePopup={(feature) => (
          <span data-testid="temporal-composition-popup">
            {feature.kind === "cluster"
              ? `Cluster ${feature.pointCount}`
              : `Selected ${feature.point.label}`}
          </span>
        )}
        selectedFeatureId={selectedId}
        showPlaybackControls={false}
        style={{ height: 360 }}
        timeline={clock}
        tracks={TEMPORAL_COMPOSITION_TRACKS}
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
      <TemporalHeatMap
        defaultViewState={VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        heatmapRadius={{ meters: 60_000 }}
        mapLabel="Temporal heat"
        mapStyle={MAP_STYLE}
        showPlaybackControls={false}
        style={{ height: 360 }}
        timeline={clock}
        tracks={TEMPORAL_COMPOSITION_TRACKS}
        weightMetric="cargo"
      >
        <GeoJsonLayer
          featureCollection={STATIC_REGIONS}
          polygonFillColor="#2563eb"
          polygonFillOpacity={0.2}
          polygonStrokeColor="#2563eb"
        />
      </TemporalHeatMap>
      <MapScopedTimelineControls timeline={clock} timelineLabel="Composition timeline" />
      <output data-testid="temporal-composition-time">{snapshot.activeTime}</output>
      <output data-testid="temporal-composition-playing">
        {snapshot.isPlaying ? "playing" : "paused"}
      </output>
      <output data-testid="temporal-composition-clusters">
        {summary ? JSON.stringify(comparableSummary(summary)) : "none"}
      </output>
      <output data-testid="temporal-composition-selection">{selectedId ?? "none"}</output>
      <output data-testid="temporal-composition-region">{regionSelectedId ?? "none"}</output>
    </main>
  );
}
