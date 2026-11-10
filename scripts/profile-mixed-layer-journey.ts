#!/usr/bin/env node
// runtime-profiler browser journey for `mixed-layer-journey-v1` (#170 Fast).
//
// Maps arranges a production build of the mixed-layer acceptance Map View and owns the
// user journey and its map-domain work counters; runtime-profiler owns Chromium launch,
// tracing, normalization and the immutable bundle. The journey writes its Maps-side
// observation (per-phase WASM crossings/draws, pointer latency, long tasks, frame
// intervals and JS heap) to MAPS_MIXED_LAYER_OBSERVATION when that path is set.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
  type MixedLayerWork,
} from "../e2e/helpers/mixed-layer-work.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = JSON.parse(
  readFileSync(path.join(rootDir, "engine-scenarios", "mixed-layer-journey-v1.json"), "utf8"),
);
const viteEntry = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const BUILD_TIMEOUT_MS = 180_000;
const STAGE_TIMEOUT_MS = 15_000;
const HOVER_ROUNDS = 3;
const UNRELATED_COMMITS = 20;
const TEARDOWN_CYCLES = 3;

type Phase = {
  durationMs: number;
  frameIntervalsMs: { count: number; p50: number | null; p95: number | null; max: number | null };
  longTasks: { count: number; totalMs: number; maxMs: number };
  work: MixedLayerWork;
};

type AcceptanceCamera = { center: [number, number]; zoom: number };

declare global {
  interface Window {
    /** The subset of demo/MapsRuntimeAcceptance's sequence handle this journey drives. */
    mapsRuntimeSequences?: {
      commitUnrelated(): void;
      controller(): {
        getViewState(): AcceptanceCamera;
        setViewState(viewState: AcceptanceCamera): void;
      } | null;
      setFixture(patch: { mapMounted?: boolean }): void;
    };
    mapsMixedLayerTiming?: {
      frames: number[];
      longTasks: number[];
      picks: { kind: string; latencyMs: number }[];
      reset(): void;
    };
  }
}

