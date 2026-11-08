import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  MapsRuntimeSequenceFixture,
  MapsRuntimeSequenceHandle,
} from "../demo/MapsRuntimeAcceptance";
import type { MapSurfaceController } from "../src";

const VISIBLE_RASTER_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGMM2FLxnwEPYMInOXwUAACRIgKL3I8IIQAAAABJRU5ErkJggg==",
  "base64",
);

declare global {
  // Declaration merging types the browser-only fault-injection probe.
  interface Window {
    destroyMapsGpuDevices: () => Promise<number>;
    rasterLoadProbe: {
      requests: { url: string; signal: AbortSignal }[];
      releaseCancelled: () => void;
      settled: number;
    };
  }
}

test("device loss preserves mixed Map Layers and selection on Canvas @smoke", async ({
  page,
}, info) => {
  // Capture the real browser device at its external creation boundary. Destroying it
  // exercises Dawn, Rust's lost-device callback and the production fallback together.
  await page.addInitScript(() => {
    type Device = { destroy(): void; lost: Promise<unknown> };
    const devices: Device[] = [];
    const adapter = Reflect.get(globalThis, "GPUAdapter").prototype;
    const requestDevice = adapter.requestDevice;
    adapter.requestDevice = async function (...args: unknown[]) {
      const device: Device = await requestDevice.apply(this, args);
      devices.push(device);
      return device;
    };
    window.destroyMapsGpuDevices = async () => {
      for (const device of devices) device.destroy();
      await Promise.all(devices.map((device) => device.lost));
      return devices.length;
    };
  });
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const base = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  await expect(base).toHaveAttribute("data-map-base-renderer", "wgpu");
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "wgpu");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  const bounds = (await overlay.boundingBox())!;
  const point = await overlayPointPosition(page);
  await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  const cameraBeforeLoss = await viewState.textContent();

  expect(await page.evaluate(() => window.destroyMapsGpuDevices())).toBeGreaterThan(0);
  // The idle-camera device monitor must recover without a camera or pointer event.
  await expect(base).toHaveAttribute("data-map-base-renderer", "canvas2d");
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "canvas2d");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect(viewState).toHaveText(cameraBeforeLoss!);
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  const samplePositions = [
    point,
    await overlayFlowPosition(page),
    await polygonPickPosition(page),
    await overlayClusterPosition(page),
  ];
  // Every primitive family must have visible Canvas pixels after the GPU disappears.
  expect(
    await overlay.evaluate((element, positions) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      const scaleX = canvas.width / canvas.clientWidth;
      const scaleY = canvas.height / canvas.clientHeight;
      return positions.map(
        ({ x, y }) =>
          context.getImageData(Math.round(x * scaleX), Math.round(y * scaleY), 1, 1).data[3]! > 0,
      );
    }, samplePositions),
  ).toEqual([true, true, true, true]);
  await info.attach("device-loss-canvas", {
    body: await map.screenshot(),
    contentType: "image/png",
  });

  const flow = await overlayFlowPosition(page);
  await page.mouse.click(bounds.x + flow.x, bounds.y + flow.y);
  await expect(page.getByTestId("maps-runtime-interaction")).toHaveText(
    "flow:click:acceptance-flow",
  );
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Flow acceptance-route");
});

test("Maps runtime preserves constrained navigation and picking after resize @smoke", async ({ page }) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-constrained");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  const before = await canvas.boundingBox();
  expect(before).toBeTruthy();

  await page.setViewportSize({ width: 780, height: 1000 });
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBeLessThan(before!.width);
  await expect.poll(async () => canvas.evaluate((element) => element.width / devicePixelRatio)).toBeCloseTo(
    (await canvas.boundingBox())!.width, 0,
  );
  await canvas.scrollIntoViewIfNeeded();
  const bounds = (await overlay.boundingBox())!;
  const point = await overlayPointPosition(page);
  await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.75);
  // MapLibre's wheel handling zooms at most one level per frame: scroll until the max zoom.
  for (let tick = 0; tick < 10; tick++) await page.mouse.wheel(0, -100_000);
  await expect.poll(async () => parseViewState(await viewState.textContent()).zoom).toBe(8);
  await expect.poll(async () => isInsideAcceptanceBounds(parseViewState(await viewState.textContent()))).toBe(true);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

