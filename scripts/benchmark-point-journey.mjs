#!/usr/bin/env node
// Comparative dense-point camera journey (#197): the deterministic 10k/100k point journey
// of the retained-point spec (#155), run on the Maps retained path (WebGPU and the
// Canvas2D fallback), MapLibre (GeoJSON source + circle layer) and Leaflet (circle
// markers on its Canvas renderer). No basemap tiles: the lanes compare application-point
// work only. Results are descriptive evidence, not a gate: software GPU rendering and
// shared runners make wall-clock thresholds meaningless, so this script never fails on
// timings. It does fail when a lane does not render, follow the journey, or (for the
// Maps WebGPU lane) does not keep the points retained.
//
// Per step it records `presentMs` (camera command until the next animation-frame
// callback, after the engine's synchronous draw) and `settledMs` (until the engine
// reports every point for that camera drawn; MapLibre cuts GeoJSON tiles for new zooms
// in workers, so it settles later than it presents).
//
// Usage: node scripts/benchmark-point-journey.mjs [--engines=a,b] [--points=10000,100000]
//        [--repeats=3] [--gpu] [--json=benchmark-results/point-journey.json]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build, loadConfigFromFile, preview } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length > 0 ? rest.join("=") : "true"];
  }),
);
const ENGINES = (args.engines ?? "maps-wgpu,maps-canvas2d,maplibre,leaflet").split(",");
const POINTS = (args.points ?? "10000,100000").split(",").map(Number);
const REPEATS = Number(args.repeats ?? 3);
const jsonPath = path.resolve(rootDir, args.json ?? "benchmark-results/point-journey.json");
const SOFTWARE_GPU_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
];
const HARDWARE_GPU_ARGS = ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"];
const POINT_ENGINES = new Set(["maps-wgpu", "maps-canvas2d", "maplibre", "leaflet"]);

for (const engine of ENGINES)
  if (!POINT_ENGINES.has(engine)) throw new Error(`${engine} has no point lane`);
