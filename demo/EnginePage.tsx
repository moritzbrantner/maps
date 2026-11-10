import { Button, NativeSelect } from "@moritzbrantner/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { AggregatedMapFeature, MapPoint } from "../src/aggregation";
import { ClusterLayer } from "../src/cluster-layer";
import type { MapSurfaceController, MapViewState } from "../src/map-display";
import type { MapsRendererStats } from "../src/maps-browser-runtime";
import { MapPlaceSearch, describeMapsPlaceSearchResult } from "../src/map-place-search";
import { MapView } from "../src/map-view";
import type { MapsPlaceSearchResult } from "../src/maps-place-search";
import { clearMapsDownloadedTiles } from "../src/maps-tile-persistence";
import { createFixturePmtilesXyzTileset } from "../src/tileset-fixtures";
import { atlasReleaseIndex, createAtlasTileset } from "./atlas-source";
import { withFixturePlaceSearch } from "./place-search-fixtures";
import { createShowcaseTileset } from "./showcase-tileset";

type EngineController = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };
type SourceChoice = "atlas" | "atlas-north" | "pmtiles" | "mvt";
type Scene = "liechtenstein" | "north" | "outside" | "points" | "west" | "east" | "south";
type Telemetry = {
  backend: "pending" | "wgpu" | "canvas2d";
  state: string;
  error: string | null;
  requests: number;
  decodes: number;
  cacheReuses: number;
  baseTiles: number;
  pendingTiles: number;
  /** `off`: this source is not kept in browser storage. */
  persistence: "off" | "idle" | "active" | "unavailable";
  storedBytes: number;
  storedTiles: number;
  budgetBytes: number;
  storedHits: number;
  storedMisses: number;
  storedEvictions: number;
};

const initialView: MapViewState = { center: [10.3, 50.4], zoom: 4.1 };
const atlasView: MapViewState = { center: [9.53, 47.14], zoom: 12.2 };
const atlasNorthView: MapViewState = { center: [9.53, 47.22], zoom: 12.2 };
const scenes: Record<Scene, MapViewState> = {
  liechtenstein: atlasView,
  north: atlasNorthView,
  outside: { center: [9.9, 47.2], zoom: 12.2 },
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
  cacheReuses: 0,
  baseTiles: 0,
  pendingTiles: 0,
  persistence: "off",
  storedBytes: 0,
  storedTiles: 0,
  budgetBytes: 0,
  storedHits: 0,
  storedMisses: 0,
  storedEvictions: 0,
};
const isAtlas = (source: SourceChoice) => source === "atlas" || source === "atlas-north";

const featureId = (feature: AggregatedMapFeature) =>
  feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;

function updateUrl(name: string, value: string) {
  const url = new URL(location.href);
  url.searchParams.set(name, value);
  history.replaceState(null, "", url);
}