test("Maps-owned MapView runs the real Rust/WASM flat runtime @smoke", async ({ page }) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  const interaction = page.getByTestId("maps-runtime-interaction");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-map-base-renderer", /^(wgpu|canvas2d)$/);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", /^(wgpu|canvas2d)$/);
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect(map.locator('svg[data-map-overlay-runtime="maps"]')).toHaveCount(0);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("13.4050,52.5200 | zoom 6.0000");
  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 3 points",
  );
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
  const flowPosition = await overlayFlowPosition(page);

  await page.mouse.move(overlayBox!.x + flowPosition.x, overlayBox!.y + flowPosition.y);
  await expect(interaction).toHaveText("flow:hover:acceptance-flow");
  await expect(page.getByText("Hover flow acceptance-route")).toBeVisible();

  await page.mouse.click(overlayBox!.x + flowPosition.x, overlayBox!.y + flowPosition.y);
  await expect(interaction).toHaveText("flow:click:acceptance-flow");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Flow acceptance-route");
  await page.keyboard.press("Escape");

  const pointPosition = await overlayPointPosition(page);
  await page.mouse.move(overlayBox!.x + pointPosition.x, overlayBox!.y + pointPosition.y);
  await expect(interaction).toHaveText("point:hover:acceptance-berlin");
  await expect(page.getByText("Hover Berlin")).toBeVisible();

  await page.mouse.click(overlayBox!.x + pointPosition.x, overlayBox!.y + pointPosition.y);
  await expect(interaction).toHaveText("point:click:acceptance-berlin");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  await page.mouse.click(overlayBox!.x + pointPosition.x, overlayBox!.y + pointPosition.y, {
    button: "right",
  });
  await expect(interaction).toHaveText("point:context-menu:acceptance-berlin");
  await expect(
    page.getByRole("button", { name: /Context Berlin at 13\.405,52\.520/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const polygonPosition = await polygonPickPosition(page);
  await page.mouse.click(overlayBox!.x + polygonPosition.x, overlayBox!.y + polygonPosition.y);
  await expect(interaction).toHaveText("geojson:click:acceptance-zone");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText(
    "GeoJSON acceptance-zone",
  );
  await page.keyboard.press("Escape");

  const initialViewState = await viewState.textContent();
  const initialPointPosition = await overlayPointPosition(page);
  const initialPolygonBounds = await overlayPolygonBounds(page);
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.35);
  await page.mouse.wheel(0, -240);

  await expect.poll(async () => viewState.textContent()).not.toBe(initialViewState);
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(initialPointPosition);
  await expect.poll(async () => overlayPolygonBounds(page)).not.toEqual(initialPolygonBounds);

  const zoomedViewState = await viewState.textContent();
  const zoomedPointPosition = await overlayPointPosition(page);
  // Control presentation time so a busy runner cannot finish the whole kinetic
  // journey before the post-release assertion gets to observe it.
  const kineticClockStart = Date.now();
  await page.clock.install({ time: kineticClockStart });
  await page.clock.pauseAt(kineticClockStart + 50);
  const cdp = await page.context().newCDPSession(page);
  const dragStart = {
    x: box!.x + box!.width * 0.8,
    y: box!.y + box!.height * 0.75,
  };
  const dragEnd = { x: dragStart.x + 96, y: dragStart.y + 36 };
  const dragTimestamp =
    (await page.evaluate(() => performance.timeOrigin + performance.now() - 200)) / 1000;

  // Start well outside the application overlays so the Milestone B gesture host,
  // not the feature-picking boundary, owns this pointer sequence. Give Chromium explicit
  // 16 ms input timestamps so the velocity tracker sees deterministic positive sample gaps
  // inside its 80 ms acceptance window, independent of CI scheduling latency.
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: dragStart.x,
    y: dragStart.y,
    timestamp: dragTimestamp,
  });
  await page.clock.runFor(16);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: dragStart.x,
    y: dragStart.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    timestamp: dragTimestamp + 0.016,
  });
  for (let step = 1; step <= 4; step += 1) {
    await page.clock.runFor(16);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dragStart.x + ((dragEnd.x - dragStart.x) * step) / 4,
      y: dragStart.y + ((dragEnd.y - dragStart.y) * step) / 4,
      button: "left",
      buttons: 1,
      timestamp: dragTimestamp + 0.016 * (step + 1),
    });
  }
  await page.clock.runFor(16);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: dragEnd.x,
    y: dragEnd.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    timestamp: dragTimestamp + 0.096,
  });
  await page.clock.runFor(32);
  const releasedViewState = await viewState.textContent();
  await page.clock.runFor(64);

  await expect.poll(async () => viewState.textContent()).not.toBe(zoomedViewState);
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(zoomedPointPosition);
  await expect.poll(async () => viewState.textContent()).not.toBe(releasedViewState);
  await page.clock.resume();

  await page.waitForTimeout(850);
  const settledViewState = await viewState.textContent();
  await page.waitForTimeout(120);
  expect(await viewState.textContent()).toBe(settledViewState);

  const draggedViewState = parseViewState(settledViewState);
  const draggedPointPosition = await overlayPointPosition(page);
  const touchCenter = {
    x: box!.x + box!.width * 0.5,
    y: box!.y + box!.height * 0.5,
  };

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 0, x: touchCenter.x - 40, y: touchCenter.y },
      { id: 1, x: touchCenter.x + 40, y: touchCenter.y },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 0, x: touchCenter.x - 80, y: touchCenter.y - 12 },
      { id: 1, x: touchCenter.x + 80, y: touchCenter.y + 12 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  await expect
    .poll(async () => parseViewState(await viewState.textContent()).zoom)
    .toBeGreaterThan(draggedViewState.zoom);
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(draggedPointPosition);

  await page.getByRole("button", { name: "Fit acceptance bounds" }).click();
  await expect(viewState).toHaveText(/^0\.0000,45\.\d{4} \| zoom \d+\.\d{4}$/);

  const fitted = await viewState.textContent();
  await page.getByRole("button", { name: "Request outside bounds" }).click();
  // The constrained camera renders, and reports, on the next animation frame (#343).
  await expect(viewState).not.toHaveText(fitted!);
  await expect
    .poll(async () => isInsideAcceptanceBounds(parseViewState(await viewState.textContent())))
    .toBe(true);
  const constrained = parseViewState(await viewState.textContent());
  expect(constrained.zoom).toBeGreaterThan(1);

  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, 10_000);
  await expect
    .poll(async () => isInsideAcceptanceBounds(parseViewState(await viewState.textContent())))
    .toBe(true);
  expect(parseViewState(await viewState.textContent()).zoom).toBeGreaterThanOrEqual(
    constrained.zoom - 0.0001,
  );

  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

