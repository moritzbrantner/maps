/**
 * MapLibre oracle gate (#306). For every named scenario (`oracle/scenarios.ts`) it renders the
 * fixture through `MapView flatRuntime="maplibre"` and `flatRuntime="maps"` and checks:
 *
 * 1. image: NVIDIA FLIP of the map pixels, mean ≤ FLIP_MEAN_MAX and p99 ≤ FLIP_P99_MAX
 *    (or the scenario's measured MapLibre-vs-MapLibre noise floor, rounded up, if higher);
 * 2. interaction: the scripted hovers/clicks pick the same feature ids, and pan/zoom end in
 *    the same bounds (within BOUNDS_TOLERANCE_PX on screen);
 * 3. time: median frame time of a scripted camera loop ≤ FRAME_TIME_MARGIN × MapLibre's.
 *    Enforced only on a hardware GPU; advisory on software adapters (CI).
 *
 * Images and interactions use SwiftShader (as the e2e suite does), so they are deterministic
 * and match CI. Timing runs in a second browser that asks for the local GPU.
 *
 * ```text
 * bun run oracle                       every scenario, all gates
 * bun run oracle -- --only labels      only these scenarios (repeatable)
 * bun run oracle -- --no-timing        image + interaction gates only
 * bun run oracle -- --out DIR          report directory (default target/oracle)
 * bun run oracle -- --list             scenario names
 * ```
 *
 * A failing gate listed in a scenario's `knownGaps` is reported, not failed; a listed gap that
 * passes fails the run until its entry is removed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer } from "vite";

import { WEBGPU_SWIFTSHADER_ARGS } from "../e2e/helpers/webgpu-args.ts";
import { renderReport } from "./report.ts";
import {
  BOUNDS_TOLERANCE_PX,
  FLIP_MEAN_MAX,
  FLIP_P99_MAX,
  FRAME_TIME_MARGIN,
  TILE_ORIGIN,
  boundsOf,
  scenarios,
  toScreen,
  type Gate,
  type Scenario,
  type Step,
} from "./scenarios.ts";
import { tilePng } from "./tiles.ts";

type Runtime = "maplibre" | "maps";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const only = args.flatMap((arg, index) => (args[index - 1] === "--only" ? [arg] : []));
const timing = !args.includes("--no-timing");
const outDir = path.resolve(option("--out") ?? path.join(root, "target/oracle"));
const python = process.env.ORACLE_PYTHON ?? "python3";
const TIMED_FRAMES = Number(option("--frames") ?? (process.env.CI ? 40 : 180));
const TIMING_ROUNDS = process.env.CI ? 1 : 3;
/** Raster crossfades (300 ms in both runtimes) and label placement settle within this. */
const SETTLE_MS = 800;

if (args.includes("--list")) {
  for (const scenario of scenarios) console.log(`${scenario.name}\t${scenario.capability}`);
  process.exit(0);
}
const unknown = only.find((name) => !scenarios.some((scenario) => scenario.name === name));
if (unknown) {
  console.error(`unknown scenario ${unknown} (see --list)`);
  process.exit(1);
}

/** Hardware GPU, vsync and frame-rate cap off: rAF intervals measure the frame's work. */
const GPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--use-angle=vulkan",
  "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
];
const UNTHROTTLED_ARGS = ["--disable-gpu-vsync", "--disable-frame-rate-limit"];

mkdirSync(outDir, { recursive: true });
const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "error",
  optimizeDeps: { entries: ["oracle/index.html"] },
  root,
  // Bun's isolated installs link packages (and MapLibre's worker) from outside the root.
  server: { fs: { strict: false }, host: "127.0.0.1", port: 5191, strictPort: true },
});
await server.listen();
const baseUrl = "http://127.0.0.1:5191";

