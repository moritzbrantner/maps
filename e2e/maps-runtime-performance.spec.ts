import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import { retainMapPixels } from "./helpers/map-pixel-evidence";

const WEBGPU_SWIFTSHADER_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
];

async function openBackendPage(
  backend: "wgpu" | "canvas2d",
  fixturePage: Page,
  baseURL: string | undefined,
) {
  if (backend === "canvas2d") {
    await fixturePage.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "gpu", {
        configurable: true,
        get: () => undefined,
      });
    });
    return { page: fixturePage, close: async () => {} };
  }

  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  const page = await browser.newPage({
    baseURL: baseURL ?? "http://127.0.0.1:5181",
    viewport: { height: 1000, width: 1440 },
  });
  return { page, close: () => browser.close() };
}

async function retainBackendPixels(
  backend: "wgpu" | "canvas2d",
  map: Parameters<typeof retainMapPixels>[0],
  page: Page,
  info: TestInfo,
  name: string,
  minimumCanvasBluePixels = 100,
) {
  if (backend === "wgpu") {
    await info.attach(name, { body: await map.screenshot(), contentType: "image/png" });
    return;
  }
  await retainMapPixels(map, page, info, name, minimumCanvasBluePixels);
}

async function wheelBurst(page: Page) {
  return page.locator('[data-flat-runtime="maps"]').evaluate(async (canvas) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const p = window.mapsNativeProbe;
    p.reset();
    const r = canvas.getBoundingClientRect();
    for (let i = 0; i < 8; i++)
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -20,
          clientX: r.left + r.width / 2 + i,
          clientY: r.top + r.height / 2,
        }),
      );
    const beforePaint = { samples: p.samples.length, projected: p.projected };
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {
      beforePaint,
      projected: p.projected,
      projectionBatches: p.projectionBatches,
      scalarProjections: p.scalarProjections,
      styles: p.styles,
      filters: p.filters,
      weights: p.weights,
      changes: p.changes,
      readyCount: p.readyCount,
      samples: p.samples,
    };
  });
}
for (const backend of ["wgpu", "canvas2d"] as const) {
  for (const count of [1000, 10000]) {
    test(`retains ${count} native points and 100 flows through controlled camera and hover on ${backend}`, async ({
      page: fixturePage,
      baseURL,
    }, info) => {
      const backendPage = await openBackendPage(backend, fixturePage, baseURL);
      const page = backendPage.page;
      try {
        await page.goto(`/e2e/fixtures/native-performance.html?count=${count}`);
        const map = page.getByLabel("Native performance map");
        await expect(map).toHaveAttribute("data-map-ready", "true");
        await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
          "data-map-base-renderer",
          backend,
        );
        const work = await wheelBurst(page);
        await info.attach("camera-work", {
          body: JSON.stringify(work, null, 2),
          contentType: "application/json",
        });
        expect(work.beforePaint).toEqual({ samples: 0, projected: 0 });
        expect(work.samples).toHaveLength(1);
        expect(work.projected).toBe(count + 2400);
        expect(work.projectionBatches).toBe(1);
        expect(work.scalarProjections).toBe(0);
        expect([work.styles, work.filters, work.weights]).toEqual([0, 0, 0]);
        expect(work.changes).toBe(1);
        expect(work.readyCount).toBe(1);
        expect(work.samples[0]!.actual![0]).toBeCloseTo(work.samples[0]!.expected[0], 4);
        expect(work.samples[0]!.actual![1]).toBeCloseTo(work.samples[0]!.expected[1], 4);
        const box = (await map.boundingBox())!;
        const point = work.samples[0]!.expected;
        await page.evaluate(() => window.mapsNativeProbe.reset());
        await page.mouse.move(box.x + point[0], box.y + point[1]);
        await expect(page.getByText("Picked entity-0", { exact: true })).toBeVisible();
        const hover = await page.evaluate(() => ({
          styles: window.mapsNativeProbe.styles,
          filters: window.mapsNativeProbe.filters,
          weights: window.mapsNativeProbe.weights,
          projected: window.mapsNativeProbe.projected,
        }));
        expect(hover).toEqual({ styles: 0, filters: 0, weights: 0, projected: 0 });
        await retainBackendPixels(backend, map, page, info, `native-${count}-${backend}`);
        // Real pointer drag exercises the native host's pointer listeners, not React synthetic events.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 15, {
          steps: 4,
        });
        await page.mouse.up();
        // An explicit command interrupts inertia and must present the requested camera immediately.
        await page.evaluate(() =>
          window.mapsNativeProbe.command({ center: [13.405, 52.52], zoom: 11 }),
        );
        await retainBackendPixels(backend, map, page, info, `native-pan-${count}-${backend}`, 50);
      } finally {
        await backendPage.close();
      }
    });
  }
  test(`mounts and interacts with the actual browser host without React on ${backend}`, async ({
    page: fixturePage,
    baseURL,
  }, info) => {
    const backendPage = await openBackendPage(backend, fixturePage, baseURL);
    const page = backendPage.page;
    const reactRequests: string[] = [];
    try {
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (
          /\/node_modules\/\.vite\/deps\/react(?:-dom(?:_client)?)?\.js$/i.test(pathname) ||
          /\/node_modules\/react(?:-dom)?\//i.test(pathname)
        )
          reactRequests.push(request.url());
      });
      await page.goto("/e2e/fixtures/browser-host.html");
      const map = page.getByLabel("Standalone map");
      await expect(map).toHaveAttribute("data-ready", "true");
      await expect(map.locator("#base")).toHaveAttribute("data-map-base-renderer", backend);
      const work = await wheelBurst(page);
      expect(work.projected).toBe(1000);
      expect(work.projectionBatches).toBe(1);
      expect(work.scalarProjections).toBe(0);
      expect(work.samples).toHaveLength(1);
      expect([work.styles, work.filters]).toEqual([0, 0]);
      const box = (await map.boundingBox())!;
      const point = work.samples[0]!.expected;
      await page.mouse.move(box.x + point[0], box.y + point[1]);
      await expect(page.locator("#picked")).toHaveText("Picked entity-0");
      await page.getByRole("button", { name: "Zoom in" }).click();
      await retainBackendPixels(backend, map, page, info, `standalone-${backend}`);
      await page.getByRole("button", { name: "Dispose runtime" }).click();
      const disposed = await wheelBurst(page);
      expect(disposed.changes).toBe(0);
      expect(disposed.projected).toBe(0);
      expect(disposed.samples).toEqual([]);
      expect(reactRequests).toEqual([]);
    } finally {
      await backendPage.close();
    }
  });
}

