import { expect, test } from "@playwright/test";

for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`controlled first-party measurement and cancellation with mixed Map Layers on ${backend} @smoke`, async ({
    page,
  }) => {
    if (backend === "canvas2d") {
      await page.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "gpu", {
          configurable: true,
          get: () => undefined,
        }),
      );
    }
    await page.goto("/demo-reference/?acceptance=maps-measurement");
    const map = page.getByLabel("Controlled measurement Map View", { exact: true });
    await expect(map).toHaveAttribute("data-map-ready", "true");
    const base = map.locator('canvas[data-flat-runtime="maps"]');
    await expect(base).toHaveAttribute("data-map-base-renderer", backend);
    const layers = map.locator('canvas[data-map-overlay-runtime="maps"]');
    await expect
      .poll(async () => Number(await layers.getAttribute("data-map-overlay-primitives")))
      .toBeGreaterThan(3);
    const measurement = map.locator('canvas[data-map-measurement-runtime="maps"]');
    await expect(measurement).toBeVisible();
    const box = (await map.boundingBox())!;
    const start = { x: box.x + box.width * 0.42, y: box.y + box.height * 0.55 };
    const end = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.55 };
    const completed = page.getByLabel("Completed measurements", { exact: true });
    const draft = page.getByLabel("Measurement draft", { exact: true });
    const camera = page.getByLabel("Measurement camera", { exact: true });
    const initialCamera = await camera.textContent();

    await page.mouse.click(start.x, start.y);
    await expect(draft).toHaveText("Choose endpoint");
    await page.mouse.move(end.x, end.y);
    await expect(draft).toContainText("m");
    await expect(measurement).toHaveAttribute("data-measurement-draft", "true");
    await page.keyboard.press("Escape");
    await expect(draft).toHaveText("No draft");
    await expect(completed).toHaveText("[]");

    for (const cancellation of ["pointercancel", "lostpointercapture"] as const) {
      await page.mouse.click(start.x, start.y);
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await map.evaluate((element, type) => {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1 }));
      }, cancellation);
      await page.mouse.up();
      await expect(draft).toHaveText("No draft");
      await expect(completed).toHaveText("[]");
    }

    await page.mouse.click(start.x, start.y);
    await page.getByRole("button", { name: "Tilt map", exact: true }).click();
    await expect(map.getByRole("status")).toContainText("requires zero pitch");
    await expect(draft).toHaveText("No draft");
    await page.mouse.click(end.x, end.y);
    await expect(completed).toHaveText("[]");
    await page.getByRole("button", { name: "Reset tilt", exact: true }).click();
    await expect(map.getByRole("status")).toContainText("Choose two locations");

    await page.mouse.click(start.x, start.y);
    await page.mouse.move(end.x, end.y);
    await page.mouse.click(end.x, end.y);
    await expect(measurement).toHaveAttribute("data-measurement-count", "1");
    const source = JSON.parse((await completed.textContent())!);
    expect(source).toHaveLength(1);
    expect(source[0].from).not.toEqual(source[0].to);
    await expect(page.getByLabel("Selected map item", { exact: true })).toHaveText("none");
    await expect(camera).toHaveText(initialCamera!);
    await page.getByRole("button", { name: "Save measurements", exact: true }).click();
    await expect(page.getByLabel("Saved measurements", { exact: true })).toHaveText(
      JSON.stringify(source),
    );
    await page.getByRole("button", { name: "Navigate map", exact: true }).click();
    await page.mouse.click((start.x + end.x) / 2, (start.y + end.y) / 2);
    await expect(page.getByLabel("Selected map item", { exact: true })).toHaveText("measurement-1");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await expect(camera).not.toHaveText(initialCamera!);
    await expect(measurement).toHaveAttribute("data-measurement-count", "1");
    await expect(completed).toHaveText(JSON.stringify(source));
    await expect(layers).toBeVisible();
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  });
}

test.describe("touch measurement", () => {
  test.use({ hasTouch: true });
  test("touch cancellation releases measurement ownership without committing a partial line @smoke", async ({
    page,
  }) => {
    await page.goto("/demo-reference/?acceptance=maps-measurement");
    const map = page.getByLabel("Controlled measurement Map View", { exact: true });
    await expect(map).toHaveAttribute("data-map-ready", "true");
    const box = (await map.boundingBox())!;
    const start = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.6 };
    const end = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 };
    const draft = page.getByLabel("Measurement draft", { exact: true });
    const completed = page.getByLabel("Completed measurements", { exact: true });
    await page.touchscreen.tap(start.x, start.y);
    await expect(draft).toHaveText("Choose endpoint");
    const input = await page.context().newCDPSession(page);
    await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [end] });
    await input.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(draft).toHaveText("No draft");
    await expect(completed).toHaveText("[]");
    await page.touchscreen.tap(start.x, start.y);
    await page.touchscreen.tap(end.x, end.y);
    await expect(map.locator('canvas[data-map-measurement-runtime="maps"]')).toHaveAttribute(
      "data-measurement-count",
      "1",
    );
    await page.getByRole("button", { name: "Navigate map", exact: true }).click();
    await expect(map).toHaveAttribute("data-map-interaction-mode", "none");
    await input.detach();
  });
});
