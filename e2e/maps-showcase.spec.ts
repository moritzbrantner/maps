import { expect, test } from "@playwright/test";

test("Pages opens the first-party engine on local PMTiles, not the legacy showcase @smoke", async ({
  page,
}) => {
  const externalTiles: string[] = [];
  const pmtilesRequests: string[] = [];
  page.on("request", (request) => {
    if (/openstreetmap\.org|maplibre-gl|unpkg\.com/.test(request.url())) {
      externalTiles.push(request.url());
    }
    if (request.url().includes("showcase-pmtiles-v1.pmtiles")) {
      pmtilesRequests.push(request.headers()["range"] ?? "");
    }
  });

  await page.goto("/?e2e=1");

  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic CC0 vector tiles", { exact: false })).toBeVisible();
  await expect(page.locator('[data-map-runtime="maps"]')).toHaveCount(1);
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-id",
    "maps-showcase",
  );
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-state",
    "ready",
  );
  await expect(page.getByRole("tablist", { name: "Map examples" })).toHaveCount(0);
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  expect(pmtilesRequests).toContain("bytes=0-16383");
  expect(externalTiles).toEqual([]);
});

test("first-party source switch preserves Map View, camera and native clustering @smoke", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  const map = page.locator('[data-map-runtime="maps"]');
  await expect(map).toBeVisible();
  await page.getByRole("combobox", { name: "Tile source" }).selectOption("mvt");
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-pmtiles-xyz");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await page.getByRole("combobox", { name: "Point count" }).selectOption("10000");
  await expect(page.getByText("10,000 synthetic points", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Tilt view" }).click();
  await expect(page.getByRole("button", { name: "Flatten view" })).toBeVisible();
  await page.getByRole("combobox", { name: "Tile source" }).selectOption("pmtiles");
  await expect(surface).toHaveAttribute("data-map-source-id", "maps-showcase");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(page.getByRole("button", { name: "Flatten view" })).toBeVisible();
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(page.getByRole("button", { name: "Tilt view" })).toBeVisible();
});

test("invalid first-party archive surfaces the error without external fallback @smoke", async ({
  page,
}) => {
  const externalTiles: string[] = [];
  page.on("request", (request) => {
    if (/openstreetmap\.org/.test(request.url())) externalTiles.push(request.url());
  });
  await page.route("**/tilesets/showcase-pmtiles-v1.pmtiles", (route) =>
    route.fulfill({ status: 200, body: "incorrect range response" }),
  );
  await page.goto("/?e2e=1");
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-state",
    "error",
  );
  await expect(page.getByRole("alert")).toContainText(/PMTiles.*Range/i);
  expect(externalTiles).toEqual([]);
});