export async function run({ page }: { page: Page }) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-mixed-layer-profile-"));
  let server: Server | undefined;
  try {
    const outDir = path.join(tempRoot, "site");
    buildAcceptanceSite(tempRoot, outDir);
    server = await serveStatic(outDir);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("static server has no port");
    const observation = await profileJourney(page, `http://127.0.0.1:${address.port}`);
    const output = process.env.MAPS_MIXED_LAYER_OBSERVATION;
    if (output) writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

/** A production build of the existing acceptance page, served with the built WASM package. */
function buildAcceptanceSite(tempRoot: string, outDir: string) {
  const config = path.join(tempRoot, "vite.mixed-layer.config.mjs");
  writeFileSync(
    config,
    `import base from ${JSON.stringify(path.join(rootDir, "vite.config.ts"))};
export default {
  ...base,
  configFile: false,
  root: ${JSON.stringify(rootDir)},
  logLevel: "warn",
  build: {
    ...base.build,
    emptyOutDir: true,
    outDir: ${JSON.stringify(outDir)},
    rollupOptions: { input: { reference: ${JSON.stringify(path.join(rootDir, "demo-reference", "index.html"))} } },
  },
};
`,
  );
  const result = spawnSync("bun", [viteEntry, "build", "--config", config], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, VITE_MAPS_WASM_SHOWCASE: "1" },
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`acceptance build failed\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
  // The measured package is the built dist/wasm artifact, never a stale public/ copy.
  mkdirSync(path.join(outDir, "wasm"), { recursive: true });
  for (const file of ["maps_wasm.js", "maps_wasm_bg.wasm"]) {
    copyFileSync(path.join(rootDir, "dist", "wasm", file), path.join(outDir, "wasm", file));
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function serveStatic(directory: string) {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
    let file = path.join(directory, pathname);
    if (!file.startsWith(directory)) {
      response.writeHead(403).end();
      return;
    }
    if (pathname.endsWith("/")) file = path.join(file, "index.html");
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function profileJourney(page: Page, origin: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async (label: string) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const used = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
    return { label, jsHeapUsedBytes: typeof used === "number" ? used : null };
  };

  await page.goto(`${origin}${scenario.fixture.page}`, { timeout: STAGE_TIMEOUT_MS });
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const ready = () =>
    page.waitForFunction(
      () => {
        const element = document.querySelector('[aria-label="Maps Rust runtime acceptance"]');
        return (
          element?.getAttribute("data-map-ready") === "true" &&
          element
            .querySelector('canvas[data-map-overlay-runtime="maps"]')
            ?.getAttribute("data-map-overlay-primitives") === "7" &&
          window.mapsRuntimeSequences?.controller() != null
        );
      },
      undefined,
      { timeout: STAGE_TIMEOUT_MS },
    );
  await ready();
  const backend = await map
    .locator('canvas[data-flat-runtime="maps"]')
    .getAttribute("data-map-base-renderer");
  // The fixed 1280x720 profiler viewport starts the page above the Map View.
  await map.scrollIntoViewIfNeeded();
  await installTiming(page);
  await installMixedLayerWork(page, { measure: true });
  await settleFrames(page, 10);
  const memory = [await heap("ready")];
  const phases: Record<string, Phase> = {};
  const phase = async (name: string, action: () => Promise<unknown>) => {
    await resetMixedLayerWork(page);
    await page.evaluate(() => window.mapsMixedLayerTiming!.reset());
    const started = await page.evaluate((label) => {
      performance.mark(`maps:mixed-layer:${label}:start`);
      return performance.now();
    }, name);
    await action();
    await settleFrames(page, 6);
    const durationMs = await page.evaluate(
      ({ label, start }) => {
        performance.measure(`maps:mixed-layer:${label}`, `maps:mixed-layer:${label}:start`);
        return performance.now() - start;
      },
      { label: name, start: started },
    );
    const timing = await page.evaluate(() => ({
      frames: window.mapsMixedLayerTiming!.frames,
      longTasks: window.mapsMixedLayerTiming!.longTasks,
    }));
    phases[name] = {
      durationMs,
      frameIntervalsMs: summarize(timing.frames),
      longTasks: {
        count: timing.longTasks.length,
        maxMs: Math.max(0, ...timing.longTasks),
        totalMs: timing.longTasks.reduce((sum, value) => sum + value, 0),
      },
      work: await readMixedLayerWork(page),
    };
  };

  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  // North-up Web Mercator from the public controller camera, as the acceptance spec does.
  const client = async ([longitude, latitude]: [number, number]) => {
    const bounds = (await overlay.boundingBox())!;
    const camera = await page.evaluate(() =>
      window.mapsRuntimeSequences!.controller()!.getViewState(),
    );
    const mercator = (lng: number, lat: number) => {
      const sin = Math.sin((lat * Math.PI) / 180);
      return { x: lng / 360 + 0.5, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
    };
    const target = mercator(longitude, latitude);
    const center = mercator(camera.center[0], camera.center[1]);
    const worldSize = 512 * 2 ** camera.zoom;
    return {
      x: bounds.x + bounds.width / 2 + (target.x - center.x) * worldSize,
      y: bounds.y + bounds.height / 2 + (target.y - center.y) * worldSize,
    };
  };
  const expectInteraction = async (text: string) => {
    try {
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="maps-runtime-interaction"]')?.textContent ===
          expected,
        text,
        { timeout: STAGE_TIMEOUT_MS },
      );
    } catch (error) {
      const actual = await page.getByTestId("maps-runtime-interaction").textContent();
      throw new Error(`expected interaction ${text}, saw ${actual}`, { cause: error });
    }
  };
  const targets: { kind: string; coordinate: [number, number]; text: string }[] = [
    { kind: "flow", coordinate: [12.3, 52], text: "flow:hover:acceptance-flow" },
    { kind: "point", coordinate: [13.405, 52.52], text: "point:hover:acceptance-berlin" },
  ];

  await phase("camera", async () => {
    const bounds = (await overlay.boundingBox())!;
    const start = { x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.8 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 160, start.y - 48, { steps: 12 });
    await page.mouse.up();
    for (let step = 0; step < 3; step += 1) {
      await page.mouse.wheel(0, -120);
      await settleFrames(page, 2);
    }
    await settleFrames(page, 30);
    await page.evaluate(() =>
      window.mapsRuntimeSequences!.controller()!.setViewState({ center: [13.405, 52.52], zoom: 6 }),
    );
  });

  await phase("hover", async () => {
    const empty = await client([16, 50.5]);
    for (let round = 0; round < HOVER_ROUNDS; round += 1) {
      for (const target of targets) {
        const { x, y } = await client(target.coordinate);
        await page.mouse.move(x, y);
        await expectInteraction(target.text);
      }
      await page.mouse.move(empty.x, empty.y);
      await settleFrames(page, 2);
    }
  });

  await phase("select", async () => {
    const clicks: { coordinate: [number, number]; text: string }[] = [
      { coordinate: [13.405, 52.52], text: "point:click:acceptance-berlin" },
      { coordinate: [13.2, 52.45], text: "geojson:click:acceptance-zone" },
      { coordinate: [12.3, 52], text: "flow:click:acceptance-flow" },
    ];
    for (const click of clicks) {
      const { x, y } = await client(click.coordinate);
      await page.mouse.click(x, y);
      await expectInteraction(click.text);
      await page.getByTestId("maps-runtime-feature-popup").waitFor({ timeout: STAGE_TIMEOUT_MS });
      await page.keyboard.press("Escape");
    }
  });

  await phase("unrelated-commits", async () => {
    for (let commit = 0; commit < UNRELATED_COMMITS; commit += 1) {
      await page.evaluate(() => window.mapsRuntimeSequences!.commitUnrelated());
    }
  });
  memory.push(await heap("after-interaction"));

  await phase("teardown", async () => {
    for (let cycle = 0; cycle < TEARDOWN_CYCLES; cycle += 1) {
      await page.evaluate(() => window.mapsRuntimeSequences!.setFixture({ mapMounted: false }));
      await settleFrames(page, 2);
      memory.push(await heap(`unmounted-${cycle + 1}`));
      await page.evaluate(() => window.mapsRuntimeSequences!.setFixture({ mapMounted: true }));
      await ready();
    }
  });
  memory.push(await heap("remounted"));

  const picks = await page.evaluate(() => window.mapsMixedLayerTiming!.picks);
  return {
    schemaVersion: "maps.mixed-layer-journey-observation/v1",
    scenarioId: scenario.id,
    backend,
    viewport: page.viewportSize(),
    phases,
    picks: {
      count: picks.length,
      latencyMs: summarize(picks.map((pick) => pick.latencyMs)),
      samples: picks,
    },
    memory: {
      jsHeapAfterGc: memory,
      unavailable: [
        "GPU memory and driver allocations",
        "WASM linear memory growth",
        "total browser process memory",
      ],
    },
    unavailable: [
      "reference/parent comparison: no other implementation runs this journey",
      "GPU completion time (frame intervals are requestAnimationFrame intervals)",
    ],
  };
}

/** rAF intervals, long tasks and pointer → Map UI interaction latency, all in-page. */
function installTiming(page: Page) {
  return page.evaluate(() => {
    const timing = {
      frames: [] as number[],
      longTasks: [] as number[],
      picks: [] as { kind: string; latencyMs: number }[],
      reset() {
        timing.frames = [];
        timing.longTasks = [];
      },
    };
    window.mapsMixedLayerTiming = timing;
    let previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) timing.frames.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) timing.longTasks.push(entry.duration);
      }).observe({ type: "longtask" });
    } catch {
      // Long-task timing is unavailable; the profiler trace still records them.
    }
    let input: { kind: string; at: number } | null = null;
    window.addEventListener("pointermove", (event) => (input = { at: event.timeStamp, kind: "hover" }), true);
    window.addEventListener("pointerdown", (event) => (input = { at: event.timeStamp, kind: "click" }), true);
    const output = document.querySelector('[data-testid="maps-runtime-interaction"]')!;
    new MutationObserver(() => {
      if (!input) return;
      const latencyMs = performance.now() - input.at;
      performance.measure("maps:mixed-layer:pointer-to-interaction", { start: input.at });
      timing.picks.push({ kind: `${input.kind}:${output.textContent?.split(":")[0]}`, latencyMs });
      input = null;
    }).observe(output, { characterData: true, childList: true, subtree: true });
  });
}

function summarize(values: number[]) {
  if (values.length === 0) return { count: 0, max: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { count: sorted.length, max: sorted.at(-1)!, p50: at(0.5), p95: at(0.95) };
}