export function EnginePage() {
  const controllerRef = useRef<EngineController | null>(null);
  const cameraReadoutRef = useRef<HTMLElement | null>(null);
  const [count, setCount] = useState(() => {
    const requested = Number(new URLSearchParams(location.search).get("points"));
    return counts.includes(requested as (typeof counts)[number]) ? requested : 1000;
  });
  const [source, setSource] = useState<SourceChoice>(() => {
    const requested = new URLSearchParams(location.search).get("source");
    if (requested === "mvt" || requested === "pmtiles" || requested === "atlas-north") {
      return requested;
    }
    return "atlas";
  });
  const [scene, setScene] = useState<Scene>(() => {
    const requested = new URLSearchParams(location.search).get("scene");
    if (requested && requested in scenes) return requested as Scene;
    if (source === "atlas") return "liechtenstein";
    if (source === "atlas-north") return "north";
    return "points";
  });
  const [tilted, setTilted] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry>(initialTelemetry);
  const [selected, setSelected] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<"inside" | "outside" | "zoom">("inside");
  const points = useMemo(() => createPoints(count), [count]);
  const tileset = useMemo(() => {
    if (source === "atlas") return createAtlasTileset("liechtenstein", import.meta.env.BASE_URL);
    if (source === "atlas-north") {
      return createAtlasTileset("liechtenstein-north", import.meta.env.BASE_URL);
    }
    const base = import.meta.env.BASE_URL;
    if (source === "pmtiles") return withFixturePlaceSearch(createShowcaseTileset(base), base);
    return withFixturePlaceSearch(createFixturePmtilesXyzTileset(base), base);
  }, [source]);
  const [place, setPlace] = useState<{
    result: MapsPlaceSearchResult;
    center: readonly [number, number];
  } | null>(null);
  // A place chosen before the Map View is ready is applied once its controller exists.
  const pendingPlaceRef = useRef<MapsPlaceSearchResult | null>(null);
  useEffect(() => {
    pendingPlaceRef.current = null;
    setPlace(null);
  }, [tileset]);
  const applyPlace = useCallback(
    (controller: MapSurfaceController, result: MapsPlaceSearchResult) => {
      pendingPlaceRef.current = null;
      // Bounds fitting is defined for a flat camera; keep the search result north-up.
      controller.setViewState({ ...controller.getViewState(), bearing: 0, pitch: 0 });
      controller.fitBounds([...result.bounds], { animate: false, maxZoom: 8 });
      setTilted(false);
      setPlace({ result, center: controller.getViewState().center });
    },
    [],
  );
  const navigateToPlace = useCallback(
    (result: MapsPlaceSearchResult) => {
      const controller = controllerRef.current;
      if (controller) applyPlace(controller, result);
      else pendingPlaceRef.current = result;
    },
    [applyPlace],
  );
  const onControllerReady = useCallback(
    (controller: MapSurfaceController | null) => {
      controllerRef.current = controller as EngineController | null;
      if (controller && pendingPlaceRef.current) applyPlace(controller, pendingPlaceRef.current);
    },
    [applyPlace],
  );
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
        persistence: stats.tileset?.persistence?.state ?? "off",
        storedBytes: stats.tileset?.persistence?.storedBytes ?? 0,
        storedTiles: stats.tileset?.persistence?.storedTiles ?? 0,
        budgetBytes: stats.tileset?.persistence?.budgetBytes ?? 0,
        storedHits: stats.tileset?.persistence?.hits ?? 0,
        storedMisses: stats.tileset?.persistence?.misses ?? 0,
        storedEvictions: stats.tileset?.persistence?.evictions ?? 0,
      };
      setTelemetry((current) =>
        (Object.keys(next) as Array<keyof Telemetry>).every((key) => current[key] === next[key])
          ? current
          : next,
      );
      // Written straight to the DOM so the sampled readout never costs a React render.
      if (controller && cameraReadoutRef.current) {
        cameraReadoutRef.current.textContent = formatCamera(controller.getViewState());
      }
      const isTilted = (controller?.getViewState().pitch ?? 0) > 0;
      setTilted((current) => (current === isTilted ? current : isTilted));
      if (controller && isAtlas(source)) {
        const camera = controller.getViewState();
        const [west, south, east, north] = tileset.bounds;
        let next: "inside" | "outside" | "zoom" = "inside";
        if (camera.zoom < tileset.minZoom) next = "zoom";
        else if (
          camera.center[0] < west ||
          camera.center[0] > east ||
          camera.center[1] < south ||
          camera.center[1] > north
        )
          next = "outside";
        setCoverage((current) => (current === next ? current : next));
      }
    };
    sample();
    const id = window.setInterval(sample, 700);
    return () => window.clearInterval(id);
  }, [source, tileset]);

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
    let next: Scene = "points";
    if (source === "atlas") next = "liechtenstein";
    if (source === "atlas-north") next = "north";
    controllerRef.current?.setViewState(scenes[next]);
    setScene(next);
    updateUrl("scene", next);
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
          // Real geography is worth keeping; synthetic fixtures always load from the network.
          tilePersistence={isAtlas(source)}
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
            <p>Explore real Liechtenstein data or switch to synthetic engine fixtures.</p>
          </div>

          <div className="engine-controls">
            <label>
              <span>Tile source</span>
              <NativeSelect
                aria-label="Tile source"
                value={source}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const requested = event.target.value;
                  if (!["atlas", "atlas-north", "pmtiles", "mvt"].includes(requested)) return;
                  const choice = requested as SourceChoice;
                  setSource(choice);
                  updateUrl("source", choice);
                }}
              >
                <option value="atlas">Atlas · Liechtenstein (OSM)</option>
                <option value="atlas-north">Atlas · northern coverage</option>
                <option value="pmtiles">Synthetic PMTiles fixture</option>
                <option value="mvt">Synthetic MVT / XYZ fixture</option>
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
                <option value="liechtenstein">Liechtenstein</option>
                <option value="north">Northern Liechtenstein</option>
                <option value="outside">Outside Atlas coverage</option>
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
          {isAtlas(source) ? (
            <div role="status" className="engine-source-note">
              <strong>Regional coverage · zoom 10–14</strong>
              <span>{coverageMessage(coverage)}</span>
              <Button variant="outline" onClick={resetView}>
                View covered region
              </Button>
            </div>
          ) : null}

          <MapPlaceSearch
            className="engine-place-search"
            tileset={tileset}
            onSelect={navigateToPlace}
          />
          {place ? (
            <div
              role="status"
              className="engine-source-note"
              data-place-key={place.result.key}
              data-camera-center={place.center.map((value) => value.toFixed(3)).join(",")}
            >
              <strong>{place.result.name}</strong>
              <span>{describeMapsPlaceSearchResult(place.result)}</span>
              <span>
                Map moved to this place's extent. No rendered map feature is highlighted for it.
              </span>
              <span>Source: {place.result.attribution}</span>
            </div>
          ) : null}

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
              <dt>Camera</dt>
              <dd ref={cameraReadoutRef} data-testid="engine-camera" />
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
          <div
            className="engine-source-note"
            data-testid="engine-downloaded-tiles"
            data-state={telemetry.persistence}
          >
            <strong>Downloaded tiles</strong>
            <span>{downloadedTilesMessage(telemetry)}</span>
            <Button variant="outline" onClick={() => void clearMapsDownloadedTiles()}>
              Clear downloaded tiles
            </Button>
          </div>
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
        {isAtlas(source) ? (
          <span>
            <strong>Atlas · Geofabrik / OpenStreetMap</strong> ·{" "}
            <a href="https://www.openstreetmap.org/copyright">
              © OpenStreetMap contributors · ODbL 1.0
            </a>{" "}
            · 2026-01-01 snapshot ·{" "}
            <a
              href={`https://github.com/moritzbrantner/asset-tooling/releases/download/maps-shortbread/${atlasReleaseIndex.tilesets[source === "atlas" ? 0 : 1]!.archiveRef.path}`}
            >
              Download source tiles
            </a>{" "}
            · {tileset.dataRevision}
          </span>
        ) : (
          <span>
            <strong>Local vector source</strong> · Synthetic CC0 vector tiles; not real-world
            geography.
          </span>
        )}
        <span>{count.toLocaleString("en")} synthetic points · Rust/WASM clustering</span>
        <span role="status">{selected ? `Selected ${selected}` : "No selection"}</span>
      </footer>
    </main>
  );
}

