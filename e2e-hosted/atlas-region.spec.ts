import { devices, expect, test, type Page } from "@playwright/test";

const fullRevision = "a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4";
const northRevision = "286216eaf8884d4ccf4a1b9e9fdc5e0f2fe14291ca9585e9416011baaf4dee92";
const archiveBytes = 2_730_127;

async function waitForRealTiles(page: Page, sourceId = "maps-liechtenstein") {
  const canvas = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(canvas).toHaveAttribute("data-map-source-id", sourceId);
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready", { timeout: 40_000 });
  await expect
    .poll(async () => {
      const renderer = await canvas.getAttribute("data-map-base-renderer");
      return Number(
        await canvas.getAttribute(
          renderer === "wgpu" ? "data-map-vector-tiles" : "data-map-base-tiles",
        ),
      );
    })
    .toBeGreaterThan(0);
  return canvas;
}

/** Sample *presented pixels*, not only tile requests or renderer counters. */
async function mapPixels(page: Page): Promise<number[][]> {
  const screenshot = await page.screenshot();
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const bounds = document
      .querySelector<HTMLElement>('[data-map-runtime="maps"]')!
      .getBoundingClientRect();
    const values: number[][] = [];
    for (let row = 0; row < 14; row++) {
      for (let column = 0; column < 16; column++) {
        // The far-right side avoids the controls panel and the map caption.
        const x = Math.floor(
          ((bounds.left + bounds.width * (0.54 + ((column + 0.5) * 0.44) / 16)) * bitmap.width) /
            innerWidth,
        );
        const y = Math.floor(
          ((bounds.top + bounds.height * (0.14 + ((row + 0.5) * 0.72) / 14)) * bitmap.height) /
            innerHeight,
        );
        const offset = (y * bitmap.width + x) * 4;
        values.push([data[offset]!, data[offset + 1]!, data[offset + 2]!]);
      }
    }
    bitmap.close();
    return values;
  }, screenshot.toString("base64"));
}

const differentPixels = (a: number[][], b: number[][]) =>
  a.reduce(
    (count, pixel, i) =>
      count +
      (pixel.reduce((difference, channel, j) => difference + Math.abs(channel - b[i]![j]!), 0) > 36
        ? 1
        : 0),
    0,
  );

test("public Pages entry presents the first-party real Atlas, with pinned ranged reads and visible features", async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const externalTiles: string[] = [];
  const ranges: Array<{ status: number; requested: string; contentRange: string; bytes: number }> =
    [];
  page.on("request", (request) => {
    if (/tile\.openstreetmap\.org|vector\.openstreetmap\.org|maplibre-gl/.test(request.url()))
      externalTiles.push(request.url());
  });
  page.on("response", (response) => {
    if (!response.url().endsWith(`${fullRevision}.pmtiles`)) return;
    const headers = response.headers();
    ranges.push({
      status: response.status(),
      requested: response.request().headers()["range"] ?? "",
      contentRange: headers["content-range"] ?? "",
      bytes: Number(headers["content-length"] ?? 0),
    });
  });

  const start = performance.now();
  await page.goto("/maps/?e2e=1");
  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  const canvas = await waitForRealTiles(page);
  const firstUsefulMs = Math.round(performance.now() - start);
  await expect(canvas).toHaveAttribute("data-map-source-revision", `sha256:${fullRevision}`);
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(page.getByText("© OpenStreetMap contributors").first()).toBeVisible();
  await expect(page.getByText("2026-01-01T21:21:30Z")).toBeVisible();
  await expect
    .poll(async () => new Set((await mapPixels(page)).map((pixel) => pixel.join(","))).size)
    .toBeGreaterThan(3);
  await test.info().attach("atlas-rendered-map.png", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  expect(ranges.length).toBeGreaterThanOrEqual(2);
  for (const range of ranges) {
    expect(range.status).toBe(206);
    expect(range.requested).toMatch(/^bytes=\d+-\d*$/);
    expect(range.contentRange).toMatch(new RegExp(`^bytes \\d+-\\d+/${archiveBytes}$`));
    expect(range.bytes).toBeLessThan(archiveBytes);
  }
  expect(externalTiles).toEqual([]);
  await test.info().attach("atlas-cold-request-evidence.json", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify(
        {
          source: `sha256:${fullRevision}`,
          firstUsefulMs,
          requests: ranges.length,
          transferBytes: ranges.reduce((sum, r) => sum + r.bytes, 0),
          rustDecodes: Number(await canvas.getAttribute("data-map-source-decodes")),
          cacheReuses: Number(await canvas.getAttribute("data-map-source-cache-reuses")),
          retainedTileBytes: await page.getByTestId("engine-retained-bytes").textContent(),
          sourceSwitchMs: await page.getByTestId("engine-switch-ms").textContent(),
          ranges,
        },
        null,
        2,
      ),
    ),
  });
});

