import { useEffect, useMemo, useState } from "react";

type BenchmarkResult = {
  basemap: "raster" | "vector";
  engine: string;
  fps: number | null;
  frameMax: number | null;
  frameP50: number | null;
  frameP95: number | null;
  jankFrames: number | null;
  loafBlockingMs: number | null;
  mainThreadMs: number | null;
  renderer: string | null;
  responded: boolean;
  scenario: string;
  scriptMs: number | null;
};

type BenchmarkRun = {
  cpuThrottle: number;
  environment: {
    browser: string;
    ci: boolean;
    cpuModel: string | null;
    cpus: number;
    platform: string;
  };
  generatedAt: string;
  gpu: string;
  repeats: number;
  results: BenchmarkResult[];
  revision: string | null;
};

type History = { runs: BenchmarkRun[]; schema: string };

type MetricKey = "frameP95" | "mainThreadMs" | "fps" | "jankFrames";

const METRICS: Record<MetricKey, { label: string; unit: string; better: "lower" | "higher" }> = {
  frameP95: { better: "lower", label: "p95 frame interval", unit: "ms" },
  mainThreadMs: { better: "lower", label: "Main-thread time per gesture", unit: "ms" },
  fps: { better: "higher", label: "Frames per second", unit: "fps" },
  jankFrames: { better: "lower", label: "Janky frames (> 25 ms)", unit: "frames" },
};

// Fixed categorical order: color follows the engine, never its rank.
const ENGINES = [
  { id: "maps-wgpu", label: "Maps · WebGPU", short: "Maps GPU", slot: 1 },
  { id: "maplibre", label: "MapLibre (reference)", short: "MapLibre", slot: 2 },
  { id: "maps-canvas2d", label: "Maps · Canvas2D fallback", short: "Maps Canvas", slot: 3 },
] as const;

const PANELS = [
  { basemap: "vector", scenario: "drag" },
  { basemap: "vector", scenario: "zoom" },
  { basemap: "vector", scenario: "rotate" },
  { basemap: "raster", scenario: "drag" },
  { basemap: "raster", scenario: "zoom" },
  { basemap: "raster", scenario: "rotate" },
] as const;

const LIVE_HISTORY = "https://moritzbrantner.github.io/maps/benchmarks/history.json";