for (const backend of ["canvas2d", "default"] as const) {
  test(`zoom keeps old raster coverage while replacement downloads wait (${backend}) @smoke`, async ({
    page,
  }, testInfo) => {
    if (backend === "canvas2d") {
      await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
    }
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = 0;
    await page.route("https://tiles.example.test/**", async (route) => {
      if (hold) {
        delayed += 1;
        await gate;
      }
      await route.fulfill({
        body: VISIBLE_RASTER_TILE,
        contentType: "image/png",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    });
    try {
      await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-raster-fetch");
      const map = page.getByLabel("Maps Rust runtime acceptance");
      const canvas = map.locator('canvas[data-flat-runtime="maps"]');
      await expect
        .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
        .toBeGreaterThan(0);
      await expect(canvas).toHaveAttribute("data-map-base-pending-tiles", "0");
      await expect(canvas).toHaveAttribute("data-map-base-renderer", /^(wgpu|canvas2d)$/);
      if (backend === "canvas2d") {
        await expect(canvas).toHaveAttribute("data-map-base-renderer", "canvas2d");
      }
      hold = true;
      const box = (await canvas.boundingBox())!;
      await canvas.dispatchEvent("wheel", {
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
        deltaY: -400,
        deltaMode: 0,
      });
      await expect.poll(() => delayed).toBeGreaterThan(0);
      await expect(page.getByTestId("maps-runtime-view-state")).not.toContainText("zoom 6.0000");
      await expect
        .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
        .toBeGreaterThan(0);
      if (backend === "canvas2d") {
        const samples = await map
          .locator('canvas[data-map-base-fallback="canvas2d"]')
          .evaluate((element) => {
            const image = element as HTMLCanvasElement;
            const context = image.getContext("2d")!;
            return [0.25, 0.5, 0.75].map((fraction) =>
              Array.from(
                context.getImageData(
                  Math.floor(image.width * fraction),
                  Math.floor(image.height / 2),
                  1,
                  1,
                ).data,
              ),
            );
          });
        expect(samples.every((pixel) => pixel[3] === 255 && pixel[0]! < 200)).toBe(true);
      }
      await testInfo.attach(`zoom-fallback-${backend}`, {
        body: await map.screenshot({ path: testInfo.outputPath(`zoom-fallback-${backend}.png`) }),
        contentType: "image/png",
      });
      hold = false;
      release();
      await expect(canvas).toHaveAttribute("data-map-base-pending-tiles", "0");
      await expect
        .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
        .toBeGreaterThan(0);
    } finally {
      hold = false;
      release();
    }
  });
}

test("first-party raster loader requests image tiles and renders them @smoke", async ({ page }) => {
  const acceptedHeaders: string[] = [];

  await page.route("https://tiles.example.test/**", async (route) => {
    const headers = await route.request().allHeaders();
    acceptedHeaders.push(headers.accept ?? "");
    await route.fulfill({
      body: VISIBLE_RASTER_TILE,
      contentType: "image/png",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      status: 200,
    });
  });

  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-raster-fetch");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  expect(acceptedHeaders.length).toBeGreaterThan(0);
  expect(acceptedHeaders.every((header) => header.includes("image/"))).toBe(true);
  await expect(canvas).not.toHaveAttribute("data-map-base-tile-error", /.+/);
});

test("raster failures release slots for the remaining visible tiles @smoke", async ({ page }) => {
  const requests = new Map<string, number>();
  await page.route("https://tiles.example.test/**", async (route) => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    // The first full concurrency batch fails. The rest of the cover is healthy.
    const failed = [...requests.keys()].indexOf(url) < 8;
    await route.fulfill({
      status: failed ? 404 : 200,
      contentType: failed ? "text/plain" : "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: failed ? "Missing tile" : VISIBLE_RASTER_TILE,
    });
  });

  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-raster-fetch");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  expect(requests.size).toBeGreaterThan(8);
  expect([...requests.values()].every((count) => count === 1)).toBe(true);
});

test("late raster cancellations preserve replacement request ownership @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let releaseCancelled = () => {};
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancelled = resolve;
    });
    const probe: Window["rasterLoadProbe"] = {
      requests: [],
      releaseCancelled,
      settled: 0,
    };
    window.rasterLoadProbe = probe;
    window.fetch = async (input, init) => {
      if (typeof input !== "string" || !input.startsWith("https://tiles.example.test/")) {
        return nativeFetch(input, init);
      }
      const signal = init?.signal;
      if (!signal) throw new Error("Raster fetch must be cancellable");
      probe.requests.push({ url: input, signal });
      try {
        return await nativeFetch(input, init);
      } catch (error) {
        // Network cancellation is real; delay its promise settlement until the
        // camera has returned and started a replacement for the same tile.
        if (signal.aborted) await cancellationGate;
        probe.settled += 1;
        throw error;
      }
    };
  });
  // Hold actual requests in flight until cancelled by the Map View.
  await page.route("https://tiles.example.test/**", () => {});
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-raster-fetch");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect
    .poll(() => page.evaluate(() => window.rasterLoadProbe.requests.length))
    .toBe(8);
  const zoom = async (deltaY: number) => {
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await canvas.dispatchEvent("wheel", {
      clientX: box!.x + box!.width / 2,
      clientY: box!.y + box!.height / 2,
      deltaY,
    });
  };
  await zoom(-100_000);
  await expect(viewState).toContainText("zoom 7.0000");
  await zoom(100_000);
  await expect(viewState).toContainText("zoom 6.0000");
  await expect
    .poll(() => page.evaluate(() => {
      const requests = window.rasterLoadProbe.requests;
      return requests.filter((request, index) =>
        !request.signal.aborted &&
        requests.some((old, oldIndex) => oldIndex < index && old.url === request.url),
      ).length;
    }))
    .toBe(8);

  await page.evaluate(() => window.rasterLoadProbe.releaseCancelled());
  await expect
    .poll(() => page.evaluate(() => window.rasterLoadProbe.settled))
    .toBe(16);
  await zoom(-100_000);
  await expect(viewState).toContainText("zoom 7.0000");
  // All requests from the previous zoom must be aborted, including replacements.
  await expect
    .poll(() => page.evaluate(() => window.rasterLoadProbe.requests
      .filter((request) => new URL(request.url).pathname.startsWith("/7/"))
      .every((request) => request.signal.aborted)))
    .toBe(true);
});