function formatCamera(view: MapViewState): string {
  const [longitude, latitude] = view.center;
  return `${longitude.toFixed(3)}, ${latitude.toFixed(3)} · z${view.zoom.toFixed(2)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function downloadedTilesMessage(telemetry: Telemetry): string {
  if (telemetry.persistence === "off")
    return "Only Atlas tiles are kept in this browser. Synthetic fixtures always load from the network.";
  if (telemetry.persistence === "unavailable")
    return "Browser storage is unavailable here. Tiles load from the network only.";
  if (telemetry.persistence === "idle") return "Opening browser storage…";
  return (
    `${telemetry.storedTiles} tiles · ${formatBytes(telemetry.storedBytes)} of ` +
    `${formatBytes(telemetry.budgetBytes)} kept in this browser. This visit: ` +
    `${telemetry.storedHits} reused, ${telemetry.storedMisses} downloaded, ` +
    `${telemetry.storedEvictions} evicted.`
  );
}

function coverageMessage(coverage: "inside" | "outside" | "zoom"): string {
  if (coverage === "zoom")
    return "Atlas geography is available only at zoom 10–14. At this scale the regional basemap is hidden; the synthetic points are independent. Use View covered region to return to the map.";
  if (coverage === "outside")
    return "Outside this archive's coverage. No provider fallback is used.";
  return "Geographic data from Liechtenstein, with gaps outside the source bounds.";
}

function createPoints(count: number): MapPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `point-${index}`,
    longitude: 4 + ((index * 0.61803398875) % 1) * 14,
    latitude: 46 + ((index * 0.41421356237) % 1) * 9,
    metrics: { demand: 1 + (index % 100) },
  }));
}
