import { expect, test } from "@playwright/test";
import { createShortbreadTileFixture } from "./fixtures/shortbread-tile.mjs";

test("standalone first-party PMTiles retains tile pixels during pan and zoom @smoke", async ({
  page,
}) => {
  // Exercise the pixel fallback too: WebGPU support must not decide whether the
  // basemap blocks input or retains coverage.
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const ranges = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("showcase-pmtiles-v1.pmtiles")) {
      const range = request.headers()["range"] ?? "";
      ranges.set(range, (ranges.get(range) ?? 0) + 1);
    }
  });
  await page.goto("/engine/?e2e=1");
  const base = page.locator("[data-flat-runtime=maps]");
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
  await expect(base).toHaveAttribute("data-map-source-state", "ready");
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
  expect(ranges.get("bytes=0-16383")).toBe(1);
  await expect(base).toHaveAttribute("data-map-source-state", "ready");
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

test("complete synthetic PMTiles coverage survives multi-region camera changes @smoke", async ({
  page,
}) => {
  // Inspect actual tile pixels in the deterministic Canvas2D fallback. A range
  // request is not required when a new camera can reuse decoded/cached tiles.
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await page.setViewportSize({ width: 512, height: 512 });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("showcase-pmtiles-v1.pmtiles")) {
      requests.push(request.headers()["range"] ?? "");
    }
  });
  await page.goto("/engine/?e2e=1");
  const base = page.locator("[data-flat-runtime=maps]");
  await expect(base).toHaveAttribute("data-map-source-state", "ready", { timeout: 30_000 });
  await expect(base).toHaveAttribute("data-map-base-renderer", "canvas2d");
  await expect(page.locator('canvas[data-map-base-fallback="canvas2d"]')).toBeVisible();
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-source-retained-tiles")))
    .toBeGreaterThan(0);
  await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
  // These regions span separate z2 tiles. The archive has complete z0–z2
  // coverage, unlike the deliberately sparse error-path fixture.
  await expect(page.getByRole("combobox", { name: "Tile source" })).toHaveCSS(
    "background-color",
    "rgb(38, 67, 74)",
  );
  for (const scene of ["west", "east", "south"] as const) {
    await page.getByRole("combobox", { name: "Camera scene" }).selectOption(scene);
    await expect(page).toHaveURL(new RegExp(`[?&]scene=${scene}(?:&|$)`));
    await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
    await expect(base).toHaveAttribute("data-map-source-state", "ready");
    await expect
      .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
      .toBeGreaterThan(0);
    // The test fixture paints every tile edge-to-edge. Uncovered regions reveal
    // the Canvas2D map background (#f9f4ee), even when some tiles are retained.
    // Sample cell centers throughout the *visible viewport*, not the overscan.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            'canvas[data-map-base-fallback="canvas2d"]',
          );
          const context = canvas?.getContext("2d");
          if (!canvas || !context) return 81;
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const ratioX = canvas.width / canvas.clientWidth;
          const ratioY = canvas.height / canvas.clientHeight;
          const marginX = -parseFloat(canvas.style.left || "0");
          const marginY = -parseFloat(canvas.style.top || "0");
          const width = canvas.clientWidth - 2 * marginX;
          const height = canvas.clientHeight - 2 * marginY;
          let missing = 0;
          for (let row = 0; row < 9; row += 1) {
            for (let column = 0; column < 9; column += 1) {
              const x = Math.floor((marginX + ((column + 0.5) * width) / 9) * ratioX);
              const y = Math.floor((marginY + ((row + 0.5) * height) / 9) * ratioY);
              const offset = (y * canvas.width + x) * 4;
              if (
                pixels[offset + 3] !== 255 ||
                (pixels[offset] === 249 && pixels[offset + 1] === 244 && pixels[offset + 2] === 238)
              ) {
                missing += 1;
              }
            }
          }
          return missing;
        }),
      )
      .toBe(0);
  }
  expect(requests).toContain("bytes=0-16383");
  expect(requests.length).toBeGreaterThan(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
