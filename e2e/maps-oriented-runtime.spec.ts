import { expect, test } from "@playwright/test";

test("Maps-owned bearing and pitch stay aligned through browser interaction @smoke", async ({
  page,
}) => {
  await page.goto("/?acceptance=maps-runtime-oriented");

  const map = page.getByLabel("Maps oriented Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-oriented-view-state");
  const contextCoordinate = page.getByTestId("maps-oriented-context-coordinate");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-map-base-renderer", /^(wgpu|canvas2d)$/);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(overlay).toHaveCount(1);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("bearing 30.00000 | pitch 45.00000");

  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  // The known point is exactly the geographic camera center. If application overlays and the
  // first-party base camera diverge under bearing/pitch, this center click will miss it.
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await expect(page.getByTestId("maps-oriented-selected-point")).toHaveText("oriented-berlin");
  await expect(page.getByTestId("maps-oriented-feature-popup")).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  const dragStart = {
    x: box!.x + box!.width * 0.74,
    y: box!.y + box!.height * 0.68,
  };
  const dragEnd = { x: dragStart.x + 72, y: dragStart.y + 34 };

  await probeCoordinate(page, contextCoordinate, dragStart.x, dragStart.y);
  const draggedGroundBefore = parseCoordinate(await contextCoordinate.textContent());

  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 });
  // Let the velocity sample go stale before release so this assertion observes the direct drag,
  // not the separately validated kinetic continuation.
  await page.waitForTimeout(180);
  await page.mouse.up();

  await probeCoordinate(page, contextCoordinate, dragEnd.x, dragEnd.y);
  const draggedGroundAfter = parseCoordinate(await contextCoordinate.textContent());
  expectCoordinateClose(draggedGroundAfter, draggedGroundBefore, 0.0002);

  const zoomAnchor = {
    x: box!.x + box!.width * 0.7,
    y: box!.y + box!.height * 0.4,
  };
  await probeCoordinate(page, contextCoordinate, zoomAnchor.x, zoomAnchor.y);
  const zoomGroundBefore = parseCoordinate(await contextCoordinate.textContent());
  const viewBeforeZoom = await viewState.textContent();

  await page.mouse.move(zoomAnchor.x, zoomAnchor.y);
  await page.mouse.wheel(0, -220);
  await expect.poll(async () => viewState.textContent()).not.toBe(viewBeforeZoom);

  await probeCoordinate(page, contextCoordinate, zoomAnchor.x, zoomAnchor.y);
  const zoomGroundAfter = parseCoordinate(await contextCoordinate.textContent());
  expectCoordinateClose(zoomGroundAfter, zoomGroundBefore, 0.0002);

  await page.getByRole("button", { name: "Apply oriented state" }).click();
  await expect(viewState).toContainText("zoom 7.50000 | bearing 55.00000 | pitch 35.00000");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

async function probeCoordinate(
  page: Parameters<typeof test>[0] extends never ? never : any,
  output: ReturnType<Parameters<typeof test>[1]> extends never ? never : any,
  x: number,
  y: number,
) {
  const previous = await output.textContent();
  await page.mouse.click(x, y, { button: "right" });
  await expect.poll(async () => output.textContent()).not.toBe(previous);
}

function parseCoordinate(text: string | null): [number, number] {
  const [longitude = Number.NaN, latitude = Number.NaN] = (text ?? "").split(",").map(Number);
  expect(Number.isFinite(longitude)).toBe(true);
  expect(Number.isFinite(latitude)).toBe(true);
  return [longitude, latitude];
}

function expectCoordinateClose(actual: [number, number], expected: [number, number], epsilon: number) {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThan(epsilon);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThan(epsilon);
}
