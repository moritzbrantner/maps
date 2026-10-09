#!/usr/bin/env node
// Comparative dense-point camera journey (#197): the deterministic 10k/100k point journey
// of the retained-point spec (#155), run on the Maps retained path (WebGPU and the
// Canvas2D fallback), MapLibre (GeoJSON source + circle layer) and Leaflet (circle
// markers on its Canvas renderer). No basemap tiles: the lanes compare application-point
// work only. Results are descriptive evidence, not a gate: software GPU rendering and
// shared runners make wall-clock thresholds meaningless, so this script never fails on
// timings. It does fail when a lane does not render, follow the journey, or (for the
// Maps WebGPU lane) keeps the points retained.
//
// Per step it records `presentMs` (camera command until the next animation-frame
// callback, after the engine's synchronous draw) and `settledMs` (until the engine
// reports every point for that camera drawn; MapLibre cuts GeoJSON tiles for new zooms
// in workers, so it settles later than it presents).
//
// Usage: node scripts/benchmark-point-journey.mjs [--engines=a,b] [--points=10000,100000]
//        [--repeats=3] [--gpu] [--json=benchmark-results/point-journey.json]

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

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
    retainedPointUploadBytes: delta("retainedPointUploadBytes"),
    applicationUploadBytes: delta("applicationUploadBytes"),
    retainedPointFrames: delta("retainedPointFrames"),
  };
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
  const png = await page.locator("#map").screenshot();
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
  const server = await createServer({
    configFile: path.join(rootDir, "vite.config.ts"),
    root: rootDir,
    logLevel: "error",
    // Pre-bundle everything the fixture imports lazily: a dependency discovered
    // mid-run makes Vite reload the page and destroys the measurement.
    optimizeDeps: {
      entries: ["e2e/fixtures/interaction-benchmark.html"],
      include: ["leaflet", "react", "react/jsx-dev-runtime", "react-dom/client"],
    },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browserArgs = args.gpu ? HARDWARE_GPU_ARGS : SOFTWARE_GPU_ARGS;
  const browser = await chromium.launch({ args: browserArgs, headless: !args.headed });
  const browserVersion = browser.version();
  const runs = new Map();
  const lanes = new Map();
  let mapSize = null;
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
    await server.close();
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
    "Deterministic dense-point camera journey (e2e/fixtures/dense-point-journey.ts) on the Maps retained path, MapLibre and Leaflet, without basemap tiles. presentMs: camera command to the next animation frame; settledMs: until every point for that camera is drawn. Headless Chromium (environment.gpu names the GPU mode); descriptive evidence, not a verdict or GPU FPS.";
  const evidence = {
    schemaVersion: 1,
    producer: "maps-point-journey",
    repository: "moritzbrantner/maps",
    revision: dirty ? null : revision,
    source: { revision, dirty },
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
      gpu: args.gpu ? "hardware" : "swiftshader",
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
