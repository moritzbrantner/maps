import { expect, test } from "@playwright/test";

test("standalone engine page loads only the custom Map View @smoke", async ({ page }) => {
  const errors: string[] = [];
  const referenceRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/maplibre-gl|leaflet(?:\.js|\/)/.test(request.url())) referenceRequests.push(request.url());
  });
  await page.goto("/engine/?source=pmtiles&e2e=1");
  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  await expect(page.locator('[data-map-runtime="maps"]')).toHaveCount(1);
  await expect(page.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Map examples" })).toHaveCount(0);
  await expect(page.getByLabel("Map engine", { exact: true })).toHaveCount(0);
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Tilt view" }).click();
  await expect(page.getByRole("button", { name: "Flatten view" })).toBeVisible();
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(page.getByRole("button", { name: "Tilt view" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/stats/");
  await page.reload();
  await expect(page.locator('[data-map-runtime="maps"]')).toBeVisible();
  expect(referenceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("packed WASM projection preserves scalar failures and coordinate ordering @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/engine-benchmark.html");
  const result = await page.evaluate(async () => {
    const url = "/wasm/maps_wasm.js";
    const wasm = await import(url);
    await wasm.default();
    const runtime = new wasm.MapsFlatRasterRuntime({
      center: [179.8, 10],
      zoom: 4,
      bearing: 35,
      pitch: 40,
      width: 1280,
      height: 720,
      source: { minZoom: 0, maxZoom: 19, tileSize: 256 },
    });
    try {
      const coordinates = new Float64Array([179.9, 10, -179.9, 10, NaN, 0, 13.405, 52.52]);
      const packed = runtime.projectPacked(coordinates);
      let parity = true;
      for (let i = 0; i < coordinates.length; i += 2) {
        try {
          const scalar = runtime.project(coordinates[i], coordinates[i + 1]);
          parity &&= packed[i] === scalar[0] && packed[i + 1] === scalar[1];
        } catch {
          parity &&= Number.isNaN(packed[i]) && Number.isNaN(packed[i + 1]);
        }
      }
      let rejectsOdd = false;
      try {
        runtime.projectPacked(new Float64Array([1]));
      } catch {
        rejectsOdd = true;
      }
      return {
        parity,
        rejectsOdd,
        length: packed.length,
        empty: runtime.projectPacked(new Float64Array()).length,
      };
    } finally {
      runtime.free();
    }
  });
  expect(result).toEqual({ parity: true, rejectsOdd: true, length: 8, empty: 0 });
});

test("engine page searches the source-pinned place index and navigates @smoke", async ({ page }) => {
  const errors: string[] = [];
  const indexRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/search-indexes/")) indexRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/engine/?source=pmtiles&e2e=1");
  const search = page.getByRole("combobox", { name: "Search places" });
  await expect(search).toBeEnabled();
  await search.fill("harbor");
  const results = page.getByRole("listbox", { name: "Search places results" });
  const options = results.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Northern shore");
  await expect(options.nth(1)).toContainText("Southern shore");
  await search.press("ArrowDown");
  await search.press("Enter");
  const note = page.locator("[data-place-key]").filter({ hasText: "No rendered map feature" });
  await expect(note).toHaveAttribute("data-place-key", "showcase/harbor-point-south");
  const [longitude, latitude] = (await note.getAttribute("data-camera-center"))!
    .split(",")
    .map(Number);
  expect(Math.abs(longitude! + 60)).toBeLessThan(0.5);
  expect(Math.abs(latitude! + 30)).toBeLessThan(1);

  await page.getByRole("combobox", { name: "Tile source" }).selectOption("mvt");
  await expect(note).toHaveCount(0);
  await expect(search).toBeEnabled();
  await search.fill("harbor");
  await expect(results.getByRole("option")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Tile source" })).toHaveValue("mvt");
  await expect(search).toBeEnabled();
  await search.fill("crossing");
  await expect(results.getByRole("option")).toHaveText(/Street Crossing/);

  await page.getByRole("combobox", { name: "Tile source" }).selectOption("atlas");
  await expect(search).toBeDisabled();
  await expect(page.getByText("Place search is not available for this map source.")).toBeVisible();
  expect(indexRequests.every((path) => path.endsWith("-r1.json"))).toBe(true);
  expect(errors).toEqual([]);
});