const images = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
let timer: Browser | null = null;
let adapter = { renderer: "none", software: true };
/** The Maps base renderer the timing browser got (wgpu on a GPU, else a fallback). */
let timingBaseRenderer: string | null = null;
if (timing) {
  timer = await chromium.launch({
    args: process.env.CI ? [...WEBGPU_SWIFTSHADER_ARGS, ...UNTHROTTLED_ARGS] : GPU_ARGS,
  });
  adapter = await probeAdapter(timer);
}
const gateTiming = timing && !adapter.software;
console.log(
  `timing adapter: ${adapter.renderer}; frame-time gate: ${
    gateTiming ? `enforced (≤ ${FRAME_TIME_MARGIN.toFixed(2)}× MapLibre)` : timing ? "advisory" : "off"
  }`,
);
console.log(
  `${"scenario".padEnd(24)}${"FLIP mean".padStart(10)}${"FLIP p99".padStart(10)}  ${"picks".padEnd(8)}${"maps ms".padStart(9)}${"ml ms".padStart(9)}${"ratio".padStart(7)}  result`,
);

let failed = false;
const results = [];
try {
  for (const scenario of scenarios.filter((entry) => !only.length || only.includes(entry.name))) {
    const result = await runScenario(scenario);
    results.push(result);
    failed ||= !result.passed;
    const fmt = (value: number | null, digits = 3) => (value === null ? "-" : value.toFixed(digits));
    console.log(
      `${scenario.name.padEnd(24)}${fmt(result.image.mean, 4).padStart(10)}${fmt(result.image.p99, 4).padStart(10)}  ${(result.interaction.ok ? "same" : "DIFFER").padEnd(8)}${fmt(result.time.mapsMs).padStart(9)}${fmt(result.time.maplibreMs).padStart(9)}${fmt(result.time.ratio, 2).padStart(7)}  ${result.verdict}`,
    );
  }
} finally {
  await images.close();
  await timer?.close();
  await server.close();
}

const report = {
  adapter: { ...adapter, mapsBaseRenderer: timingBaseRenderer },
  boundsTolerancePx: BOUNDS_TOLERANCE_PX,
  commit: gitCommit(),
  flipMeanMax: FLIP_MEAN_MAX,
  flipP99Max: FLIP_P99_MAX,
  frameTimeGate: gateTiming,
  frameTimeMargin: FRAME_TIME_MARGIN,
  frames: TIMED_FRAMES,
  generatedAt: new Date().toISOString(),
  maplibreVersion: maplibreVersion(),
  passed: !failed,
  scenarios: results,
};
writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(outDir, "index.html"), renderReport(report));
if (timing) console.log(`Maps base renderer while timing: ${timingBaseRenderer ?? "unknown"}`);
console.log(`report: ${path.relative(process.cwd(), path.join(outDir, "index.html"))}`);
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------------------

