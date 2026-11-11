#!/usr/bin/env node
// runtime-profiler browser journey for `heat-scalar-journey-v1` (#171 phase 5, Fast).
//
// Maps arranges a production build of the heat/scalar journey fixture and owns the user
// journey and its heat/scalar work counters; runtime-profiler owns Chromium launch, tracing,
// normalization and the immutable bundle. The journey writes its Maps-side observation
// (per-phase frame intervals, long tasks, heat/scalar work, input → presented-surface latency
// and JS heap) to MAPS_HEAT_SCALAR_OBSERVATION when that path is set.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

import type { HeatLayerWorkTotals } from "../src/heat-layer-work.ts";
import {
  buildFixtureSite,
  createHeapSampler,
  installJourneyTiming,
  readJourneyTiming,
  resetJourneyTiming,
  serveStatic,
  summarize,
  summarizeLongTasks,
  type HeapSample,
  type Summary,
} from "./browser-journey-support.ts";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scenario = JSON.parse(
  readFileSync(
    path.join(rootDir, "engine-scenarios", "heat-scalar-journey-v1.json"),
    "utf8",
  ),
);
const FIXTURE = "e2e/fixtures/heat-scalar-journey.html";
const STAGE_TIMEOUT_MS = 30_000;
const SEEKS = [10, 9, 8, 7, 6, 5];
const FIELD_UPDATES = [1, 2, 3, 4, 5, 6];
const STYLE_VARIANTS = [1, 0, 1, 0];
const TEARDOWN_CYCLES = 3;
const ORIENT_FRAMES = 60;

type WorkDelta = {
  data: Record<string, number>;
  surface: Record<string, number>;
};

type Commit = { label: string; latencyMs: number; work: WorkDelta };

type Phase = {
  commits: Commit[];
  durationMs: number;
  frameIntervalsMs: Summary;
  longTasks: { count: number; maxMs: number; totalMs: number };
  work: WorkDelta;
};

declare global {
  interface Window {
    heatScalarJourney: {
      controller: {
        getViewState(): {
          bearing?: number;
          center: [number, number];
          pitch?: number;
          zoom: number;
        };
        setViewState(viewState: {
          bearing?: number;
          center: [number, number];
          pitch?: number;
          zoom: number;
        }): void;
      } | null;
      seekDensity(step: number): void;
      setMounted(mounted: boolean): void;
      setSize(size: { height: number; width: number }): void;
      setStyle(variant: number): void;
      totals(): HeatLayerWorkTotals;
      updateField(step: number): void;
    };
  }
}

