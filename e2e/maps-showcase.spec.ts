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
  await expect(runtimeStatus).toHaveAttribute("data-state", /verified|unavailable/);
  await expect(page.getByText("MapLibre + Canvas2D", { exact: true })).toBeVisible();
  await expect(page.locator(".mb-maps").first()).toBeVisible();
});

test("renderer comparison switches pixels without replacing the map camera @smoke", async ({ page }) => {
  await page.goto("/?e2e=1");

  const comparison = page.getByTestId("renderer-comparison");
  await comparison.scrollIntoViewIfNeeded();
  await expect(comparison.getByText("Same Maps frame, different pixels")).toBeVisible();
  await expect(comparison.getByText("Backend:").locator(".." )).toContainText("MapLibre");

  const renderer = comparison.getByLabel("Point cluster renderer");
  await renderer.selectOption("canvas2d");

  await expect(comparison.locator('canvas[data-map-renderer="canvas2d"]')).toBeVisible();
  await expect(comparison.getByText("Backend:").locator(".." )).toContainText("Canvas2D");
  await expect(comparison.locator(".maplibregl-canvas")).toBeVisible();

  await renderer.selectOption("maplibre");
  await expect(comparison.locator('canvas[data-map-renderer="canvas2d"]')).toHaveCount(0);
  await expect(comparison.getByText("Backend:").locator(".." )).toContainText("MapLibre");
});