async function runScenario(scenario: Scenario) {
  const reference = await capture(images, scenario, "maplibre", true);
  const candidate = await capture(images, scenario, "maps", true);
  const floorRun = await capture(images, scenario, "maplibre", false);

  const write = (file: string, png: Buffer) => {
    writeFileSync(path.join(outDir, file), png);
    return file;
  };
  const files = {
    flip: `${scenario.name}.flip.png`,
    maplibre: write(`${scenario.name}.maplibre.png`, reference.png),
    maps: write(`${scenario.name}.maps.png`, candidate.png),
  };
  write(`${scenario.name}.maplibre-repeat.png`, floorRun.png);
  const flip = runFlip(files.maplibre, files.maps, files.flip);
  const floor = runFlip(files.maplibre, `${scenario.name}.maplibre-repeat.png`, null);
  // A principled per-scenario limit: MapLibre's own run-to-run noise, rounded up.
  const meanMax = Math.max(FLIP_MEAN_MAX, Math.ceil(floor.mean * 1000) / 1000);
  const p99Max = Math.max(FLIP_P99_MAX, Math.ceil(floor.p99 * 100) / 100);
  const imageOk = candidate.error === null && flip.mean <= meanMax && flip.p99 <= p99Max;

  const interaction = compareInteractions(scenario, reference.steps, candidate.steps);
  const interactionOk = candidate.error === null && interaction.ok;

  let time = { maplibreMs: null as number | null, mapsMs: null as number | null, ratio: null as number | null };
  if (timer) {
    const maplibreRounds: number[] = [];
    const mapsRounds: number[] = [];
    for (let round = 0; round < TIMING_ROUNDS; round++) {
      // Alternate the order so neither runtime always runs on a warmer browser.
      const order: Runtime[] = round % 2 ? ["maps", "maplibre"] : ["maplibre", "maps"];
      for (const runtime of order) {
        const median = await measureFrameTime(timer, scenario, runtime);
        if (median !== null) (runtime === "maps" ? mapsRounds : maplibreRounds).push(median);
      }
    }
    const maplibreMs = medianOf(maplibreRounds);
    const mapsMs = medianOf(mapsRounds);
    time = {
      maplibreMs,
      mapsMs,
      ratio: maplibreMs && mapsMs !== null ? mapsMs / maplibreMs : null,
    };
  }
  const timeOk = !gateTiming || (time.ratio !== null && time.ratio <= FRAME_TIME_MARGIN);

  const outcomes: Record<Gate, boolean> = { image: imageOk, interaction: interactionOk, time: timeOk };
  const verdicts: string[] = [];
  let passed = true;
  for (const gate of ["image", "interaction", "time"] as Gate[]) {
    const gaps = scenario.knownGaps
      .filter((entry) => entry.gate === gate)
      .map((entry) => `#${entry.issue}`)
      .join(" ");
    if (outcomes[gate] && gaps) {
      passed = false;
      verdicts.push(`${gate} PASSES: remove known gaps ${gaps}`);
    } else if (!outcomes[gate] && gaps) {
      verdicts.push(`${gate}: known gap ${gaps}`);
    } else if (!outcomes[gate]) {
      passed = false;
      verdicts.push(`${gate} FAILS`);
    }
  }
  if (timing && !gateTiming && time.ratio !== null && time.ratio > FRAME_TIME_MARGIN) {
    verdicts.push("time slower (advisory)");
  }

  return {
    capability: scenario.capability,
    errors: { maplibre: reference.error, maps: candidate.error },
    files,
    gates: outcomes,
    image: { ...flip, floor, meanMax, p99Max },
    interaction,
    knownGaps: scenario.knownGaps,
    mapsBaseRenderer: candidate.baseRenderer,
    name: scenario.name,
    origin: scenario.origin,
    passed,
    time,
    verdict: verdicts.length ? verdicts.join("; ") : "ok",
  };
}

type StepResult = {
  label: string;
  kind: Step["kind"];
  hovered: Record<string, string | null>;
  selected: Record<string, string | null>;
  bounds: [number, number, number, number] | null;
  zoom: number | null;
};

