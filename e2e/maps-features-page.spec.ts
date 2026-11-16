import { expect, test, type Page } from "@playwright/test";

const features = [
  { id: "heat", label: "Heat / scalar", map: "Europe tiled temperature surface" },
  { id: "clusters", label: "Layers & clustering", map: "Clusters and flows" },
  { id: "polygons", label: "Polygons / GeoJSON", map: "GeoJSON features" },
  { id: "timeline", label: "Timeline", map: "Freight timeline" },
] as const;

function watchPage(page: Page) {
  const errors: string[] = [];
  const referenceRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/maplibre-gl|leaflet(?:\.js|\/)|openstreetmap\.org/.test(request.url())) {
      referenceRequests.push(request.url());
    }
  });
  return { errors, referenceRequests };
}

async function expectFirstPartyMap(page: Page, mapLabel: string) {
  const map = page.locator('[data-map-runtime="maps"]');
  await expect(map).toHaveCount(1);
  await expect(map).toHaveAttribute("aria-label", mapLabel);
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 30_000 });
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
}

/** Distinct colors inside the map surface, sampled from a real screenshot. */
async function mapPixels(page: Page): Promise<string[]> {
  const map = page.locator('[data-map-runtime="maps"]');
  const screenshot = await map.screenshot();
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const samples: string[] = [];
    for (let row = 0; row < 40; row += 1) {
      for (let column = 0; column < 40; column += 1) {
        const x = Math.floor(((column + 0.5) * bitmap.width) / 40);
        const y = Math.floor(((row + 0.5) * bitmap.height) / 40);
        const i = (y * bitmap.width + x) * 4;
        samples.push(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
    }
    bitmap.close();
    return samples;
  }, screenshot.toString("base64"));
}

