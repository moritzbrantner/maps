import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MapsRasterTileId } from "../../src/flat-runtime-wasm";
import { GeoJsonLayer, type GeoJsonLayerFeature } from "../../src/geojson-layer";
import type { GeoJsonLayerStyle } from "../../src/geojson-layer";
import type { MapSurfaceController, MapViewState } from "../../src/map-display";
import type {
  MapsCanvasFlatRuntimeController,
  MapsRendererStats,
} from "../../src/maps-browser-runtime";
import { MapView } from "../../src/map-view";
import {
  MAPS_VECTOR_BASEMAP_STYLE_CLASSES,
  type MapsVectorBasemapClassStyle,
  type MapsVectorBasemapStyleClass,
} from "../../src/vector-basemap";
import {
  SHORTBREAD_TILE_URL,
  getShortbreadBasemapStyle,
  getShortbreadClassStyle,
  useShortbreadBasemap,
  type ShortbreadFeatureProperties,
} from "../ShortbreadBasemapLayer";

type InspectorController = MapSurfaceController &
  Pick<
    MapsCanvasFlatRuntimeController,
    "getRetainedVectorBasemap" | "getVisibleTiles" | "subscribeBaseRenderer"
  > & { getRendererStats(): MapsRendererStats | null };

type BasemapPath = "retained" | "overlay";

const PRESETS: Array<{ label: string; view: MapViewState }> = [
  { label: "Europe", view: { center: [10.3, 50.4], zoom: 4.4 } },
  { label: "Alps", view: { center: [10.5, 46.8], zoom: 8 } },
  { label: "Hamburg port", view: { center: [9.95, 53.535], zoom: 13 } },
  { label: "Berlin", view: { center: [13.405, 52.52], zoom: 12 } },
  { label: "Berlin Mitte", view: { center: [13.392, 52.517], zoom: 15.5 } },
  { label: "Rotated Berlin", view: { center: [13.405, 52.52], zoom: 13.5, bearing: 35 } },
];

const FRAME_WINDOW = 240;
const POLL_MS = 250;
const SWEEP_PHASE_MS = 3000;

