import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Map as MapLibreMap } from "maplibre-gl";

import {
  GeoJsonLayer,
  MapView,
  type MapSurfaceController,
  type MapViewState,
} from "@moritzbrantner/maps";

import {
  BENCHMARK_INITIAL_VIEW,
  createBenchmarkFeatureCollection,
  createBenchmarkJourney,
  summarizeBenchmarkSamples,
  type BenchmarkFeatureCollection,
  type BenchmarkSummary,
} from "./benchmark-model";
import "./benchmarks.css";

type BenchmarkId = "maps" | "canvas2d" | "leaflet" | "maplibre";

type BenchmarkRun = {
  detail: string;
  summary: BenchmarkSummary;
};

type BenchmarkRunner = (journey: readonly MapViewState[]) => Promise<BenchmarkRun>;

type RegisterRunner = (
  id: BenchmarkId,
  runner: BenchmarkRunner | null,
  availability: string,
) => void;

type BenchmarkResultState = {
  detail: string;
  status: "idle" | "running" | "complete" | "error";
  summary?: BenchmarkSummary;
};

const BENCHMARK_ROWS: ReadonlyArray<{
  id: BenchmarkId;
  label: string;
  scope: string;
}> = [
  {
    id: "maps",
    label: "Maps engine",
    scope: "End-to-end Maps camera, projection, retained geometry, and pixel backend",
  },
  {
    id: "canvas2d",
    label: "Canvas2D reference",
    scope: "Pixel-only baseline over the same point count; no geographic projection",
  },
  {
    id: "leaflet",
    label: "Leaflet 1.9.4",
    scope: "Reference map engine using its Canvas renderer and in-memory point layers",
  },
  {
    id: "maplibre",
    label: "MapLibre GL 6.4.1",
    scope: "Reference map engine using an in-memory GeoJSON source and circle layer",
  },
];

const LEAFLET_SCRIPT_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_SCRIPT_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
const LEAFLET_STYLE_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_STYLE_INTEGRITY = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";