test("wheel zoom keeps the surrounding page stationary @smoke", async ({ page }) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.7);
  await page.mouse.wheel(0, 100_000);
  // Let the browser apply the default wheel action before checking the page.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(viewState).toContainText("zoom 5.0000");
});

test("ClusterLayer uses Rust aggregation and shared picking @smoke", async ({ page }) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  const interaction = page.getByTestId("maps-runtime-interaction");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 3 points",
  );

  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
  const clusterPosition = await overlayClusterPosition(page);
  const initialZoom = parseViewState(await viewState.textContent()).zoom;

  await page.mouse.click(overlayBox!.x + clusterPosition.x, overlayBox!.y + clusterPosition.y);

  await expect(interaction).toHaveText("cluster:click:acceptance-hamburg-cluster");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Cluster 3");
  await expect
    .poll(async () => parseViewState(await viewState.textContent()).zoom)
    .toBeGreaterThan(initialZoom);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

// Composition sequences (#170 phase A): each drives the public Map View as an application
// would and asserts what a user sees and can pick, on the real Rust/WASM and WebGPU path.

test("replacing layer data retargets picks and retires replaced feature overlays @smoke", async ({
  page,
}) => {
  const { interaction, overlay, popup } = await openSequences(page);

  // A stationary pointer: nothing but the data replacement may clear the hover.
  await moveToCoordinate(page, [13.405, 52.52]);
  await expect(page.getByText("Hover Berlin")).toBeVisible();
  await setFixture(page, { pointData: "replaced" });
  await expect(page.getByText("Hover Berlin")).toHaveCount(0);
  await expect(interaction).toHaveText("point:clear:none");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");

  await clickCoordinate(page, [13.0, 52.2]);
  await expect(popup).toHaveText("Selected Potsdam");
  await setFixture(page, { pointData: "original" });
  await expect(popup).toHaveCount(0);

  await clickCoordinate(page, [13.405, 52.52]);
  await expect(popup).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  // A new record with the same feature identity is the same Map Feature, moved.
  await clickCoordinate(page, [13.405, 52.52]);
  await expect(popup).toHaveText("Selected Berlin");
  await setFixture(page, { pointData: "moved" });
  await expect(popup).toHaveCount(1);
  await page.keyboard.press("Escape");
  await clickCoordinate(page, [13.6, 52.6]);
  await expect(popup).toHaveText("Selected Berlin moved");
  await page.keyboard.press("Escape");
  await setFixture(page, { pointData: "original" });

  await clickCoordinate(page, [13.2, 52.45]);
  await expect(popup).toHaveText("GeoJSON acceptance-zone");
  await setFixture(page, { polygonData: "replaced" });
  await expect(popup).toHaveCount(0);
  await clickCoordinate(page, [13.2, 52.45]);
  await expect(popup).toHaveCount(0);
  await clickCoordinate(page, [14.3, 52.2]);
  await expect(popup).toHaveText("GeoJSON acceptance-zone-b");
  await page.keyboard.press("Escape");

  await clickCoordinate(page, [12.3, 52]);
  await expect(popup).toHaveText("Flow acceptance-route");
  await setFixture(page, { flowData: "replaced" });
  // The flow keeps its Map Feature identity through this replacement.
  await expect(popup).toHaveCount(1);
  await page.keyboard.press("Escape");
  await clickCoordinate(page, [12.3, 52]);
  await expect(popup).toHaveCount(0);
  await clickCoordinate(page, [12.3, 51.5]);
  await expect(popup).toHaveText("Flow acceptance-route-b");
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 3 points",
  );
  await setFixture(page, { clusterData: "replaced" });
  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 2 points",
  );
  await clickCoordinate(page, [9.9937, 53.5511]);
  await expect(popup).toHaveText("Cluster 2");
});

