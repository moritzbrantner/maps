#!/usr/bin/env node
// Comparative interaction benchmark: Maps (wgpu + Canvas2D backends) against
// MapLibre, Leaflet and a minimal hand-written Canvas2D tile drawer.
//
// Every engine renders the same deterministic tiles served by this script, in its
// own browser context, and receives identical trusted input (CDP) for the drag,
// wheel-zoom and rotate scenarios. Basemaps: `raster` (PNG tiles) and `vector`
// (Shortbread-like MVT with the demo style: retained WebGPU buckets on maps-wgpu,
// the Canvas GeoJSON overlay on maps-canvas2d, MapLibre's vector renderer). Results are descriptive evidence, not a
// correctness gate: software GPU rendering and shared CI runners make wall-clock
// thresholds meaningless, so this script never fails on timings.
//
// Usage: node scripts/benchmark-interactions.mjs [--engines=a,b] [--scenarios=a,b]
//        [--basemaps=raster,vector] [--repeats=3] [--cpu-throttle=4] [--profile] [--gpu]
//        [--json=benchmark-results/interactions.json]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { benchmarkTilePlugin as tilePlugin } from "./benchmark-tiles.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length > 0 ? rest.join("=") : "true"];
  }),
);
const ENGINES = (args.engines ?? "maps-wgpu,maps-canvas2d,maplibre,leaflet,canvas2d").split(",");
const SCENARIOS = (args.scenarios ?? "drag,zoom,rotate").split(",");
const BASEMAPS = (args.basemaps ?? "raster").split(",");
// Engines that can draw the vector basemap; the others are raster-only baselines.
const VECTOR_ENGINES = new Set(["maps-wgpu", "maps-canvas2d", "maplibre"]);
const REPEATS = Number(args.repeats ?? 3);
const CPU_THROTTLE = Number(args["cpu-throttle"] ?? 1);
// Extra fixture query, e.g. --query=margin=0 for an overscan A/B.
const EXTRA_QUERY = args.query ? `&${args.query}` : "";
const jsonPath = path.resolve(rootDir, args.json ?? "benchmark-results/interactions.json");
const SOFTWARE_GPU_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
];
const HARDWARE_GPU_ARGS = ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"];

// ---------------------------------------------------------------------------
// Scenarios: identical trusted input for every engine.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOVE_INTERVAL_MS = 8; // ~125 Hz pointer, typical of desktop mice.

