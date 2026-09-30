import { expect, test } from "@playwright/test";

test("standalone engine page loads only the custom Map View @smoke", async ({ page }) => {
  const errors: string[] = [];
  const referenceRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/maplibre-gl|leaflet(?:\.js|\/)/.test(request.url())) referenceRequests.push(request.url());
  });
  await page.goto("/engine/?e2e=1");
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
