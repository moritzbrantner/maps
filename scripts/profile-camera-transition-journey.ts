#!/usr/bin/env node
// runtime-profiler browser journey for `camera-transition-journey-v1` (#433, Fast).
//
// Maps arranges a production build of the camera transition fixture and owns the user
// journey, the flight observations (presented frames, stalls, interruptions) and the Map View
// runtime counters (`e2e/helpers/mixed-layer-work.ts`); runtime-profiler owns Chromium launch,
// tracing, normalization and the immutable bundle. The journey writes its Maps-side
// observation to MAPS_CAMERA_TRANSITION_OBSERVATION when that path is set.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright";

import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
  type MixedLayerWork,
} from "../e2e/helpers/mixed-layer-work.ts";
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
  readFileSync(path.join(rootDir, "engine-scenarios", "camera-transition-journey-v1.json"), "utf8"),
);
const FIXTURE = "e2e/fixtures/camera-transition-journey.html";
const MAP_LABEL = "Camera transition journey";
const STAGE_TIMEOUT_MS = 30_000;
const IDLE_FRAMES = 60;
/** Flight frames presented before an interruption or a successive command. */
const INTERRUPT_AFTER_FRAMES = 8;
const JUMPS = 10;
const TEARDOWN_CYCLES = 3;

type FlyOptions = { animate?: boolean; durationMs?: number };
/** The named cameras of `e2e/fixtures/camera-transition-journey.tsx`. */
type CameraJourneyView = "berlin" | "fiji" | "paris" | "rome" | "samoa" | "vienna";
type CameraJourneyViewState = {
  bearing?: number;
  center: [number, number];
  pitch?: number;
  zoom: number;
};

/** One flight command and what the Map View presented for it. */
export type FlightObservation = {
  label: string;
  target: CameraJourneyView;
  /** `fly-to` frames presented for this command. */
  frames: number;
  /** Animation-frame time from the command to its last presented frame. */
  presentedMs: number | null;
  /** Largest gap between consecutive presented frames, the command included. */
  maxFrameGapMs: number | null;
  /** Whether the last presented camera is the target (completed flights only). */
  endedOnTarget: boolean;
  /** The last presented camera. */
  lastViewState: CameraJourneyViewState | null;
  /** How the flight ended: completed, superseded by the next command, interrupted or unmounted. */
  ending: "completed" | "superseded" | "pointer" | "unmounted";
  /** `fly-to` frames presented after the interruption (must be 0). */
  framesAfterEnd: number;
  /** `performance.now()` at the command, and its first entry in the fixture's camera trace. */
  commandTime: number;
  traceStart: number;
};

type Phase = {
  durationMs: number;
  flights: FlightObservation[];
  frameIntervalsMs: Summary;
  longTasks: LongTaskSummary;
  /**
   * Base renders and translated presentations, from the Map View's renderer stats; `null`
   * when the phase remounts the Map View (each mount counts from zero).
   */
  renderer: { renders: number; translatedFrames: number } | null;
  runtime: MixedLayerWork;
  slowInputEventsMs: Summary;
};

type TraceEntry = {
  frameTime: number;
  reason: string;
  viewState: { bearing?: number; center: [number, number]; pitch?: number; zoom: number };
};

declare global {
  interface Window {
    cameraJourney: {
      commandTime: number;
      controller: unknown;
      fly(view: CameraJourneyView, options?: FlyOptions): void;
      pointerDownTraceLength: number | null;
      setMounted(mounted: boolean): number;
      setWidth(width: number): void;
      stats(): { renders: number; translatedFrames: number } | null;
      targets: Record<CameraJourneyView, CameraJourneyViewState>;
      trace: TraceEntry[];
    };
  }
}

