import { expect, test } from "@playwright/test";

import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
} from "./helpers/mixed-layer-work";
import { WEBGPU_SWIFTSHADER_ARGS } from "./helpers/webgpu-args";

/*
 * The per-frame work contract of `camera-transition-journey-v1` (#433, Fast) on every browser
 * run: a controlled Map View over 2,000 points and a static polygon grid flies Paris → Berlin
 * with one Rust frame plan and at most one base render per animation frame, although tiles
 * arrive and fade in during the flight and React echoes every frame; no Map Layer is
 * re-lowered. Frame timing is captured by `verify:engine-camera-transition-evidence`.
 */

test.use({ launchOptions: { args: [...WEBGPU_SWIFTSHADER_ARGS] } });

type Stats = { renders: number } | null;

declare global {
  interface Window {
    cameraJourney: {
      fly(view: string, options?: { animate?: boolean; durationMs?: number }): void;
      stats(): Stats;
      trace: {
        reason: string;
        viewState: { bearing?: number; center: [number, number]; zoom: number };
      }[];
    };
  }
}

for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`camera transition journey: a flight plans and renders once per animation frame on ${backend} @smoke`, async ({
    page,
  }) => {
    test.slow();
    if (backend === "canvas2d") {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "gpu", {
          configurable: true,
          get: () => undefined,
        });
      });
    }
    await page.goto("/e2e/fixtures/camera-transition-journey.html");
    const map = page.getByLabel("Camera transition journey");
    const canvas = map.locator('canvas[data-flat-runtime="maps"]');
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(canvas).toHaveAttribute("data-map-base-renderer", backend);
    await installMixedLayerWork(page);
    await settleFrames(page, 10);

    await resetMixedLayerWork(page);
    const before = await page.evaluate(() => ({
      renders: window.cameraJourney.stats()!.renders,
      trace: window.cameraJourney.trace.length,
    }));
    // Count the animation frames the flight spans, from the command to its last frame, and
    // read the work counters in that last frame.
    const flight = await page.evaluate(
      () =>
        new Promise<{ animationFrames: number; framePlans: number; renders: number }>((resolve) => {
          const counters = (
            window as unknown as { mapsMixedLayerWork: { counters: Record<string, number> } }
          ).mapsMixedLayerWork.counters;
          let count = 0;
          const tick = () => {
            count += 1;
            const flying =
              document
                .querySelector('canvas[data-flat-runtime="maps"]')
                ?.getAttribute("data-map-camera-transition") === "fly-to";
            if (flying) requestAnimationFrame(tick);
            else
              resolve({
                animationFrames: count,
                framePlans: counters.framePlans!,
                renders: window.cameraJourney.stats()!.renders,
              });
          };
          window.cameraJourney.fly("berlin");
          requestAnimationFrame(tick);
        }),
    );
    const { animationFrames } = flight;
    await settleFrames(page, 2);
    const work = await readMixedLayerWork(page);
    const after = await page.evaluate(
      (from) => ({
        flight: window.cameraJourney.trace.slice(from).filter((entry) => entry.reason === "fly-to"),
      }),
      before.trace,
    );
    test.info().annotations.push({
      description: JSON.stringify({
        animationFrames,
        backend,
        flightFrames: after.flight.length,
        framePlans: flight.framePlans,
        renders: flight.renders - before.renders,
        tileUploads: work.tileUploads,
      }),
      type: "camera-transition-work",
    });

    expect(after.flight.length).toBeGreaterThan(3);
    expect(after.flight.at(-1)!.viewState).toMatchObject({
      bearing: 40,
      center: [13.405, 52.52],
      zoom: 9,
    });
    // One plan per presented frame; tile arrivals and fade-ins join the flight's frames.
    expect(flight.framePlans).toBeLessThanOrEqual(animationFrames);
    expect(flight.renders - before.renders).toBeLessThanOrEqual(animationFrames);
    // Camera frames never re-lower the retained points or polygons.
    expect(work.retainedPointSets + work.retainedPolygonSets).toBe(0);
    expect(work.retainedPointUpdates + work.retainedPolygonUpdates).toBe(0);
    expect(work.freedRuntimes + work.freedRenderers).toBe(0);
  });
}
