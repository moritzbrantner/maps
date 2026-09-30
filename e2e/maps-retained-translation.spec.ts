import { chromium, expect, test, type Page } from "@playwright/test";
// @ts-expect-error -- plain ESM helper shared with the interaction benchmark.
import { pngTile } from "../scripts/benchmark-tiles.mjs";

const WEBGPU_SWIFTSHADER_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
];

async function serveTiles(page: Page) {
  await page.route(/\/__bench_tiles\/(\d+)\/(-?\d+)\/(-?\d+)\.png/, (route) => {
    const [, z, x, y] = /\/__bench_tiles\/(\d+)\/(-?\d+)\/(-?\d+)\.png/.exec(
      route.request().url(),
    )!;
    return route.fulfill({
      body: pngTile(Number(z), Number(x), Number(y)),
      contentType: "image/png",
    });
  });
}

/** Per-pixel RGB comparison of two same-sized PNG screenshots, computed in the page. */
async function comparePixels(page: Page, left: Buffer, right: Buffer) {
  return page.evaluate(
    async ([a, b]) => {
      const load = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [first, second] = await Promise.all([load(a!), load(b!)]);
      let total = 0;
      let large = 0;
      const pixels = first.length / 4;
      for (let index = 0; index < first.length; index += 4) {
        const difference = Math.max(
          Math.abs(first[index]! - second[index]!),
          Math.abs(first[index + 1]! - second[index + 1]!),
          Math.abs(first[index + 2]! - second[index + 2]!),
        );
        total += difference;
        if (difference > 48) large += 1;
      }
      return { meanDifference: total / pixels, largeFraction: large / pixels };
    },
    [left.toString("base64"), right.toString("base64")] as const,
  );
}

for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`a pan presented by retained-frame translation matches a fresh render on ${backend} @smoke`, async ({
    baseURL,
  }, info) => {
    const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
    try {
      const page = await browser.newPage({
        baseURL: baseURL ?? "http://127.0.0.1:5181",
        viewport: { height: 820, width: 1100 },
      });
      await serveTiles(page);
      await page.goto(`/e2e/fixtures/interaction-benchmark.html?engine=maps-${backend}`);
      const map = page.getByLabel("Benchmark map");
      await expect(map).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
      const base = map.locator('canvas[data-flat-runtime="maps"]');
      await expect(base).toHaveAttribute("data-map-base-renderer", backend);
      // Let every margin tile arrive so the retained frame is complete.
      await page.waitForTimeout(500);
      const before = await map.screenshot();

      // Hold animation frames so the translated presentation cannot settle yet.
      const translation = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const held: FrameRequestCallback[] = [];
        const original = window.requestAnimationFrame;
        (window as unknown as { releaseFrames: () => void }).releaseFrames = () => {
          window.requestAnimationFrame = original;
          for (const callback of held.splice(0)) original(callback);
        };
        window.requestAnimationFrame = (callback) => {
          held.push(callback);
          return held.length;
        };
        const camera = window.interactionBenchmark.camera();
        window.interactionBenchmark.presentCamera({
          center: [camera.longitude + 0.012, camera.latitude - 0.004],
          zoom: camera.zoom,
        });
        return document.querySelector<HTMLCanvasElement>('canvas[data-flat-runtime="maps"]')!.style
          .transform;
      });
      expect(translation).toMatch(/^translate\(-?\d+(\.\d+)?px, -?\d+(\.\d+)?px\)$/);
      const translated = await map.screenshot();

      await page.evaluate(async () => {
        (window as unknown as { releaseFrames: () => void }).releaseFrames();
        for (let index = 0; index < 4; index += 1) await new Promise(requestAnimationFrame);
      });
      await expect(base).toHaveCSS("transform", "none");
      const rendered = await map.screenshot();

      const equivalence = await comparePixels(page, translated, rendered);
      const control = await comparePixels(page, before, rendered);
      await info.attach("retained-translation-pixels", {
        body: JSON.stringify({ translation, equivalence, control }, null, 2),
        contentType: "application/json",
      });
      await info.attach("translated", { body: translated, contentType: "image/png" });
      await info.attach("rendered", { body: rendered, contentType: "image/png" });
      // Only sub-pixel resampling may differ between the translated and fresh frames.
      expect(equivalence.meanDifference).toBeLessThan(1.5);
      expect(equivalence.largeFraction).toBeLessThan(0.005);
      // The pan itself is clearly visible, so the equivalence check is sensitive.
      expect(control.meanDifference).toBeGreaterThan(5 * Math.max(equivalence.meanDifference, 0.5));
    } finally {
      await browser.close();
    }
  });
}
