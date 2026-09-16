import { expect, test, type Locator, type Page } from "@playwright/test";

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
  await expect.poll(async () => overlay.getAttribute("data-map-overlay-backend")).toBe("canvas2d");
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
    .toBe(2);
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-primitives")))
    .toBeGreaterThan(8);
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
  const draggedGroundBefore = await probeCoordinate(
    page,
    contextCoordinate,
    dragStart.x,
    dragStart.y,
  );

  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 });
  // Let the velocity sample go stale before release so this assertion observes the direct drag,
  // not the separately validated kinetic continuation.
  await page.waitForTimeout(180);
  await page.mouse.up();

  const draggedGroundAfter = await probeCoordinate(
    page,
    contextCoordinate,
    dragEnd.x,
    dragEnd.y,
  );
  expectCoordinateClose(draggedGroundAfter, draggedGroundBefore, 0.0002);

  // Chromium wheel/touch injection is pixel-addressed. Use an integer browser coordinate so all
  // browser input and the geographic probes observe exactly the same off-center screen anchor.
  const zoomAnchor = {
    x: Math.round(box!.x + box!.width * 0.7),
    y: Math.round(box!.y + box!.height * 0.4),
  };
  const zoomGroundBefore = await probeCoordinate(
    page,
    contextCoordinate,
    zoomAnchor.x,
    zoomAnchor.y,
  );
  const viewBeforeZoom = await viewState.textContent();

  await wheelZoomAt(page, zoomAnchor);
  await expect.poll(async () => viewState.textContent()).not.toBe(viewBeforeZoom);

  const zoomGroundAfter = await probeCoordinate(
    page,
    contextCoordinate,
    zoomAnchor.x,
    zoomAnchor.y,
  );
  expectCoordinateClose(zoomGroundAfter, zoomGroundBefore, 0.0002);

  const pinchGroundBefore = await probeCoordinate(
    page,
    contextCoordinate,
    zoomAnchor.x,
    zoomAnchor.y,
  );
  const viewBeforePinch = await viewState.textContent();

  await pinchZoomAt(page, zoomAnchor);
  await expect.poll(async () => viewState.textContent()).not.toBe(viewBeforePinch);

  const pinchGroundAfter = await probeCoordinate(
    page,
    contextCoordinate,
    zoomAnchor.x,
    zoomAnchor.y,
  );
  expectCoordinateClose(pinchGroundAfter, pinchGroundBefore, 0.0002);

  await page.getByRole("button", { name: "Apply oriented state" }).click();
  await expect(viewState).toContainText("zoom 7.50000 | bearing 55.00000 | pitch 35.00000");
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
    .toBe(2);
  await expect.poll(async () => overlay.getAttribute("data-map-overlay-backend")).toBe("canvas2d");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

async function probeCoordinate(page: Page, output: Locator, x: number, y: number) {
  const previous = await output.textContent();
  await page.mouse.click(x, y, { button: "right" });
  await expect.poll(async () => output.textContent()).not.toBe(previous);
  return parseCoordinate(await output.textContent());
}

async function wheelZoomAt(page: Page, center: { x: number; y: number }) {
  const client = await page.context().newCDPSession(page);

  try {
    await client.send("Input.dispatchMouseEvent", {
      deltaX: 0,
      deltaY: -220,
      type: "mouseWheel",
      x: center.x,
      y: center.y,
    });
  } finally {
    await client.detach();
  }
}

async function pinchZoomAt(page: Page, center: { x: number; y: number }) {
  const client = await page.context().newCDPSession(page);

  try {
    await client.send("Input.dispatchTouchEvent", {
      touchPoints: [
        { id: 1, x: center.x - 24, y: center.y },
        { id: 2, x: center.x + 24, y: center.y },
      ],
      type: "touchStart",
    });
    await client.send("Input.dispatchTouchEvent", {
      touchPoints: [
        { id: 1, x: center.x - 76, y: center.y },
        { id: 2, x: center.x + 76, y: center.y },
      ],
      type: "touchMove",
    });
    await client.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
  } finally {
    await client.detach();
  }
}

function parseCoordinate(text: string | null): [number, number] {
  const coordinateText = (text ?? "").split("|").at(-1) ?? "";
  const [longitude = Number.NaN, latitude = Number.NaN] = coordinateText.split(",").map(Number);
  expect(Number.isFinite(longitude)).toBe(true);
  expect(Number.isFinite(latitude)).toBe(true);
  return [longitude, latitude];
}

function expectCoordinateClose(actual: [number, number], expected: [number, number], epsilon: number) {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThan(epsilon);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThan(epsilon);
}