test("reordering and removing layers changes paint, picking and overlays together @smoke", async ({
  page,
}) => {
  const { overlay, popup } = await openSequences(page);
  await setFixture(page, { polygonFillOpacity: 0.85 });
  const offMap = await overlay.boundingBox();
  await page.mouse.move(offMap!.x + 4, offMap!.y + offMap!.height - 4);

  const berlin: [number, number] = [13.405, 52.52];
  await expectDominantChannel(page, berlin, "red");
  await clickCoordinate(page, berlin);
  await expect(popup).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  await setFixture(page, { order: ["cluster", "flow", "point", "polygon"] });
  await expectDominantChannel(page, berlin, "blue");
  await clickCoordinate(page, berlin);
  await expect(popup).toHaveText("GeoJSON acceptance-zone");
  await page.keyboard.press("Escape");

  await setFixture(page, { order: ["cluster", "flow", "polygon", "point"] });
  await expectDominantChannel(page, berlin, "red");

  // Removing the polygon uncovers what it hid; picking and paint agree.
  await setFixture(page, { order: ["cluster", "flow", "point"] });
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "6");
  await expectDominantChannel(page, [13.2, 52.45], "none");
  await clickCoordinate(page, [13.2, 52.45]);
  await expect(popup).toHaveCount(0);

  // Dropping the only non-retained layer moves the frame between GPU paths and back.
  await setFixture(page, { order: ["flow", "polygon", "point"] });
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "6");
  await clickCoordinate(page, [9.9937, 53.5511]);
  await expect(popup).toHaveCount(0);
  await clickCoordinate(page, berlin);
  await expect(popup).toHaveText("Selected Berlin");

  // A removed layer takes its popup with it, and its pointer hover.
  await setFixture(page, { order: ["flow", "polygon"] });
  await expect(popup).toHaveCount(0);
  await moveToCoordinate(page, [12.3, 52]);
  await expect(page.getByText("Hover flow acceptance-route")).toBeVisible();
  await setFixture(page, { order: ["polygon"] });
  await expect(page.getByText("Hover flow acceptance-route")).toHaveCount(0);
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "1");

  await setFixture(page, { order: ["cluster", "flow", "polygon", "point"] });
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await clickCoordinate(page, [9.9937, 53.5511]);
  await expect(popup).toHaveText("Cluster 3");
});

for (const path of ["mixed", "retained"] as const) {
  test(`layer opacity changes repaint the ${path} GPU frame @smoke`, async ({ page }) => {
    const { overlay } = await openSequences(page);
    if (path === "retained") await setFixture(page, { order: ["flow", "polygon", "point"] });
    const expected = path === "retained" ? "wgpu-retained" : "wgpu";
    await expect(overlay).toHaveAttribute("data-map-overlay-backend", expected);
    const bounds = (await overlay.boundingBox())!;
    await page.mouse.move(bounds.x + 4, bounds.y + bounds.height - 4);

    const inside: [number, number] = [13.2, 52.45];
    const faint = await samplePixel(page, inside);
    await setFixture(page, { polygonFillOpacity: 0.85 });
    await expect
      .poll(async () => {
        const [r, , b] = await samplePixel(page, inside);
        return b - r;
      })
      .toBeGreaterThan(faint[2] - faint[0] + 40);
    await expect(overlay).toHaveAttribute("data-map-overlay-backend", expected);
  });
}