test("feature pages load each capability on the first-party runtime @smoke", async ({ page }) => {
  const { errors, referenceRequests } = watchPage(page);
  await page.goto("/features/?e2e=1");
  await expect(page.getByRole("heading", { name: "Maps features" })).toBeVisible();
  // A bare /features/ names its default feature in the shareable URL.
  await expect(page).toHaveURL(/[?&]feature=heat\b/);

  const picker = page.getByRole("navigation", { name: "Capabilities" });
  // Not-yet-first-party families are listed as text, never as a route.
  await expect(picker.getByText("Measurement & editing")).toBeVisible();
  await expect(picker.getByRole("link", { name: /editing|Transformations/ })).toHaveCount(0);

  for (const feature of features) {
    const link = picker.getByRole("link", { name: feature.label, exact: true });
    // Keyboard: the picker is a plain list of links.
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(new RegExp(`[?&]feature=${feature.id}\\b`));
    await expectFirstPartyMap(page, feature.map);
  }

  // History navigation restores the previous feature.
  await page.goBack();
  await expectFirstPartyMap(page, "GeoJSON features");
  expect(referenceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("feature URLs survive direct navigation and refresh @smoke", async ({ page }) => {
  const { errors, referenceRequests } = watchPage(page);
  for (const feature of features) {
    await page.goto(`/features/?feature=${feature.id}`);
    await expectFirstPartyMap(page, feature.map);
    await expect(page.getByRole("link", { name: feature.label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await page.reload();
  await expectFirstPartyMap(page, "Freight timeline");
  expect(referenceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("heat controls change the first-party render mode and persist it in the URL @smoke", async ({
  page,
}) => {
  const { errors } = watchPage(page);
  // Use the source-free comparison to keep the existing raster/contour pixel oracle stable.
  await page.goto("/features/?feature=heat&mode=raster&basemap=none");
  await expectFirstPartyMap(page, "Europe temperature surface");
  const overlay = page.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
    .toBeGreaterThan(0);
  const colors = page.getByRole("button", { name: "Colors" });
  const lines = page.getByRole("button", { name: "Level lines" });
  await expect(colors).toHaveAttribute("aria-pressed", "true");

  const background = "230,236,232";
  // The raster surface paints most of the masked domain with the color ramp.
  await expect
    .poll(async () => (await mapPixels(page)).filter((pixel) => pixel !== background).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(600);
  const raster = await mapPixels(page);

  await lines.focus();
  await page.keyboard.press("Enter");
  await expect(lines).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]mode=contours\b/);
  // Level lines alone leave most of the surface uncolored.
  await expect
    .poll(async () => (await mapPixels(page)).filter((pixel) => pixel !== background).length, {
      timeout: 20_000,
    })
    .toBeLessThan(raster.filter((pixel) => pixel !== background).length / 2);

  await page.getByRole("checkbox", { name: "Show data points" }).check();
  await page.getByRole("slider", { name: "Level line thickness" }).fill("3");
  await page.reload();
  await expectFirstPartyMap(page, "Europe temperature surface");
  await expect(page.getByRole("button", { name: "Level lines" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(errors).toEqual([]);
});

test("heat stays above same-origin PMTiles while the first-party camera moves @smoke", async ({
  page,
}) => {
  const { errors, referenceRequests } = watchPage(page);
  const tileRanges: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("showcase-pmtiles-v1.pmtiles")) {
      tileRanges.push(request.headers()["range"] ?? "");
    }
  });
  await page.goto("/features/?feature=heat");
  await expectFirstPartyMap(page, "Europe tiled temperature surface");
  await expect(page.getByRole("combobox", { name: "Heat map basemap" })).toHaveValue("synthetic");

  const base = page.locator('canvas[data-flat-runtime="maps"]');
  const overlay = page.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect(base).toHaveAttribute("data-map-source-id", "maps-showcase");
  await expect(base).toHaveAttribute("data-map-source-state", "ready", { timeout: 30_000 });
  await expect
    .poll(async () => {
      const gpu = (await base.getAttribute("data-map-base-renderer")) === "wgpu";
      return Number(await base.getAttribute(gpu ? "data-map-vector-tiles" : "data-map-base-tiles"));
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
    .toBeGreaterThan(0);
  expect(tileRanges).toContain("bytes=0-16383");

  await test.info().attach("heat-over-pmtiles-before.png", {
    contentType: "image/png",
    body: await page.locator('[data-map-runtime="maps"]').screenshot(),
  });
  const bounds = (await base.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.5, {
    steps: 8,
  });
  await page.mouse.up();
  await page.mouse.wheel(0, -100);
  await expect(base).toHaveAttribute("data-map-source-state", "ready");
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
    .toBeGreaterThan(0);
  await test.info().attach("heat-over-pmtiles-after.png", {
    contentType: "image/png",
    body: await page.locator('[data-map-runtime="maps"]').screenshot(),
  });
  expect(referenceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("tiled heat survives the Canvas fallback with no WebGPU", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await page.goto("/features/?feature=heat&mode=raster");
  await expectFirstPartyMap(page, "Europe tiled temperature surface");
  const base = page.locator('canvas[data-flat-runtime="maps"]');
  const overlay = page.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect(base).toHaveAttribute("data-map-base-renderer", "canvas2d");
  await expect(base).toHaveAttribute("data-map-source-state", "ready");
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
    .toBeGreaterThan(0);
  await test.info().attach("heat-over-pmtiles-canvas.png", {
    contentType: "image/png",
    body: await page.locator('[data-map-runtime="maps"]').screenshot(),
  });
});

test("feature pages select polygons and drive the map-scoped timeline @smoke", async ({ page }) => {
  const { errors } = watchPage(page);
  await page.goto("/features/?feature=polygons");
  await expectFirstPartyMap(page, "GeoJSON features");
  const hole = page.getByRole("button", { name: /Eastern service area/ });
  await hole.click();
  await expect(hole).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("feature-selection")).toHaveText("Selected geojson-polygon-hole");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.getByTestId("feature-selection")).toHaveText("No selection");

  await page.goto("/features/?feature=timeline");
  await expectFirstPartyMap(page, "Freight timeline");
  const time = page.getByTestId("feature-time");
  await page.getByRole("slider", { name: "Freight timeline" }).fill("60");
  await expect(time).toHaveText("09:00 · paused");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(time).toContainText("playing");
  await expect(time).not.toHaveText(/09:00/);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(time).toContainText("paused");
  expect(errors).toEqual([]);
});
