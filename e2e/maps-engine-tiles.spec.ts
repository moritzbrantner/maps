import { expect, test } from "@playwright/test";
import { createShortbreadTileFixture } from "./fixtures/shortbread-tile.mjs";

const body = createShortbreadTileFixture({ dense: true });

test("standalone dense vector basemap retains tile pixels during pan and zoom @smoke", async ({
  page,
}) => {
  // Exercise the pixel fallback too: WebGPU support must not decide whether the
  // basemap blocks input or retains coverage.
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const requests = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", async (route) => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    await route.fulfill({ body, contentType: "application/vnd.mapbox-vector-tile" });
  });
  await page.goto("/engine/?e2e=1&vectorTiles=fixture");
  const base = page.locator("[data-flat-runtime=maps]");
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
  const warmTiles = [...requests.keys()];
  // The tile pixels are owned by the base renderer; only application features
  // enter the changing overlay scene.
  await expect
    .poll(async () =>
      Number(
        await page
          .locator("[data-map-overlay-runtime=maps]")
          .getAttribute("data-map-overlay-primitives"),
      ),
    )
    .toBeLessThan(1000);
  const bounds = (await base.boundingBox())!;
  const x = bounds.x + bounds.width * 0.55,
    y = bounds.y + bounds.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 180, y, { steps: 18 });
  await page.mouse.up();
  await page.mouse.wheel(0, -160);
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(page.locator("[data-map-overlay-runtime=maps]")).toHaveCSS("transform", "none");
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  for (const url of warmTiles) expect(requests.get(url)).toBe(1);
  expect(errors).toEqual([]);
});

test("worker tile pixels preserve forest, water and island holes @smoke", async ({ page }) => {
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", (route) =>
    route.fulfill({
      body: createShortbreadTileFixture(),
      contentType: "application/vnd.mapbox-vector-tile",
    }),
  );
  await page.goto("/e2e/fixtures/engine-benchmark.html");
  const pixels = await page.evaluate(async () => {
    const { createShortbreadTileLoader } = await import("/demo/shortbread-tile-loader.ts");
    const loader = createShortbreadTileLoader(new URL("/wasm/maps_wasm.js", location.origin).href);
    try {
      const image = await loader.load(
        "https://vector.openstreetmap.org/shortbread_v1/0/0/0.mvt",
        { key: "0/0/0", x: 0, y: 0, z: 0 },
        new AbortController().signal,
      );
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      image.close();
      return {
        water: [...context.getImageData(64, 64, 1, 1).data],
        island: [...context.getImageData(256, 256, 1, 1).data],
      };
    } finally {
      loader.dispose();
    }
  });
  expect(pixels).toEqual({ water: [168, 204, 224, 255], island: [196, 216, 180, 255] });
});

test("tile worker rejects malformed data and remains usable, then disposes pending loads", async ({
  page,
}) => {
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", (route) =>
    route.fulfill({
      body: route.request().url().includes("bad")
        ? Buffer.from([255])
        : createShortbreadTileFixture(),
      contentType: "application/vnd.mapbox-vector-tile",
    }),
  );
  await page.goto("/e2e/fixtures/engine-benchmark.html");
  const result = await page.evaluate(async () => {
    const { createShortbreadTileLoader } = await import("/demo/shortbread-tile-loader.ts");
    const loader = createShortbreadTileLoader(new URL("/wasm/maps_wasm.js", location.origin).href);
    const tile = { key: "0/0/0", x: 0, y: 0, z: 0 };
    const url = "https://vector.openstreetmap.org/shortbread_v1/0/0/0.mvt";
    try {
      let malformed = false;
      try {
        await loader.load(`${url}?bad`, tile, new AbortController().signal);
      } catch (error) {
        malformed = String(error).includes("invalid MVT protobuf");
      }
      const image = await loader.load(url, tile, new AbortController().signal);
      const width = image.width;
      image.close();
      const abort = new AbortController();
      abort.abort();
      const cancelled = await loader.load(url, tile, abort.signal).then(
        () => false,
        () => true,
      );
      const pending = loader.load(url, tile, new AbortController().signal).then(
        () => false,
        () => true,
      );
      loader.dispose();
      return { malformed, width, cancelled, disposed: await pending };
    } finally {
      loader.dispose();
    }
  });
  expect(result).toEqual({ malformed: true, width: 512, cancelled: true, disposed: true });
});

test("pan predicts vector tiles beyond the stationary ring and reuses them @smoke", async ({
  page,
}) => {
  await page.setViewportSize({ width: 512, height: 512 });
  const requests = new Map<string, number>();
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", async (route) => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    await route.fulfill({ body, contentType: "application/vnd.mapbox-vector-tile" });
  });
  await page.goto("/engine/?e2e=1&vectorTiles=fixture");
  const base = page.locator("[data-flat-runtime=maps]");
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
  const initial = new Set(requests.keys());
  // A small eastward pan keeps the visible XYZ columns unchanged, but predicts
  // column 19 beyond the stationary ring (columns 15..18 at this camera).
  await page.mouse.move(300, 280);
  await page.mouse.down();
  await page.mouse.move(284, 280, { steps: 2 });
  await expect
    .poll(() => [...requests.keys()].filter((url) => /\/5\/19\//.test(url)).length)
    .toBeGreaterThan(0);
  await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
  const predicted = [...requests.keys()].filter((url) => /\/5\/19\//.test(url));
  expect(predicted.every((url) => !initial.has(url))).toBe(true);
  // Three separate drags move that predicted column into the viewport.
  await page.mouse.up();
  for (let step = 0; step < 3; step++) {
    await page.mouse.move(420, 280);
    await page.mouse.down();
    await page.mouse.move(140, 280, { steps: 20 });
    // Let outstanding tile work finish before continuing the journey.
    await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
    await page.mouse.up();
  }
  // Column 21 can only be predicted once column 19 has entered the cover.
  await expect
    .poll(() => [...requests.keys()].filter((url) => /\/5\/21\//.test(url)).length)
    .toBeGreaterThan(0);
  for (const url of predicted) expect(requests.get(url)).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