async function openFixture(browser: Browser, scenario: Scenario, runtime: Runtime) {
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { height: scenario.size.height, width: scenario.size.width },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${TILE_ORIGIN}/**`, (route) => {
    const match = /\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(new URL(route.request().url()).pathname);
    if (!match) return route.fulfill({ status: 404 });
    const [, pattern, z, x, y] = match;
    return route.fulfill({
      body: tilePng(pattern!, Number(z), Number(x), Number(y)),
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  const query = new URLSearchParams({ runtime, scenario: scenario.name });
  await page.goto(`${baseUrl}/oracle/index.html?${query}`);
  await waitReady(page, runtime);
  return { errors, page };
}

async function capture(browser: Browser, scenario: Scenario, runtime: Runtime, interact: boolean) {
  const { errors, page } = await openFixture(browser, scenario, runtime).catch((error: Error) => {
    throw new Error(`${scenario.name}/${runtime}: ${error.message}`);
  });
  try {
    const baseRenderer = await page
      .locator('canvas[data-flat-runtime="maps"]')
      .first()
      .getAttribute("data-map-base-renderer", { timeout: 1000 })
      .catch(() => null);
    const png = await page.locator("#map").screenshot({ animations: "disabled" });
    const steps: StepResult[] = [];
    if (interact) {
      for (const step of scenario.steps) steps.push(await perform(page, scenario, step));
    }
    return { baseRenderer, error: errors[0] ?? null, png, steps };
  } finally {
    await page.close();
  }
}

async function waitReady(page: Page, runtime: Runtime) {
  if (runtime === "maps") {
    await page.waitForSelector('[data-map-ready="true"]', { timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flat-runtime="maps"]');
        return (
          canvas !== null &&
          canvas.dataset.mapBaseRenderer !== "pending" &&
          Number(canvas.dataset.mapBaseTiles) > 0 &&
          canvas.dataset.mapBasePendingTiles === "0"
        );
      },
      undefined,
      { timeout: 30_000 },
    );
  } else {
    await page.waitForFunction(
      () => {
        const map = window.__oracle?.maplibre;
        return Boolean(map && map.loaded() && map.areTilesLoaded() && !map.isMoving());
      },
      undefined,
      { timeout: 30_000 },
    );
  }
  await page.waitForFunction(() => window.__oracle?.controller !== null, undefined, { timeout: 10_000 });
  await settle(page, runtime);
}

/** Waits until tiles are loaded and the camera has stopped, then for crossfades to end. */
async function settle(page: Page, runtime: Runtime) {
  let previous = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate((maps) => {
      const view = window.__oracle.viewState();
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-flat-runtime="maps"]');
      const map = window.__oracle.maplibre;
      const busy = maps
        ? canvas?.dataset.mapBasePendingTiles !== "0"
        : !map || !map.areTilesLoaded() || map.isMoving();
      return JSON.stringify({ busy, view });
    }, runtime === "maps");
    if (state !== previous) {
      previous = state;
      stableSince = Date.now();
    } else if (!JSON.parse(state).busy && Date.now() - stableSince >= 250) {
      break;
    }
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function perform(page: Page, scenario: Scenario, step: Step): Promise<StepResult> {
  const box = (await page.locator("#map").boundingBox())!;
  const center = { x: box.x + scenario.size.width / 2, y: box.y + scenario.size.height / 2 };
  const runtime = new URL(page.url()).searchParams.get("runtime") as Runtime;
  const view = await page.evaluate(() => window.__oracle.viewState());
  const camera = view ? { center: view.center, zoom: view.zoom } : scenario.camera;
  if (step.kind === "hover" || step.kind === "click") {
    const point = toScreen(step.at, camera, scenario.size);
    await page.mouse.move(box.x + point.x, box.y + point.y, { steps: 4 });
    if (step.kind === "click") await page.mouse.click(box.x + point.x, box.y + point.y);
  } else if (step.kind === "pan") {
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + step.by[0], center.y + step.by[1], { steps: 12 });
    // Hold still before releasing: the step checks where a drag lands, not release inertia.
    await page.waitForTimeout(300);
    await page.mouse.up();
  } else {
    await page.mouse.move(center.x + step.at[0], center.y + step.at[1]);
    for (let tick = 0; tick < step.ticks; tick++) {
      await page.mouse.wheel(0, step.deltaY);
      await page.waitForTimeout(40);
    }
  }
  await settle(page, runtime);
  const state = await page.evaluate(() => {
    const hovered: Record<string, string | null> = {};
    const selected: Record<string, string | null> = {};
    for (const event of window.__oracle.events) {
      (event.kind === "hover" ? hovered : selected)[event.layer] = event.id;
    }
    return { hovered, selected, view: window.__oracle.viewState() };
  });
  const moved = step.kind === "pan" || step.kind === "wheel";
  return {
    bounds: moved && state.view ? boundsOf(state.view, scenario.size) : null,
    hovered: state.hovered,
    kind: step.kind,
    label: step.label,
    selected: state.selected,
    zoom: state.view?.zoom ?? null,
  };
}