const scenarios = {
  async drag(page, box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const steps = 120;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      await page.mouse.move(cx + Math.sin(t) * 180, cy + Math.sin(2 * t) * 90);
      await sleep(MOVE_INTERVAL_MS);
    }
    await page.mouse.up();
  },
  async zoom(page, box) {
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, i < 20 ? -60 : 60);
      await sleep(16);
    }
  },
  async rotate(page, box) {
    // Off the exact center line: MapLibre flips its around-center rotation sign there.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2 + 60;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    const steps = 120;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(cx + Math.sin((i / steps) * Math.PI * 2) * 200, cy);
      await sleep(MOVE_INTERVAL_MS);
    }
    await page.mouse.up({ button: "right" });
  },
};

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function metricMap(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

async function runPass(page, cdp, scenario, box) {
  const before = await metricMap(cdp);
  const cameraBefore = await page.evaluate(() => window.interactionBenchmark.camera());
  await page.evaluate(() => window.interactionBenchmark.start());
  const wallStart = performance.now();
  let cameraMid = null;
  const run = scenarios[scenario](page, box);
  // Sample mid-gesture camera to prove the engine actually responded.
  await sleep(scenario === "zoom" ? 300 : 500);
  cameraMid = await page.evaluate(() => window.interactionBenchmark.camera());
  await run;
  await sleep(600); // inertia / zoom animations settle inside the window.
  const recording = await page.evaluate(() => window.interactionBenchmark.stop());
  const wallMs = performance.now() - wallStart;
  const after = await metricMap(cdp);
  const intervals = recording.frames.slice(1).map((time, i) => time - recording.frames[i]);
  const delta = (name) => ((after[name] ?? 0) - (before[name] ?? 0)) * 1000;
  return {
    wallMs,
    frames: recording.frames.length,
    fps: (intervals.length / (recording.frames.at(-1) - recording.frames[0])) * 1000,
    frameP50: percentile(intervals, 50),
    frameP95: percentile(intervals, 95),
    frameP99: percentile(intervals, 99),
    frameMax: Math.max(...intervals),
    jankFrames: intervals.filter((interval) => interval > 25).length,
    mainThreadMs: delta("TaskDuration"),
    scriptMs: delta("ScriptDuration"),
    layoutStyleMs: delta("LayoutDuration") + delta("RecalcStyleDuration"),
    loafBlockingMs: recording.loafBlockingMs,
    loafCount: recording.loafCount,
    slowInputs: recording.inputDurations.length,
    inputP95: percentile(recording.inputDurations, 95),
    responded: responded(scenario, cameraBefore, cameraMid),
  };
}

function responded(scenario, before, mid) {
  if (!before || !mid) return false;
  if (scenario === "rotate")
    return mid.bearing !== null && Math.abs(mid.bearing - before.bearing) > 1;
  if (scenario === "zoom") return Math.abs(mid.zoom - before.zoom) > 0.05;
  return (
    Math.abs(mid.longitude - before.longitude) + Math.abs(mid.latitude - before.latitude) > 1e-4
  );
}

function median(values) {
  const finite = values.filter((value) => value !== null && Number.isFinite(value));
  return finite.length === 0 ? null : percentile(finite, 50);
}

async function main() {
  const server = await createServer({
    configFile: path.join(rootDir, "vite.config.ts"),
    root: rootDir,
    logLevel: "error",
    plugins: [tilePlugin],
    // Pre-bundle everything the fixture imports lazily: a dependency discovered
    // mid-run makes Vite reload the page and destroys the measurement.
    optimizeDeps: {
      entries: ["e2e/fixtures/interaction-benchmark.html"],
      include: ["leaflet", "react", "react/jsx-dev-runtime", "react-dom/client"],
    },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const browserArgs = args.gpu ? HARDWARE_GPU_ARGS : SOFTWARE_GPU_ARGS;
  const browser = await chromium.launch({
    args: browserArgs,
    headless: args.headed ? false : true,
  });
  const results = [];
  const browserVersion = browser.version();
  const passesByKey = new Map();
  const renderers = new Map();
  try {
    // Round-robin: each repeat visits every engine/scenario once, so machine drift
    // (thermal, background load, software GPU contention) spreads across engines.
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      for (const basemap of BASEMAPS)
        for (const scenario of SCENARIOS) {
          for (const engine of ENGINES) {
            if (basemap === "vector" && !VECTOR_ENGINES.has(engine)) continue;
            const key = `${engine}\u0000${scenario}\u0000${basemap}`;
            const context = await browser.newContext({
              viewport: { width: 1100, height: 820 },
              deviceScaleFactor: 1,
            });
            try {
              const page = await context.newPage();
              page.on("pageerror", (error) => console.error(`[${engine}] ${error.message}`));
              await page.goto(
                `${origin}/e2e/fixtures/interaction-benchmark.html?engine=${engine}&basemap=${basemap}${EXTRA_QUERY}`,
              );
              await page.locator('#map[data-ready="true"]').waitFor({ timeout: 120_000 });
              const baseRenderer = await page
                .locator("#map canvas")
                .first()
                .getAttribute("data-map-base-renderer", { timeout: 1000 })
                .catch(() => null);
              const basemapRenderer = await page
                .locator("#map")
                .getAttribute("data-basemap-renderer");
              renderers.set(key, [baseRenderer, basemapRenderer].filter(Boolean).join("+") || null);
              const cdp = await context.newCDPSession(page);
              await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
              const box = await page.locator("#map").boundingBox();
              await runPass(page, cdp, scenario, box); // warm tiles/JIT
              await sleep(400);
              if (CPU_THROTTLE > 1) {
                await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
              }
              if (args.profile && repeat === 0) {
                await cdp.send("Profiler.enable");
                await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
                await cdp.send("Profiler.start");
                await runPass(page, cdp, scenario, box);
                const { profile } = await cdp.send("Profiler.stop");
                const file = path.resolve(
                  rootDir,
                  `benchmark-results/${engine}-${basemap}-${scenario}.cpuprofile`,
                );
                mkdirSync(path.dirname(file), { recursive: true });
                writeFileSync(file, JSON.stringify(profile));
                printProfile(engine, scenario, profile);
                await sleep(400);
              }
              const pass = await runPass(page, cdp, scenario, box);
              if (!passesByKey.has(key)) passesByKey.set(key, []);
              passesByKey.get(key).push(pass);
              console.error(
                `#${repeat + 1} ${engine.padEnd(14)} ${basemap.padEnd(6)} ${scenario.padEnd(7)} fps=${fmt(pass.fps)} p95=${fmt(pass.frameP95)}ms jank=${pass.jankFrames} main=${fmt(pass.mainThreadMs)}ms script=${fmt(pass.scriptMs)}ms responded=${pass.responded}`,
              );
            } finally {
              await context.close();
            }
          }
        }
    }
    for (const basemap of BASEMAPS)
      for (const engine of ENGINES) {
        for (const scenario of SCENARIOS) {
          const key = `${engine}\u0000${scenario}\u0000${basemap}`;
          const passes = passesByKey.get(key) ?? [];
          if (passes.length === 0) continue;
          const summary = { engine, scenario, basemap, renderer: renderers.get(key), passes };
          for (const metric of Object.keys(passes[0])) {
            if (metric !== "responded")
              summary[metric] = median(passes.map((pass) => pass[metric]));
          }
          summary.responded = passes.every((pass) => pass.responded);
          results.push(summary);
        }
      }
  } finally {
    await browser.close();
    await server.close();
  }

  printTable(results);
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        schema: "maps.interaction-benchmark/v2",
        revision: sourceRevision(),
        generatedAt: new Date().toISOString(),
        environment: {
          browser: `chromium ${browserVersion}`,
          ci: Boolean(process.env.CI),
          cpus: os.cpus().length,
          cpuModel: os.cpus()[0]?.model ?? null,
          platform: `${os.platform()} ${os.release()}`,
        },
        gpu: args.gpu ? "hardware" : "swiftshader",
        repeats: REPEATS,
        cpuThrottle: CPU_THROTTLE,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${path.relative(rootDir, jsonPath)}`);
}

function sourceRevision() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function printProfile(engine, scenario, profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  const top = [...self.entries()]
    .filter(([key]) => !key.startsWith("(idle)") && !key.startsWith("(program)"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(args.top ?? 25));
  console.error(`\n# ${engine} ${scenario} self time (ms)`);
  for (const [key, ms] of top) console.error(`${ms.toFixed(1).padStart(8)}  ${key}`);
}

function fmt(value, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}

function printTable(results) {
  const columns = [
    ["engine", (r) => r.engine],
    ["basemap", (r) => r.basemap],
    ["scenario", (r) => r.scenario],
    ["ok", (r) => (r.responded ? "yes" : "NO")],
    ["fps", (r) => fmt(r.fps)],
    ["p50 ms", (r) => fmt(r.frameP50)],
    ["p95 ms", (r) => fmt(r.frameP95)],
    ["max ms", (r) => fmt(r.frameMax)],
    ["jank", (r) => fmt(r.jankFrames, 0)],
    ["main ms", (r) => fmt(r.mainThreadMs)],
    ["script ms", (r) => fmt(r.scriptMs)],
    ["loaf blk", (r) => fmt(r.loafBlockingMs)],
    ["slow in", (r) => fmt(r.slowInputs, 0)],
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
