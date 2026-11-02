import { Button, NativeSelect } from "@moritzbrantner/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { AggregatedMapFeature, MapPoint } from "../src/aggregation";
import { ClusterLayer } from "../src/cluster-layer";
import type { MapSurfaceController, MapViewState } from "../src/map-display";
import type { MapsRendererStats } from "../src/maps-browser-runtime";
import { MapView } from "../src/map-view";
import { createFixturePmtilesXyzTileset } from "../src/tileset-fixtures";
import { createAtlasTileset } from "./atlas-tilesets";
import { createShowcaseTileset } from "./showcase-tileset";

type EngineController = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };
type SourceChoice = "atlas" | "atlas-north" | "pmtiles" | "mvt";
type Scene = "atlas" | "atlas-south" | "points" | "west" | "east" | "south";
type Telemetry = {
  backend: "pending" | "wgpu" | "canvas2d";
  state: string;
  error: string | null;
  requests: number;
  decodes: number;
  bucketBuilds: number;
  cacheReuses: number;
  retainedBytes: number;
  switchMs: number | null;
  baseTiles: number;
  pendingTiles: number;
};

const initialView: MapViewState = { center: [10.3, 50.4], zoom: 4.1 };
const scenes: Record<Scene, MapViewState> = {
  atlas: { center: [9.54, 47.19], zoom: 12.2 },
  "atlas-south": { center: [9.53, 47.1], zoom: 12.3 },
  points: initialView,
  west: { center: [-95, 40], zoom: 3.1 },
  east: { center: [96, 30], zoom: 3.1 },
  south: { center: [13.4, -30], zoom: 3.1 },
};
const emptyStyle = { tiles: false as const };
const counts = [1000, 10000, 100000] as const;
const initialTelemetry: Telemetry = {
  backend: "pending",
  state: "loading",
  error: null,
  requests: 0,
  decodes: 0,
  bucketBuilds: 0,
  cacheReuses: 0,
  retainedBytes: 0,
  switchMs: null,
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
    (() => {
      const requested = new URLSearchParams(location.search).get("source");
      if (
        requested === "atlas" ||
        requested === "atlas-north" ||
        requested === "pmtiles" ||
        requested === "mvt"
      )
        return requested;
      // Local fixture suites remain opt-in and asset-tooling is not a dev-server dependency.
      return import.meta.env.PROD ? "atlas" : "pmtiles";
    })(),
  );
  const [scene, setScene] = useState<Scene>(() => {
    const requested = new URLSearchParams(location.search).get("scene");
    return requested && requested in scenes
      ? (requested as Scene)
      : source.startsWith("atlas")
        ? "atlas"
        : "points";
  });
  const [tilted, setTilted] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry>(initialTelemetry);
  const [selected, setSelected] = useState<string | null>(null);
  const [cameraLabel, setCameraLabel] = useState<string>("Waiting for camera");
  const [centerOutsideCoverage, setCenterOutsideCoverage] = useState(false);
  const points = useMemo(() => createPoints(count), [count]);
  const tileset = useMemo(
    () =>
      source === "atlas" || source === "atlas-north"
        ? createAtlasTileset(source, import.meta.env.BASE_URL)
        : source === "pmtiles"
          ? createShowcaseTileset(import.meta.env.BASE_URL)
          : createFixturePmtilesXyzTileset(import.meta.env.BASE_URL),
    [source],
  );
  const isAtlas = source === "atlas" || source === "atlas-north";
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
        bucketBuilds: stats.tileset?.bucketBuilds ?? 0,
        cacheReuses: stats.tileset?.cacheReuses ?? 0,
        retainedBytes: stats.tileset?.retainedBytes ?? 0,
        switchMs: stats.tileset?.switchMs ?? null,
        baseTiles: Number(canvas.dataset.mapBaseTiles ?? 0),
        pendingTiles: Number(canvas.dataset.mapBasePendingTiles ?? 0),
      };
      setTelemetry((current) =>
        (Object.keys(next) as Array<keyof Telemetry>).every((key) => current[key] === next[key])
          ? current
          : next,
      );
      const view = controller!.getViewState();
      const label = `${view.center[1].toFixed(4)}° N, ${view.center[0].toFixed(4)}° E · z${view.zoom.toFixed(2)}`;
      setCameraLabel((current) => (current === label ? current : label));
      const [west, south, east, north] = tileset.bounds;
      const outside =
        view.center[0] < west ||
        view.center[0] > east ||
        view.center[1] < south ||
        view.center[1] > north;
      setCenterOutsideCoverage((current) => (current === outside ? current : outside));
      const isTilted = (view.pitch ?? 0) > 0;
      setTilted((current) => (current === isTilted ? current : isTilted));
    };
    sample();
    const id = window.setInterval(sample, 700);
    return () => window.clearInterval(id);
  }, [tileset]);

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
    const target: Scene = isAtlas ? "atlas" : "points";
    controllerRef.current?.setViewState(scenes[target]);
    setScene(target);
    updateUrl("scene", target);
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
            <p>
              Explore a first-party Rust/WASM map of real geography, switch archive coverage, or
              test synthetic workloads.
            </p>
          </div>

          <div className="engine-controls">
            <label>
              <span>Tile source</span>
              <NativeSelect
                aria-label="Tile source"
                value={source}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const choice = event.target.value as SourceChoice;
                  if (!["atlas", "atlas-north", "pmtiles", "mvt"].includes(choice)) return;
                  setSource(choice);
                  updateUrl("source", choice);
                }}
              >
                <option value="atlas">Liechtenstein · real PMTiles</option>
                <option value="atlas-north">Liechtenstein north · real PMTiles</option>
                <option value="pmtiles">Synthetic · packed PMTiles</option>
                <option value="mvt">Synthetic · direct MVT / XYZ</option>
              </NativeSelect>
            </label>
            <label>
              <span>Point count</span>
              <NativeSelect
                aria-label="Point count"
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
                <option value="atlas">Liechtenstein overview</option>
                <option value="atlas-south">Southern coverage comparison</option>
                <option value="points">Point workload</option>
                <option value="west">West tile sample</option>
                <option value="east">East tile sample</option>
                <option value="south">South tile sample</option>
              </NativeSelect>
            </label>
          </div>

          {isAtlas && centerOutsideCoverage ? (
            <p role="status" data-testid="engine-coverage" className="engine-coverage-warning">
              Camera center outside this archive’s coverage. Only the declared region has tiles; no
              provider fallback is used.
              <Button
                variant="outline"
                onClick={() => {
                  controllerRef.current?.setViewState(scenes.atlas);
                  setScene("atlas");
                  updateUrl("scene", "atlas");
                }}
              >
                Go to Atlas
              </Button>
            </p>
          ) : null}

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
              <dt>Camera</dt>
              <dd data-testid="engine-camera">{cameraLabel}</dd>
            </div>
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
              <dt>Tile rebuilds</dt>
              <dd>{telemetry.bucketBuilds}</dd>
            </div>
            <div>
              <dt>Cache reuses</dt>
              <dd>{telemetry.cacheReuses}</dd>
            </div>
            <div>
              <dt>Retained tile bytes</dt>
              <dd data-testid="engine-retained-bytes">
                {telemetry.retainedBytes.toLocaleString("en")}
              </dd>
            </div>
            <div>
              <dt>Source switch</dt>
              <dd data-testid="engine-switch-ms">
                {telemetry.switchMs == null
                  ? "Not measured"
                  : `${telemetry.switchMs.toFixed(1)} ms`}
              </dd>
            </div>
          </dl>
          {telemetry.error ? (
            <p role="alert" className="engine-error">
              {telemetry.error}
            </p>
          ) : null}
          <div className="engine-source-details">
            <span className="engine-eyebrow">Selected tile data</span>
            <strong>{isAtlas ? "Geofabrik · Liechtenstein" : "Maps synthetic fixture"}</strong>
            <span>
              {tileset.attribution} · {tileset.license}
            </span>
            {tileset.observation ? (
              <span>
                OSM dataset observed {tileset.observation.snapshot}; not a historical validity date.
              </span>
            ) : null}
            <span className="engine-revision">
              Revision <code title={tileset.dataRevision}>{tileset.dataRevision}</code>
            </span>
            {isAtlas ? (
              <a href="https://www.openstreetmap.org/copyright">
                OpenStreetMap copyright and license ↗
              </a>
            ) : null}
          </div>
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
          {isAtlas ? (
            <>
              <strong>First-party precomputed Atlas tiles</strong> · Geofabrik Liechtenstein ·{" "}
              <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> ·
              ODbL 1.0 ·{" "}
              <span title={tileset.dataRevision}>rev {tileset.dataRevision.slice(7, 19)}</span>
            </>
          ) : (
            <>
              <strong>Synthetic local vector source</strong> · CC0 illustrative geometry, not
              real-world geography
            </>
          )}
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