export async function run({ page }: { page: Page }) {
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), "maps-heat-scalar-profile-"),
  );
  let server: Server | undefined;
  try {
    const outDir = path.join(tempRoot, "site");
    buildFixtureSite(tempRoot, outDir, FIXTURE);
    server = await serveStatic(outDir);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("static server has no port");
    const observation = await profileJourney(
      page,
      `http://127.0.0.1:${address.port}`,
    );
    const output = process.env.MAPS_HEAT_SCALAR_OBSERVATION;
    if (output)
      writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

type Heap = (label: string) => Promise<HeapSample>;

type Lane = "control" | "heat";

async function profileJourney(page: Page, origin: string) {
  const heap: Heap = await createHeapSampler(page);

  // Long tasks from navigation on, so page load and the first surfaces are attributed too.
  await page.addInitScript(installJourneyTiming);
  // The control lane is the same Map View without its Heat Layers: the camera phases of the two
  // lanes differ only by the heat/scalar surfaces.
  const control = await profileLane(page, origin, "control", heap);
  const heat = await profileLane(page, origin, "heat", heap);

  return {
    schemaVersion: "maps.heat-scalar-journey-observation/v1",
    scenarioId: scenario.id,
    backend: heat.backend,
    viewport: page.viewportSize(),
    lanes: { control, heat },
    memory: {
      unavailable: [
        "GPU memory and driver allocations",
        "WASM linear memory growth",
        "total browser process memory",
      ],
    },
    unavailable: [
      "reference/parent comparison: no other implementation or parent revision runs this journey",
      "GPU completion time (frame intervals are requestAnimationFrame intervals)",
      "bridge bytes: no WASM bridge carries heat/scalar data while TypeScript is the authority",
    ],
  };
}

async function profileLane(page: Page, origin: string, lane: Lane, heap: Heap) {
  const heatLayers = lane === "heat" ? 2 : 0;
  await page.goto(
    `${origin}/${FIXTURE}${lane === "control" ? "?heat=0" : ""}`,
    {
      timeout: STAGE_TIMEOUT_MS,
    },
  );
  const map = page.getByLabel("Heat scalar journey");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  // Ready: the Map View, its vector layers and (heat lane) both heat surfaces decoded and drawn.
  const ready = (decodedBefore: number) =>
    page.waitForFunction(
      ({ decodedBefore, heatLayers }) => {
        const element = document.querySelector(
          '[aria-label="Heat scalar journey"]',
        );
        const canvas = element?.querySelector(
          'canvas[data-map-overlay-runtime="maps"]',
        );
        return (
          element?.getAttribute("data-map-ready") === "true" &&
          Number(canvas?.getAttribute("data-map-overlay-primitives")) > 0 &&
          canvas?.getAttribute("data-map-overlay-heat-layers") ===
            String(heatLayers) &&
          window.heatScalarJourney.controller != null &&
          window.heatScalarJourney.totals().surface.rasterImagesDecoded >=
            decodedBefore + heatLayers
        );
      },
      { decodedBefore, heatLayers },
      { polling: "raf", timeout: STAGE_TIMEOUT_MS },
    );
  await ready(0);
  const load = await page.evaluate(() => ({
    longTasks: window.mapsJourneyTiming!.longTasks.map((task) => task.duration),
    presentedMs: performance.now(),
    work: window.heatScalarJourney.totals(),
  }));
  const backend = await map
    .locator('canvas[data-flat-runtime="maps"]')
    .getAttribute("data-map-base-renderer");
  await settleFrames(page, 10);
  const memory = [await heap("ready")];

  const phases: Record<string, Phase> = {};
  const phase = async (
    name: string,
    action: (commits: Commit[]) => Promise<unknown>,
  ) => {
    const before = await totals(page);
    await resetJourneyTiming(page);
    const started = await page.evaluate((label) => {
      performance.mark(`${label}:start`);
      return performance.now();
    }, `maps:heat-scalar:${lane}:${name}`);
    const commits: Commit[] = [];
    await action(commits);
    await settleFrames(page, 6);
    const durationMs = await page.evaluate(
      ({ label, start }) => {
        performance.measure(label, `${label}:start`);
        return performance.now() - start;
      },
      { label: `maps:heat-scalar:${lane}:${name}`, start: started },
    );
    const { frameIntervalsMs, longTasks } = await readJourneyTiming(page);
    phases[name] = {
      commits,
      durationMs,
      frameIntervalsMs,
      longTasks,
      work: delta(before, await totals(page)),
    };
  };

  const bounds = (await overlay.boundingBox())!;
  await phase("camera-pan", async () => {
    const start = {
      x: bounds.x + bounds.width * 0.7,
      y: bounds.y + bounds.height * 0.6,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 220, start.y - 90, { steps: 20 });
    await page.mouse.up();
    await settleFrames(page, 20);
  });

  await phase("camera-zoom", async () => {
    // Toward the density around Berlin, three wheel steps near its projected position.
    for (let step = 0; step < 3; step += 1) {
      await page.mouse.move(
        bounds.x + bounds.width * 0.55,
        bounds.y + bounds.height * 0.4,
      );
      await page.mouse.wheel(0, -240);
      await settleFrames(page, 4);
    }
    await settleFrames(page, 30);
  });

  await phase("camera-orient", async () => {
    // One camera per animation frame, bearing and pitch together, then back to north-up.
    await page.evaluate(
      (frames) =>
        new Promise<void>((resolve) => {
          const controller = window.heatScalarJourney.controller!;
          const from = controller.getViewState();
          let frame = 0;
          const tick = () => {
            frame += 1;
            const t = frame <= frames ? frame / frames : 2 - frame / frames;
            controller.setViewState({
              bearing: 35 * t,
              center: from.center,
              pitch: 40 * t,
              zoom: from.zoom,
            });
            if (frame < frames * 2) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        }),
      ORIENT_FRAMES,
    );
    await settleFrames(page, 20);
    await page.evaluate(
      (view) => window.heatScalarJourney.controller!.setViewState(view),
      scenario.initialCamera,
    );
    await settleFrames(page, 20);
  });

  await phase("resize", async () => {
    await page.evaluate(() =>
      window.heatScalarJourney.setSize({ height: 640, width: 1024 }),
    );
    await settleFrames(page, 30);
    await page.evaluate(() =>
      window.heatScalarJourney.setSize({ height: 720, width: 1280 }),
    );
    await settleFrames(page, 30);
  });

  if (lane === "heat") {
    await phase("density-seek", async (commits) => {
      for (const step of SEEKS) {
        commits.push(
          await commit(page, `seek-${step}`, "seekDensity", step, {
            data: { sourceIndexBuilds: 1 },
            surface: { rasterImagesDecoded: 1 },
          }),
        );
      }
    });

    await phase("field-update", async (commits) => {
      for (const step of FIELD_UPDATES) {
        commits.push(
          await commit(page, `field-${step}`, "updateField", step, {
            data: {
              fieldContourBuilds: 1,
              fieldGridBuilds: 1,
              fieldImageBuilds: 1,
            },
            surface: { rasterImagesDecoded: 1 },
          }),
        );
      }
    });

    await phase("style", async (commits) => {
      for (const variant of STYLE_VARIANTS) {
        commits.push(
          await commit(page, `style-${variant}`, "setStyle", variant, {
            data: { fieldImageBuilds: 1 },
            surface: { rasterImagesDecoded: 2 },
          }),
        );
      }
    });

    await phase("superseded-bursts", async (commits) => {
      commits.push(
        await burst(page, "density-burst", "seekDensity", [0, 1, 2, 3, 4, 11]),
      );
      commits.push(
        await burst(page, "field-burst", "updateField", [7, 8, 9, 10, 11, 0]),
      );
    });
  }
  memory.push(await heap("after-journey"));

  await phase("teardown", async () => {
    for (let cycle = 0; cycle < TEARDOWN_CYCLES; cycle += 1) {
      await page.evaluate(() => window.heatScalarJourney.setMounted(false));
      await settleFrames(page, 4);
      memory.push(await heap(`unmounted-${cycle + 1}`));
      const decoded = (await totals(page)).surface.rasterImagesDecoded;
      await page.evaluate(() => window.heatScalarJourney.setMounted(true));
      await ready(decoded);
    }
  });
  memory.push(await heap("remounted"));

  const commits = Object.values(phases).flatMap((entry) => entry.commits);
  return {
    backend,
    load: {
      longTasks: summarizeLongTasks(load.longTasks),
      // From navigation start until the Map View (heat lane: both surfaces) is presented.
      presentedMs: load.presentedMs,
      work: load.work,
    },
    phases,
    commitLatencyMs: summarize(commits.map((entry) => entry.latencyMs)),
    jsHeapAfterGc: memory,
  };
}

/**
 * One input, then the animation frame after its new surfaces are decoded: the input → presented
 * latency of the async heat/scalar path. `expected` are the minimum counter increases that mark
 * the commit; the work delta records everything that ran.
 */
async function commit(
  page: Page,
  label: string,
  operation: "seekDensity" | "setStyle" | "updateField",
  argument: number,
  expected: WorkDelta,
): Promise<Commit> {
  const result = await page.evaluate(
    async ({ argument, expected, operation, timeout }) => {
      const journey = window.heatScalarJourney;
      const before = journey.totals();
      const reached = () => {
        const now = journey.totals();
        return (["data", "surface"] as const).every((group) =>
          Object.entries(expected[group]).every(
            ([key, minimum]) =>
              (now[group] as Record<string, number>)[key]! -
                (before[group] as Record<string, number>)[key]! >=
              minimum,
          ),
        );
      };
      const nextFrame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const started = performance.now();
      journey[operation](argument);
      while (!reached()) {
        if (performance.now() - started > timeout) {
          throw new Error(
            `no commit within ${timeout} ms: ${JSON.stringify(journey.totals())}`,
          );
        }
        await nextFrame();
      }
      await nextFrame();
      return {
        before,
        after: journey.totals(),
        latencyMs: performance.now() - started,
      };
    },
    { argument, expected, operation, timeout: STAGE_TIMEOUT_MS },
  );
  await settleFrames(page, 4);
  return {
    label,
    latencyMs: result.latencyMs,
    work: delta(result.before, result.after),
  };
}

/**
 * Inputs on consecutive animation frames: every superseded async result must be discarded, and
 * the latency runs from the last input until its surface is decoded and no further work arrives.
 */
async function burst(
  page: Page,
  label: string,
  operation: "seekDensity" | "updateField",
  steps: number[],
): Promise<Commit> {
  const result = await page.evaluate(
    async ({ operation, steps, timeout }) => {
      const journey = window.heatScalarJourney;
      const nextFrame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const before = journey.totals();
      for (const step of steps.slice(0, -1)) {
        journey[operation](step);
        await nextFrame();
      }
      const started = performance.now();
      journey[operation](steps.at(-1)!);
      // Settled: a decoded surface after the last input and ten quiet frames of heat work.
      let decodedAt: number | null = null;
      let quiet = 0;
      let last = JSON.stringify(journey.totals());
      while (quiet < 10) {
        if (performance.now() - started > timeout) {
          throw new Error(`burst did not settle within ${timeout} ms`);
        }
        await nextFrame();
        const now = journey.totals();
        const serialized = JSON.stringify(now);
        if (serialized === last) {
          quiet += decodedAt === null ? 0 : 1;
        } else {
          quiet = 0;
          if (
            now.surface.rasterImagesDecoded > before.surface.rasterImagesDecoded
          ) {
            decodedAt = performance.now();
          }
          last = serialized;
        }
      }
      return {
        after: journey.totals(),
        before,
        latencyMs: (decodedAt ?? performance.now()) - started,
      };
    },
    { operation, steps, timeout: STAGE_TIMEOUT_MS },
  );
  return {
    label,
    latencyMs: result.latencyMs,
    work: delta(result.before, result.after),
  };
}

function totals(page: Page) {
  return page.evaluate(() => window.heatScalarJourney.totals());
}

function delta(
  before: HeatLayerWorkTotals,
  after: HeatLayerWorkTotals,
): WorkDelta {
  const subtract = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.keys(b).map((key) => [key, b[key]! - a[key]!]));
  return {
    data: subtract(before.data, after.data),
    surface: subtract(before.surface, after.surface),
  };
}

function settleFrames(page: Page, frames = 4) {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let seen = 0;
        const tick = () =>
          ++seen >= count ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