test("real Atlas features remain rendered while zooming and panning across tile boundaries", async ({
  page,
}) => {
  // Unlike the explicit Canvas2D path above, this exercises WebGPU when available.
  await page.goto("/maps/engine/?source=atlas&scene=atlas&e2e=1");
  const canvas = await waitForRealTiles(page);
  await test.info().attach("atlas-camera-renderer.json", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({ backend: await canvas.getAttribute("data-map-base-renderer") }),
    ),
  });
  const firstCamera = await page.getByTestId("engine-camera").textContent();

  // Movement is not required to issue a new HTTP range request: decoded tiles may be reused.
  await page.mouse.move(1100, 530);
  await page.mouse.wheel(0, -440);
  await expect(page.getByTestId("engine-camera")).not.toHaveText(firstCamera!);
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  await expect
    .poll(async () => new Set((await mapPixels(page)).map((pixel) => pixel.join(","))).size)
    .toBeGreaterThan(3);

  const zoomedCamera = await page.getByTestId("engine-camera").textContent();
  await page.mouse.move(1100, 520);
  await page.mouse.down();
  await page.mouse.move(925, 660, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId("engine-camera")).not.toHaveText(zoomedCamera!);
  await expect(canvas).toHaveAttribute("data-map-source-id", "maps-liechtenstein");
  await expect
    .poll(async () => new Set((await mapPixels(page)).map((pixel) => pixel.join(","))).size)
    .toBeGreaterThan(3);

  await page.getByLabel("Camera scene").selectOption("atlas-south");
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  await expect
    .poll(async () => new Set((await mapPixels(page)).map((pixel) => pixel.join(","))).size)
    .toBeGreaterThan(3);
});

test("two real regions and synthetic XYZ switch without camera or overlay resets; missing coverage is explicit", async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await page.goto("/maps/engine/?source=atlas&scene=atlas-south&e2e=1");
  const canvas = await waitForRealTiles(page);
  const first = await mapPixels(page);
  const camera = await page.getByTestId("engine-camera").textContent();
  const workload = await page.getByLabel("Point count").inputValue();

  await page.getByLabel("Tile source").selectOption("atlas-north");
  await expect(canvas).toHaveAttribute("data-map-source-id", "maps-liechtenstein-north");
  await expect(canvas).toHaveAttribute("data-map-source-revision", `sha256:${northRevision}`);
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  await expect(page.getByTestId("engine-coverage")).toContainText("no provider fallback");
  await expect.poll(async () => differentPixels(first, await mapPixels(page))).toBeGreaterThan(20);
  await expect(page.getByTestId("engine-camera")).toHaveText(camera!);

  await page.getByLabel("Tile source").selectOption("mvt");
  await expect(canvas).toHaveAttribute("data-map-source-id", "fixture-pmtiles-xyz");
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  await expect(page.getByLabel("Point count")).toHaveValue(workload);
  await expect(page.getByTestId("engine-camera")).toHaveText(camera!);

  const warmStart = performance.now();
  await page.getByLabel("Tile source").selectOption("atlas");
  await waitForRealTiles(page);
  const warmMs = Math.round(performance.now() - warmStart);
  await expect(page.getByTestId("engine-camera")).toHaveText(camera!);
  await expect(page.getByTestId("engine-coverage")).toHaveCount(0);
  await expect.poll(async () => differentPixels(first, await mapPixels(page))).toBeLessThan(20);
  await test.info().attach("atlas-warm-revisit-evidence.json", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify(
        {
          warmMs,
          cacheReuses: await canvas.getAttribute("data-map-source-cache-reuses"),
          source: fullRevision,
        },
        null,
        2,
      ),
    ),
  });
});

test("broken real archive fails visibly without switching to a provider", async ({ page }) => {
  await page.route(`**/tilesets/${fullRevision}.pmtiles`, (route) =>
    route.fulfill({
      status: 206,
      headers: { "Content-Range": `bytes 0-16383/${archiveBytes}`, "Accept-Ranges": "bytes" },
      body: Buffer.alloc(16_384),
    }),
  );
  await page.goto("/maps/engine/?source=atlas&scene=atlas&e2e=1");
  const canvas = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(canvas).toHaveAttribute("data-map-source-state", "error", { timeout: 30_000 });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(canvas).toHaveAttribute("data-map-source-id", "maps-liechtenstein");
});

test("mobile touch view keeps Atlas data and attribution accessible", async ({ browser }) => {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  try {
    const page = await context.newPage();
    await page.goto("/maps/engine/?source=atlas&scene=atlas&e2e=1");
    await waitForRealTiles(page);
    await expect(page.getByLabel("Tile source")).toBeVisible();
    await expect(page.getByText("© OpenStreetMap contributors").first()).toBeVisible();
    await page.touchscreen.tap(250, 600);
    await page.getByLabel("Tile source").selectOption("atlas-north");
    await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
      "data-map-source-id",
      "maps-liechtenstein-north",
    );
  } finally {
    await context.close();
  }
});
