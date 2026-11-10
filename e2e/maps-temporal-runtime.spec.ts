import { expect, test, type Page } from "@playwright/test";

import { TEMPORAL_ACCEPTANCE_TRACKS } from "../demo/temporal-acceptance-data";
import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
} from "./helpers/mixed-layer-work";

const MAP_LABEL = "Maps temporal runtime acceptance";
const VIEW_STATE = { center: [13, 52] as [number, number], zoom: 6 };

/** Linear keyframe interpolation of the acceptance tracks (two keyframes each). */
function trackPosition(trackId: string, time: number): [number, number] {
  const [from, to] = TEMPORAL_ACCEPTANCE_TRACKS.find((track) => track.id === trackId)!.frames;
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

async function clientPosition(page: Page, coordinate: [number, number]) {
  const overlay = page.getByLabel(MAP_LABEL).locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = (await overlay.boundingBox())!;
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(VIEW_STATE.center);
  const worldSize = 512 * 2 ** VIEW_STATE.zoom;
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
