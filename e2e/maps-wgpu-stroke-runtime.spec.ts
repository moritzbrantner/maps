import { expect, test } from "@playwright/test";

test("Maps wgpu keeps mixed point and flow geometry on the first-party GPU path @smoke", async ({
  page,
}) => {
  await page.goto("/?acceptance=maps-runtime-wgpu-strokes");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const baseCanvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(baseCanvas).toHaveAttribute("data-map-base-renderer", "wgpu");
  await expect
    .poll(async () => Number(await baseCanvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);

  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "6");
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "wgpu");
  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 3 points",
  );
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});
