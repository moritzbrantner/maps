import { expect, test } from "@playwright/test";

test("feature pages survive direct navigation and refresh under the Pages base path", async ({
  page,
}) => {
  const errors: string[] = [];
  const referenceRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/maplibre-gl|leaflet(?:\.js|\/)|openstreetmap\.org/.test(request.url())) {
      referenceRequests.push(request.url());
    }
  });
  const map = page.locator('[data-map-runtime="maps"]');

  await page.goto("/maps/features/?feature=heat&mode=contours");
  await expect(page.getByRole("heading", { name: "Maps features" })).toBeVisible();
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Level lines" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Colors" }).click();
  await expect(page).toHaveURL(/\/maps\/features\/\?feature=heat&mode=raster$/);
  await page.reload();
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Colors" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("link", { name: "Timeline", exact: true }).click();
  await expect(page).toHaveURL(/\/maps\/features\/\?feature=timeline$/);
  await expect(map).toHaveAttribute("aria-label", "Freight timeline");
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Engine", exact: true })).toHaveAttribute(
    "href",
    "/maps/engine/",
  );

  await page.goto("/maps/engine/?source=pmtiles");
  await expect(page.getByRole("link", { name: "Features", exact: true })).toHaveAttribute(
    "href",
    "/maps/features/",
  );
  expect(referenceRequests).toEqual([]);
  expect(errors).toEqual([]);
});