test("startup configuration changes apply before readiness and rebuild the runtime after it @smoke", async ({
  page,
}) => {
  const tileUrls: string[] = [];
  await page.route("https://tiles.example.test/**", async (route) => {
    tileUrls.push(route.request().url());
    await route.fulfill({ body: VISIBLE_RASTER_TILE, contentType: "image/png" });
  });
  // Hold the renderer at its external boundary, so configuration lands mid-startup.
  await page.addInitScript(() => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Reflect.set(window, "releaseGpuAdapter", release);
    const gpu = Reflect.get(globalThis, "GPU").prototype;
    const requestAdapter = gpu.requestAdapter;
    gpu.requestAdapter = async function (...args: unknown[]) {
      await gate;
      return requestAdapter.apply(this, args);
    };
  });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-sequences");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  await expect.poll(() => page.evaluate(() => Boolean(window.mapsRuntimeSequences))).toBe(true);
  await expect(map).toHaveAttribute("data-map-ready", "false");

  await setFixture(page, {
    maxBounds: [-20, 35, 35, 65],
    maxZoom: 5,
    rasterTileUrl: "https://tiles.example.test/a/{z}/{x}/{y}.png",
  });
  await expect(map).toHaveAttribute("data-map-ready", "false");
  await page.evaluate(() => (Reflect.get(window, "releaseGpuAdapter") as () => void)());

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect(viewState).toContainText("| zoom 5.0000");
  await expect.poll(() => tileUrls.some((url) => url.includes("/a/"))).toBe(true);
  expect(
    await page.evaluate(() =>
      window.mapsRuntimeSequences!.events.filter((event) => event === "controller-ready"),
    ),
  ).toEqual([
    "controller-ready",
  ]);

  // The tile source is runtime identity: the runtime is rebuilt, the composition survives.
  const cameraBefore = await viewState.textContent();
  tileUrls.length = 0;
  await setFixture(page, { rasterTileUrl: "https://tiles.example.test/b/{z}/{x}/{y}.png" });
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect.poll(() => tileUrls.some((url) => url.includes("/b/"))).toBe(true);
  expect(tileUrls.some((url) => url.includes("/a/"))).toBe(false);
  await expect(viewState).toHaveText(cameraBefore!);
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await clickCoordinate(page, [13.405, 52.52]);
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  // The same saved controller reaches the rebuilt runtime.
  await page.evaluate(() =>
    window.mapsRuntimeSequences!.controller()!.setViewState({ center: [10, 50], zoom: 4 }),
  );
  await expect(viewState).toHaveText("10.0000,50.0000 | zoom 4.0000");

  // A narrower limit corrects the camera, and the application hears about it.
  await setFixture(page, { maxBounds: [12, 40, 40, 62], maxZoom: 6 });
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect
    .poll(async () => {
      const camera = parseViewState(await viewState.textContent());
      return camera.center[0] > 12 && camera.zoom <= 6;
    })
    .toBe(true);
  const runtimeCamera = await page.evaluate(() =>
    window.mapsRuntimeSequences!.controller()!.getViewState(),
  );
  expect(runtimeCamera.zoom).toBeLessThanOrEqual(6);
  expect(runtimeCamera.center[0]).toBeGreaterThan(12);
  expect(errors).toEqual([]);
});

for (const owner of ["controlled", "uncontrolled"] as const) {
  test(`programmatic camera commands complete in order (${owner}) @smoke`, async ({ page }) => {
    await openSequences(
      page,
      owner === "controlled" ? "maps-runtime-sequences" : "maps-runtime-sequences-uncontrolled",
    );
    const viewState = page.getByTestId("maps-runtime-view-state");

    // A camera read in the same tick sees the command; delivery happens exactly once.
    const read = await runCameraSequence(page, (controller) => {
      controller.setViewState({ center: [10, 50], zoom: 5 });
      return controller.getViewState();
    });
    expectCamera(read.result, [10, 50], 5);
    expect(read.events).toEqual(["camera:programmatic:10.0000,50.0000,5.0000"]);
    await expect(viewState).toHaveText("10.0000,50.0000 | zoom 5.0000");
    await expect
      .poll(async () => {
        const position = await projectAcceptanceCoordinate(page, [10, 50]);
        const bounds = (await page
          .getByLabel("Maps Rust runtime acceptance")
          .locator('canvas[data-map-overlay-runtime="maps"]')
          .boundingBox())!;
        return Math.hypot(position.x - bounds.width / 2, position.y - bounds.height / 2);
      })
      .toBeLessThan(1);

    // Later commands supersede a command that has not been presented yet.
    const superseded = await runCameraSequence(page, (controller) => {
      controller.setViewState({ center: [11, 50], zoom: 5 });
      controller.setViewState({ center: [12, 51], zoom: 6 });
    });
    expect(superseded.events).toEqual(["camera:programmatic:12.0000,51.0000,6.0000"]);

    const fitted = await runCameraSequence(page, (controller) => {
      controller.setViewState({ center: [14, 52], zoom: 7 });
      controller.fitBounds([-10, 40, 10, 50], { maxZoom: 7 });
    });
    expect(fitted.events).toHaveLength(1);
    expect(fitted.events[0]).toMatch(/^camera:fit-bounds:/);

    await runCameraSequence(page, (controller) => {
      controller.flyTo({ center: [8, 47], zoom: 6 }, { animate: false });
    });
    await expect(viewState).toHaveText("8.0000,47.0000 | zoom 6.0000");

    // A settled uncontrolled camera stays; React's follow-up commit must not re-apply it.
    await page.waitForTimeout(250);
    await expect(viewState).toHaveText("8.0000,47.0000 | zoom 6.0000");
    expect(
      await page.evaluate(() => window.mapsRuntimeSequences!.controller()!.getViewState()),
    ).toMatchObject({ zoom: 6 });

    if (owner === "controlled") {
      // The application's prop wins over a programmatic command it interrupts.
      const interrupted = await runCameraSequence(page, (controller, handle) => {
        controller.setViewState({ center: [6, 46], zoom: 5 });
        handle.setControlledViewState({ center: [7, 48], zoom: 5.5 });
      });
      expect(interrupted.events).toEqual([]);
      await expect(viewState).toHaveText("7.0000,48.0000 | zoom 5.5000");
      expectCamera(
        await page.evaluate(() => window.mapsRuntimeSequences!.controller()!.getViewState()),
        [7, 48],
        5.5,
      );
    }
  });
}

