import { expect, test, type Page } from "@playwright/test";

import type { MapScopedTimelineSnapshot } from "../src/map-scoped-timeline";
import type { TemporalPlaybackWork, TemporalWorkTotals } from "../src/temporal-work";
import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
} from "./helpers/mixed-layer-work";
import { TEMPORAL_JOURNEY_TRACK_COUNT } from "./fixtures/temporal-playback-workloads";

declare global {
  interface Window {
    temporalJourney: {
      clock: {
        getSnapshot(): MapScopedTimelineSnapshot;
        pause(): void;
        play(): void;
        seek(time: number): void;
      };
      commitUnrelated(): void;
      controller: {
        getViewState(): { center: [number, number]; zoom: number };
        setViewState(viewState: { center: [number, number]; zoom: number }): void;
      } | null;
      replaceSource(variant: number): void;
      runtimeStatus(): string;
      setMounted(mounted: boolean): void;
      totals(): TemporalWorkTotals;
    };
  }
}

const MAP_LABEL = "Temporal playback journey";

function playback(page: Page) {
  return page.evaluate(() => window.temporalJourney.totals().playback);
}

function since(before: TemporalPlaybackWork, after: TemporalPlaybackWork) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [
      key,
      after[key as keyof TemporalPlaybackWork] - before[key as keyof TemporalPlaybackWork],
    ]),
  ) as TemporalPlaybackWork;
}

/*
 * The work contract of `temporal-playback-journey-v1` (#172 phase E) on every browser run:
 * 2,000 moving tracks sampled by Rust/WASM from one Map-Scoped Timeline over static regions.
 * Frame timing is captured by `verify:engine-temporal-evidence`.
 */
test("temporal playback journey: time changes only sample, camera and unrelated commits do no temporal work", async ({
  page,
}) => {
  test.slow();
  await page.goto("/e2e/fixtures/temporal-playback-journey.html");
  const map = page.getByLabel(MAP_LABEL);
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(page.getByTestId("temporal-journey-sampler")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.temporalJourney.totals().playback.rustTrackPreparations))
    .toBe(1);

  // Load: the TypeScript reference until Rust is ready, then Rust once; loading itself
  // (idle → loading) re-prepares nothing.
  const load = await playback(page);
  expect(load.trackPreparations).toBe(2);
  expect(load.preparedTracks).toBe(2 * TEMPORAL_JOURNEY_TRACK_COUNT);

  await installMixedLayerWork(page);
  await settleFrames(page);

  // Camera only, paused: no preparation, no sample.
  await resetMixedLayerWork(page);
  let before = await playback(page);
  for (const center of [
    [11, 50.5],
    [12, 51],
    [10, 50],
  ] as [number, number][]) {
    await page.evaluate((view) => window.temporalJourney.controller!.setViewState(view), {
      center,
      zoom: 4.6,
    });
    await settleFrames(page, 4);
  }
  expect(since(before, await playback(page))).toMatchObject({ samples: 0, trackPreparations: 0 });
  let runtime = await readMixedLayerWork(page);
  expect(runtime.temporalSamples).toBe(0);
  expect(runtime.framePlans).toBeGreaterThan(0);

  // Playback: one Rust sample per advanced time; nothing prepared, static regions retained.
  await resetMixedLayerWork(page);
  before = await playback(page);
  await page.evaluate(() => window.temporalJourney.clock.play());
  await settleFrames(page, 30);
  await page.evaluate(() => window.temporalJourney.clock.pause());
  await settleFrames(page, 4);
  const played = since(before, await playback(page));
  runtime = await readMixedLayerWork(page);
  expect(played.trackPreparations).toBe(0);
  expect(played.samples).toBeGreaterThan(10);
  expect(played.sampledTracks).toBe(played.samples * TEMPORAL_JOURNEY_TRACK_COUNT);
  expect(played.changedFeatures).toBeGreaterThan(0);
  expect(played.bridgeBytesToWasm).toBe(0);
  expect(played.bridgeBytesFromWasm).toBe(played.samples * TEMPORAL_JOURNEY_TRACK_COUNT * 6 * 8);
  expect(runtime.temporalSamples).toBe(played.samples);
  expect({
    freed: runtime.freedRuntimes + runtime.freedRenderers,
    polygonWrites: runtime.retainedPolygonSets + runtime.retainedPolygonUpdates,
    tileUploads: runtime.tileUploads,
  }).toEqual({ freed: 0, polygonWrites: 0, tileUploads: 0 });
  expect(runtime.gpuFrames + runtime.canvasOverlayRedraws).toBeGreaterThan(0);

  // Seeks: one sample each.
  before = await playback(page);
  for (const time of [800, 200, 650, 50]) {
    await page.evaluate((value) => window.temporalJourney.clock.seek(value), time);
    await settleFrames(page, 2);
  }
  expect(since(before, await playback(page))).toMatchObject({ samples: 4, trackPreparations: 0 });

  // Unrelated commits at a fixed time: nothing sampled.
  before = await playback(page);
  for (let commit = 0; commit < 5; commit += 1) {
    await page.evaluate(() => window.temporalJourney.commitUnrelated());
    await settleFrames(page, 2);
  }
  expect(since(before, await playback(page))).toMatchObject({ samples: 0, trackPreparations: 0 });

  // Source replacement: one Rust preparation and one sample, static regions retained.
  await resetMixedLayerWork(page);
  before = await playback(page);
  await page.evaluate(() => window.temporalJourney.replaceSource(1));
  await settleFrames(page, 4);
  expect(since(before, await playback(page))).toMatchObject({
    rustTrackPreparations: 1,
    samples: 1,
    trackPreparations: 1,
  });
  runtime = await readMixedLayerWork(page);
  expect(runtime.retainedPolygonSets + runtime.retainedPolygonUpdates).toBe(0);

  // Remounting the Map View keeps the authoritative time and samples it once: the clock's
  // placeholder time before the remounted map registers its range is not sampled, and the
  // empty first frame builds an empty aggregation index.
  const time = await page.evaluate(() => window.temporalJourney.clock.getSnapshot().activeTime);
  await page.evaluate(() => window.temporalJourney.setMounted(false));
  await settleFrames(page, 2);
  before = await playback(page);
  await page.evaluate(() => window.temporalJourney.setMounted(true));
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await settleFrames(page, 4);
  expect(since(before, await playback(page))).toMatchObject({
    rustTrackPreparations: 1,
    samples: 1,
    trackPreparations: 1,
  });
  expect(await page.evaluate(() => window.temporalJourney.clock.getSnapshot().activeTime)).toBe(
    time,
  );
});
