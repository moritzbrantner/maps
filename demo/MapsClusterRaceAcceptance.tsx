import { useEffect, useRef, useState } from "react";

import { ClusterLayer, MapView, type MapViewState } from "../src";
import { densePoints } from "../e2e/fixtures/dense-point-journey";

// Acceptance fixture for #212: a MapLibre-backed Map View with 100k clustered points that
// mounts *before* the aggregation WASM runtime is ready. The page never pre-initializes the
// runtime, so whichever of the map style and the runtime loads first decides the order.

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const POINTS = densePoints(100_000);

const INITIAL_VIEW_STATE: MapViewState = { center: [12, 50], zoom: 5 };

type RaceProbe = {
  maxRenderedFeatures: number;
  samples: number;
  latest: { clusters: number; points: number; unclustered: number } | null;
};

declare global {
  interface Window {
    __MB_CLUSTER_RACE__?: RaceProbe;
  }
}

export function MapsClusterRaceAcceptance() {
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [summary, setSummary] = useState("pending");
  const probe = useRef<RaceProbe>({ latest: null, maxRenderedFeatures: 0, samples: 0 });

  useEffect(() => {
    window.__MB_CLUSTER_RACE__ = probe.current;
  }, []);

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Dense cluster race acceptance</h1>
      <MapView
        fitToData={false}
        mapLabel="Dense cluster race"
        mapStyle={{ maxZoom: 19, minZoom: 0, tileSize: 256, tiles: ACCEPTANCE_RASTER_TILE }}
        onViewStateChange={setViewState}
        viewState={viewState}
      >
        <ClusterLayer
          clusterRadius={48}
          onViewportAggregationChange={(next) => {
            const rendered = next.visibleClusterCount + next.visibleUnclusteredCount;
            const current = probe.current;
            current.samples += 1;
            current.maxRenderedFeatures = Math.max(current.maxRenderedFeatures, rendered);
            current.latest = {
              clusters: next.visibleClusterCount,
              points: next.visiblePointCount,
              unclustered: next.visibleUnclusteredCount,
            };
            setSummary(
              `${next.visibleClusterCount} clusters / ${next.visibleUnclusteredCount} unclustered / ${next.visiblePointCount} points`,
            );
          }}
          points={POINTS}
        />
      </MapView>
      <output data-testid="cluster-race-summary">{summary}</output>
    </main>
  );
}