// Descriptive CPU observations, intentionally separate from correctness ratchets.
// The baseline runner executes this same fixture/test against the original src.
test("records native camera CPU samples without a wall-clock CI threshold", async ({
  page: fixturePage,
  baseURL,
}, info) => {
  const backendPage = await openBackendPage("wgpu", fixturePage, baseURL);
  const page = backendPage.page;
  const profiles: unknown[] = [];
  try {
    for (const count of [1000, 10000]) {
      await page.goto(`/e2e/fixtures/native-performance.html?count=${count}`);
      await expect(page.getByLabel("Native performance map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
      await expect(page.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
        "data-map-base-renderer",
        "wgpu",
      );
      const result = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const p = window.mapsNativeProbe;
        const summarize = (values: readonly number[]) => {
          const sorted = [...values].sort((left, right) => left - right);
          const percentile = (ratio: number) =>
            sorted.length === 0
              ? 0
              : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
          return {
            count: sorted.length,
            meanMs:
              sorted.length === 0
                ? 0
                : sorted.reduce((total, value) => total + value, 0) / sorted.length,
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
          };
        };

        p.reset();
        for (let i = 0; i < 30; i++) {
          p.command({ center: [13.405 + (i % 2) * 0.001, 52.52], zoom: 11 + (i % 2) * 0.05 });
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }
        return {
          scenario: "camera-world-pan-v1",
          workload: `native-${new URLSearchParams(location.search).get("count")}-points-100-arcs`,
          phases: {
            command: summarize(p.commandCpuMs),
            finalFrameToSubmit: summarize(p.cameraCpuMs),
            projection: summarize(p.projectionCpuMs),
            renderer: summarize(p.rendererCpuMs),
            runtimeFrame: summarize(p.runtimeFrameCpuMs),
          },
          projected: p.projected,
          projectionBatches: p.projectionBatches,
          scalarProjections: p.scalarProjections,
          styles: p.styles,
          filters: p.filters,
          weights: p.weights,
          presentations: p.samples.length,
          changes: p.changes,
          readyCount: p.readyCount,
        };
      });
      profiles.push(result);
      expect(result.phases.command.count).toBeGreaterThanOrEqual(20);
      expect(result.phases.projection.count).toBeGreaterThanOrEqual(20);
      expect(result.phases.renderer.count).toBeGreaterThanOrEqual(20);
      expect(result.scalarProjections).toBe(0);
      expect([result.styles, result.filters, result.weights]).toEqual([0, 0, 0]);
    }
    console.log("MAPS_CAMERA_PHASE_PROFILE " + JSON.stringify(profiles));
    await info.attach("native-camera-cpu-phases", {
      body: JSON.stringify(profiles, null, 2),
      contentType: "application/json",
    });
  } finally {
    await backendPage.close();
  }
});