export function BenchmarksPage() {
  const e2e = new URLSearchParams(window.location.search).get("e2e") === "1";
  const [pointCount, setPointCount] = useState(e2e ? 400 : 5_000);
  const [cameraSteps, setCameraSteps] = useState(e2e ? 4 : 12);
  const [availability, setAvailability] = useState<Record<BenchmarkId, string>>({
    maps: "Initializing",
    canvas2d: "Initializing",
    leaflet: "Loading reference runtime",
    maplibre: "Initializing",
  });
  const [results, setResults] = useState<Record<BenchmarkId, BenchmarkResultState>>(
    createInitialResults,
  );
  const [runningAll, setRunningAll] = useState(false);
  const runnersRef = useRef(new Map<BenchmarkId, BenchmarkRunner>());

  const featureCollection = useMemo(
    () => createBenchmarkFeatureCollection(pointCount),
    [pointCount],
  );
  const journey = useMemo(() => createBenchmarkJourney(cameraSteps), [cameraSteps]);

  const registerRunner = useCallback<RegisterRunner>((id, runner, nextAvailability) => {
    if (runner) runnersRef.current.set(id, runner);
    else runnersRef.current.delete(id);
    setAvailability((current) => ({ ...current, [id]: nextAvailability }));
  }, []);

  useEffect(() => {
    setResults(createInitialResults());
  }, [pointCount, cameraSteps]);

  const runBenchmark = useCallback(
    async (id: BenchmarkId) => {
      const runner = runnersRef.current.get(id);
      if (!runner) {
        setResults((current) => ({
          ...current,
          [id]: {
            detail: availability[id],
            status: "error",
          },
        }));
        return;
      }

      setResults((current) => ({
        ...current,
        [id]: { detail: "Running", status: "running" },
      }));

      try {
        const result = await runner(journey);
        setResults((current) => ({
          ...current,
          [id]: {
            detail: result.detail,
            status: "complete",
            summary: result.summary,
          },
        }));
      } catch (error) {
        setResults((current) => ({
          ...current,
          [id]: {
            detail: error instanceof Error ? error.message : "Benchmark failed.",
            status: "error",
          },
        }));
      }
    },
    [availability, journey],
  );

  const runAll = useCallback(async () => {
    setRunningAll(true);
    try {
      for (const row of BENCHMARK_ROWS) {
        await runBenchmark(row.id);
      }
    } finally {
      setRunningAll(false);
    }
  }, [runBenchmark]);

  const updatePointCount = (event: ChangeEvent<HTMLInputElement>) => {
    setPointCount(clampInteger(Number(event.currentTarget.value), 100, 20_000));
  };
  const updateCameraSteps = (event: ChangeEvent<HTMLInputElement>) => {
    setCameraSteps(clampInteger(Number(event.currentTarget.value), 3, 40));
  };

  const pagesBase = import.meta.env.BASE_URL;

  return (
    <main className="maps-benchmarks">
      <header className="maps-benchmarks__header">
        <div>
          <p className="maps-benchmarks__kicker">@moritzbrantner/maps</p>
          <h1>Renderer benchmark lab</h1>
          <p className="maps-benchmarks__lede">
            Run the same deterministic dense-point camera journey through the first-party Maps
            engine and explicit browser reference implementations.
          </p>
        </div>
        <nav className="maps-benchmarks__nav" aria-label="Project pages">
          <a href={pagesBase}>Demo</a>
          <a aria-current="page" href={pagesBase + "benchmarks/"}>
            Benchmarks
          </a>
          <a href={pagesBase + "stats/"}>Stats</a>
          <a href={pagesBase + "evidence/"}>Evidence</a>
          <a href="https://github.com/moritzbrantner/maps">Source</a>
        </nav>
      </header>

      <section className="maps-benchmarks__controls" aria-labelledby="benchmark-controls-title">
        <div>
          <h2 id="benchmark-controls-title">Workload</h2>
          <p>
            Exact values are editable. Changing the workload clears prior observations so results
            always describe the visible configuration.
          </p>
        </div>
        <label>
          Points
          <input
            aria-label="Benchmark point count"
            inputMode="numeric"
            max={20_000}
            min={100}
            onChange={updatePointCount}
            step={100}
            type="number"
            value={pointCount}
          />
        </label>
        <label>
          Camera steps
          <input
            aria-label="Benchmark camera steps"
            inputMode="numeric"
            max={40}
            min={3}
            onChange={updateCameraSteps}
            step={1}
            type="number"
            value={cameraSteps}
          />
        </label>
        <button
          className="maps-benchmarks__button maps-benchmarks__button--primary"
          disabled={runningAll}
          onClick={() => void runAll()}
          type="button"
        >
          {runningAll ? "Running all…" : "Run all"}
        </button>
      </section>

      <section className="maps-benchmarks__results" aria-labelledby="benchmark-results-title">
        <div className="maps-benchmarks__section-heading">
          <div>
            <h2 id="benchmark-results-title">Local browser observations</h2>
            <p>
              p50 and p95 are presentation-step durations from this browser session. Lower values
              mean the local presentation step completed sooner; they are not a repository verdict.
            </p>
          </div>
        </div>
        <div className="maps-benchmarks__table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Implementation</th>
                <th scope="col">Scope</th>
                <th scope="col">Status / backend</th>
                <th scope="col">p50</th>
                <th scope="col">p95</th>
                <th scope="col">Samples</th>
                <th scope="col">
                  <span className="maps-benchmarks__visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {BENCHMARK_ROWS.map((row) => {
                const result = results[row.id];
                const isRunning = result.status === "running";

                return (
                  <tr data-testid={"benchmark-result-" + row.id} key={row.id}>
                    <th scope="row">{row.label}</th>
                    <td>{row.scope}</td>
                    <td>{formatStatus(result, availability[row.id])}</td>
                    <td>{formatMilliseconds(result.summary?.p50Ms)}</td>
                    <td>{formatMilliseconds(result.summary?.p95Ms)}</td>
                    <td>{result.summary?.samples ?? "—"}</td>
                    <td>
                      <button
                        aria-label={"Run " + row.label}
                        className="maps-benchmarks__button"
                        disabled={runningAll || isRunning}
                        onClick={() => void runBenchmark(row.id)}
                        type="button"
                      >
                        {isRunning ? "Running…" : "Run"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="maps-benchmarks__evidence-note">
          These timings are local-session diagnostics only. They are not runtime-profiler evidence
          and do not participate in Moonlight verdicts. Canonical performance evidence remains
          produced and evaluated in CI.
        </p>
      </section>

      <section className="maps-benchmarks__previews" aria-labelledby="benchmark-previews-title">
        <div className="maps-benchmarks__section-heading">
          <div>
            <h2 id="benchmark-previews-title">Live implementations</h2>
            <p>
              The map-engine lanes share the same generated geographic points and camera journey.
              Canvas2D intentionally stays a pixel-only raster baseline instead of becoming a second
              geographic authority.
            </p>
          </div>
        </div>
        <div className="maps-benchmarks__preview-grid">
          <MapsBenchmarkPreview
            featureCollection={featureCollection}
            registerRunner={registerRunner}
          />
          <CanvasBenchmarkPreview pointCount={pointCount} registerRunner={registerRunner} />
          <LeafletBenchmarkPreview
            featureCollection={featureCollection}
            registerRunner={registerRunner}
          />
          <MapLibreBenchmarkPreview
            featureCollection={featureCollection}
            registerRunner={registerRunner}
          />
        </div>
      </section>
    </main>
  );
}

function MapsBenchmarkPreview({
  featureCollection,
  registerRunner,
}: {
  featureCollection: BenchmarkFeatureCollection;
  registerRunner: RegisterRunner;
}) {
  const controllerRef = useRef<MapSurfaceController | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const ready = useCallback(
    (controller: MapSurfaceController) => {
      controllerRef.current = controller;
      registerRunner(
        "maps",
        async (journey) => {
          const activeController = controllerRef.current;
          if (!activeController) throw new Error("Maps controller is unavailable.");

          const summary = await measureJourney(journey, (viewState) => {
            activeController.setViewState(viewState);
          });
          const backend =
            hostRef.current
              ?.querySelector("[data-map-overlay-backend]")
              ?.getAttribute("data-map-overlay-backend") ??
            hostRef.current
              ?.querySelector("[data-map-base-renderer]")
              ?.getAttribute("data-map-base-renderer") ??
            "runtime";

          return { detail: "Complete · " + backend, summary };
        },
        "Ready · first-party runtime",
      );
    },
    [registerRunner],
  );

  useEffect(
    () => () => registerRunner("maps", null, "Initializing"),
    [registerRunner],
  );

  return (
    <BenchmarkPreviewCard
      description="Rust-owned map semantics with the active WebGPU/Canvas2D pixel backend."
      label="Maps engine"
      status="First-party"
    >
      <div className="maps-benchmarks__map-host" ref={hostRef}>
        <MapView
          fitToData={false}
          flatRuntime="maps"
          initialViewState={BENCHMARK_INITIAL_VIEW}
          mapLabel="Maps benchmark preview"
          mapStyle={{ tiles: false }}
          onMapControllerReady={ready}
          style={{ height: "100%" }}
        >
          <GeoJsonLayer
            featureCollection={featureCollection}
            pointColor="#0f766e"
            pointRadius={2.5}
          />
        </MapView>
      </div>
    </BenchmarkPreviewCard>
  );
}

function CanvasBenchmarkPreview({
  pointCount,
  registerRunner,
}: {
  pointCount: number;
  registerRunner: RegisterRunner;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const points = useMemo(() => createScreenPoints(pointCount), [pointCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = (journeyIndex: number) => drawCanvasReference(canvas, points, journeyIndex);
    const resizeObserver = new ResizeObserver(() => draw(0));
    resizeObserver.observe(canvas);
    draw(0);

    registerRunner(
      "canvas2d",
      async (journey) => {
        const summary = await measureJourney(journey, (_viewState, index) => draw(index));
        return { detail: "Complete · pixel-only Canvas2D", summary };
      },
      "Ready · pixel-only baseline",
    );

    return () => {
      resizeObserver.disconnect();
      registerRunner("canvas2d", null, "Initializing");
    };
  }, [points, registerRunner]);

  return (
    <BenchmarkPreviewCard
      description="Preprojected screen points only. Useful for raster cost, not map semantics."
      label="Canvas2D reference"
      status="Pixel baseline"
    >
      <canvas
        aria-label="Canvas2D benchmark preview"
        className="maps-benchmarks__reference-canvas"
        ref={canvasRef}
      />
    </BenchmarkPreviewCard>
  );
}

function MapLibreBenchmarkPreview({
  featureCollection,
  registerRunner,
}: {
  featureCollection: BenchmarkFeatureCollection;
  registerRunner: RegisterRunner;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Initializing");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let map: MapLibreMap | null = null;
    registerRunner("maplibre", null, "Initializing");

    try {
      map = new MapLibreMap({
        attributionControl: false,
        center: BENCHMARK_INITIAL_VIEW.center,
        container: host,
        interactive: false,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: "benchmark-background",
              type: "background",
              paint: { "background-color": "#edf2f4" },
            },
          ],
        },
        zoom: BENCHMARK_INITIAL_VIEW.zoom,
      });

      map.once("load", () => {
        if (disposed || !map) return;

        map.addSource("benchmark-points", {
          type: "geojson",
          data: featureCollection as never,
        });
        map.addLayer({
          id: "benchmark-points",
          type: "circle",
          source: "benchmark-points",
          paint: {
            "circle-color": "#2563eb",
            "circle-radius": 2.5,
          },
        });
        map.resize();
        setStatus("Ready");

        registerRunner(
          "maplibre",
          async (journey) => {
            if (!map) throw new Error("MapLibre reference is unavailable.");
            const summary = await measureJourney(journey, (viewState) => {
              map!.jumpTo({
                center: viewState.center,
                zoom: viewState.zoom,
              });
            });
            return { detail: "Complete · MapLibre GL 6.4.1", summary };
          },
          "Ready · MapLibre GL 6.4.1",
        );
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "MapLibre initialization failed.";
      setStatus("Unavailable");
      registerRunner("maplibre", null, "Unavailable · " + detail);
    }

    return () => {
      disposed = true;
      registerRunner("maplibre", null, "Initializing");
      map?.remove();
    };
  }, [featureCollection, registerRunner]);

  return (
    <BenchmarkPreviewCard
      description="Pinned MapLibre dependency with an in-memory GeoJSON source and no tile network."
      label="MapLibre GL 6.4.1"
      status={status}
    >
      <div
        aria-label="MapLibre benchmark preview"
        className="maps-benchmarks__map-host"
        ref={hostRef}
      />
    </BenchmarkPreviewCard>
  );
}

function LeafletBenchmarkPreview({
  featureCollection,
  registerRunner,
}: {
  featureCollection: BenchmarkFeatureCollection;
  registerRunner: RegisterRunner;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Loading");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let map: LeafletMapLike | null = null;
    registerRunner("leaflet", null, "Loading Leaflet 1.9.4");

    void loadLeaflet()
      .then((leaflet) => {
        if (disposed) return;

        const renderer = leaflet.canvas({ padding: 0.5 });
        map = leaflet.map(host, {
          attributionControl: false,
          preferCanvas: true,
          fadeAnimation: false,
          markerZoomAnimation: false,
          zoomAnimation: false,
          zoomControl: false,
          zoomSnap: 0,
        });
        map.setView(
          [BENCHMARK_INITIAL_VIEW.center[1], BENCHMARK_INITIAL_VIEW.center[0]],
          BENCHMARK_INITIAL_VIEW.zoom,
          { animate: false },
        );

        for (const feature of featureCollection.features) {
          if (feature.geometry.type !== "Point") continue;
          const [longitude, latitude] = feature.geometry.coordinates;
          leaflet
            .circleMarker([latitude, longitude], {
              color: "#7c3aed",
              fillColor: "#7c3aed",
              fillOpacity: 1,
              radius: 2.5,
              renderer,
              stroke: false,
            })
            .addTo(map);
        }

        map.invalidateSize(false);
        setStatus("Ready");
        registerRunner(
          "leaflet",
          async (journey) => {
            if (!map) throw new Error("Leaflet reference is unavailable.");
            const summary = await measureJourney(journey, (viewState) => {
              map!.setView(
                [viewState.center[1], viewState.center[0]],
                viewState.zoom,
                { animate: false },
              );
            });
            return { detail: "Complete · Leaflet 1.9.4 Canvas", summary };
          },
          "Ready · Leaflet 1.9.4 Canvas",
        );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const detail = error instanceof Error ? error.message : "Leaflet failed to load.";
        setStatus("Unavailable");
        registerRunner("leaflet", null, "Unavailable · " + detail);
      });

    return () => {
      disposed = true;
      registerRunner("leaflet", null, "Initializing");
      map?.remove();
    };
  }, [featureCollection, registerRunner]);

  return (
    <BenchmarkPreviewCard
      description="Pinned stable Leaflet reference loaded only by this lab; no product runtime dependency."
      label="Leaflet 1.9.4"
      status={status}
    >
      <div
        aria-label="Leaflet benchmark preview"
        className="maps-benchmarks__map-host"
        ref={hostRef}
      />
    </BenchmarkPreviewCard>
  );
}

