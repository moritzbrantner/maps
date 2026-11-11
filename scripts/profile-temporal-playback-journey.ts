#!/usr/bin/env node
// runtime-profiler browser journey for `temporal-playback-journey-v1` (#172 phase E, Fast).
//
// Maps arranges a production build of the temporal playback fixture and owns the user journey,
// the temporal work counters (`src/temporal-work.ts`) and the Map View runtime counters
// (`e2e/helpers/mixed-layer-work.ts`); runtime-profiler owns Chromium launch, tracing,
// normalization and the immutable bundle. The journey writes its Maps-side observation
// (per-phase frame intervals, long tasks, temporal and runtime work, input → presented latency
// and JS heap) to MAPS_TEMPORAL_OBSERVATION when that path is set.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
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
import type { TemporalPlaybackWork, TemporalWorkTotals } from "../src/temporal-work.ts";
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
  type LongTaskSummary,
  type Summary,
} from "./browser-journey-support.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = JSON.parse(
  readFileSync(path.join(rootDir, "engine-scenarios", "temporal-playback-journey-v1.json"), "utf8"),
);
const FIXTURE = "e2e/fixtures/temporal-playback-journey.html";
const MAP_LABEL = "Temporal playback journey";
const STAGE_TIMEOUT_MS = 30_000;
const IDLE_FRAMES = 60;
const PLAYBACK_FRAMES = 180;
const SEEKS = [800, 120, 640, 300, 960, 40, 500, 720];
const SCRUB_STEPS = 40;
const SOURCE_VARIANTS = [1, 0, 1];
const UNRELATED_COMMITS = 20;
const TEARDOWN_CYCLES = 3;

type Commit = {
  label: string;
  latencyMs: number;
  runtime: MixedLayerWork;
  temporal: TemporalPlaybackWork;
};

type Phase = {
  commits: Commit[];
  durationMs: number;
  frameIntervalsMs: Summary;
  longTasks: LongTaskSummary;
  runtime: MixedLayerWork;
  /** Event Timing: input → next paint of inputs that took at least 16 ms. */
  slowInputEventsMs: Summary;
  temporal: TemporalPlaybackWork;
};

declare global {
  interface Window {
    temporalJourney: {
      clock: {
        getSnapshot(): { activeTime: number };
        pause(): void;
        play(): void;
        seek(time: number): void;
      };
      commitUnrelated(): void;
      controller: unknown;
      replaceSource(variant: number): void;
      runtimeStatus(): string;
      setMounted(mounted: boolean): void;
      totals(): TemporalWorkTotals;
    };
  }
}

export async function run({ page }: { page: Page }) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-temporal-profile-"));
  let server: Server | undefined;
  try {
    const outDir = path.join(tempRoot, "site");
    buildFixtureSite(tempRoot, outDir, FIXTURE);
    server = await serveStatic(outDir);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("static server has no port");
    const observation = await profileJourney(page, `http://127.0.0.1:${address.port}`);
    const output = process.env.MAPS_TEMPORAL_OBSERVATION;
    if (output) writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

async function profileJourney(page: Page, origin: string) {
  const heap = await createHeapSampler(page);
  // Long tasks from navigation on, so page load and the sampler handover are attributed too.
  await page.addInitScript(installJourneyTiming);
  await page.goto(`${origin}/${FIXTURE}`, { timeout: STAGE_TIMEOUT_MS });
  const map = page.getByLabel(MAP_LABEL);
  // Ready: the Map View presented its layers and Rust samples the tracks.
  const ready = (rustPreparationsBefore: number) =>
    page.waitForFunction(
      (before) => {
        const element = document.querySelector('[aria-label="Temporal playback journey"]');
        const overlay = element?.querySelector('canvas[data-map-overlay-runtime="maps"]');
        return (
          element?.getAttribute("data-map-ready") === "true" &&
          Number(overlay?.getAttribute("data-map-overlay-primitives")) > 0 &&
          window.temporalJourney.controller != null &&
          window.temporalJourney.totals().playback.rustTrackPreparations > before
        );
      },
      rustPreparationsBefore,
      { polling: "raf", timeout: STAGE_TIMEOUT_MS },
    );
  await ready(0);
  const load = await page.evaluate(() => ({
    longTasks: window.mapsJourneyTiming!.longTasks.map((task) => task.duration),
    presentedMs: performance.now(),
    sampler: window.temporalJourney.runtimeStatus(),
    temporal: window.temporalJourney.totals(),
  }));
  const backend = await map
    .locator('canvas[data-flat-runtime="maps"]')
    .getAttribute("data-map-base-renderer");
  await installMixedLayerWork(page, { measure: true });
  await settleFrames(page, 10);
  const memory: HeapSample[] = [await heap("ready")];

  const phases: Record<string, Phase> = {};
  const phase = async (name: string, action: (commits: Commit[]) => Promise<unknown>) => {
    const before = await temporalTotals(page);
    await resetMixedLayerWork(page);
    await resetJourneyTiming(page);
    const label = `maps:temporal:${name}`;
    const started = await page.evaluate((mark) => {
      performance.mark(`${mark}:start`);
      return performance.now();
    }, label);
    const commits: Commit[] = [];
    await action(commits);
    await settleFrames(page, 6);
    const durationMs = await page.evaluate(
      ({ mark, start }) => {
        performance.measure(mark, `${mark}:start`);
        return performance.now() - start;
      },
      { mark: label, start: started },
    );
    phases[name] = {
      commits,
      durationMs,
      ...(await readJourneyTiming(page)),
      runtime: await readMixedLayerWork(page),
      temporal: delta(before, await temporalTotals(page)),
    };
  };

  // Paused baseline: the same Map View presenting nothing new.
  await phase("idle", () => settleFrames(page, IDLE_FRAMES));

  await phase("playback", async () => {
    await page.evaluate(() => window.temporalJourney.clock.play());
    await settleFrames(page, PLAYBACK_FRAMES);
    await page.evaluate(() => window.temporalJourney.clock.pause());
  });

  await phase("seek", async (commits) => {
    for (const time of SEEKS) {
      commits.push(await commit(page, `seek-${time}`, "seek", time));
    }
  });

  // Dragging the public timeline slider: one input per pointer move, as fast as the page takes.
  await phase("scrub", async () => {
    const slider = page.getByRole("slider", { name: "Journey timeline" });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, y, { steps: SCRUB_STEPS });
    await page.mouse.up();
    await settleFrames(page, 4);
  });

  await phase("camera-pan-paused", () => drag(page, map));

  await phase("camera-pan-playing", async () => {
    await page.evaluate(() => window.temporalJourney.clock.play());
    await drag(page, map);
    await page.evaluate(() => window.temporalJourney.clock.pause());
  });

  await phase("source-replace", async (commits) => {
    for (const variant of SOURCE_VARIANTS) {
      commits.push(await commit(page, `source-${variant}`, "replaceSource", variant));
    }
  });

  await phase("unrelated-commits", async () => {
    for (let index = 0; index < UNRELATED_COMMITS; index += 1) {
      await page.evaluate(() => window.temporalJourney.commitUnrelated());
      await settleFrames(page, 2);
    }
  });
  memory.push(await heap("after-journey"));

  const timeBeforeTeardown = await activeTime(page);
  await phase("teardown", async () => {
    for (let cycle = 0; cycle < TEARDOWN_CYCLES; cycle += 1) {
      await page.evaluate(() => window.temporalJourney.setMounted(false));
      await settleFrames(page, 4);
      memory.push(await heap(`unmounted-${cycle + 1}`));
      const rust = (await temporalTotals(page)).playback.rustTrackPreparations;
      await page.evaluate(() => window.temporalJourney.setMounted(true));
      await ready(rust);
    }
  });
  memory.push(await heap("remounted"));

  const commits = Object.values(phases).flatMap((entry) => entry.commits);
  return {
    schemaVersion: "maps.temporal-playback-journey-observation/v1",
    scenarioId: scenario.id,
    backend,
    viewport: page.viewportSize(),
    load: {
      longTasks: summarizeLongTasks(load.longTasks),
      // From navigation start until the Map View is presented with Rust sampling the tracks.
      presentedMs: load.presentedMs,
      sampler: load.sampler,
      temporal: load.temporal,
    },
    phases,
    commitLatencyMs: summarize(commits.map((entry) => entry.latencyMs)),
    timeKeptAcrossTeardown: timeBeforeTeardown === (await activeTime(page)),
    jsHeapAfterGc: memory,
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
    ],
  };
}

