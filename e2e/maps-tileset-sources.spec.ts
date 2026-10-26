import { expect, test } from "@playwright/test";

for (const canvas of [false, true]) {
  test(`Map View switches versioned MVT sources and reuses style data (${canvas ? "Canvas" : "WebGPU"}) @smoke`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/e2e/fixtures/tileset-sources.html${canvas ? "?canvas" : ""}`);
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
    await expect(page.locator("[data-map-overlay-primitives]")).toHaveAttribute(
      "data-map-overlay-primitives",
      "1",
    );
    // Base canvases overscan beyond the Map View. Capture its clipped public surface,
    // not the oversized canvas box, which also includes focused buttons above it.
    const presentedCanvas = page.locator('[data-map-runtime="maps"]');
    const initial = await presentedCanvas.screenshot();
    const requests = await surface.getAttribute("data-map-source-requests");
    const decodes = await surface.getAttribute("data-map-source-decodes");
    const builds = await surface.getAttribute("data-map-source-bucket-builds");
    await page.getByRole("button", { name: "Red forest" }).click();
    await expect(surface).toHaveAttribute("data-map-source-requests", requests!);
    await expect(surface).toHaveAttribute("data-map-source-decodes", decodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", builds!);
    const styled = await presentedCanvas.screenshot();
    expect(styled.equals(initial)).toBe(false);
    await page.getByRole("button", { name: "Source B" }).click();
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-b");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    const bPixels = await presentedCanvas.screenshot();
    expect(bPixels.equals(styled)).toBe(false);
    const bRequests = Number(await surface.getAttribute("data-map-source-requests"));
    const bDecodes = await surface.getAttribute("data-map-source-decodes");
    const bBuilds = await surface.getAttribute("data-map-source-bucket-builds");
    await page.getByRole("button", { name: "Source A", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect(Number(await surface.getAttribute("data-map-source-requests"))).toBe(bRequests);
    await expect(surface).toHaveAttribute("data-map-source-decodes", bDecodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", bBuilds!);
    const warmPixels = await presentedCanvas.screenshot();
    await test.info().attach("styled-a", { body: styled, contentType: "image/png" });
    await test.info().attach("warm-a", { body: warmPixels, contentType: "image/png" });
    expect(warmPixels.equals(styled)).toBe(true);
    await page.getByRole("button", { name: "Revision 2" }).click();
    await expect(surface).toHaveAttribute("data-map-source-revision", "2");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect(Number(await surface.getAttribute("data-map-source-requests"))).toBeGreaterThan(
      bRequests,
    );
    expect(errors).toEqual([]);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });
}

test("Map View rejects reversed late source responses while preserving camera and application selection @smoke", async ({
  page,
}) => {
  // Exercise non-cooperative transports: an aborted fetch can still resolve.
  await page.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input, init) =>
      fetchOriginal(
        input,
        String(input).includes("/tilesets/") ? { ...init, signal: undefined } : init,
      );
  });
  const pending: import("@playwright/test").Route[] = [];
  await page.route("**/tilesets/*.mvt?**", (route) => {
    pending.push(route);
  });
  await page.goto("/e2e/fixtures/tileset-sources.html");
  await expect.poll(() => pending.length).toBe(1);
  const root = page.locator('[data-map-runtime="maps"]');
  const box = await root.boundingBox();
  await page.mouse.click(box!.x + 320, box!.y + 240);
  await expect(page.getByLabel("Selected Map Feature")).toHaveText("application-point");
  const before = await page.evaluate(() => window.tilesetController!.getViewState());
  await page.getByRole("button", { name: "Source B" }).click();
  await expect.poll(() => pending.length).toBe(2);
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect.poll(() => pending.length).toBe(3);
  const body = (await pending[2]!.fetch()).body();
  await pending[2]!.fulfill({ body: await body });
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  const correct = await surface.screenshot();
  // B then original A resolve after the replacement A has already rendered.
  for (const route of [pending[1]!, pending[0]!]) {
    await route.fulfill({ response: await route.fetch() });
  }
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  expect((await surface.screenshot()).equals(correct)).toBe(true);
  await expect(page.getByLabel("Selected Map Feature")).toHaveText("application-point");
  expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(before);
  expect(Number(await surface.getAttribute("data-map-source-decodes"))).toBe(2);
  await expect(page.locator(".maplibregl-map")).toHaveCount(0);
});

test("Engine Inspector exposes the active Maps Tileset identity, metadata and request failures @smoke", async ({
  page,
}) => {
  await page.route("**/tilesets/fixture-b.mvt?**", (route) => route.fulfill({ status: 503 }));
  await page.goto("/engine/?view=inspector&source=a&e2e=1");
  await expect(page.getByText("fixture-a / 1", { exact: true })).toBeVisible();
  await expect(page.getByText("CC0-1.0", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Tile source", exact: true }).selectOption("b");
  await expect(page.getByText("fixture-b / 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await expect(page.locator(".maplibregl-map")).toHaveCount(0);
});

test("source revisions evict old decoded and GPU resources under the shared Rust budget @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/tileset-sources.html?smallCache");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  for (const name of ["Source B", "Revision 2"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect(
      Number(await surface.getAttribute("data-map-source-retained-tiles")),
    ).toBeLessThanOrEqual(2);
  }
  const requests = Number(await surface.getAttribute("data-map-source-requests"));
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  expect(Number(await surface.getAttribute("data-map-source-requests"))).toBe(requests + 1);
  expect(Number(await surface.getAttribute("data-map-source-retained-tiles"))).toBe(2);
});

test("canonical source tiles are shared by antimeridian world copies and overzoom @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/tileset-sources.html");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).toHaveAttribute("data-map-source-requests", "1");
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [179, 0], zoom: 4 }));
  await expect(surface).toHaveAttribute("data-map-source-requests", "1");
  const camera = await page.evaluate(() => window.tilesetController!.getViewState());
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).toHaveAttribute("data-map-source-requests", "2");
  expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(camera);
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [-179, 0], zoom: 0 }));
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).toHaveAttribute("data-map-source-requests", "2");
});

for (const name of ["Malformed manifest", "Unsupported schema"]) {
  test(`public Map View rejects ${name.toLowerCase()} before source requests @smoke`, async ({
    page,
  }) => {
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/tilesets/")) requests++;
    });
    await page.goto("/e2e/fixtures/tileset-sources.html");
    await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
      "data-map-source-state",
      "ready",
    );
    expect(requests).toBe(1);
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Maps Tileset");
    expect(requests).toBe(1);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });
}