export function EngineInspector() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const tileUrl = params.get("tiles") ?? SHORTBREAD_TILE_URL;
  const initialView = useMemo(() => readInitialView(params), [params]);
  const [controller, setController] = useState<InspectorController | null>(null);
  const controllerRef = useRef<InspectorController | null>(null);
  const [tiles, setTiles] = useState<MapsRasterTileId[]>([]);
  const tileKeyRef = useRef("");
  const [path, setPath] = useState<BasemapPath>(
    params.get("path") === "overlay" ? "overlay" : "retained",
  );
  const [hidden, setHidden] = useState<ReadonlySet<MapsVectorBasemapStyleClass>>(new Set());
  const [sweep, setSweep] = useState<SweepState>({ status: "idle" });

  const styleOverride = useMemo(
    () =>
      hidden.size === 0
        ? undefined
        : (styleClass: MapsVectorBasemapStyleClass, style: MapsVectorBasemapClassStyle) =>
            hidden.has(styleClass) ? { ...style, opacity: 0 } : style,
    [hidden],
  );
  const basemap = useShortbreadBasemap(tiles, {
    controller,
    forceOverlay: path === "overlay",
    styleOverride,
    tileUrl,
  });

  const refreshTiles = useCallback(() => {
    const current = controllerRef.current;
    if (!current) return;
    const next = current.getVisibleTiles();
    const key = next.map((tile) => tile.key).join("|");
    if (key === tileKeyRef.current) return;
    tileKeyRef.current = key;
    setTiles(next);
  }, []);
  const handleController = useCallback(
    (next: MapSurfaceController | null) => {
      controllerRef.current = next as InspectorController | null;
      setController(controllerRef.current);
      refreshTiles();
    },
    [refreshTiles],
  );

  const frames = useFrameMonitor();
  const stats = usePolled(() => controllerRef.current?.getRendererStats() ?? null);
  const camera = usePolled(() => controllerRef.current?.getViewState() ?? null);

  const overlayStyle = useCallback(
    (feature: GeoJsonLayerFeature) => {
      const properties = feature.properties as ShortbreadFeatureProperties;
      return hideOverlayClasses(
        getShortbreadBasemapStyle(properties.kind, properties.sourceKind),
        properties,
        feature.geometry?.type === "LineString",
        hidden,
      );
    },
    [hidden],
  );

  const runSweep = useCallback(async () => {
    const current = controllerRef.current;
    if (!current) return;
    setSweep({ status: "running", phase: "pan", results: [] });
    const results = await runCameraSweep(current, (phase, completed) =>
      setSweep({ status: "running", phase, results: completed }),
    );
    setSweep({ status: "done", results });
  }, []);

  const backendLabel =
    stats?.backend === "canvas2d"
      ? "Canvas2D fallback (no WebGPU)"
      : stats?.backend === "wgpu"
        ? basemap.renderer === "wgpu-retained"
          ? "WebGPU · retained vector buckets"
          : "WebGPU base · Canvas vector overlay"
        : "Starting…";

  return (
    <div className="engine-inspector">
      <main className="engine-inspector__map">
        <MapView
          fitToData={false}
          flatRuntime="maps"
          initialViewState={initialView}
          mapLabel="Maps engine inspector map"
          mapStyle={{ attribution: "© OpenStreetMap contributors", tiles: false }}
          onMapControllerReady={handleController}
          onViewStateChange={refreshTiles}
          style={{ height: "100%", minHeight: 0 }}
        >
          {basemap.renderer === "canvas-overlay" ? (
            <GeoJsonLayer
              featureCollection={basemap.featureCollection}
              getFeatureStyle={overlayStyle}
              isFeatureInteractive={nonInteractive}
              layerId="shortbread-basemap"
            />
          ) : null}
        </MapView>
      </main>

      <aside className="engine-inspector__panel" aria-label="Engine inspector">
        <header className="engine-inspector__header">
          <p className="engine-inspector__kicker">@moritzbrantner/maps</p>
          <h1>Engine inspector</h1>
          <p className="engine-inspector__backend" data-backend={stats?.backend ?? "pending"}>
            {backendLabel}
          </p>
          <nav className="engine-inspector__links">
            <a href={import.meta.env.BASE_URL}>Demo</a>
            <a href={`${import.meta.env.BASE_URL}engine/`}>Engine</a>
            <a href={`${import.meta.env.BASE_URL}benchmarks/`}>Benchmarks</a>
            <a href="https://github.com/moritzbrantner/maps/issues/167">#167</a>
          </nav>
        </header>

        <section aria-labelledby="inspector-frames">
          <h2 id="inspector-frames">Frame cadence</h2>
          <div className="engine-inspector__metrics">
            <Metric label="FPS" value={format(frames.fps, 0)} />
            <Metric label="p50" unit="ms" value={format(frames.p50)} />
            <Metric label="p95" unit="ms" value={format(frames.p95)} />
            <Metric label="max" unit="ms" value={format(frames.max)} />
          </div>
          <FrameSparkline intervals={frames.intervals} />
        </section>

        <section aria-labelledby="inspector-renderer">
          <h2 id="inspector-renderer">Renderer</h2>
          <dl className="engine-inspector__list">
            <Row label="Last base render" value={`${format(stats?.lastRenderMs, 2)} ms`} />
            <Row label="Full renders" value={format(stats?.renders, 0)} />
            <Row label="Translated frames" value={format(stats?.translatedFrames, 0)} />
            <Row label="Draw calls" value={format(stats?.drawCalls, 0)} />
            <Row label="Raster tiles drawn" value={format(stats?.rasterTiles, 0)} />
            <Row label="Vector tiles drawn" value={format(stats?.vectorTiles, 0)} />
          </dl>
        </section>

        <section aria-labelledby="inspector-retained">
          <h2 id="inspector-retained">Retained on the GPU</h2>
          <dl className="engine-inspector__list">
            <Row label="Vector tiles" value={format(stats?.retainedVectorTiles, 0)} />
            <Row label="Features" value={formatCount(stats?.retainedVectorFeatures)} />
            <Row label="Fill triangles" value={formatCount(stats?.retainedVectorTriangles)} />
            <Row label="Line segments" value={formatCount(stats?.retainedVectorLineSegments)} />
            <Row
              label="Buffer memory"
              value={
                stats?.retainedVectorBytes === undefined
                  ? "—"
                  : `${(stats.retainedVectorBytes / 1024 / 1024).toFixed(1)} MB`
              }
            />
            <Row
              label="Tile build (median / max)"
              value={
                basemap.buildMs.length === 0
                  ? "—"
                  : `${format(percentile(basemap.buildMs, 50))} / ${format(Math.max(...basemap.buildMs))} ms`
              }
            />
            <Row
              label="Basemap tiles"
              value={`${basemap.tileCount} visible · ${basemap.state}${basemap.error ? " · error" : ""}`}
            />
          </dl>
          {basemap.error ? <p className="engine-inspector__error">{basemap.error}</p> : null}
        </section>

        <section aria-labelledby="inspector-camera">
          <h2 id="inspector-camera">Camera</h2>
          <dl className="engine-inspector__list">
            <Row
              label="Center"
              value={
                camera ? `${camera.center[0].toFixed(4)}, ${camera.center[1].toFixed(4)}` : "—"
              }
            />
            <Row label="Zoom" value={format(camera?.zoom, 2)} />
            <Row label="Bearing" value={`${format(camera?.bearing ?? 0, 1)}°`} />
          </dl>
          <div className="engine-inspector__buttons">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => controllerRef.current?.setViewState(preset.view)}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="inspector-basemap">
          <h2 id="inspector-basemap">Basemap path</h2>
          <div className="engine-inspector__segmented" role="radiogroup">
            {(["retained", "overlay"] as const).map((option) => (
              <label key={option}>
                <input
                  checked={path === option}
                  name="basemap-path"
                  onChange={() => setPath(option)}
                  type="radio"
                />
                {option === "retained" ? "Retained WebGPU" : "Canvas overlay"}
              </label>
            ))}
          </div>
          <p className="engine-inspector__hint">
            {params.get("gpu") === "off" ? (
              <a href="?">Re-enable WebGPU</a>
            ) : (
              <a href="?gpu=off">Reload without WebGPU</a>
            )}{" "}
            to inspect the Canvas2D fallback with the motion-transform path.
          </p>
          <fieldset className="engine-inspector__classes">
            <legend>Style classes</legend>
            {MAPS_VECTOR_BASEMAP_STYLE_CLASSES.map((styleClass) => (
              <label key={styleClass}>
                <input
                  checked={!hidden.has(styleClass)}
                  onChange={(event) =>
                    setHidden((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.delete(styleClass);
                      else next.add(styleClass);
                      return next;
                    })
                  }
                  type="checkbox"
                />
                <span
                  aria-hidden="true"
                  className="engine-inspector__swatch"
                  data-line={getShortbreadClassStyle(styleClass).width !== undefined}
                  style={{ background: getShortbreadClassStyle(styleClass).color }}
                />
                {styleClass}
              </label>
            ))}
          </fieldset>
        </section>

        <section aria-labelledby="inspector-sweep">
          <h2 id="inspector-sweep">Camera sweep</h2>
          <p className="engine-inspector__hint">
            Scripted pan, zoom and rotation ({SWEEP_PHASE_MS / 1000} s each) through the real
            controller. Camera ms is the synchronous Rust frame plus base render.
          </p>
          <div className="engine-inspector__buttons">
            <button
              disabled={!controller || sweep.status === "running"}
              onClick={runSweep}
              type="button"
            >
              {sweep.status === "running" ? `Running ${sweep.phase}…` : "Run sweep"}
            </button>
            <button
              disabled={!stats}
              onClick={() =>
                void navigator.clipboard?.writeText(
                  JSON.stringify(
                    { basemap: basemap.renderer, camera, frames, stats, sweep },
                    null,
                    2,
                  ),
                )
              }
              type="button"
            >
              Copy JSON
            </button>
          </div>
          {sweep.status !== "idle" && sweep.results.length > 0 ? (
            <table className="engine-inspector__table">
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  <th scope="col">FPS</th>
                  <th scope="col">p95 ms</th>
                  <th scope="col">max ms</th>
                  <th scope="col">camera p95 ms</th>
                </tr>
              </thead>
              <tbody>
                {sweep.results.map((result) => (
                  <tr key={result.phase}>
                    <th scope="row">{result.phase}</th>
                    <td>{format(result.fps, 0)}</td>
                    <td>{format(result.frameP95)}</td>
                    <td>{format(result.frameMax)}</td>
                    <td>{format(result.cameraP95, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </aside>
    </div>
  );
}

function Metric({ label, unit, value }: { label: string; unit?: string; value: string }) {
  return (
    <div className="engine-inspector__metric">
      <span className="engine-inspector__metric-value">
        {value}
        {unit ? <small> {unit}</small> : null}
      </span>
      <span className="engine-inspector__metric-label">{label}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** Browser frame intervals over the last FRAME_WINDOW frames (one series). */
function FrameSparkline({ intervals }: { intervals: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 300;
  const height = 72;
  const ceiling = 50;
  const x = (index: number) => (index / (FRAME_WINDOW - 1)) * width;
  const y = (value: number) => height - (Math.min(value, ceiling) / ceiling) * height;
  const offset = FRAME_WINDOW - intervals.length;
  const points = intervals.map((value, index) => `${x(index + offset)},${y(value)}`).join(" ");
  const hovered = hover === null ? null : intervals[hover - offset];
  return (
    <figure className="engine-inspector__sparkline">
      <svg
        aria-label="Frame interval over the last 240 frames"
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const index = Math.round(
            ((event.clientX - bounds.left) / bounds.width) * (FRAME_WINDOW - 1),
          );
          setHover(index >= offset ? index : null);
        }}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <line className="engine-inspector__budget" x1={0} x2={width} y1={y(16.7)} y2={y(16.7)} />
        <polyline className="engine-inspector__series" points={points} />
        {hover !== null && hovered !== undefined ? (
          <line
            className="engine-inspector__crosshair"
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={height}
          />
        ) : null}
      </svg>
      <figcaption>
        {hovered !== undefined && hovered !== null
          ? `${hovered.toFixed(1)} ms frame`
          : "Frame interval (ms), dashed line = 16.7 ms, clipped at 50 ms"}
      </figcaption>
    </figure>
  );
}

function useFrameMonitor() {
  const [snapshot, setSnapshot] = useState(() => summarizeFrames([]));
  useEffect(() => {
    const intervals: number[] = [];
    let last: number | null = null;
    let handle = requestAnimationFrame(function tick(now) {
      if (last !== null) {
        intervals.push(now - last);
        if (intervals.length > FRAME_WINDOW) intervals.shift();
      }
      last = now;
      handle = requestAnimationFrame(tick);
    });
    const timer = window.setInterval(() => setSnapshot(summarizeFrames(intervals)), POLL_MS);
    return () => {
      cancelAnimationFrame(handle);
      window.clearInterval(timer);
    };
  }, []);
  return snapshot;
}

function summarizeFrames(intervals: readonly number[]) {
  const total = intervals.reduce((sum, value) => sum + value, 0);
  return {
    fps: total > 0 ? (intervals.length / total) * 1000 : null,
    intervals: [...intervals],
    max: intervals.length > 0 ? Math.max(...intervals) : null,
    p50: percentile(intervals, 50),
    p95: percentile(intervals, 95),
  };
}

function usePolled<T>(read: () => T): T | null {
  const readRef = useRef(read);
  readRef.current = read;
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    const poll = () => {
      try {
        setValue(readRef.current());
      } catch {
        setValue(null);
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  return value;
}

type SweepPhase = "pan" | "zoom" | "rotate";
type SweepResult = {
  cameraP95: number | null;
  fps: number | null;
  frameMax: number | null;
  frameP95: number | null;
  phase: SweepPhase;
};
type SweepState =
  | { status: "idle" }
  | { phase: SweepPhase; results: SweepResult[]; status: "running" }
  | { results: SweepResult[]; status: "done" };

async function runCameraSweep(
  controller: InspectorController,
  onProgress: (phase: SweepPhase, completed: SweepResult[]) => void,
) {
  const start = controller.getViewState();
  const degreesPerPixel = 360 / (512 * 2 ** start.zoom);
  const phases: Array<[SweepPhase, (t: number) => MapViewState]> = [
    [
      "pan",
      (t) => ({
        ...start,
        center: [
          start.center[0] + Math.sin(t * 2 * Math.PI) * 220 * degreesPerPixel,
          start.center[1] +
            Math.sin(t * 4 * Math.PI) *
              110 *
              degreesPerPixel *
              Math.cos((start.center[1] * Math.PI) / 180),
        ],
      }),
    ],
    ["zoom", (t) => ({ ...start, zoom: start.zoom + Math.sin(t * 2 * Math.PI) * 1.5 })],
    ["rotate", (t) => ({ ...start, bearing: (start.bearing ?? 0) + t * 360 })],
  ];
  const results: SweepResult[] = [];
  for (const [phase, viewAt] of phases) {
    onProgress(phase, [...results]);
    const intervals: number[] = [];
    const cameraMs: number[] = [];
    await new Promise<void>((resolve) => {
      let first: number | null = null;
      let last: number | null = null;
      requestAnimationFrame(function tick(now) {
        first ??= now;
        if (last !== null) intervals.push(now - last);
        last = now;
        const t = (now - first) / SWEEP_PHASE_MS;
        if (t >= 1) {
          resolve();
          return;
        }
        const started = performance.now();
        controller.setViewState(viewAt(t));
        cameraMs.push(performance.now() - started);
        requestAnimationFrame(tick);
      });
    });
    controller.setViewState(start);
    const total = intervals.reduce((sum, value) => sum + value, 0);
    results.push({
      cameraP95: percentile(cameraMs, 95),
      fps: total > 0 ? (intervals.length / total) * 1000 : null,
      frameMax: intervals.length > 0 ? Math.max(...intervals) : null,
      frameP95: percentile(intervals, 95),
      phase,
    });
  }
  return results;
}

/** Applies the style-class toggles to the Canvas overlay path. */
function hideOverlayClasses(
  style: GeoJsonLayerStyle,
  { kind, sourceKind }: ShortbreadFeatureProperties,
  isLine: boolean,
  hidden: ReadonlySet<MapsVectorBasemapStyleClass>,
): GeoJsonLayerStyle {
  if (hidden.size === 0) return style;
  if (isLine) {
    const lineClass: MapsVectorBasemapStyleClass =
      kind === "water" ? "water-line" : (kind as MapsVectorBasemapStyleClass);
    return hidden.has(lineClass) ? { ...style, lineOpacity: 0 } : style;
  }
  const fillClass: MapsVectorBasemapStyleClass =
    kind === "land" && sourceKind === "forest"
      ? "land-forest"
      : kind === "water" && sourceKind === "glacier"
        ? "water-glacier"
        : (kind as MapsVectorBasemapStyleClass);
  let next = style;
  if (hidden.has(fillClass)) next = { ...next, polygonFillOpacity: 0 };
  if (kind === "building" && hidden.has("building-outline")) {
    next = { ...next, polygonStrokeWidth: 0 };
  }
  return next;
}

function readInitialView(params: URLSearchParams): MapViewState {
  const number = (key: string) => {
    const value = params.get(key);
    return value === null || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  const preset = PRESETS[0]!.view;
  const bearing = number("bearing");
  return {
    center: [number("lon") ?? preset.center[0], number("lat") ?? preset.center[1]],
    zoom: number("zoom") ?? preset.zoom,
    ...(bearing !== null ? { bearing } : {}),
  };
}

function percentile(values: readonly number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function format(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}

function formatCount(value: number | undefined) {
  return value === undefined ? "—" : Math.round(value).toLocaleString("en-US");
}

function nonInteractive() {
  return false;
}
