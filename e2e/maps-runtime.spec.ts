import { expect, test } from "@playwright/test";

test("Maps-owned MapView runs the real Rust/WASM flat runtime @smoke", async ({ page }) => {
  await page.goto("/?acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('[data-map-overlay-runtime="maps"]');
  const point = overlay.locator('[data-map-feature-id="acceptance-berlin"]');
  const polygon = overlay.locator('[data-map-feature-id="acceptance-zone"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  const interaction = page.getByTestId("maps-runtime-interaction");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(overlay).toHaveCount(1);
  await expect(point).toHaveCount(1);
  await expect(polygon).toHaveCount(1);
  await expect(point).toHaveAttribute("data-map-feature-interactive", "true");
  await expect(polygon).toHaveAttribute("data-map-feature-interactive", "true");
  await expect(point).toHaveClass(/mb-maps__feature--hovered/);
  await expect(polygon).toHaveClass(/mb-maps__feature--selected/);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("13.4050,52.5200 | zoom 6.0000");

  await point.hover();
  await expect(interaction).toHaveText("point:hover:acceptance-berlin");
  await expect(page.getByText("Hover Berlin")).toBeVisible();

  await point.click();
  await expect(interaction).toHaveText("point:click:acceptance-berlin");
  await expect(point).toHaveClass(/mb-maps__feature--selected/);
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  await point.click({ button: "right" });
  await expect(interaction).toHaveText("point:context-menu:acceptance-berlin");
  await expect(page.getByRole("button", { name: /Context Berlin at 13\.405,52\.520/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await polygon.click({ position: { x: 12, y: 12 } });
  await expect(interaction).toHaveText("geojson:click:acceptance-zone");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText(
    "GeoJSON acceptance-zone",
  );
  await page.keyboard.press("Escape");

  const initialViewState = await viewState.textContent();
  const initialPointPosition = await projectedPointPosition(point);
  const initialPolygonPath = await polygon.getAttribute("d");
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.35);
  await page.mouse.wheel(0, -240);

  await expect
    .poll(async () => viewState.textContent())
    .not.toBe(initialViewState);
  await expect
    .poll(async () => projectedPointPosition(point))
    .not.toEqual(initialPointPosition);
  await expect.poll(async () => polygon.getAttribute("d")).not.toBe(initialPolygonPath);

  const zoomedViewState = await viewState.textContent();
  const zoomedPointPosition = await projectedPointPosition(point);

  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.5 + 96, box!.y + box!.height * 0.5 + 36, {
    steps: 4,
  });
  await page.mouse.up();

  await expect
    .poll(async () => viewState.textContent())
    .not.toBe(zoomedViewState);
  await expect
    .poll(async () => projectedPointPosition(point))
    .not.toEqual(zoomedPointPosition);

  const releasedViewState = await viewState.textContent();
  await expect
    .poll(async () => viewState.textContent())
    .not.toBe(releasedViewState);

  await page.waitForTimeout(850);
  const settledViewState = await viewState.textContent();
  await page.waitForTimeout(120);
  expect(await viewState.textContent()).toBe(settledViewState);

  const draggedViewState = parseViewState(settledViewState);
  const draggedPointPosition = await projectedPointPosition(point);
  const cdp = await page.context().newCDPSession(page);
  const touchCenter = {
    x: box!.x + box!.width * 0.5,
    y: box!.y + box!.height * 0.5,
  };

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 0, x: touchCenter.x - 40, y: touchCenter.y },
      { id: 1, x: touchCenter.x + 40, y: touchCenter.y },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 0, x: touchCenter.x - 80, y: touchCenter.y - 12 },
      { id: 1, x: touchCenter.x + 80, y: touchCenter.y + 12 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  await expect
    .poll(async () => parseViewState(await viewState.textContent()).zoom)
    .toBeGreaterThan(draggedViewState.zoom);
  await expect
    .poll(async () => projectedPointPosition(point))
    .not.toEqual(draggedPointPosition);

  await page.getByRole("button", { name: "Fit acceptance bounds" }).click();
  await expect(viewState).toHaveText(/^0\.0000,45\.\d{4} \| zoom \d+\.\d{4}$/);

  await page.getByRole("button", { name: "Request outside bounds" }).click();
  await expect
    .poll(async () => isInsideAcceptanceBounds(parseViewState(await viewState.textContent())))
    .toBe(true);
  const constrained = parseViewState(await viewState.textContent());
  expect(constrained.zoom).toBeGreaterThan(1);

  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, 10_000);
  await expect
    .poll(async () => isInsideAcceptanceBounds(parseViewState(await viewState.textContent())))
    .toBe(true);
  expect(parseViewState(await viewState.textContent()).zoom).toBeGreaterThanOrEqual(
    constrained.zoom - 0.0001,
  );

  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

async function projectedPointPosition(point: import("@playwright/test").Locator) {
  return {
    cx: await point.getAttribute("cx"),
    cy: await point.getAttribute("cy"),
  };
}

function parseViewState(text: string | null) {
  const [coordinates = "", zoomText = ""] = (text ?? "").split(" | zoom ");
  const [longitude = Number.NaN, latitude = Number.NaN] = coordinates.split(",").map(Number);

  return {
    center: [longitude, latitude] as [number, number],
    zoom: Number(zoomText),
  };
}

function isInsideAcceptanceBounds(viewState: ReturnType<typeof parseViewState>) {
  return (
    Number.isFinite(viewState.center[0]) &&
    Number.isFinite(viewState.center[1]) &&
    viewState.center[0] >= -25 &&
    viewState.center[0] <= 35 &&
    viewState.center[1] >= 34 &&
    viewState.center[1] <= 66
  );
}
