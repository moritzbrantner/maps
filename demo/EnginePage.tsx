import { useCallback, useMemo, useState } from "react";
import { Button, NativeSelect } from "@moritzbrantner/ui";
import { MapsMapView } from "../src/maps-map-view";
import { ClusterLayer } from "../src/cluster-layer";
import type { AggregatedMapFeature, MapPoint } from "../src/aggregation";
import type { MapViewState, RasterMapStyle } from "../src/map-display";
import { createShortbreadTileLoader } from "./shortbread-tile-loader";

const initialView: MapViewState = { center: [10.3, 50.4], zoom: 4.4 };
const mapStyle: RasterMapStyle = {
  tiles: "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt",
  minZoom: 0,
  maxZoom: 14,
  tileSize: 256,
  attribution: "© OpenStreetMap contributors",
};
const emptyStyle: RasterMapStyle = { tiles: false };
const counts = [1000, 10000, 100000];
const featureId = (feature: AggregatedMapFeature) =>
  feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;

export function EnginePage() {
  const [count, setCount] = useState(() => {
    const requested = Number(new URLSearchParams(location.search).get("points"));
    return counts.includes(requested) ? requested : 1000;
  });
  const [viewState, setViewState] = useState(initialView);
  const [tileError, setTileError] = useState<string | null>(null);
  const [basemapEnabled] = useState(() => {
    const params = new URLSearchParams(location.search);
    return !params.has("e2e") || params.get("vectorTiles") === "fixture";
  });
  const [selected, setSelected] = useState<string | null>(null);
  const points = useMemo(() => createPoints(count), [count]);
  const createTileImageLoader = useCallback(() => {
    const wasmPackage = new URL(`${import.meta.env.BASE_URL}wasm/maps_wasm.js`, location.origin)
      .href;
    const loader = createShortbreadTileLoader(wasmPackage);
    return {
      ...loader,
      async load(...args: Parameters<typeof loader.load>) {
        try {
          return await loader.load(...args);
        } catch (error) {
          if (!args[2].aborted)
            setTileError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
  }, []);
  const select = useCallback((feature: AggregatedMapFeature | null) => {
    setSelected(feature ? featureId(feature) : null);
  }, []);

  return (
    <main className="engine-page">
      <header className="engine-toolbar">
        <div>
          <h1>Maps engine</h1>
          <p>Explore, pan, zoom, and select a cluster.</p>
        </div>
        <div className="engine-controls">
          <label>
            Points
            <NativeSelect
              aria-label="Point count"
              value={count}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!counts.includes(next)) return;
                setCount(next);
                setSelected(null);
                const url = new URL(location.href);
                url.searchParams.set("points", String(next));
                history.replaceState(null, "", url);
              }}
            >
              {counts.map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString("en")}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button
            variant="outline"
            onClick={() =>
              setViewState((current) => ({
                ...current,
                bearing: current.pitch ? 0 : 35,
                pitch: current.pitch ? 0 : 40,
              }))
            }
          >
            {viewState.pitch ? "Flatten view" : "Tilt view"}
          </Button>
          <Button variant="outline" onClick={() => setViewState(initialView)}>
            Reset view
          </Button>
          <a href={`${import.meta.env.BASE_URL}stats/`}>Stats</a>
        </div>
      </header>
      <MapsMapView
        mapLabel="Maps engine map"
        fitToData={false}
        maxZoom={22}
        mapStyle={basemapEnabled ? mapStyle : emptyStyle}
        createTileImageLoader={createTileImageLoader}
        onViewStateChange={setViewState}
        viewState={viewState}
        className="engine-map"
        style={{ height: "100%", minHeight: 320 }}
      >
        <ClusterLayer
          points={points}
          getFeatureId={featureId}
          onFeatureSelect={select}
          selectedFeatureId={selected}
        />
      </MapsMapView>
      <footer className="engine-status">
        <span>Rust/WASM · {count.toLocaleString("en")} points</span>
        <span role="status">{selected ? `Selected ${selected}` : "No selection"}</span>
        {tileError ? (
          <span role="alert">Basemap unavailable. You can still explore the points.</span>
        ) : null}
        <a href={`${import.meta.env.BASE_URL}`}>Library showcase</a>
      </footer>
    </main>
  );
}

function createPoints(count: number): MapPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `point-${index}`,
    longitude: 4 + ((index * 0.61803398875) % 1) * 14,
    latitude: 46 + ((index * 0.41421356237) % 1) * 9,
    metrics: { demand: 1 + (index % 100) },
  }));
}
