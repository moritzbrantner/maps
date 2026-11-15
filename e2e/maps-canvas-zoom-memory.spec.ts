import { expect, test } from "@playwright/test";

import { WEBGPU_SWIFTSHADER_ARGS } from "./helpers/webgpu-args";

// #447: sustained wheel zoom on the Canvas fallback keeps the memory Maps owns bounded. The
// decoded tile images it holds stay within Rust's tile cache, every image it drops is closed,
// and the JS heap returns to its starting size after GC.
//
// Chromium's GPU process also grows during this journey: it caches each uploaded frame of a
// software 2D canvas (docs/engine-evidence.md, "Canvas fallback zoom memory"). That cache
// belongs to the browser, so this spec runs in its own browser to keep it from slowing the
// next spec, and asserts nothing about it.
test.use({ launchOptions: { args: [...WEBGPU_SWIFTSHADER_ARGS] } });

/** Rust's default decoded-tile cache capacity (`DEFAULT_CACHE_CAPACITY` in flat_runtime.rs). */
const RUST_TILE_CACHE_CAPACITY = 512;
const HEAP_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024;

test("Canvas fallback keeps Maps-owned memory bounded during sustained zoom", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => undefined,
    });
    // Every ImageBitmap the page creates and closes: live ones are the decoded tiles held.
    const counts = { closed: 0, created: 0 };
    Reflect.set(window, "mapsImageBitmaps", counts);
    const create = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((
      ...args: Parameters<typeof createImageBitmap>
    ) => {
      counts.created += 1;
      return create(...args);
    }) as typeof createImageBitmap;
    const close = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function () {
      counts.closed += 1;
      return close.call(this);
    };
  });
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime");
  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]').first();
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(canvas).toHaveAttribute("data-map-base-renderer", "canvas2d");
  await expect(canvas).toHaveAttribute("data-map-base-pending-tiles", "0");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const sample = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const counts = await page.evaluate(
      () =>
        Reflect.get(window, "mapsImageBitmaps") as {
          closed: number;
          created: number;
        },
    );
    return {
      heap: metrics.find((metric) => metric.name === "JSHeapUsedSize")!.value,
      live: counts.created - counts.closed,
      created: counts.created,
      retained: Number(
        await canvas.getAttribute("data-map-base-retained-tiles"),
      ),
    };
  };
  const before = await sample();
  // Bitmaps other page content holds (the parity map) stay outside this Map View's count.
  const elsewhere = before.live - before.retained;

  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Zoom in about nine levels and back out: every level loads new tiles.
  for (let step = 0; step < 100; step++) {
    await page.mouse.wheel(0, step < 50 ? -120 : 120);
    await page.waitForTimeout(16);
  }
  await expect(canvas).toHaveAttribute("data-map-base-pending-tiles", "0");
  const after = await sample();

  expect(after.created - before.created).toBeGreaterThan(100);
  expect(after.retained).toBeLessThanOrEqual(RUST_TILE_CACHE_CAPACITY);
  expect(after.live - elsewhere).toBe(after.retained);
  expect(after.heap - before.heap).toBeLessThan(HEAP_GROWTH_LIMIT_BYTES);
});
