import { expect, test } from "@playwright/test";

test("Pages showcase makes the Map Library capabilities and runtime boundary visible @smoke", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  await expect(page.getByRole("heading", { name: "Map building blocks, end to end." })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Map examples" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Clusters" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Editor" })).toBeVisible();

  const runtimeStatus = page.getByTestId("rust-runtime-status");
  await expect(runtimeStatus).toHaveAttribute("data-state", "authoritative");
  await expect(runtimeStatus).toContainText("Rust authoritative");
  await expect(page.getByText("MapLibre + Canvas2D", { exact: true })).toBeVisible();
  await expect(page.locator(".mb-maps").first()).toBeVisible();
});

test("renderer comparison exposes the first-party Maps runtime and reference paths @smoke", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  const comparison = page.getByTestId("renderer-comparison");
  await comparison.scrollIntoViewIfNeeded();
  await expect(comparison.getByText("Same Maps frame, different pixels")).toBeVisible();
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("Maps engine");
  await expect(comparison.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(comparison.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    /canvas2d|wgpu/,
  );

  const renderer = comparison.getByLabel("Renderer path");
  await renderer.selectOption("canvas2d");

  const cameraCanvas = comparison.locator(".maplibregl-canvas");
  await expect(cameraCanvas).toBeVisible();
  await cameraCanvas.evaluate((element) => element.setAttribute("data-camera-sentinel", "stable"));
  await expect(comparison.locator('canvas[data-map-renderer="canvas2d"]')).toBeVisible();
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("Canvas2D");

  await renderer.selectOption("maplibre");
  await expect(comparison.locator('canvas[data-map-renderer="canvas2d"]')).toHaveCount(0);
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("MapLibre");
  await expect(comparison.locator('.maplibregl-canvas[data-camera-sentinel="stable"]')).toBeVisible();

  await renderer.selectOption("maps");
  await expect(comparison.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(comparison.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("Maps engine");
});
