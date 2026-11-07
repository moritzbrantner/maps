import { expect, test, type Page } from "@playwright/test";

const fullArchive =
  "liechtenstein-a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4.pmtiles";
const northArchive =
  "liechtenstein-north-286216eaf8884d4ccf4a1b9e9fdc5e0f2fe14291ca9585e9416011baaf4dee92.pmtiles";

async function expectGeographicTiles(page: Page, sourceId: string): Promise<void> {
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-id", sourceId);
  await expect(surface).toHaveAttribute("data-map-source-state", "ready", { timeout: 30_000 });
  await expect
    .poll(async () => {
      const renderer = await surface.getAttribute("data-map-base-renderer");
      return Number(
        await surface.getAttribute(
          renderer === "wgpu" ? "data-map-vector-tiles" : "data-map-base-tiles",
        ),
      );
    })
    .toBeGreaterThan(0);
}

// Inspect presented map pixels, rather than assuming that loaded tiles rendered.
async function mapColors(page: Page): Promise<number> {
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
    const colors = new Set<string>();
    for (let row = 0; row < 14; row++) {
      for (let column = 0; column < 16; column++) {
        const x = Math.floor(
          ((bounds.left + bounds.width * (0.54 + ((column + 0.5) * 0.44) / 16)) * bitmap.width) /
            innerWidth,
        );
        const y = Math.floor(
          ((bounds.top + bounds.height * (0.14 + ((row + 0.5) * 0.72) / 14)) * bitmap.height) /
            innerHeight,
        );
        const i = (y * bitmap.width + x) * 4;
        colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
    }
    bitmap.close();
    return colors.size;
  }, screenshot.toString("base64"));
}

test("published Atlas is geographic, ranged, attributed and independent of tile services", async ({
  page,
  request,
}) => {
  const external: string[] = [];
  const ranges: Array<{ range: string; status: number; contentRange: string | undefined }> = [];
  page.on("request", (req) => {
    if (/openstreetmap\.org|maplibre|unpkg\.com|geofabrik\.de/.test(req.url()))
      external.push(req.url());
  });
  page.on("response", (response) => {
    if (!response.url().endsWith(fullArchive)) return;
    ranges.push({
      range: response.request().headers()["range"] ?? "",
      status: response.status(),
      contentRange: response.headers()["content-range"],
    });
  });
  await page.goto("/maps/?e2e=1");
  await expectGeographicTiles(page, "maps-liechtenstein");
  // Decoded tiles can be ready before WebGPU has presented the first colorful frame.
  await expect.poll(() => mapColors(page), { timeout: 20_000 }).toBeGreaterThan(3);
  await test.info().attach("atlas-rendered-map.png", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  expect(ranges.length).toBeGreaterThan(0);
  expect(
    ranges.every(
      (response) =>
        response.status === 206 && /^bytes \d+-\d+\/2730127$/.test(response.contentRange ?? ""),
    ),
  ).toBe(true);
  expect(ranges.some((response) => response.range === "bytes=0-16383")).toBe(true);
  expect(external).toEqual([]);
  await expect(page.getByText("© OpenStreetMap contributors · ODbL 1.0")).toBeVisible();
  await expect(page.getByText("2026-01-01 snapshot", { exact: false })).toBeVisible();

  const partial = await request.get(`/maps/tilesets/${fullArchive}`, {
    headers: { Range: "bytes=0-16383" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toBe(`bytes 0-16383/2730127`);
  expect((await partial.body()).length).toBe(16_384);
});

test("a corrupt real archive fails visibly without a provider fallback", async ({ page }) => {
  await page.route(`**/tilesets/${fullArchive}`, (route) =>
    route.fulfill({
      status: 206,
      headers: { "Content-Range": "bytes 0-16383/2730127" },
      body: Buffer.alloc(16_384),
    }),
  );
  await page.goto("/maps/?source=atlas&scene=liechtenstein&e2e=1");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "error", { timeout: 30_000 });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(surface).toHaveAttribute("data-map-source-id", "maps-liechtenstein");
});

test("zooming far below Atlas source zoom does not overflow the tile cover", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/maps/?source=atlas&scene=liechtenstein&e2e=1");
  await expectGeographicTiles(page, "maps-liechtenstein");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  const bounds = (await surface.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.5);
  for (let step = 0; step < 5; step++) {
    await page.mouse.wheel(0, 2_000);
    await expect(surface).toHaveAttribute("data-map-source-id", "maps-liechtenstein");
  }
  await expect(page.getByText("© OpenStreetMap contributors · ODbL 1.0")).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Reset view" }).click();
  await expectGeographicTiles(page, "maps-liechtenstein");
  await expect.poll(() => mapColors(page), { timeout: 20_000 }).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test("real source A/B switches keep camera and overlays; out-of-coverage is explicit", async ({
  page,
}) => {
  const northStatuses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith(northArchive)) northStatuses.push(response.status());
  });
  await page.goto("/maps/?source=atlas&scene=liechtenstein&e2e=1");
  await expectGeographicTiles(page, "maps-liechtenstein");
  await page.getByRole("combobox", { name: "Point count" }).selectOption("10000");
  await page.getByRole("button", { name: "Tilt view" }).click();
  await page.getByRole("combobox", { name: "Tile source" }).selectOption("atlas-north");
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-id",
    "maps-liechtenstein-north",
  );
  await expect(page.getByText("10,000 synthetic points", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Flatten view" })).toBeVisible();
  await page.getByRole("combobox", { name: "Camera scene" }).selectOption("north");
  await expectGeographicTiles(page, "maps-liechtenstein-north");
  await expect.poll(() => mapColors(page), { timeout: 20_000 }).toBeGreaterThan(3);
  expect(northStatuses.length).toBeGreaterThan(0);
  expect(northStatuses.every((status) => status === 206)).toBe(true);
  await page.getByRole("combobox", { name: "Tile source" }).selectOption("atlas");
  await expectGeographicTiles(page, "maps-liechtenstein");
  await page.getByRole("combobox", { name: "Camera scene" }).selectOption("outside");
  await expect(page.getByText(/Outside this archive's coverage/)).toBeVisible();
  await page.getByRole("button", { name: "View covered region" }).click();
  await expectGeographicTiles(page, "maps-liechtenstein");
  await page.getByRole("combobox", { name: "Tile source" }).selectOption("pmtiles");
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-id",
    "maps-showcase",
  );
  await page.getByRole("combobox", { name: "Tile source" }).selectOption("atlas");
  await expectGeographicTiles(page, "maps-liechtenstein");
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("touch pan and source selection remain functional", async ({ page }) => {
    await page.goto("/maps/?source=atlas&scene=liechtenstein&e2e=1");
    await expectGeographicTiles(page, "maps-liechtenstein");
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    const bounds = (await surface.boundingBox())!;
    const x = bounds.x + bounds.width * 0.65;
    const y = bounds.y + bounds.height * 0.77;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - i * 8, y: y + i * 3 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await page.getByRole("combobox", { name: "Tile source" }).selectOption("atlas-north");
    await page.getByRole("button", { name: "View covered region" }).click();
    await expectGeographicTiles(page, "maps-liechtenstein-north");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
