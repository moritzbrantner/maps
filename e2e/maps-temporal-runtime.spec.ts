import { expect, test, type Page } from "@playwright/test";

import {
  TEMPORAL_ACCEPTANCE_ANTIMERIDIAN_TRACKS,
  TEMPORAL_ACCEPTANCE_REPLACEMENT_TRACKS,
  TEMPORAL_ACCEPTANCE_TRACKS,
} from "../demo/temporal-acceptance-data";
import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
} from "./helpers/mixed-layer-work";

const MAP_LABEL = "Maps temporal runtime acceptance";
const VIEW_STATE = { center: [13, 52] as [number, number], zoom: 6 };
const ANTIMERIDIAN_VIEW_STATE = { center: [178, 10] as [number, number], zoom: 6 };

/** Linear keyframe interpolation of the acceptance tracks (two keyframes each). */
function trackPosition(
  trackId: string,
  time: number,
  tracks = TEMPORAL_ACCEPTANCE_TRACKS,
): [number, number] {
  const [from, to] = tracks.find((track) => track.id === trackId)!.frames;
  const progress = (time - from!.time) / (to!.time - from!.time);
  return [
    from!.longitude + (to!.longitude - from!.longitude) * progress,
    from!.latitude + (to!.latitude - from!.latitude) * progress,
  ];
}

function projectWebMercator([longitude, latitude]: [number, number]) {
  const radians = (latitude * Math.PI) / 180;
  return {
    x: (longitude + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  };
}

async function clientPosition(page: Page, coordinate: [number, number], viewState = VIEW_STATE) {
  const overlay = page.getByLabel(MAP_LABEL).locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = (await overlay.boundingBox())!;
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(viewState.center);
  const worldSize = 512 * 2 ** viewState.zoom;
  return {
    x: bounds.x + bounds.width / 2 + (target.x - center.x) * worldSize,
    y: bounds.y + bounds.height / 2 + (target.y - center.y) * worldSize,
  };
}

function clock(page: Page, action: "pause" | "play") {
  return page.evaluate((name) => window.mapsTemporalAcceptance!.clock[name](), action);
}

async function seek(page: Page, time: number) {
  await page.getByRole("slider", { name: "Acceptance timeline" }).fill(String(time));
  await expect(page.getByTestId("temporal-runtime-time")).toHaveText(String(time));
}

// #172 Developed: moving tracks over static regions on the first-party runtime, one clock.
test("temporal points play, pause and seek over static regions on the Maps runtime @smoke", async ({
  page,
}) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-temporal");

  const map = page.getByLabel(MAP_LABEL);
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const time = page.getByTestId("temporal-runtime-time");
  const selection = page.getByTestId("temporal-runtime-selection");
  const popup = page.getByTestId("temporal-runtime-popup");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(map.locator('canvas[data-flat-runtime="maps"]')).toBeVisible();
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", /^(wgpu|canvas2d)$/);
  const primitives = await overlay.getAttribute("data-map-overlay-primitives");
  expect(Number(primitives)).toBeGreaterThanOrEqual(3);
  // Rust/WASM samples the moving tracks picked below.
  await expect(page.getByTestId("temporal-runtime-sampler")).toHaveText("ready");

  // Select a moving Map Feature at a seeked time through first-party picking.
  await seek(page, 30);
  const selected = await clientPosition(page, trackPosition("courier-north", 30));
  await page.mouse.click(selected.x, selected.y);
  await expect(selection).toHaveText("courier-north");
  await expect(popup).toHaveText("Selected Courier north");

  await installMixedLayerWork(page);
  await settleFrames(page);
  await resetMixedLayerWork(page);

  // Play: the one map-scoped clock advances; selection survives every sampled frame.
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("temporal-runtime-playing")).toHaveText("playing");
  await expect.poll(async () => Number(await time.textContent())).toBeGreaterThan(32);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("temporal-runtime-playing")).toHaveText("paused");
  const pausedAt = Number(await time.textContent());
  await settleFrames(page, 8);
  expect(Number(await time.textContent())).toBe(pausedAt);
  await expect(selection).toHaveText("courier-north");

  // Backward seek, then resume and pause again.
  await seek(page, 10);
  await clock(page, "play");
  await expect.poll(async () => Number(await time.textContent())).toBeGreaterThan(12);
  await clock(page, "pause");
  await seek(page, 60);
  await expect(selection).toHaveText("courier-north");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", primitives!);

  // The moving feature is picked where the sampler places it at the new time.
  await page.keyboard.press("Escape");
  const moved = await clientPosition(page, trackPosition("courier-north", 60));
  await page.mouse.click(moved.x, moved.y);
  await expect(selection).toHaveText("courier-north");
  await expect(popup).toHaveText("Selected Courier north");

  // Changing only time keeps static regions and runtime resources retained.
  const work = await readMixedLayerWork(page);
  expect({
    freed: work.freedRuntimes + work.freedRenderers,
    polygonWrites: work.retainedPolygonSets + work.retainedPolygonUpdates,
    tileUploads: work.tileUploads,
  }).toEqual({ freed: 0, polygonWrites: 0, tileUploads: 0 });
  // ...while the moving points did repaint (the counters are live).
  expect(work.gpuFrames + work.canvasOverlayRedraws).toBeGreaterThan(0);

  // The static region is still drawn and pickable after playback.
  const region = await clientPosition(page, [13, 51.7]);
  await page.mouse.click(region.x, region.y);
  await expect(page.getByTestId("temporal-runtime-region")).toHaveText("static-region");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

