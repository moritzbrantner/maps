import { expect, test } from "@playwright/test";

test("Maps-owned MapView runs the real Rust/WASM flat runtime @smoke", async ({ page }) => {
  await page.goto("/?acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("13.4050,52.5200 | zoom 6.0000");

  const initialViewState = await viewState.textContent();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.35);
  await page.mouse.wheel(0, -240);

  await expect
    .poll(async () => viewState.textContent())
    .not.toBe(initialViewState);
  const zoomedViewState = await viewState.textContent();

  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.5 + 96, box!.y + box!.height * 0.5 + 36, {
    steps: 4,
  });
  await page.mouse.up();

  await expect
    .poll(async () => viewState.textContent())
    .not.toBe(zoomedViewState);

  await page.getByRole("button", { name: "Fit acceptance bounds" }).click();

  await expect(viewState).toHaveText(/^0\.0000,45\.\d{4} \| zoom \d+\.\d{4}$/);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});
