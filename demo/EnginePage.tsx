import { Button, NativeSelect } from "@moritzbrantner/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { AggregatedMapFeature, MapPoint } from "../src/aggregation";
import { ClusterLayer } from "../src/cluster-layer";
import type { MapSurfaceController, MapViewState } from "../src/map-display";
import type { MapsRendererStats } from "../src/maps-browser-runtime";
import { MapView } from "../src/map-view";
import { createFixturePmtilesXyzTileset } from "../src/tileset-fixtures";
import { createShowcaseTileset } from "./showcase-tileset";

type EngineController = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };
type SourceChoice = "pmtiles" | "mvt";
type Scene = "points" | "west" | "east" | "south";
type Telemetry = {
  backend: "pending" | "wgpu" | "canvas2d";
  state: string;
  error: string | null;
  requests: number;
  decodes: number;
  cacheReuses: number;
  baseTiles: number;
  pendingTiles: number;
};

const initialView: MapViewState = { center: [10.3, 50.4], zoom: 4.1 };
const scenes: Record<Scene, MapViewState> = {
  points: initialView,
  west: { center: [-95, 40], zoom: 3.1 },
  east: { center: [96, 30], zoom: 3.1 },
  south: { center: [13.4, -30], zoom: 3.1 },
};
const emptyStyle = { tiles: false as const };
const counts = [1000, 10000, 100000] as const;
// NativeSelect inherits a light theme background from @moritzbrantner/ui in
// Chromium. Keep this panel's dark control contrast explicit at the element.
const selectStyle = { backgroundColor: "#26434a", color: "#f1f6f2" };
const initialTelemetry: Telemetry = {
  backend: "pending",
  state: "loading",
  error: null,
  requests: 0,
  decodes: 0,
  cacheReuses: 0,
  baseTiles: 0,
  pendingTiles: 0,
};

const featureId = (feature: AggregatedMapFeature) =>
  feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;

function updateUrl(name: string, value: string) {
  const url = new URL(location.href);
  url.searchParams.set(name, value);
  history.replaceState(null, "", url);
}

