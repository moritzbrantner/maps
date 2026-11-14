import { expect, test, type Page } from "@playwright/test";

import { maplibreDefaultEasing, maplibreFlyTo } from "./helpers/maplibre-flyto-oracle";

// Animated first-party flyTo (#433) through the real Rust/WASM runtime: the presented
// trajectory follows MapLibre's flyTo, `onViewStateChange` reports every presented frame,
// layers stay aligned and pickable after the flight, user input interrupts it, and the Canvas
// fallback presents the same flight.

type TraceEntry = {
  reason: string;
  time: number;
  viewState: { bearing?: number; center: [number, number]; pitch?: number; zoom: number };
};
type Stats = { renders: number; retainedPointPreparations?: number } | null;

const PARIS = { bearing: 0, center: [2.3522, 48.8566] as [number, number], pitch: 0, zoom: 7 };
const BERLIN = { bearing: 40, center: [13.405, 52.52] as [number, number], pitch: 0, zoom: 9 };

for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`Maps-owned flyTo animates MapLibre's trajectory on ${backend} @smoke`, async ({
    page,
  }) => {
    if (backend === "canvas2d") {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "gpu", {
          configurable: true,
          get: () => undefined,
        });
      });
    }
    await page.goto("/demo-reference/?acceptance=maps-runtime-flyto");

    const map = page.getByLabel("Maps flyTo Rust runtime acceptance");
    const canvas = map.locator('canvas[data-flat-runtime="maps"]');
    const viewState = page.getByTestId("maps-flyto-view-state");
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(map).toHaveAttribute("data-map-runtime", "maps");
    await expect(canvas).toHaveAttribute("data-map-base-renderer", backend);
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
    await expect(viewState).toContainText("2.35220,48.85660 | zoom 7.00000 | bearing 0.00000");
    const size = await map.evaluate((element) => ({
      height: element.clientHeight,
      width: element.clientWidth,
    }));

    // --- An animated flight across center, zoom and bearing.
    await clearTrace(page);
    const before = await stats(page);
    await page.getByRole("button", { name: "Fly to Berlin" }).click();
    await expect(canvas).toHaveAttribute("data-map-camera-transition", "fly-to");
    await expect(canvas).not.toHaveAttribute("data-map-camera-transition", "fly-to", {
      timeout: 15_000,
    });
    await expect(viewState).toContainText("13.40500,52.52000 | zoom 9.00000 | bearing 40.00000");
    const flight = await trace(page);
    const after = await stats(page);

    const oracle = maplibreFlyTo(PARIS, BERLIN, size);
    // Software-GPU runners present few frames; the trajectory is still checked per frame.
    expect(flight.length).toBeGreaterThan(3);
    expect(flight.every((entry) => entry.reason === "fly-to")).toBe(true);
    let lowestZoom = Number.POSITIVE_INFINITY;
    let previousBearing = 0;
    for (const entry of flight) {
      // Bearing is linear in the eased progress k: recover k and compare the presented
      // center/zoom with MapLibre's camera at the same k.
      const bearing = entry.viewState.bearing ?? 0;
      expect(bearing).toBeGreaterThanOrEqual(previousBearing);
      previousBearing = bearing;
      const expected = oracle.at(bearing / oracle.bearing);
      expect(Math.abs(entry.viewState.center[0] - expected.center[0])).toBeLessThan(1e-6);
      expect(Math.abs(entry.viewState.center[1] - expected.center[1])).toBeLessThan(1e-6);
      expect(Math.abs(entry.viewState.zoom - expected.zoom)).toBeLessThan(1e-6);
      lowestZoom = Math.min(lowestZoom, entry.viewState.zoom);
    }
    // The van Wijk & Nuij curve zooms out below both endpoints, then back in.
    expect(oracle.at(0.3).zoom).toBeLessThan(PARIS.zoom - 1);
    expect(lowestZoom).toBeLessThan(PARIS.zoom);
    expect(flight.at(-1)!.viewState).toMatchObject({ bearing: 40, center: BERLIN.center, zoom: 9 });
    // The flight ends at MapLibre's duration after the command (a frame of tolerance before;
    // software-GPU frame stalls after).
    const commandTime = await page.evaluate(() => window.mapsFlyToAcceptance!.commandTime());
    const presentedMs = flight.at(-1)!.time - commandTime;
    expect(presentedMs).toBeGreaterThan(oracle.durationMs - 20);
    expect(presentedMs).toBeLessThan(oracle.durationMs + 500);
    // Easing in time: each frame's progress follows MapLibre's ease of its elapsed time.
    for (const entry of flight.slice(0, -1)) {
      const t = (entry.time - commandTime) / oracle.durationMs;
      const k = (entry.viewState.bearing ?? 0) / oracle.bearing;
      // A frame presents its rAF timestamp, before the callback records the time (by more
      // than a frame on a loaded software-GPU runner).
      expect(k).toBeLessThanOrEqual(maplibreDefaultEasing(t) + 1e-9);
      expect(k).toBeGreaterThan(maplibreDefaultEasing(t - 0.15) - 1e-9);
    }

    // Work counters: camera frames re-render the base; no Map Layer data is re-lowered.
    expect(after!.renders - before!.renders).toBeGreaterThan(0);
    if (backend === "wgpu") {
      expect(after!.retainedPointPreparations).toBe(before!.retainedPointPreparations);
    }
    test.info().annotations.push({
      description: JSON.stringify({
        backend,
        frames: flight.length,
        oracleDurationMs: Math.round(oracle.durationMs),
        presentedMs: Math.round(presentedMs),
        renders: after!.renders - before!.renders,
        retainedPointPreparations:
          (after!.retainedPointPreparations ?? 0) - (before!.retainedPointPreparations ?? 0),
      }),
      type: "flyto-work-counters",
    });

    // Layers stay aligned and pickable after the flight: Berlin is the camera center.
    const box = await map.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByTestId("maps-flyto-selected-point")).toHaveText("flyto-berlin");

    // --- The instant opt-out: one presented frame at the target.
    await clearTrace(page);
    await page.getByRole("button", { name: "Jump to Paris" }).click();
    await expect(viewState).toContainText("2.35220,48.85660 | zoom 7.00000 | bearing 0.00000");
    await page.waitForTimeout(200);
    const jump = await trace(page);
    expect(jump.map((entry) => entry.reason)).toEqual(["fly-to"]);
    await expect(canvas).not.toHaveAttribute("data-map-camera-transition", "fly-to");

    // --- A pointer press interrupts the flight where it is, with no later frame.
    await clearTrace(page);
    await page.getByRole("button", { name: "Fly to Berlin" }).click();
    await expect.poll(async () => (await trace(page)).length).toBeGreaterThan(5);
    await page.mouse.move(box!.x + 40, box!.y + 40);
    await page.mouse.down();
    await expect(canvas).not.toHaveAttribute("data-map-camera-transition", "fly-to");
    const interrupted = (await trace(page)).length;
    await page.waitForTimeout(300);
    await page.mouse.up();
    const afterInterrupt = await trace(page);
    expect(afterInterrupt.length).toBe(interrupted);
    expect(afterInterrupt.at(-1)!.viewState.zoom).not.toBe(9);

    // --- A resize and device-pixel-ratio change mid-flight keep the geographic flight, and
    // the layers stay aligned and pickable where it ends.
    await clearTrace(page);
    await page.getByRole("button", { name: "Fly to Paris" }).click();
    await expect.poll(async () => (await trace(page)).length).toBeGreaterThan(2);
    const cdp = await page.context().newCDPSession(page);
    const viewport = page.viewportSize()!;
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: 2,
        height: viewport.height - 80,
        mobile: false,
        width: viewport.width - 120,
      });
      await expect(viewState).toContainText("2.35220,48.85660 | zoom 7.00000 | bearing 0.00000", {
        timeout: 15_000,
      });
      await expect(canvas).not.toHaveAttribute("data-map-camera-transition", "fly-to");
      const resized = await trace(page);
      expect(resized.every((entry) => entry.reason === "fly-to")).toBe(true);
      expect(resized.length).toBeGreaterThan(3);
      const resizedBox = await map.boundingBox();
      await page.mouse.click(
        resizedBox!.x + resizedBox!.width / 2,
        resizedBox!.y + resizedBox!.height / 2,
      );
      await expect(page.getByTestId("maps-flyto-selected-point")).toHaveText("flyto-paris");
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await cdp.detach();
    }

    // --- Across the antimeridian along the short way.
    await page.getByRole("button", { name: "Jump to Fiji" }).click();
    await expect(viewState).toContainText("178.44000,-18.14000");
    await clearTrace(page);
    await page.getByRole("button", { name: "Fly across the dateline to Samoa" }).click();
    await expect(viewState).toContainText("-171.76000,-13.83000 | zoom 6.00000", {
      timeout: 10_000,
    });
    const dateline = await trace(page);
    expect(dateline.length).toBeGreaterThan(2);
    for (const entry of dateline) {
      expect(Math.abs(entry.viewState.center[0])).toBeGreaterThanOrEqual(171.76 - 1e-6);
    }
    const datelineMs =
      dateline.at(-1)!.time - (await page.evaluate(() => window.mapsFlyToAcceptance!.commandTime()));
    expect(datelineMs).toBeGreaterThan(1200 - 20);
    expect(datelineMs).toBeLessThan(1200 + 500);
    await expect(canvas).toHaveAttribute("data-map-base-renderer", backend);
  });
}

async function clearTrace(page: Page) {
  await page.evaluate(() => window.mapsFlyToAcceptance!.clearTrace());
}

async function trace(page: Page): Promise<TraceEntry[]> {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.mapsFlyToAcceptance!.trace)));
}

async function stats(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    const value = window.mapsFlyToAcceptance!.stats();
    return value
      ? { renders: value.renders, retainedPointPreparations: value.retainedPointPreparations }
      : null;
  });
}
