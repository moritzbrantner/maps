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

test("real Atlas vector tiles render under an illustrative heat field on Pages", async ({
  page,
}) => {
  const external: string[] = [];
  const archiveResponses: number[] = [];
  page.on("request", (request) => {
    if (/tile\.openstreetmap\.org|vector\.openstreetmap\.org|geofabrik\.de/.test(request.url())) {
      external.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (
      response
        .url()
        .includes(
          "liechtenstein-a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4.pmtiles",
        )
    ) {
      archiveResponses.push(response.status());
    }
  });
  await page.goto("/maps/features/?feature=heat&basemap=atlas");
  const base = page.locator('canvas[data-flat-runtime="maps"]');
  const overlay = page.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect(page.locator('[data-map-runtime="maps"]')).toHaveAttribute(
    "aria-label",
    "Liechtenstein tiled temperature surface",
  );
  await expect(base).toHaveAttribute("data-map-source-id", "maps-liechtenstein");
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
  await expect(
    page.getByText("Real Liechtenstein OpenStreetMap tiles", { exact: false }),
  ).toBeVisible();
  await test.info().attach("real-atlas-heat-tiles.png", {
    contentType: "image/png",
    body: await page.locator('[data-map-runtime="maps"]').screenshot(),
  });
  expect(archiveResponses).toContain(206);
  expect(external).toEqual([]);
});