/** A pointer drag across the Map View, 24 steps. */
async function drag(page: Page, map: ReturnType<Page["getByLabel"]>) {
  const bounds = (await map.boundingBox())!;
  const start = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 240, start.y - 80, { steps: 24 });
  await page.mouse.up();
  await settleFrames(page, 12);
}

/**
 * One input, then the animation frame after its new positions were sampled and the overlay
 * repainted: the input → presented latency of the temporal path.
 */
async function commit(
  page: Page,
  label: string,
  operation: "replaceSource" | "seek",
  argument: number,
): Promise<Commit> {
  // The phase's runtime counters keep running; the commit records its own difference.
  const runtimeBefore = await readMixedLayerWork(page);
  const result = await page.evaluate(
    async ({ argument, operation, timeout }) => {
      const journey = window.temporalJourney;
      type Counters = { counters: Record<string, number> };
      const runtime = (window as unknown as { mapsMixedLayerWork: Counters }).mapsMixedLayerWork;
      const repaints = () =>
        runtime.counters.gpuFrames! + runtime.counters.canvasOverlayRedraws!;
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const before = journey.totals();
      // Paused over a static camera, nothing else repaints the Map View.
      const repaintsBefore = repaints();
      const started = performance.now();
      if (operation === "seek") journey.clock.seek(argument);
      else journey.replaceSource(argument);
      // Sampled and repainted, then presented.
      while (
        journey.totals().playback.samples === before.playback.samples ||
        repaints() === repaintsBefore
      ) {
        if (performance.now() - started > timeout) throw new Error(`${operation}: not presented`);
        await nextFrame();
      }
      await nextFrame();
      return { before, latencyMs: performance.now() - started };
    },
    { argument, operation, timeout: STAGE_TIMEOUT_MS },
  );
  await settleFrames(page, 4);
  const runtimeAfter = await readMixedLayerWork(page);
  return {
    label,
    latencyMs: result.latencyMs,
    runtime: Object.fromEntries(
      Object.keys(runtimeAfter).map((key) => [
        key,
        runtimeAfter[key as keyof MixedLayerWork] - runtimeBefore[key as keyof MixedLayerWork],
      ]),
    ) as MixedLayerWork,
    temporal: delta(result.before, await temporalTotals(page)),
  };
}

function temporalTotals(page: Page) {
  return page.evaluate(() => window.temporalJourney.totals());
}

function activeTime(page: Page) {
  return page.evaluate(() => window.temporalJourney.clock.getSnapshot().activeTime);
}

function delta(before: TemporalWorkTotals, after: TemporalWorkTotals): TemporalPlaybackWork {
  return Object.fromEntries(
    Object.keys(after.playback).map((key) => [
      key,
      after.playback[key as keyof TemporalPlaybackWork] -
        before.playback[key as keyof TemporalPlaybackWork],
    ]),
  ) as TemporalPlaybackWork;
}