export async function run({ page }: { page: Page }) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-camera-transition-profile-"));
  let server: Server | undefined;
  try {
    const outDir = path.join(tempRoot, "site");
    buildFixtureSite(tempRoot, outDir, FIXTURE);
    server = await serveStatic(outDir);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("static server has no port");
    const observation = await profileCameraTransitionJourney(
      page,
      `http://127.0.0.1:${address.port}`,
    );
    const output = process.env.MAPS_CAMERA_TRANSITION_OBSERVATION;
    if (output) writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

/** The journey over an already served fixture origin (also used by the browser spec). */
export async function profileCameraTransitionJourney(page: Page, origin: string) {
  const heap = await createHeapSampler(page);
  await page.addInitScript(installJourneyTiming);
  await page.goto(`${origin}/${FIXTURE}`, { timeout: STAGE_TIMEOUT_MS });
  const map = page.getByLabel(MAP_LABEL);
  await ready(page);
  const load = await page.evaluate(() => ({
    longTasks: window.mapsJourneyTiming!.longTasks.map((task) => task.duration),
    presentedMs: performance.now(),
  }));
  const backend = await map
    .locator('canvas[data-flat-runtime="maps"]')
    .getAttribute("data-map-base-renderer");
  await installMixedLayerWork(page, { measure: true });
  await settleFrames(page, 10);
  const memory: HeapSample[] = [await heap("ready")];

  const phases: Record<string, Phase> = {};
  const phase = async (
    name: string,
    action: (flights: FlightObservation[]) => Promise<unknown>,
    remounts = false,
  ) => {
    await settleFrames(page, 4);
    await resetMixedLayerWork(page);
    await resetJourneyTiming(page);
    const rendererBefore = await rendererStats(page);
    const label = `maps:camera-transition:${name}`;
    const started = await page.evaluate((mark) => {
      performance.mark(`${mark}:start`);
      return performance.now();
    }, label);
    const flights: FlightObservation[] = [];
    await action(flights);
    await settleFrames(page, 6);
    const durationMs = await page.evaluate(
      ({ mark, start }) => {
        performance.measure(mark, `${mark}:start`);
        return performance.now() - start;
      },
      { mark: label, start: started },
    );
    const rendererAfter = await rendererStats(page);
    phases[name] = {
      durationMs,
      flights,
      ...(await readJourneyTiming(page)),
      renderer: remounts
        ? null
        : {
            renders: rendererAfter.renders - rendererBefore.renders,
            translatedFrames: rendererAfter.translatedFrames - rendererBefore.translatedFrames,
          },
      runtime: await readMixedLayerWork(page),
    };
  };

  // The same Map View presenting nothing new.
  await phase("idle", () => settleFrames(page, IDLE_FRAMES));

  // A complete out-and-back flight across center, zoom and bearing.
  await phase("flight", async (flights) => {
    flights.push(await flight(page, "paris-berlin", "berlin"));
    flights.push(await flight(page, "berlin-paris", "paris"));
  });

  // Across the antimeridian on the short path, after an instant jump there.
  await phase("dateline", async (flights) => {
    flights.push(await flight(page, "jump-fiji", "fiji", { animate: false }));
    flights.push(await flight(page, "fiji-samoa", "samoa", { durationMs: 1200 }));
    flights.push(await flight(page, "samoa-paris", "paris"));
  });

  // Each command supersedes the flight in progress; the last one completes.
  await phase("successive", async (flights) => {
    const targets: CameraJourneyView[] = ["berlin", "vienna", "rome", "paris"];
    for (const [index, target] of targets.entries()) {
      const last = index === targets.length - 1;
      flights.push(
        await flight(page, `successive-${target}`, target, undefined, last ? null : "next"),
      );
    }
    // A superseded command's frames end where the next command starts.
    for (let index = 0; index < flights.length - 1; index += 1) {
      const superseded = flights[index]!;
      const frames = await page.evaluate(
        ({ from, to }) =>
          window.cameraJourney.trace
            .slice(from, to)
            .filter((entry) => entry.reason === "fly-to")
            .map((entry) => entry.frameTime),
        { from: superseded.traceStart, to: flights[index + 1]!.traceStart },
      );
      superseded.frames = frames.length;
      superseded.presentedMs = frames.length > 0 ? frames.at(-1)! - superseded.commandTime : null;
    }
  });

  // A pointer press ends the flight where it is.
  await phase("pointer-interrupt", async (flights) => {
    flights.push(await flight(page, "interrupted-berlin", "berlin", undefined, "pointer", map));
    flights.push(await flight(page, "resume-paris", "paris"));
  });

  // The Map View resizes mid-flight; the geographic flight continues to its target.
  await phase("resize", async (flights) => {
    flights.push(await flight(page, "resize-berlin", "berlin", undefined, "resize"));
    await page.evaluate(() => window.cameraJourney.setWidth(1280));
    await settleFrames(page, 6);
    flights.push(await flight(page, "resize-paris", "paris"));
  });

  // The instant opt-out: one presented frame per jump.
  await phase("jumps", async (flights) => {
    const targets: CameraJourneyView[] = ["berlin", "paris"];
    for (let index = 0; index < JUMPS; index += 1) {
      const target = targets[index % targets.length]!;
      flights.push(await flight(page, `jump-${index}`, target, { animate: false }));
    }
  });
  memory.push(await heap("after-journey"));

  // Unmounting mid-flight ends it with no later frame; a remount presents the kept camera.
  await phase(
    "teardown",
    async (flights) => {
      for (let cycle = 0; cycle < TEARDOWN_CYCLES; cycle += 1) {
        // Far apart, so each flight is still running when the Map View unmounts.
        const target = (["berlin", "rome", "vienna"] as const)[cycle % 3]!;
        flights.push(await flight(page, `unmount-${cycle + 1}`, target, undefined, "unmount"));
        memory.push(await heap(`unmounted-${cycle + 1}`));
        await page.evaluate(() => window.cameraJourney.setMounted(true));
        await ready(page);
      }
    },
    true,
  );
  memory.push(await heap("remounted"));

  const flights = Object.values(phases).flatMap((entry) => entry.flights);
  const completed = flights.filter((entry) => entry.ending === "completed" && entry.frames > 1);
  return {
    schemaVersion: "maps.camera-transition-journey-observation/v1",
    scenarioId: scenario.id,
    backend,
    // A device loss would move the Map View to the Canvas fallback mid-journey.
    backendAtEnd: await page
      .getByLabel(MAP_LABEL)
      .locator('canvas[data-flat-runtime="maps"]')
      .getAttribute("data-map-base-renderer"),
    viewport: page.viewportSize(),
    load: {
      longTasks: summarizeLongTasks(load.longTasks),
      presentedMs: load.presentedMs,
    },
    phases,
    animatedFlightFramesPerSecond: summarize(
      completed.map((entry) => (entry.frames * 1000) / Math.max(1, entry.presentedMs ?? 1)),
    ),
    maxFlightFrameGapMs: summarize(
      completed.map((entry) => entry.maxFrameGapMs).filter((value) => value !== null),
    ),
    jsHeapAfterGc: memory,
    memory: {
      unavailable: [
        "GPU memory and driver allocations",
        "WASM linear memory growth",
        "total browser process memory",
      ],
    },
    unavailable: [
      "reference/parent comparison: no reference implementation or parent revision runs this journey",
      "GPU completion time (frame intervals are requestAnimationFrame intervals)",
    ],
  };
}

/** The Map View presented its layers. */
function ready(page: Page) {
  return page.waitForFunction(
    () => {
      const element = document.querySelector('[aria-label="Camera transition journey"]');
      const base = element?.querySelector('canvas[data-flat-runtime="maps"]');
      return (
        element?.getAttribute("data-map-ready") === "true" &&
        window.cameraJourney.controller != null &&
        (base?.getAttribute("data-map-base-renderer") === "wgpu" ||
          base?.getAttribute("data-map-base-renderer") === "canvas2d")
      );
    },
    undefined,
    { polling: "raf", timeout: STAGE_TIMEOUT_MS },
  );
}

async function rendererStats(page: Page) {
  const stats = await page.evaluate(() => window.cameraJourney.stats());
  return { renders: stats?.renders ?? 0, translatedFrames: stats?.translatedFrames ?? 0 };
}

/**
 * Issues one flyTo and observes it until it completes, or until `end` interrupts it after
 * INTERRUPT_AFTER_FRAMES presented frames: `next` leaves it for the next command to supersede,
 * `pointer` presses on the Map View, `resize` narrows the Map View and lets it complete,
 * `unmount` unmounts the Map View.
 */
async function flight(
  page: Page,
  label: string,
  target: CameraJourneyView,
  options?: FlyOptions,
  end: "next" | "pointer" | "resize" | "unmount" | null = null,
  map?: Locator,
): Promise<FlightObservation> {
  const start = await page.evaluate(
    ({ options, target }) => {
      const first = window.cameraJourney.trace.length;
      window.cameraJourney.fly(target, options);
      return { commandTime: window.cameraJourney.commandTime, first };
    },
    { options, target },
  );
  const animated = options?.animate !== false && options?.durationMs !== 0;
  let ending: FlightObservation["ending"] = "completed";
  let framesAtEnd: number | null = null;
  if (end && animated) {
    // A software GPU can present fewer frames than that over the whole flight.
    const reached = await page.waitForFunction(
      ({ first, frames }) =>
        window.cameraJourney.trace.slice(first).filter((entry) => entry.reason === "fly-to")
          .length >= frames ||
        document
          .querySelector(
            '[aria-label="Camera transition journey"] canvas[data-flat-runtime="maps"]',
          )
          ?.getAttribute("data-map-camera-transition") !== "fly-to",
      { first: start.first, frames: end === "resize" ? 3 : INTERRUPT_AFTER_FRAMES },
      { polling: "raf", timeout: STAGE_TIMEOUT_MS },
    );
    await reached.dispose();
    const flying = await page.evaluate(
      () =>
        document
          .querySelector(
            '[aria-label="Camera transition journey"] canvas[data-flat-runtime="maps"]',
          )
          ?.getAttribute("data-map-camera-transition") === "fly-to",
    );
    if (!flying) {
      if (end === "unmount") await page.evaluate(() => window.cameraJourney.setMounted(false));
      return observe(page, label, target, start, "completed", null);
    }
    if (end === "pointer") {
      const box = (await map!.boundingBox())!;
      await page.mouse.move(box.x + 60, box.y + 60);
      await page.mouse.down();
      const length = await page.evaluate(() => window.cameraJourney.pointerDownTraceLength!);
      framesAtEnd = await flightFrames(page, start.first, length);
      ending = "pointer";
    } else if (end === "unmount") {
      const length = await page.evaluate(() => window.cameraJourney.setMounted(false));
      framesAtEnd = await flightFrames(page, start.first, length);
      ending = "unmounted";
    } else if (end === "resize") {
      await page.evaluate(() => window.cameraJourney.setWidth(1000));
    } else {
      return observe(page, label, target, start, "superseded", null);
    }
  }
  if (!animated) {
    // The jump presents one frame on the next animation frame.
    await page.waitForFunction((first) => window.cameraJourney.trace.length > first, start.first, {
      polling: "raf",
      timeout: STAGE_TIMEOUT_MS,
    });
    await settleFrames(page, 4);
  } else if (ending === "completed") {
    await page.waitForFunction(
      () =>
        document
          .querySelector(
            '[aria-label="Camera transition journey"] canvas[data-flat-runtime="maps"]',
          )
          ?.getAttribute("data-map-camera-transition") !== "fly-to",
      undefined,
      { polling: "raf", timeout: STAGE_TIMEOUT_MS },
    );
  } else {
    await settleFrames(page, 20);
  }
  if (end === "pointer") await page.mouse.up();
  return observe(page, label, target, start, ending, framesAtEnd);
}

function flightFrames(page: Page, first: number, end: number) {
  return page.evaluate(
    ({ from, to }) =>
      window.cameraJourney.trace.slice(from, to).filter((entry) => entry.reason === "fly-to")
        .length,
    { from: first, to: end },
  );
}

async function observe(
  page: Page,
  label: string,
  target: CameraJourneyView,
  start: { commandTime: number; first: number },
  ending: FlightObservation["ending"],
  framesAtEnd: number | null,
): Promise<FlightObservation> {
  const { frames, targetView } = await page.evaluate(
    ({ first, target }) => ({
      frames: window.cameraJourney.trace.slice(first).filter((entry) => entry.reason === "fly-to"),
      targetView: window.cameraJourney.targets[target],
    }),
    { first: start.first, target },
  );
  let maxFrameGapMs: number | null = null;
  let previous = start.commandTime;
  for (const entry of frames) {
    maxFrameGapMs = Math.max(maxFrameGapMs ?? 0, entry.frameTime - previous);
    previous = entry.frameTime;
  }
  const last = frames.at(-1)?.viewState;
  const endedOnTarget =
    last !== undefined &&
    Math.abs(last.center[0] - targetView.center[0]) < 1e-9 &&
    Math.abs(last.center[1] - targetView.center[1]) < 1e-9 &&
    Math.abs(last.zoom - targetView.zoom) < 1e-9 &&
    Math.abs((last.bearing ?? 0) - (targetView.bearing ?? 0)) < 1e-9;
  return {
    label,
    target,
    frames: framesAtEnd ?? frames.length,
    presentedMs: frames.length > 0 ? frames.at(-1)!.frameTime - start.commandTime : null,
    maxFrameGapMs,
    endedOnTarget,
    lastViewState: last ?? null,
    ending,
    framesAfterEnd: framesAtEnd === null ? 0 : frames.length - framesAtEnd,
    commandTime: start.commandTime,
    traceStart: start.first,
  };
}
