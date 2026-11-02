import { expect, test, type Page } from "@playwright/test";

const fullArchive =
  "liechtenstein-749bc3ac9a430b41fb7613686b7898b43ed11d8e8321624559ea591f49cc8fdf.pmtiles";
const northArchive =
  "liechtenstein-north-7761a554051b9d8a77cf9c1f790b03a4e66a15fbe91dde46c488a10e0f95bf3e.pmtiles";

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
  expect(ranges.length).toBeGreaterThan(0);
  expect(
    ranges.every(
      (response) =>
        response.status === 206 && /^bytes \d+-\d+\/2780045$/.test(response.contentRange ?? ""),
    ),
  ).toBe(true);
  expect(ranges.some((response) => response.range === "bytes=0-16383")).toBe(true);
  expect(external).toEqual([]);
  await expect(page.getByText("© OpenStreetMap contributors · ODbL 1.0")).toBeVisible();
  await expect(page.getByText("2026-10-25 snapshot", { exact: false })).toBeVisible();

  const partial = await request.get(`/maps/tilesets/${fullArchive}`, {
    headers: { Range: "bytes=0-16383" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toBe(`bytes 0-16383/2780045`);
  expect((await partial.body()).length).toBe(16_384);
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
