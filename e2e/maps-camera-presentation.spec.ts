import { expect, test } from "@playwright/test";

for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`keeps 1,000 entities aligned during a wheel burst on ${backend} @smoke`, async ({
    page,
  }, testInfo) => {
    if (backend === "canvas2d") {
      await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
    }
    const external: string[] = [];
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.goto("/e2e/fixtures/camera-presentation.html");
    const map = page.getByLabel("Camera synchronization acceptance");
    const canvas = map.locator('[data-flat-runtime="maps"]');
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(canvas).toHaveAttribute("data-map-base-renderer", backend);
    await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveAttribute(
      "data-map-overlay-primitives",
      "1000",
    );
    const work = await canvas.evaluate(async (element) => {
      // Let initial canvas sizing settle; the measured burst has no tile/network work.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const probe = window.mapsCameraProbe;
      probe.reset();
      const bounds = element.getBoundingClientRect();
      for (let index = 0; index < 8; index++) {
        element.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: -20,
            clientX: bounds.left + bounds.width / 2 + index,
            clientY: bounds.top + bounds.height / 2,
          }),
        );
      }
      const beforePaint = {
        frames: probe.frames,
        samples: probe.samples.length,
        projected: probe.projected,
      };
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return {
        beforePaint,
        frames: probe.frames,
        projected: probe.projected,
        changes: probe.changes,
        samples: probe.samples,
      };
    });
    await testInfo.attach("camera-work-counts", {
      body: JSON.stringify(work, null, 2),
      contentType: "application/json",
    });
    expect(work.beforePaint).toEqual({ frames: 0, samples: 0, projected: 0 });
    // No-raster scheduling may drain synthetic tile requests; rendering and
    // projection counts are the deterministic hot-path acceptance boundary.
    expect(work.samples).toHaveLength(1);
    expect(work.projected).toBe(1000);
    expect(work.changes).toBe(1);
    for (const sample of work.samples) {
      expect(sample.actual).not.toBeNull();
      expect(sample.actual![0]).toBeCloseTo(sample.expected[0], 4);
      expect(sample.actual![1]).toBeCloseTo(sample.expected[1], 4);
    }
    const box = await map.boundingBox();
    expect(box).not.toBeNull();
    const point = work.samples[0]!.expected;
    // An offscreen feature is not a valid target for browser pointer input.
    expect(point[0]).toBeGreaterThan(3);
    expect(point[0]).toBeLessThan(box!.width - 3);
    expect(point[1]).toBeGreaterThan(3);
    expect(point[1]).toBeLessThan(box!.height - 3);
    await page.mouse.move(box!.x + point[0], box!.y + point[1]);
    await expect(page.getByText("Picked entity-0", { exact: true })).toBeVisible();
    await map.screenshot({ path: testInfo.outputPath(`camera-alignment-${backend}.png`) });
    expect(external).toEqual([]);
  });
}
