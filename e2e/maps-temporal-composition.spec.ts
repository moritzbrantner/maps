import { expect, test, type Locator, type Page } from "@playwright/test";

import { TEMPORAL_COMPOSITION_TRACKS } from "../demo/temporal-acceptance-data";
import {
  installMixedLayerWork,
  readMixedLayerWork,
  resetMixedLayerWork,
  settleFrames,
} from "./helpers/mixed-layer-work";

/*
 * #172 phase D: temporal clustering and heat composed over static regions on the first-party
 * Flat Map, both sampled from one shared Map-Scoped Timeline clock.
 */

const URL =
  "/demo-reference/?e2e=1&acceptance=maps-runtime-temporal-composition";
const VIEW_STATE = { center: [13, 52] as [number, number], zoom: 6 };

/** Linear keyframe interpolation of the composition tracks (two keyframes each). */
function trackPosition(trackId: string, time: number): [number, number] {
  const [from, to] = TEMPORAL_COMPOSITION_TRACKS.find(
    (track) => track.id === trackId,
  )!.frames;
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

async function clientPosition(map: Locator, coordinate: [number, number]) {
  // Seeking scrolls the timeline into view; bring the Map View back before pointing at it.
  await map.scrollIntoViewIfNeeded();
  const bounds = (await map
    .locator('canvas[data-map-overlay-runtime="maps"]')
    .boundingBox())!;
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(VIEW_STATE.center);
  const worldSize = 512 * 2 ** VIEW_STATE.zoom;
  return {
    x: bounds.x + bounds.width / 2 + (target.x - center.x) * worldSize,
    y: bounds.y + bounds.height / 2 + (target.y - center.y) * worldSize,
  };
}

function clock(page: Page, action: "pause" | "play") {
  return page.evaluate(
    (name) => window.mapsTemporalComposition!.clock[name](),
    action,
  );
}

async function seek(page: Page, time: number) {
  await page
    .getByRole("slider", { name: "Composition timeline" })
    .fill(String(time));
  await expect(page.getByTestId("temporal-composition-time")).toHaveText(
    String(time),
  );
}

/** Cluster summary of the Map View equals clustering the independently sampled couriers. */
async function expectClustersMatchOracle(page: Page, time: number) {
  const clusters = page.getByTestId("temporal-composition-clusters");
  await expect
    .poll(async () => {
      const expected = await page.evaluate(
        (sampled) => window.mapsTemporalComposition!.expectedClusters(sampled),
        time,
      );
      const actual = await clusters.textContent();
      return actual === JSON.stringify(expected)
        ? "match"
        : `${actual} != ${JSON.stringify(expected)}`;
    })
    .toBe("match");
  return JSON.parse((await clusters.textContent())!) as {
    visibleClusterCount: number;
    visiblePointCount: number;
  };
}

/** A screenshot of the Map View once two consecutive frames are identical. */
async function settledPixels(page: Page, map: Locator) {
  let previous = await map.screenshot();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await settleFrames(page, 4);
    const next = await map.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error("Map View did not settle");
}

async function openComposition(page: Page) {
  await page.goto(URL);
  const clusters = page.getByLabel("Temporal clusters");
  const heat = page.getByLabel("Temporal heat");
  for (const map of [clusters, heat]) {
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(map).toHaveAttribute("data-map-runtime", "maps");
    await expect(map.locator('canvas[data-flat-runtime="maps"]')).toBeVisible();
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  }
  return { clusters, heat };
}

test("temporal clusters and heat play, pause and seek over static regions on the Maps runtime @smoke", async ({
  page,
}) => {
  const { clusters, heat } = await openComposition(page);
  const time = page.getByTestId("temporal-composition-time");
  const selection = page.getByTestId("temporal-composition-selection");
  const popup = page.getByTestId("temporal-composition-popup");

  // The heat Map Layer draws its density surface on the first-party overlay.
  await seek(page, 25);
  await expect(
    heat.locator('canvas[data-map-overlay-runtime="maps"]'),
  ).toHaveAttribute("data-map-overlay-heat-layers", "1");

  // Clustering at the map-scoped time matches the independent sampler: the converging couriers
  // are separate, one cluster, then separate again with the late courier admitted.
  expect(await expectClustersMatchOracle(page, 25)).toMatchObject({
    visibleClusterCount: 0,
    visiblePointCount: 3,
  });
  await seek(page, 75);
  expect(await expectClustersMatchOracle(page, 75)).toMatchObject({
    visiblePointCount: 4,
  });
  await seek(page, 50);
  expect(await expectClustersMatchOracle(page, 50)).toMatchObject({
    visibleClusterCount: 1,
    visiblePointCount: 3,
  });

  // Select a moving courier while it is separate.
  await seek(page, 25);
  const west = await clientPosition(
    clusters,
    trackPosition("courier-west", 25),
  );
  await page.mouse.click(west.x, west.y);
  await expect(selection).toHaveText("courier-west");
  await expect(popup).toHaveText("Selected Courier west");

  await installMixedLayerWork(page);
  await settleFrames(page);
  await resetMixedLayerWork(page);

  // Play through the meeting: one clock drives both Map Views; selection survives clustering.
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("temporal-composition-playing")).toHaveText(
    "playing",
  );
  await expect
    .poll(async () => Number(await time.textContent()))
    .toBeGreaterThan(55);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("temporal-composition-playing")).toHaveText(
    "paused",
  );
  const pausedAt = Number(await time.textContent());
  await settleFrames(page, 8);
  expect(Number(await time.textContent())).toBe(pausedAt);
  await expect(selection).toHaveText("courier-west");
  await expectClustersMatchOracle(page, pausedAt);

  // Backward seek, resume, pause, then seek past the meeting.
  await seek(page, 10);
  await clock(page, "play");
  await expect
    .poll(async () => Number(await time.textContent()))
    .toBeGreaterThan(12);
  await clock(page, "pause");
  await seek(page, 75);
  await expect(selection).toHaveText("courier-west");
  await expectClustersMatchOracle(page, 75);

  // The courier is picked where the sampler places it after leaving the cluster.
  await page.keyboard.press("Escape");
  const moved = await clientPosition(
    clusters,
    trackPosition("courier-west", 75),
  );
  await page.mouse.click(moved.x, moved.y);
  await expect(selection).toHaveText("courier-west");
  await expect(popup).toHaveText("Selected Courier west");

  // Changing only time keeps static regions and runtime resources retained in both Map Views.
  const work = await readMixedLayerWork(page);
  expect({
    freed: work.freedRuntimes + work.freedRenderers,
    polygonWrites: work.retainedPolygonSets + work.retainedPolygonUpdates,
    tileUploads: work.tileUploads,
  }).toEqual({ freed: 0, polygonWrites: 0, tileUploads: 0 });
  expect(work.gpuFrames + work.canvasOverlayRedraws).toBeGreaterThan(0);

  // The static region is still drawn and pickable after playback.
  const region = await clientPosition(clusters, [11.2, 52.9]);
  await page.mouse.click(region.x, region.y);
  await expect(page.getByTestId("temporal-composition-region")).toHaveText(
    "static-region",
  );

  // The cluster is picked where the couriers meet (picking it then expands the camera).
  await seek(page, 50);
  await expectClustersMatchOracle(page, 50);
  const meeting = await clientPosition(
    clusters,
    trackPosition("courier-west", 50),
  );
  await page.mouse.click(meeting.x, meeting.y);
  await expect(popup).toHaveText("Cluster 3");
  for (const map of [clusters, heat]) {
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  }
});