function BenchmarkPreviewCard({
  children,
  description,
  label,
  status,
}: {
  children: ReactNode;
  description: string;
  label: string;
  status: string;
}) {
  return (
    <article className="maps-benchmarks__preview-card">
      <header>
        <div>
          <h3>{label}</h3>
          <p>{description}</p>
        </div>
        <span>{status}</span>
      </header>
      <div className="maps-benchmarks__preview-stage">{children}</div>
    </article>
  );
}

async function measureJourney(
  journey: readonly MapViewState[],
  command: (viewState: MapViewState, index: number) => void | Promise<void>,
) {
  const samples: number[] = [];

  for (const [index, viewState] of journey.entries()) {
    const startedAt = performance.now();
    await command(viewState, index);
    await waitForPresentation();
    samples.push(performance.now() - startedAt);
  }

  return summarizeBenchmarkSamples(samples);
}

function waitForPresentation() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}


function createScreenPoints(count: number) {
  const columns = Math.ceil(Math.sqrt(count));

  return Array.from({ length: count }, (_, index) => ({
    x: ((index % columns) + 0.5) / columns,
    y: (Math.floor(index / columns) + 0.5) / columns,
  }));
}

function drawCanvasReference(
  canvas: HTMLCanvasElement,
  points: ReadonlyArray<{ x: number; y: number }>,
  journeyIndex: number,
) {
  const width = Math.max(1, Math.round(canvas.clientWidth || 1));
  const height = Math.max(1, Math.round(canvas.clientHeight || 1));
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.max(1, Math.round(width * ratio));
  const backingHeight = Math.max(1, Math.round(height * ratio));

  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D context is unavailable.");

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = "#edf2f4";
  context.fillRect(0, 0, width, height);

  const scale = 1 + ((journeyIndex % 3) - 1) * 0.015;
  const offsetX = ((journeyIndex % 5) - 2) * 1.4;
  const offsetY = ((journeyIndex % 4) - 1.5) * 1.2;

  context.save();
  context.translate(width / 2 + offsetX, height / 2 + offsetY);
  context.scale(scale, scale);
  context.translate(-width / 2, -height / 2);
  context.fillStyle = "#b45309";
  context.beginPath();
  for (const point of points) {
    context.moveTo(point.x * width + 2.5, point.y * height);
    context.arc(point.x * width, point.y * height, 2.5, 0, Math.PI * 2);
  }
  context.fill();
  context.restore();
}

