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
  await expect(page.getByText("Rust/WASM + wgpu", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Benchmarks" })).toHaveAttribute(
    "href",
    "/benchmarks/",
  );
  await expect(page.locator(".mb-maps").first()).toBeVisible();
});

test("renderer comparison exposes the first-party Maps engine and MapLibre reference @smoke", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  const comparison = page.getByTestId("renderer-comparison");
  await comparison.scrollIntoViewIfNeeded();
  await expect(comparison.getByText("First-party Maps engine")).toBeVisible();
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("Maps engine");
  await expect(comparison.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(comparison.locator(".maplibregl-canvas")).toHaveCount(0);

  const engine = comparison.getByLabel("Map engine");
  await expect(engine.locator('option[value="maps"]')).toHaveText("Maps engine (first-party)");
  await expect(engine.locator('option[value="canvas2d"]')).toHaveCount(0);

  await engine.selectOption("maplibre");
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("MapLibre reference");
  await expect(comparison.locator(".maplibregl-canvas")).toBeVisible();

  await engine.selectOption("maps");
  await expect(comparison.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(comparison.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(comparison.getByText("Backend:").locator("..")).toContainText("Maps engine");
});
