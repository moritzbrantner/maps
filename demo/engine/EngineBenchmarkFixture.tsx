import { Button } from "@moritzbrantner/ui";
import { useCallback, useMemo, useState } from "react";

import type { AggregatedMapFeature, MapPoint } from "../../src/aggregation";
import { ClusterLayer } from "../../src/cluster-layer";
import type { MapViewState, RasterMapStyle } from "../../src/map-display";
import { MapsMapView } from "../../src/maps-map-view";
import { createShortbreadTileLoader } from "../shortbread-tile-loader";

// Keep the pre-Pages-switch vector-city-style-v1 scenario and its old camera
// workload comparable. The benchmark runner supplies the canonical dense MVT
// bytes by intercepting a local fixture URL; no external OSM endpoint is used.
const initialView: MapViewState = { center: [10.3, 50.4], zoom: 4.4 };
const mapStyle: RasterMapStyle = {
  tiles: `${import.meta.env.BASE_URL}tilesets/fixture-pmtiles-v1.mvt?z={z}&x={x}&y={y}`,
  minZoom: 0,
  maxZoom: 14,
  tileSize: 256,
  attribution: "Maps deterministic CC0 fixture",
};
const featureId = (feature: AggregatedMapFeature) =>
  feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;

export function EngineBenchmarkFixture() {
  const [viewState, setViewState] = useState(initialView);
  const points = useMemo<MapPoint[]>(
    () =>
      Array.from({ length: 1000 }, (_, index) => ({
        id: `point-${index}`,
        longitude: 4 + ((index * 0.61803398875) % 1) * 14,
        latitude: 46 + ((index * 0.41421356237) % 1) * 9,
        metrics: { demand: 1 + (index % 100) },
      })),
    [],
  );
  const createTileImageLoader = useCallback(() => {
    const wasmPackage = new URL(`${import.meta.env.BASE_URL}wasm/maps_wasm.js`, location.origin)
      .href;
    return createShortbreadTileLoader(wasmPackage);
  }, []);

  return (
    <main className="engine-page" data-testid="engine-benchmark-fixture">
      <header className="engine-toolbar">
        <div>
          <h1>Maps engine · vector-city-style-v1</h1>
          <p className="engine-kicker">Synthetic benchmark fixture · no external tile provider</p>
        </div>
        <Button variant="outline" onClick={() => setViewState(initialView)}>
          Reset view
        </Button>
      </header>
      <MapsMapView
        mapLabel="Maps engine benchmark map"
        fitToData={false}
        maxZoom={22}
        mapStyle={mapStyle}
        createTileImageLoader={createTileImageLoader}
        onViewStateChange={setViewState}
        viewState={viewState}
        className="engine-map"
        style={{ height: "100%", minHeight: 320 }}
      >
        <ClusterLayer points={points} getFeatureId={featureId} />
      </MapsMapView>
      <footer className="engine-status">
        Rust/WASM · 1,000 synthetic points · canonical vector-city-style-v1
      </footer>
    </main>
  );
}