function createInitialResults(): Record<BenchmarkId, BenchmarkResultState> {
  return {
    maps: { detail: "", status: "idle" },
    canvas2d: { detail: "", status: "idle" },
    leaflet: { detail: "", status: "idle" },
    maplibre: { detail: "", status: "idle" },
  };
}

function formatStatus(result: BenchmarkResultState, availability: string) {
  if (result.status === "running") return "Running";
  if (result.status === "complete" || result.status === "error") return result.detail;
  return availability;
}

function formatMilliseconds(value: number | undefined) {
  return value === undefined ? "—" : value.toFixed(2) + " ms";
}

function clampInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

type LeafletRendererLike = object;

type LeafletLayerLike = {
  addTo(map: LeafletMapLike): LeafletLayerLike;
};

type LeafletMapLike = {
  invalidateSize(animate: boolean): void;
  remove(): void;
  setView(
    center: [latitude: number, longitude: number],
    zoom: number,
    options: { animate: boolean },
  ): LeafletMapLike;
};

type LeafletNamespace = {
  canvas(options: { padding: number }): LeafletRendererLike;
  circleMarker(
    coordinates: [latitude: number, longitude: number],
    options: {
      color: string;
      fillColor: string;
      fillOpacity: number;
      radius: number;
      renderer: LeafletRendererLike;
      stroke: boolean;
    },
  ): LeafletLayerLike;
  map(
    element: HTMLElement,
    options: {
      attributionControl: boolean;
      fadeAnimation: boolean;
      markerZoomAnimation: boolean;
      preferCanvas: boolean;
      zoomAnimation: boolean;
      zoomControl: boolean;
      zoomSnap: number;
    },
  ): LeafletMapLike;
};