function compareInteractions(scenario: Scenario, reference: StepResult[], candidate: StepResult[]) {
  const steps = scenario.steps.map((step, index) => {
    const expected = reference[index];
    const actual = candidate[index];
    const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
    let boundsPx: number | null = null;
    if (expected?.bounds && actual?.bounds && expected.zoom !== null) {
      // Edge error in screen pixels at the reference zoom.
      const world = 512 * 2 ** expected.zoom;
      const pxPerDegree = world / 360;
      const [w0, s0, e0, n0] = expected.bounds;
      const [w1, s1, e1, n1] = actual.bounds;
      const latPx = (a: number, b: number) =>
        Math.abs(mercatorY(a) - mercatorY(b)) * (world / (2 * Math.PI));
      boundsPx = Math.max(
        Math.abs(w0 - w1) * pxPerDegree,
        Math.abs(e0 - e1) * pxPerDegree,
        latPx(s0, s1),
        latPx(n0, n1),
      );
    }
    const picksSame =
      expected !== undefined &&
      actual !== undefined &&
      same(expected.hovered, actual.hovered) &&
      same(expected.selected, actual.selected);
    const boundsSame = boundsPx === null ? expected?.bounds === actual?.bounds : boundsPx <= BOUNDS_TOLERANCE_PX;
    return {
      bounds: { maplibre: expected?.bounds ?? null, maps: actual?.bounds ?? null, px: boundsPx },
      hovered: { maplibre: expected?.hovered ?? null, maps: actual?.hovered ?? null },
      label: step.label,
      ok: picksSame && boundsSame,
      selected: { maplibre: expected?.selected ?? null, maps: actual?.selected ?? null },
    };
  });
  return { ok: steps.every((step) => step.ok), steps };
}

function mercatorY(latitude: number) {
  const sin = Math.sin((latitude * Math.PI) / 180);
  return Math.log((1 + sin) / (1 - sin)) / 2;
}

function sortKeys(value: unknown) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

async function measureFrameTime(browser: Browser, scenario: Scenario, runtime: Runtime) {
  const { page } = await openFixture(browser, scenario, runtime);
  try {
    if (runtime === "maps") {
      timingBaseRenderer = await page
        .locator('canvas[data-flat-runtime="maps"]')
        .first()
        .getAttribute("data-map-base-renderer");
    }
    await page.evaluate(() => window.__oracle.frameTimes(20));
    const times = await page.evaluate((frames) => window.__oracle.frameTimes(frames), TIMED_FRAMES);
    return medianOf(times);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function probeAdapter(browser: Browser) {
  const page = await browser.newPage();
  try {
    // WebGPU needs a secure context; about:blank has no navigator.gpu.
    await page.goto(`${baseUrl}/oracle/index.html?scenario=zoom-crossfade&runtime=none`);
    const renderer = await page.evaluate(async () => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const webgl = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "no webgl";
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { description?: string; vendor?: string; architecture?: string } } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter();
      const webgpu = adapter?.info
        ? [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(" ")
        : "no webgpu";
      return `WebGL: ${webgl}; WebGPU: ${webgpu}`;
    });
    return { renderer, software: /swiftshader|llvmpipe|lavapipe|software|no webgl/i.test(renderer) };
  } finally {
    await page.close();
  }
}

function runFlip(referenceFile: string, testFile: string, heatmapFile: string | null) {
  const result = spawnSync(
    python,
    [
      path.join(root, "oracle/flip.py"),
      path.join(outDir, referenceFile),
      path.join(outDir, testFile),
      ...(heatmapFile ? [path.join(outDir, heatmapFile)] : []),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`FLIP failed (${python} oracle/flip.py): ${result.stderr || result.error}`);
  }
  return JSON.parse(result.stdout) as { mean: number; p99: number };
}

function medianOf(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function maplibreVersion() {
  const result = spawnSync(
    process.execPath,
    ["-p", "require('maplibre-gl/package.json').version"],
    { cwd: root, encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}