export function EnginePage() {
  const controllerRef = useRef<EngineController | null>(null);
  const [count, setCount] = useState(() => {
    const requested = Number(new URLSearchParams(location.search).get("points"));
    return counts.includes(requested as (typeof counts)[number]) ? requested : 1000;
  });
  const [source, setSource] = useState<SourceChoice>(() =>
    new URLSearchParams(location.search).get("source") === "mvt" ? "mvt" : "pmtiles",
  );
  const [scene, setScene] = useState<Scene>(() => {
    const requested = new URLSearchParams(location.search).get("scene");
    return requested === "west" || requested === "east" || requested === "south"
      ? requested
      : "points";
  });
  const [tilted, setTilted] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry>(initialTelemetry);
  const [selected, setSelected] = useState<string | null>(null);
  const points = useMemo(() => createPoints(count), [count]);
  const tileset = useMemo(
    () =>
      source === "pmtiles"
        ? createShowcaseTileset(import.meta.env.BASE_URL)
        : createFixturePmtilesXyzTileset(import.meta.env.BASE_URL),
    [source],
  );
  const onControllerReady = useCallback((controller: MapSurfaceController | null) => {
    controllerRef.current = controller as EngineController | null;
  }, []);
  const select = useCallback((feature: AggregatedMapFeature | null) => {
    setSelected(feature ? featureId(feature) : null);
  }, []);

  // Diagnostics are sampled; camera gestures stay inside the imperative Rust/rAF path.
  // Nothing here feeds per-frame camera coordinates back through React (#343).
  useEffect(() => {
    const sample = () => {
      const controller = controllerRef.current;
      const stats = controller?.getRendererStats();
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flat-runtime="maps"]');
      if (!stats || !canvas) return;
      const next: Telemetry = {
        backend: stats.backend,
        state: stats.tileset?.state ?? "loading",
        error: stats.tileset?.error ?? null,
        requests: stats.tileset?.requests ?? 0,
        decodes: stats.tileset?.decodes ?? 0,
        cacheReuses: stats.tileset?.cacheReuses ?? 0,
        baseTiles: Number(canvas.dataset.mapBaseTiles ?? 0),
        pendingTiles: Number(canvas.dataset.mapBasePendingTiles ?? 0),
      };
      setTelemetry((current) =>
        (Object.keys(next) as Array<keyof Telemetry>).every((key) => current[key] === next[key])
          ? current
          : next,
      );
      const isTilted = (controller?.getViewState().pitch ?? 0) > 0;
      setTilted((current) => (current === isTilted ? current : isTilted));
    };
    sample();
    const id = window.setInterval(sample, 700);
    return () => window.clearInterval(id);
  }, []);

  const toggleTilt = () => {
    const controller = controllerRef.current;
    if (!controller) return;
    const current = controller.getViewState();
    const nextTilt = (current.pitch ?? 0) === 0;
    controller.setViewState({
      ...current,
      bearing: nextTilt ? 35 : 0,
      pitch: nextTilt ? 40 : 0,
    });
    setTilted(nextTilt);
  };
  const resetView = () => {
    controllerRef.current?.setViewState(initialView);
    setScene("points");
    updateUrl("scene", "points");
    setTilted(false);
  };

  return (
    <main className="engine-page">
      <header className="engine-toolbar">
        <div className="engine-brand">
          <span className="engine-logo" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <p className="engine-kicker">@moritzbrantner/maps · First-party</p>
            <h1>Maps engine</h1>
          </div>
        </div>
        <nav aria-label="Engine navigation" className="engine-nav">
          <a href="?view=inspector">Renderer inspector</a>
          <a href={`${import.meta.env.BASE_URL}stats/`}>Stats</a>
          <a href={`${import.meta.env.BASE_URL}benchmarks/`}>Benchmark evidence</a>
          <a href="https://github.com/moritzbrantner/maps">Source ↗</a>
        </nav>
      </header>

      <section className="engine-workspace" aria-label="First-party engine playground">
        <MapView
          className="engine-map"
          flatRuntime="maps"
          fitToData={false}
          initialViewState={scenes[scene]}
          mapLabel="Maps engine map"
          mapStyle={emptyStyle}
          maxZoom={20}
          onMapControllerReady={onControllerReady}
          tileset={tileset}
          style={{ height: "100%", minHeight: 0 }}
        >
          <ClusterLayer
            points={points}
            getFeatureId={featureId}
            onFeatureSelect={select}
            selectedFeatureId={selected}
          />
        </MapView>

        <aside aria-label="Engine controls" className="engine-panel">
          <div className="engine-panel-heading">
            <span className="engine-eyebrow">
              <span className="engine-online-dot" /> Live engine
            </span>
            <p>Move the map. Inspect a cluster. Change the tile transport or point workload.</p>
          </div>

          <div className="engine-controls">
            <label>
              <span>Tile source</span>
              <NativeSelect
                aria-label="Tile source"
                style={selectStyle}
                value={source}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const choice: SourceChoice = event.target.value === "mvt" ? "mvt" : "pmtiles";
                  setSource(choice);
                  updateUrl("source", choice);
                }}
              >
                <option value="pmtiles">Packed PMTiles v3</option>
                <option value="mvt">Direct MVT / XYZ</option>
              </NativeSelect>
            </label>
            <label>
              <span>Point count</span>
              <NativeSelect
                aria-label="Point count"
                style={selectStyle}
                value={count}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const next = Number(event.target.value);
                  if (!counts.includes(next as (typeof counts)[number])) return;
                  setCount(next);
                  setSelected(null);
                  updateUrl("points", String(next));
                }}
              >
                {counts.map((value) => (
                  <option key={value} value={value}>
                    {value.toLocaleString("en")}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              <span>Camera scene</span>
              <NativeSelect
                aria-label="Camera scene"
                style={selectStyle}
                value={scene}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const next = event.target.value as Scene;
                  if (!(next in scenes)) return;
                  controllerRef.current?.setViewState(scenes[next]);
                  setScene(next);
                  setTilted(false);
                  updateUrl("scene", next);
                }}
              >
                <option value="points">Point workload</option>
                <option value="west">West tile sample</option>
                <option value="east">East tile sample</option>
                <option value="south">South tile sample</option>
              </NativeSelect>
            </label>
          </div>

          <div className="engine-actions">
            <Button variant="outline" onClick={toggleTilt}>
              {tilted ? "Flatten view" : "Tilt view"}
            </Button>
            <Button variant="outline" onClick={resetView}>
              Reset view
            </Button>
          </div>

          <div className="engine-divider" />

          <div className="engine-live-heading">
            <span className="engine-eyebrow">Runtime telemetry</span>
            <span className="engine-state" data-state={telemetry.state}>
              {telemetry.state}
            </span>
          </div>
          <dl className="engine-metrics">
            <div>
              <dt>Renderer</dt>
              <dd data-testid="engine-renderer">
                {telemetry.backend === "wgpu"
                  ? "WebGPU"
                  : telemetry.backend === "canvas2d"
                    ? "Canvas2D fallback"
                    : "Starting…"}
              </dd>
            </div>
            <div>
              <dt>Base tiles</dt>
              <dd>
                {telemetry.baseTiles} <small>/ {telemetry.pendingTiles} pending</small>
              </dd>
            </div>
            <div>
              <dt>Tile requests</dt>
              <dd>{telemetry.requests}</dd>
            </div>
            <div>
              <dt>Rust decodes</dt>
              <dd>{telemetry.decodes}</dd>
            </div>
            <div>
              <dt>Cache reuses</dt>
              <dd>{telemetry.cacheReuses}</dd>
            </div>
          </dl>
          {telemetry.error ? (
            <p role="alert" className="engine-error">
              {telemetry.error}
            </p>
          ) : null}
          <div className="engine-capabilities">
            <span>Rust camera + tile scheduling</span>
            <span>WebGPU / Canvas2D presentation</span>
            <span>Spatial clustering + picking</span>
          </div>
        </aside>

        <div className="engine-map-hint">Drag to pan · Scroll to zoom · Select a cluster</div>
      </section>

      <footer className="engine-status">
        <span>
          <strong>Local vector source</strong> · Synthetic CC0 vector tiles; not real-world
          geography.{" "}
          <a href="https://github.com/moritzbrantner/maps/issues/270">Atlas source in progress ↗</a>
        </span>
        <span>{count.toLocaleString("en")} synthetic points · Rust/WASM clustering</span>
        <span role="status">{selected ? `Selected ${selected}` : "No selection"}</span>
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