// #172 Correct: the Rust/WASM sampler the Map View uses matches the independent reference.
test("the Rust temporal sampler matches the reference sampler over the edge sequence @smoke", async ({
  page,
}) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-temporal");

  await expect(page.getByTestId("temporal-runtime-sampler")).toHaveText("ready");
  const parity = await page.evaluate(() => window.mapsTemporalAcceptance!.sampleEdgeSequence());
  expect(parity).toEqual({ mismatches: [], sampler: "ready", steps: 30 });
});

// #172 Correct: a source change keeps the one map-scoped time, playback and selection.
test("replacing the temporal source keeps time, playback and selection on the Maps runtime @smoke", async ({
  page,
}) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-temporal");

  const map = page.getByLabel(MAP_LABEL);
  const time = page.getByTestId("temporal-runtime-time");
  const selection = page.getByTestId("temporal-runtime-selection");
  const source = page.getByTestId("temporal-runtime-source");
  const replaceSource = page.getByRole("button", { name: "Replace source" });
  const pick = async (trackId: string, tracks = TEMPORAL_ACCEPTANCE_TRACKS) => {
    const position = await clientPosition(page, trackPosition(trackId, 60, tracks));
    await page.mouse.click(position.x, position.y);
  };

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");

  await seek(page, 60);
  await pick("courier-north");
  await expect(selection).toHaveText("courier-north");

  await installMixedLayerWork(page);
  await settleFrames(page);
  await resetMixedLayerWork(page);

  // Same time, new source: the selected track is kept and drawn on its new route.
  await replaceSource.click();
  await expect(source).toHaveText("replacement");
  await expect(time).toHaveText("60");
  await expect(selection).toHaveText("courier-north");
  await settleFrames(page);

  // The admitted track is pickable where the new source places it at this time...
  await pick("courier-east", TEMPORAL_ACCEPTANCE_REPLACEMENT_TRACKS);
  await expect(selection).toHaveText("courier-east");
  // ...the surviving track is picked on its new route, not where the old source had it...
  await pick("courier-north");
  await expect(selection).not.toHaveText("courier-north");
  await pick("courier-north", TEMPORAL_ACCEPTANCE_REPLACEMENT_TRACKS);
  await expect(selection).toHaveText("courier-north");
  // ...and the removed track is gone.
  await pick("courier-south");
  await expect(selection).not.toHaveText("courier-south");

  // Replacing moving tracks leaves the static region and the runtime resources retained.
  const work = await readMixedLayerWork(page);
  expect({
    freed: work.freedRuntimes + work.freedRenderers,
    polygonWrites: work.retainedPolygonSets + work.retainedPolygonUpdates,
    tileUploads: work.tileUploads,
  }).toEqual({ freed: 0, polygonWrites: 0, tileUploads: 0 });

  // A time the shorter source does not cover is sampled at its end and kept for the old source.
  await replaceSource.click();
  await expect(source).toHaveText("initial");
  await seek(page, 95);
  await replaceSource.click();
  await expect(time).toHaveText("80");
  await replaceSource.click();
  await expect(time).toHaveText("95");

  // Replacing the source while playing keeps the clock playing.
  await seek(page, 30);
  await clock(page, "play");
  await replaceSource.click();
  await expect(source).toHaveText("replacement");
  await expect(page.getByTestId("temporal-runtime-playing")).toHaveText("playing");
  await expect.poll(async () => Number(await time.textContent())).toBeGreaterThan(32);
  await clock(page, "pause");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

// #172 Correct: world wrapping. A track supplied with unwrapped longitudes moves continuously
// across the antimeridian and is picked where it is drawn on both sides of it.
test("a moving feature crosses the antimeridian on the Maps runtime @smoke", async ({ page }) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-temporal&scene=antimeridian");

  const map = page.getByLabel(MAP_LABEL);
  const selection = page.getByTestId("temporal-runtime-selection");
  const popup = page.getByTestId("temporal-runtime-popup");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");

  // 177° (before), 180° (on) and 183° (after the antimeridian, i.e. 177°W).
  for (const sampledTime of [25, 50, 75]) {
    await seek(page, sampledTime);
    await settleFrames(page);

    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);

    const feature = await clientPosition(
      page,
      trackPosition("ferry-east", sampledTime, TEMPORAL_ACCEPTANCE_ANTIMERIDIAN_TRACKS),
      ANTIMERIDIAN_VIEW_STATE,
    );
    await page.mouse.click(feature.x, feature.y);
    await expect(selection).toHaveText("ferry-east");
    await expect(popup).toHaveText("Selected Ferry east");
  }
});