test("controlled maxZoom tightened after readiness reaches the application camera @smoke", async ({
  page,
}) => {
  await openSequences(page);
  const viewState = page.getByTestId("maps-runtime-view-state");
  await page.evaluate(() =>
    window.mapsRuntimeSequences!.controller()!.setViewState({ center: [10, 50], zoom: 8 }),
  );
  await expect(viewState).toHaveText("10.0000,50.0000 | zoom 8.0000");
  await setFixture(page, { maxZoom: 5 });
  await expect(viewState).toContainText("| zoom 5.0000");
  expect(
    (await page.evaluate(() => window.mapsRuntimeSequences!.controller()!.getViewState())).zoom,
  ).toBeCloseTo(5, 5);
});

test("teardown releases the Map View mid-camera and remounts a working runtime @smoke", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  const { map, overlay, popup } = await openSequences(page);
  await clickCoordinate(page, [13.405, 52.52]);
  await expect(popup).toHaveText("Selected Berlin");

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const afterTeardown = await runCameraSequence(page, (controller, handle) => {
      // A presented-next-frame command is pending when the runtime is torn down.
      controller.setViewState({ center: [10, 50], zoom: 5 });
      handle.setFixture({ mapMounted: false });
      return {
        canvases: document.querySelectorAll('[aria-label="Maps Rust runtime acceptance"] canvas').length,
      };
    });
    expect(afterTeardown.result.canvases).toBe(0);
    expect(afterTeardown.events).toEqual([]);
    await expect(map).toHaveCount(0);

    // A saved controller outlives its Map View without acting on released resources.
    await page.evaluate(() => {
      const controller = window.mapsRuntimeSequences!.controller()!;
      controller.setViewState({ center: [1, 2], zoom: 3 });
      controller.flyTo({ center: [1, 2], zoom: 3 });
      controller.fitBounds([0, 0, 1, 1]);
      controller.getViewState();
    });

    await setFixture(page, { mapMounted: true });
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(map).toHaveAttribute("data-map-runtime", "maps");
    await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
    await expect(popup).toHaveCount(0);
  }

  await clickCoordinate(page, [13.405, 52.52]);
  await expect(popup).toHaveText("Selected Berlin");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`background-only style is a tile-free base with interactions (${backend}) @smoke`, async ({
    page,
  }) => {
    if (backend === "canvas2d") {
      await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
    }
    await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-background");
    const map = page.getByLabel("Maps Rust runtime acceptance");
    const base = map.locator('canvas[data-flat-runtime="maps"]');
    const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
    const viewState = page.getByTestId("maps-runtime-view-state");
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(base).toHaveAttribute("data-map-base-renderer", backend);
    await expect(base).toHaveAttribute("data-map-base-tiles", "0");
    await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
    // Nothing to attribute: a source-free style carries no attribution.
    await expect(map.locator(".mb-maps__attribution")).toHaveCount(0);

    await expect.poll(() => cornerPixel(page, map)).toEqual([47, 125, 107]);

    const bounds = (await overlay.boundingBox())!;
    const point = await overlayPointPosition(page);
    await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
    await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
    await page.keyboard.press("Escape");

    const before = await viewState.textContent();
    await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.6, { steps: 4 });
    await page.mouse.up();
    await expect(viewState).not.toHaveText(before!);
    // The base keeps its color after the camera moved.
    await expect.poll(() => cornerPixel(page, map)).toEqual([47, 125, 107]);
  });
}

test("a translucent background does not accumulate across Canvas frames @smoke", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-background-translucent");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    "canvas2d",
  );
  const before = await cornerPixel(page, map);
  expect(before).not.toEqual([47, 125, 107]);

  const bounds = (await overlay.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("maps-runtime-view-state")).not.toHaveText("");
  expect(await cornerPixel(page, map)).toEqual(before);
});

function expectCamera(
  actual: { center: [number, number]; zoom: number },
  center: [number, number],
  zoom: number,
) {
  expect(actual.center[0]).toBeCloseTo(center[0], 8);
  expect(actual.center[1]).toBeCloseTo(center[1], 8);
  expect(actual.zoom).toBeCloseTo(zoom, 8);
}

async function openSequences(
  page: Page,
  acceptance = "maps-runtime-sequences",
) {
  await page.goto(`/demo-reference/?e2e=1&acceptance=${acceptance}`);
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect
    .poll(() => page.evaluate(() => window.mapsRuntimeSequences?.controller() != null))
    .toBe(true);
  return {
    interaction: page.getByTestId("maps-runtime-interaction"),
    map,
    overlay,
    popup: page.getByTestId("maps-runtime-feature-popup"),
  };
}

function setFixture(page: Page, patch: Partial<MapsRuntimeSequenceFixture>) {
  return page.evaluate((next) => window.mapsRuntimeSequences!.setFixture(next), patch);
}

async function coordinateClientPosition(page: Page, coordinate: [number, number]) {
  const overlay = page
    .getByLabel("Maps Rust runtime acceptance")
    .locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = (await overlay.boundingBox())!;
  const position = await projectAcceptanceCoordinate(page, coordinate);
  return { x: bounds.x + position.x, y: bounds.y + position.y };
}

async function clickCoordinate(page: Page, coordinate: [number, number]) {
  const { x, y } = await coordinateClientPosition(page, coordinate);
  await page.mouse.click(x, y);
}

