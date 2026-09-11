import { expect, test } from "@playwright/test";

test("Maps-owned MapView runs the real Rust/WASM flat runtime @smoke", async ({ page }) => {
  await page.goto("/?acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('[data-map-overlay-runtime="maps"]');
  const point = overlay.locator('[data-map-feature-id="acceptance-berlin"]');
  const polygon = overlay.locator('[data-map-feature-id="acceptance-zone"]');
  const viewState = page.getByTestId("maps-runtime-view-state");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(overlay).toHaveCount(1);
  await expect(point).toHaveCount(1);
  await expect(polygon).toHaveCount(1);
  await expect(point).toHaveClass(/mb-maps__feature--hovered/);
  await expect(polygon).toHaveClass(/mb-maps__feature--selected/);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("13.4050,52.5200 | zoom 6.0000");

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
  const [longitude = Number.NaN, latitude = Number.NaN] = coordinates
    .split(",")
    .map(Number);

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