declare global {
  interface Window {
    L?: LeafletNamespace;
  }
}

let leafletLoadPromise: Promise<LeafletNamespace> | null = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = Promise.all([loadLeafletStyle(), loadLeafletScript()]).then(() => {
    if (!window.L) throw new Error("Leaflet loaded without exposing its browser API.");
    return window.L;
  });

  return leafletLoadPromise;
}

function loadLeafletStyle() {
  const existing = document.querySelector<HTMLLinkElement>(
    'link[data-maps-benchmark-leaflet="style"]',
  );
  if (existing) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.crossOrigin = "anonymous";
    link.dataset.mapsBenchmarkLeaflet = "style";
    link.href = LEAFLET_STYLE_URL;
    link.integrity = LEAFLET_STYLE_INTEGRITY;
    link.rel = "stylesheet";
    link.onload = () => resolve();
    link.onerror = () => reject(new Error("Leaflet stylesheet could not be loaded."));
    document.head.append(link);
  });
}

function loadLeafletScript() {
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-maps-benchmark-leaflet="script"]',
  );
  if (existing && window.L) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Leaflet script could not be loaded.")),
      { once: true },
    );
    if (!existing) {
      script.crossOrigin = "anonymous";
      script.dataset.mapsBenchmarkLeaflet = "script";
      script.integrity = LEAFLET_SCRIPT_INTEGRITY;
      script.src = LEAFLET_SCRIPT_URL;
      document.head.append(script);
    }
  });
}