for (const count of POINTS)
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid point count ${count}`);
if (!Number.isInteger(REPEATS) || REPEATS < 1 || REPEATS > 20)
  throw new Error("repeats must be in 1..20");

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function median(values) {
  const finite = values.filter((value) => value !== null && Number.isFinite(value));
  return finite.length === 0 ? null : percentile(finite, 50);
}

/** Per-run summary of one journey; Maps lanes add their retained-work counters. */
function summarize(journey) {
  const present = journey.steps.map((step) => step.presentMs);
  const settled = journey.steps.map((step) => step.settledMs);
  const delta = (key) =>
    journey.before && journey.after ? journey.after[key] - journey.before[key] : null;
  return {
    steps: journey.steps.length,
    presentP50: percentile(present, 50),
    presentP95: percentile(present, 95),
    presentMax: Math.max(...present),
    settledP50: percentile(settled, 50),
    settledP95: percentile(settled, 95),
    settledTotal: settled.reduce((sum, value) => sum + value, 0),
    retainedPointPreparations: delta("retainedPointPreparations"),
    retainedPointRebases: delta("retainedPointRebases"),
    retainedPointUploadBytes: delta("retainedPointUploadBytes"),
    applicationUploadBytes: delta("applicationUploadBytes"),
    retainedPointFrames: delta("retainedPointFrames"),
  };
}

/** Retained-work counters that must not move while only the camera changes. */
const RETAINED_COUNTERS = [
  "retainedPointPreparations",
  "retainedPointRebases",
  "retainedPointUploadBytes",
];

/**
 * Counters that moved during the timed journey: the WebGPU lane must keep its points
 * retained (no re-preparation, rebase or re-upload on camera changes), as in the
 * retained-point acceptance spec.
 */
function retainedWorkViolations(journey) {
  if (!journey.before || !journey.after) return ["retained-work counters missing"];
  const missing = RETAINED_COUNTERS.filter(
    (key) => !Number.isFinite(journey.before[key]) || !Number.isFinite(journey.after[key]),
  );
  if (missing.length) return missing.map((key) => `${key} unavailable`);
  return RETAINED_COUNTERS.filter((key) => journey.after[key] !== journey.before[key]).map(
    (key) => `${key} +${journey.after[key] - journey.before[key]}`,
  );
}

/**
 * The WebGPU adapter Chromium actually selected. `--enable-unsafe-webgpu` may fall back
 * to SwiftShader even when hardware was requested, so the evidence records what ran.
 */
async function observedAdapter(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const info = adapter.info ?? {};
    const fallback = Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter);
    const fields = [info.vendor, info.architecture, info.device, info.description];
    const software = fallback || fields.some((field) => /swiftshader/i.test(field ?? ""));
    return {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      fallback,
      kind: software ? "software" : "hardware",
    };
  });
}

/**
 * Production build of the benchmark fixture, served by `vite preview`: the measured
 * lanes run shipped code, not the development server's React dev runtime and checks.
 */
async function serveProductionFixture() {
  const configFile = path.join(rootDir, "vite.config.ts");
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, configFile);
  const outDir = path.join(rootDir, "node_modules/.cache/maps-point-journey");
  const config = {
    ...loaded.config,
    configFile: false,
    root: rootDir,
    logLevel: "error",
    mode: "production",
    build: {
      ...loaded.config.build,
      emptyOutDir: true,
      outDir,
      rollupOptions: {
        ...loaded.config.build?.rollupOptions,
        input: { benchmark: path.join(rootDir, "e2e/fixtures/interaction-benchmark.html") },
      },
    },
  };
  await build(config);
  return preview({ ...config, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
}

/** Angular difference in degrees, ignoring whole turns. */
function angleDifference(left, right) {
  const difference = (((left - right) % 360) + 540) % 360 - 180;
  return Math.abs(difference);
}

/**
 * Axes on which the lane did not end at the journey's last camera. Every axis the lane
 * claims in `cameraAxes` is checked, so a lane that ignores bearing or pitch cannot pass
 * as having run the claimed journey.
 */
function unfollowedAxes(journey) {
  const camera = journey.finalCamera;
  const last = journey.lastCamera;
  const checks = {
    center: () =>
      Math.abs(camera.longitude - last.center[0]) < 1e-3 &&
      Math.abs(camera.latitude - last.center[1]) < 1e-3,
    zoom: () => Math.abs(camera.zoom - last.zoom) < 1e-3,
    bearing: () => Number.isFinite(camera.bearing) && angleDifference(camera.bearing, last.bearing) < 0.01,
    pitch: () => Number.isFinite(camera.pitch) && Math.abs(camera.pitch - last.pitch) < 0.01,
  };
  return journey.cameraAxes.filter((axis) => !checks[axis]?.());
}

/**
 * Point-coloured pixels in a PNG screenshot of the map, counted in the page: an observed
 * render result for every lane, independent of what the lane says about itself.
 */
async function pointPixels(page) {
  // A clipped page screenshot: an element screenshot waits for the element to be
  // "stable" across frames, which a busy 100k-point main thread may never report.
  const clip = await page.locator("#map").boundingBox();
  const png = await page.screenshot({ clip, timeout: 120_000 });
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4)
      if (data[index] > 200 && data[index + 1] < 70 && data[index + 2] < 70) count++;
    return count;
  }, png.toString("base64"));
}

async function main() {
  // The Maps lanes load the WebGPU/WASM runtime from public/wasm, which is ignored
  // and only produced by `bun run build:wasm`.
  if (
    ENGINES.some((engine) => engine.startsWith("maps-")) &&
    !existsSync(path.join(rootDir, "public/wasm/maps_wasm.js"))
  )
    throw new Error(
      "public/wasm/maps_wasm.js is missing: run `bun run build:wasm` first (the Maps lanes load it)",
    );
  const server = await serveProductionFixture();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browserArgs = args.gpu ? HARDWARE_GPU_ARGS : SOFTWARE_GPU_ARGS;
  const browser = await chromium.launch({ args: browserArgs, headless: !args.headed });
  const browserVersion = browser.version();
  const runs = new Map();
  const lanes = new Map();
  let mapSize = null;
  let adapter = null;
  try {
    // Round-robin: each repeat visits every lane once, so machine drift spreads evenly.
    for (let repeat = 0; repeat < REPEATS; repeat++)
      for (const count of POINTS)
        for (const engine of ENGINES) {
          const key = `${engine}\u0000${count}`;
          const context = await browser.newContext({
            viewport: { width: 1100, height: 820 },
            deviceScaleFactor: 1,
          });
          try {
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(
              `${origin}/e2e/fixtures/interaction-benchmark.html?engine=${engine}&points=${count}`,
            );
            await page.locator('#map[data-ready="true"]').waitFor({ timeout: 180_000 });
            // One untimed journey warms JIT, shaders and (MapLibre) GeoJSON tiles.
            await page.evaluate(() => window.interactionBenchmark.pointJourney());
            const journey = await page.evaluate(() => window.interactionBenchmark.pointJourney());
            const renderer = await page.evaluate(() => window.interactionBenchmark.pointRenderer());
            errors.push(...(await page.evaluate(() => window.interactionBenchmark.laneErrors())));
            if (errors.length) throw new Error(`[${engine} ${count}] ${errors.join("; ")}`);
            const unfollowed = unfollowedAxes(journey);
            if (unfollowed.length)
              throw new Error(
                `[${engine} ${count}] did not follow the journey on ${unfollowed.join(", ")}`,
              );
            const pixels = await pointPixels(page);
            if (pixels === 0) throw new Error(`[${engine} ${count}] drew no point pixels`);
            const box = await page.locator("#map").boundingBox();
            mapSize = { width: Math.round(box.width), height: Math.round(box.height) };
            if (engine === "maps-wgpu" && renderer !== "wgpu-retained")
              throw new Error(`[maps-wgpu ${count}] drew points with ${renderer}`);
            if (engine === "maps-canvas2d" && renderer !== "canvas2d")
              throw new Error(`[maps-canvas2d ${count}] drew points with ${renderer}`);
            if (engine === "maps-wgpu") {
              const violations = retainedWorkViolations(journey);
              if (violations.length)
                throw new Error(
                  `[maps-wgpu ${count}] camera journey redid retained work: ${violations.join(", ")}`,
                );
            }
            // The Canvas2D lane hides navigator.gpu on purpose; probe from a lane that
            // keeps WebGPU visible, and retry until one reports an adapter.
            if (!adapter && engine !== "maps-canvas2d") adapter = await observedAdapter(page);
            const summary = summarize(journey);
            if (!runs.has(key)) runs.set(key, []);
            runs.get(key).push(summary);
            lanes.set(key, { renderer, cameraAxes: journey.cameraAxes });
            summary.pointPixels = pixels;
            console.error(
              `#${repeat + 1} ${engine.padEnd(14)} ${String(count).padStart(6)} present p95=${fmt(summary.presentP95)}ms settled p95=${fmt(summary.settledP95)}ms renderer=${renderer}`,
            );
          } finally {
            await context.close();
          }
        }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }

  const results = [];
  for (const count of POINTS)
    for (const engine of ENGINES) {
      const key = `${engine}\u0000${count}`;
      const passes = runs.get(key) ?? [];
      if (passes.length === 0) continue;
      const result = { engine, points: count, ...lanes.get(key), passes };
      for (const metric of Object.keys(passes[0]))
        result[metric] = median(passes.map((pass) => pass[metric]));
      results.push(result);
    }
  printTable(results);
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  const { revision, dirty } = sourceRevision();
  const description =
    "Deterministic dense-point camera journey (e2e/fixtures/dense-point-journey.ts) on the Maps retained path, MapLibre and Leaflet, without basemap tiles. presentMs: camera command to the next animation frame; settledMs: until every point for that camera is drawn. Production build served by vite preview in headless Chromium (environment.gpu names the observed WebGPU adapter kind); descriptive evidence, not a verdict or GPU FPS.";
  const evidence = {
    schemaVersion: 1,
    producer: "maps-point-journey",
    repository: "moritzbrantner/maps",
    revision: dirty ? null : revision,
    // The served WASM is an ignored build output: hash it so the evidence names the
    // runtime actually measured, not only the source revision.
    source: { revision, dirty, wasm: wasmProvenance() },
    generatedAt: new Date().toISOString(),
    status: "measured",
    description,
    workload: {
      journey: "e2e/fixtures/dense-point-journey.ts densePointJourney",
      points: POINTS,
      engines: ENGINES,
      // The fixture's #map element, inside a 1100×820 page at device pixel ratio 1.
      mapSize,
      devicePixelRatio: 1,
      warmups: 1,
      repeats: REPEATS,
    },
    environment: {
      browser: `chromium ${browserVersion}`,
      browserArgs,
      // Requested GPU mode versus the WebGPU adapter Chromium actually selected.
      gpuRequested: args.gpu ? "hardware" : "swiftshader",
      gpu: adapter?.kind ?? "unavailable",
      gpuAdapter: adapter ?? null,
      ci: Boolean(process.env.CI),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? null,
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
    },
    results,
    metrics: [
      {
        id: "point-journey-scope",
        label: "Dense-point camera journey",
        value: `${POINTS.map((count) => count.toLocaleString("en")).join(" and ")} points; ${REPEATS} warm journeys per lane. Leaflet follows centre and zoom only.`,
        state: "measured",
      },
      ...results.flatMap((result) => {
        const lane = `${result.engine} · ${result.points.toLocaleString("en")} points`;
        const id = `point-journey-${result.engine}-${result.points}`;
        return [
          {
            id: `${id}-present-p95`,
            label: `${lane} · camera step presented · p95`,
            value: result.presentP95,
            unit: "ms",
            state: "measured",
          },
          {
            id: `${id}-settled-p95`,
            label: `${lane} · every point drawn · p95`,
            value: result.settledP95,
            unit: "ms",
            state: "measured",
          },
        ];
      }),
    ],
    accomplishments: [],
  };
  writeFileSync(`${jsonPath}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
  renameSync(`${jsonPath}.tmp`, jsonPath);
  console.log(`\nWrote ${path.relative(rootDir, jsonPath)}`);
}

function wasmProvenance() {
  if (!ENGINES.some((engine) => engine.startsWith("maps-"))) return null;
  return Object.fromEntries(
    ["maps_wasm.js", "maps_wasm_bg.wasm"].map((file) => [
      file,
      `sha256:${createHash("sha256")
        .update(readFileSync(path.join(rootDir, "public/wasm", file)))
        .digest("hex")}`,
    ]),
  );
}

function sourceRevision() {
  const git = (...gitArgs) =>
    execFileSync("git", gitArgs, { cwd: rootDir, encoding: "utf8" }).trim();
  try {
    return {
      revision: process.env.GITHUB_SHA ?? git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain", "--untracked-files=normal").length > 0,
    };
  } catch {
    return { revision: null, dirty: true };
  }
}

function fmt(value, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}

function printTable(results) {
  const columns = [
    ["engine", (r) => r.engine],
    ["points", (r) => String(r.points)],
    ["renderer", (r) => r.renderer ?? "—"],
    ["axes", (r) => r.cameraAxes.join("+")],
    ["present p50", (r) => fmt(r.presentP50)],
    ["present p95", (r) => fmt(r.presentP95)],
    ["settled p50", (r) => fmt(r.settledP50)],
    ["settled p95", (r) => fmt(r.settledP95)],
    ["preparations", (r) => fmt(r.retainedPointPreparations, 0)],
    ["upload B", (r) => fmt(r.applicationUploadBytes, 0)],
  ];
  const rows = results.map((result) => columns.map(([, get]) => String(get(result))));
  const widths = columns.map(([name], i) =>
    Math.max(name.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) => `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`;
  console.log(line(columns.map(([name]) => name)));
  console.log(`|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`);
  for (const row of rows) console.log(line(row));
}

await main();
