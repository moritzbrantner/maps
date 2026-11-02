import { expect, test } from "@playwright/test";

test("hosted Pages runs the first-party PMTiles engine without external tile requests", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const externalTiles: string[] = [];
  const rangeStatuses: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/openstreetmap\.org|maplibre-gl|unpkg\.com/.test(request.url())) {
      externalTiles.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("showcase-pmtiles-v1.pmtiles")) {
      rangeStatuses.push(response.status());
    }
  });

  // The public default is the real Atlas; keep the synthetic coverage fixture explicit.
  await page.goto("/maps/?source=pmtiles&scene=points&e2e=1");

  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-id",
    "maps-showcase",
  );
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-state",
    "ready",
    { timeout: 30_000 },
  );
  expect(rangeStatuses.length).toBeGreaterThanOrEqual(3);
  expect(rangeStatuses.every((status) => status === 206)).toBe(true);
  expect(externalTiles).toEqual([]);

  expect(pageErrors).toEqual([]);
});

test("hosted evidence page fails closed with actionable missing runtime diagnostics", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/maps/evidence/");

  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  const runtimeRow = page.getByRole("row").filter({ hasText: "Runtime and Moonlight evidence" });
  await expect(runtimeRow).toContainText("source-unavailable", { timeout: 45_000 });
  await expect(runtimeRow).toContainText("unavailable");
  await expect(runtimeRow).toContainText("Evidence source returned non-JSON content (text/html).");
  await expect(page.getByText(/evidence sources need attention/)).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("hosted Pages publishes the benchmark lab as a direct route", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://unpkg.com/**", (route) => route.abort());

  await page.goto("/maps/benchmarks/?e2e=1");

  await expect(page.getByRole("heading", { name: "Renderer benchmark lab" })).toBeVisible();
  await expect(page.getByLabel("Benchmark point count")).toHaveValue("400");
  await expect(page.getByTestId("benchmark-result-maplibre")).toContainText("MapLibre GL 6.4.1");

  await page.getByRole("button", { name: "Run Canvas2D reference" }).click();
  await expect(page.getByTestId("benchmark-result-canvas2d")).toContainText(
    "Complete · pixel-only Canvas2D",
  );
  await expect(page.getByTestId("benchmark-result-leaflet")).toContainText("Unavailable", {
    timeout: 10_000,
  });

  expect(pageErrors).toEqual([]);
});