async function moveToCoordinate(page: Page, coordinate: [number, number]) {
  const { x, y } = await coordinateClientPosition(page, coordinate);
  await page.mouse.move(x, y);
}

/** The composited pixel a user sees, through whichever backend presented it. */
async function samplePixel(page: Page, coordinate: [number, number]) {
  const { x, y } = await coordinateClientPosition(page, coordinate);
  const png = await page.screenshot({
    clip: { height: 3, width: 3, x: Math.round(x) - 1, y: Math.round(y) - 1 },
  });
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(1, 1, 1, 1).data;
    return [data[0]!, data[1]!, data[2]!] as [number, number, number];
  }, png.toString("base64"));
}

async function expectDominantChannel(
  page: Page,
  coordinate: [number, number],
  channel: "red" | "blue" | "none",
) {
  await expect
    .poll(async () => {
      const [r, , b] = await samplePixel(page, coordinate);
      if (Math.abs(r - b) < 60) return "none";
      return r > b ? "red" : "blue";
    })
    .toBe(channel);
}

/** Runs camera commands in one tick and returns what was delivered over the next frames. */
async function runCameraSequence<T>(
  page: Page,
  sequence: (controller: MapSurfaceController, handle: MapsRuntimeSequenceHandle) => T,
): Promise<{ events: string[]; result: T }> {
  const before = await page.evaluate(() => window.mapsRuntimeSequences!.events.length);
  const result = await page.evaluate(
    (source) => {
      const handle = window.mapsRuntimeSequences!;
      // Serialized so one source can run in the page with the page's live objects.
      const run = new Function(`return (${source})`)() as (
        controller: MapSurfaceController,
        handle: MapsRuntimeSequenceHandle,
      ) => unknown;
      return run(handle.controller()!, handle);
    },
    sequence.toString(),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => (++frames === 4 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
  );
  const events = await page.evaluate(
    (start) => window.mapsRuntimeSequences!.events.slice(start).filter((e) => e.startsWith("camera:")),
    before,
  );
  return { events, result: result as T };
}

async function overlayPointPosition(page: Page) {
  return projectAcceptanceCoordinate(page, [13.405, 52.52]);
}

async function overlayClusterPosition(page: Page) {
  return projectAcceptanceCoordinate(page, [9.9937, 53.5511]);
}

async function overlayFlowPosition(page: Page) {
  const from = await projectAcceptanceCoordinate(page, [11.8, 52]);
  const to = await projectAcceptanceCoordinate(page, [12.8, 52]);
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

async function overlayPolygonBounds(page: Page) {
  const points = await Promise.all(
    [
      [13.1, 52.35],
      [13.72, 52.35],
      [13.72, 52.7],
      [13.1, 52.7],
    ].map((coordinate) =>
      projectAcceptanceCoordinate(page, coordinate as [longitude: number, latitude: number]),
    ),
  );
  return {
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
  };
}

async function polygonPickPosition(page: Page) {
  return projectAcceptanceCoordinate(page, [13.2, 52.45]);
}

async function projectAcceptanceCoordinate(
  page: Page,
  coordinate: [longitude: number, latitude: number],
) {
  const overlay = page
    .getByLabel("Maps Rust runtime acceptance")
    .locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = await overlay.boundingBox();
  if (!bounds) throw new Error("Maps overlay has no layout bounds.");

  const viewState = parseViewState(
    await page.getByTestId("maps-runtime-view-state").textContent(),
  );
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(viewState.center);
  const worldSize = 512 * 2 ** viewState.zoom;
  let dx = target.x - center.x;
  if (dx >= 0.5) dx -= 1;
  if (dx < -0.5) dx += 1;

  return {
    x: bounds.width / 2 + dx * worldSize,
    y: bounds.height / 2 + (target.y - center.y) * worldSize,
  };
}

function projectWebMercator([longitude, latitude]: [number, number]) {
  const wrappedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
  const clampedLatitude = Math.min(85.0511287798066, Math.max(-85.0511287798066, latitude));
  const radians = (clampedLatitude * Math.PI) / 180;
  return {
    x: (wrappedLongitude + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  };
}

function parseViewState(text: string | null) {
  const [coordinates = "", zoomText = ""] = (text ?? "").split(" | zoom ");
  const [longitude = Number.NaN, latitude = Number.NaN] = coordinates.split(",").map(Number);

  return {
    center: [longitude, latitude] as [number, number],
    zoom: Number(zoomText),
  };
}

function isInsideAcceptanceBounds(viewState: ReturnType<typeof parseViewState>) {
  return (
    Number.isFinite(viewState.center[0]) &&
    Number.isFinite(viewState.center[1]) &&
    viewState.center[0] >= -25 &&
    viewState.center[0] <= 35 &&
    viewState.center[1] >= 34 &&
    viewState.center[1] <= 66
  );
}

/** The map's composited pixel near the corner the fixture leaves empty, element-relative. */
async function cornerPixel(page: Page, map: Locator) {
  const png = await map.screenshot();
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(12, image.height - 12, 1, 1).data;
    return [data[0]!, data[1]!, data[2]!];
  }, png.toString("base64"));
}