export function BenchmarkDashboard() {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<MetricKey>("frameP95");
  const [basemap, setBasemap] = useState<"all" | "vector" | "raster">("all");

  useEffect(() => {
    void loadHistory().then(setHistory, (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, []);

  const runs = history?.runs ?? [];
  const latest = runs.at(-1) ?? null;
  const panels = PANELS.filter((panel) => basemap === "all" || panel.basemap === basemap);

  return (
    <section className="bench" aria-labelledby="bench-history-title">
      <header className="bench__header">
        <p className="bench__kicker">Benchmark history</p>
        <h2 id="bench-history-title">Engine interaction benchmarks</h2>
        <p className="bench__lede">
          Every push to <code>main</code> drives the same drag, wheel-zoom and rotate gestures
          through Maps (WebGPU and its Canvas2D fallback) and the MapLibre reference, over a
          deterministic raster basemap and a Shortbread-style vector basemap.
        </p>
        <p className="bench__note">
          Descriptive evidence, not a gate: runs use a software GPU (SwiftShader) on shared CI
          runners, so absolute numbers understate real hardware. Compare engines within a run and
          watch trends. Inspect the engine live in the{" "}
          <a href={`${import.meta.env.BASE_URL}engine/?view=inspector`}>engine inspector</a>.
        </p>
        <nav className="bench__links">
          <a href="https://github.com/moritzbrantner/maps/blob/main/scripts/benchmark-interactions.mjs">
            Methodology
          </a>
        </nav>
      </header>

      {error ? (
        <p className="bench__empty" role="status">
          Benchmark history is unavailable: {error}
        </p>
      ) : !history ? (
        <p className="bench__empty" role="status">
          Loading benchmark history…
        </p>
      ) : runs.length === 0 ? (
        <p className="bench__empty" role="status">
          No benchmark runs have been published yet.
        </p>
      ) : (
        <>
          <div className="bench__filters" role="group" aria-label="Chart filters">
            <label>
              Metric
              <select
                value={metric}
                onChange={(event) => setMetric(event.target.value as MetricKey)}
              >
                {(Object.keys(METRICS) as MetricKey[]).map((key) => (
                  <option key={key} value={key}>
                    {METRICS[key].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Basemap
              <select
                value={basemap}
                onChange={(event) => setBasemap(event.target.value as typeof basemap)}
              >
                <option value="all">Vector and raster</option>
                <option value="vector">Vector (Shortbread)</option>
                <option value="raster">Raster</option>
              </select>
            </label>
            <Legend />
          </div>

          {latest ? <LatestRun metric={metric} run={latest} basemap={basemap} /> : null}

          <section aria-labelledby="bench-trends">
            <h2 id="bench-trends">
              {METRICS[metric].label} over time{" "}
              <span className="bench__muted">
                ({METRICS[metric].better} is better, {runs.length} run{runs.length === 1 ? "" : "s"}
                )
              </span>
            </h2>
            <div className="bench__grid">
              {panels.map((panel) => (
                <TrendChart
                  basemap={panel.basemap}
                  key={`${panel.basemap}-${panel.scenario}`}
                  metric={metric}
                  runs={runs}
                  scenario={panel.scenario}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function Legend() {
  return (
    <ul className="bench__legend" aria-label="Engines">
      {ENGINES.map((engine) => (
        <li key={engine.id}>
          <span aria-hidden="true" className="bench__key" data-slot={engine.slot} />
          {engine.label}
        </li>
      ))}
    </ul>
  );
}

function LatestRun({
  basemap,
  metric,
  run,
}: {
  basemap: "all" | "vector" | "raster";
  metric: MetricKey;
  run: BenchmarkRun;
}) {
  const definition = METRICS[metric];
  const rows = PANELS.filter((panel) => basemap === "all" || panel.basemap === basemap);
  return (
    <section aria-labelledby="bench-latest" className="bench__latest">
      <h2 id="bench-latest">
        Latest run{" "}
        <span className="bench__muted">
          {new Date(run.generatedAt).toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          {run.revision ? (
            <>
              {" · "}
              <a href={`https://github.com/moritzbrantner/maps/commit/${run.revision}`}>
                {run.revision.slice(0, 7)}
              </a>
            </>
          ) : null}
          {` · ${run.environment.browser} · ${run.gpu} · ${run.repeats} repeats`}
        </span>
      </h2>
      <div className="bench__table-wrap">
        <table className="bench__table">
          <caption>
            {definition.label} ({definition.unit}), median of repeats; {definition.better} is
            better.
          </caption>
          <thead>
            <tr>
              <th scope="col">Basemap · gesture</th>
              {ENGINES.map((engine) => (
                <th key={engine.id} scope="col">
                  <span aria-hidden="true" className="bench__key" data-slot={engine.slot} />
                  {engine.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const values = ENGINES.map((engine) =>
                findResult(run, engine.id, row.basemap, row.scenario),
              );
              const numbers = values.map((result) => result?.[metric] ?? null);
              const finite = numbers.filter((value): value is number => value !== null);
              const best =
                finite.length === 0
                  ? null
                  : definition.better === "lower"
                    ? Math.min(...finite)
                    : Math.max(...finite);
              return (
                <tr key={`${row.basemap}-${row.scenario}`}>
                  <th scope="row">
                    {row.basemap} · {row.scenario}
                  </th>
                  {values.map((result, index) => (
                    <td
                      data-best={
                        numbers[index] !== null && numbers[index] === best && finite.length > 1
                      }
                      key={ENGINES[index]!.id}
                      title={result?.renderer ? `renderer: ${result.renderer}` : undefined}
                    >
                      {result === null ? "—" : formatValue(numbers[index] ?? null, metric)}
                      {result && !result.responded ? " (no response)" : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const CHART = { width: 360, height: 180, top: 12, right: 76, bottom: 26, left: 44 };

function TrendChart({
  basemap,
  metric,
  runs,
  scenario,
}: {
  basemap: "vector" | "raster";
  metric: MetricKey;
  runs: BenchmarkRun[];
  scenario: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(
    () =>
      ENGINES.map((engine) => ({
        engine,
        values: runs.map((run) => findResult(run, engine.id, basemap, scenario)?.[metric] ?? null),
      })).filter((entry) => entry.values.some((value) => value !== null)),
    [basemap, metric, runs, scenario],
  );
  const title = `${basemap === "vector" ? "Vector" : "Raster"} · ${scenario}`;
  if (series.length === 0) {
    return (
      <figure className="bench__card">
        <figcaption className="bench__card-title">{title}</figcaption>
        <p className="bench__muted">No data yet.</p>
      </figure>
    );
  }

  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const all = series.flatMap((entry) =>
    entry.values.filter((value): value is number => value !== null),
  );
  const max = niceCeiling(Math.max(...all, 1));
  const x = (index: number) =>
    CHART.left + (runs.length === 1 ? plotWidth / 2 : (index / (runs.length - 1)) * plotWidth);
  const y = (value: number) => CHART.top + plotHeight - (value / max) * plotHeight;
  const ticks = [0, max / 2, max];
  const showMarkers = runs.length <= 30;
  const labels = placeEndLabels(
    series.map((entry) => {
      const lastIndex = entry.values.findLastIndex((value) => value !== null);
      return { entry, lastIndex, y: y(entry.values[lastIndex]!) };
    }),
  );
  const hoveredRun = hover === null ? null : runs[hover];

  return (
    <figure className="bench__card">
      <figcaption className="bench__card-title">{title}</figcaption>
      <div className="bench__chart">
        <svg
          aria-label={`${METRICS[metric].label}, ${title}, per run`}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - bounds.left) / bounds.width) * CHART.width;
            const index =
              runs.length === 1
                ? 0
                : Math.round(((px - CHART.left) / plotWidth) * (runs.length - 1));
            setHover(Math.max(0, Math.min(runs.length - 1, index)));
          }}
          role="img"
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="bench__grid-line"
                x1={CHART.left}
                x2={CHART.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="bench__axis" textAnchor="end" x={CHART.left - 6} y={y(tick) + 4}>
                {formatTick(tick)}
              </text>
            </g>
          ))}
          <text className="bench__axis" x={CHART.left} y={CHART.height - 6}>
            {shortDate(runs[0]!.generatedAt)}
          </text>
          {runs.length > 1 ? (
            <text
              className="bench__axis"
              textAnchor="end"
              x={CHART.left + plotWidth}
              y={CHART.height - 6}
            >
              {shortDate(runs.at(-1)!.generatedAt)}
            </text>
          ) : null}
          {hover !== null ? (
            <line
              className="bench__crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={CHART.top}
              y2={CHART.top + plotHeight}
            />
          ) : null}
          {series.map((entry) => (
            <g data-slot={entry.engine.slot} key={entry.engine.id}>
              <path className="bench__line" d={linePath(entry.values, x, y)} />
              {entry.values.map((value, index) =>
                value !== null && (showMarkers || index === hover) ? (
                  <circle className="bench__marker" cx={x(index)} cy={y(value)} key={index} r={4} />
                ) : null,
              )}
            </g>
          ))}
          {labels.map(({ entry, lastIndex, labelY }) => (
            <text
              className="bench__direct-label"
              key={entry.engine.id}
              x={x(lastIndex) + 8}
              y={labelY + 4}
            >
              {entry.engine.short}
            </text>
          ))}
        </svg>
        {hoveredRun && hover !== null ? (
          <div
            className="bench__tooltip"
            role="status"
            style={{ left: `${(x(hover) / CHART.width) * 100}%` }}
          >
            <p className="bench__tooltip-title">
              {shortDate(hoveredRun.generatedAt)}
              {hoveredRun.revision ? ` · ${hoveredRun.revision.slice(0, 7)}` : ""}
            </p>
            {series.map((entry) => (
              <p className="bench__tooltip-row" key={entry.engine.id}>
                <span aria-hidden="true" className="bench__key" data-slot={entry.engine.slot} />
                <strong>{formatValue(entry.values[hover] ?? null, metric)}</strong>
                <span>{entry.engine.short}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <details className="bench__data">
        <summary>Data table</summary>
        <table className="bench__table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              {series.map((entry) => (
                <th key={entry.engine.id} scope="col">
                  {entry.engine.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((run, index) => (
              <tr key={`${run.generatedAt}-${run.revision}`}>
                <th scope="row">
                  {shortDate(run.generatedAt)} {run.revision?.slice(0, 7)}
                </th>
                {series.map((entry) => (
                  <td key={entry.engine.id}>{formatValue(entry.values[index] ?? null, metric)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Keeps end-of-line labels at least 13 px apart without reordering them. */
function placeEndLabels<T extends { y: number }>(items: T[]) {
  const sorted = [...items].sort((left, right) => left.y - right.y);
  let previous = -Infinity;
  return sorted.map((item) => {
    const labelY = Math.max(item.y, previous + 13);
    previous = labelY;
    return { ...item, labelY };
  });
}

function linePath(
  values: Array<number | null>,
  x: (index: number) => number,
  y: (value: number) => number,
) {
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    path += `${open ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    open = true;
  });
  return path;
}

function findResult(run: BenchmarkRun, engine: string, basemap: string, scenario: string) {
  return (
    run.results.find(
      (result) =>
        result.engine === engine &&
        (result.basemap ?? "raster") === basemap &&
        result.scenario === scenario,
    ) ?? null
  );
}

function niceCeiling(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function formatTick(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`
    : String(Math.round(value));
}

function formatValue(value: number | null, metric: MetricKey) {
  if (value === null) return "—";
  if (metric === "jankFrames") return String(Math.round(value));
  if (metric === "fps") return value.toFixed(0);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ms`;
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

async function loadHistory(): Promise<History> {
  const sources = [new URL("history.json", window.location.href).href];
  // Local development has no published history next to the page; read the live one.
  if (import.meta.env.DEV) sources.push(LIVE_HISTORY);
  let lastError: unknown = null;
  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: "no-cache" });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const history = (await response.json()) as History;
      if (history.schema !== "maps.interaction-benchmark-history/v1") {
        throw new Error(`unsupported schema ${history.schema}`);
      }
      return history;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { runs: [], schema: "maps.interaction-benchmark-history/v1" };
}