// #172 Correct: at the same timestamp, direct seek, playback then seek, and a burst of seeks
// that ends on it present identical cluster and heat pixels; no older time's result remains.
for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`temporal clusters and heat present the same pixels at the same time on every path on ${backend} @smoke`, async ({
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
    const { clusters, heat } = await openComposition(page);
    for (const map of [clusters, heat]) {
      await expect(
        map.locator('canvas[data-map-overlay-runtime="maps"]'),
      ).toHaveAttribute("data-map-overlay-backend", backend);
    }

    await seek(page, 40);
    await expectClustersMatchOracle(page, 40);
    const direct = {
      clusters: await settledPixels(page, clusters),
      heat: await settledPixels(page, heat),
    };

    // Another time looks different (the Map Views are live, not frozen).
    await seek(page, 90);
    await expectClustersMatchOracle(page, 90);
    expect((await settledPixels(page, heat)).equals(direct.heat)).toBe(false);
    expect((await settledPixels(page, clusters)).equals(direct.clusters)).toBe(
      false,
    );

    // Forward playback past the time, pause, seek back to it.
    await seek(page, 0);
    await clock(page, "play");
    await expect
      .poll(async () =>
        Number(
          await page.getByTestId("temporal-composition-time").textContent(),
        ),
      )
      .toBeGreaterThan(45);
    await clock(page, "pause");
    await seek(page, 40);
    await expectClustersMatchOracle(page, 40);
    expect((await settledPixels(page, heat)).equals(direct.heat)).toBe(true);
    expect((await settledPixels(page, clusters)).equals(direct.clusters)).toBe(
      true,
    );

    // A burst of seeks without waiting: only the newest time is presented.
    await page.evaluate(() => {
      const { clock: timeline } = window.mapsTemporalComposition!;
      for (const sampled of [100, 70, 10, 55, 40]) timeline.seek(sampled);
    });
    await expect(page.getByTestId("temporal-composition-time")).toHaveText(
      "40",
    );
    await expectClustersMatchOracle(page, 40);
    expect((await settledPixels(page, heat)).equals(direct.heat)).toBe(true);
    expect((await settledPixels(page, clusters)).equals(direct.clusters)).toBe(
      true,
    );
  });
}
