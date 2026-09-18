import { expect, test, type Page } from "@playwright/test";

const VISIBLE_RASTER_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGMM2FLxnwEPYMInOXwUAACRIgKL3I8IIQAAAABJRU5ErkJggg==",
  "base64",
);

test("Maps-owned MapView runs the real Rust/WASM flat runtime @smoke", async ({ page }) => {
  await page.goto("/?acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  const interaction = page.getByTestId("maps-runtime-interaction");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-map-base-renderer", /^(wgpu|canvas2d)$/);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", /^(wgpu|canvas2d)$/);
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect(map.locator('svg[data-map-overlay-runtime="maps"]')).toHaveCount(0);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("13.4050,52.5200 | zoom 6.0000");
  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 3 points",
  );
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
  const flowPosition = await overlayFlowPosition(page);

  await page.mouse.move(overlayBox!.x + flowPosition.x, overlayBox!.y + flowPosition.y);
  await expect(interaction).toHaveText("flow:hover:acceptance-flow");
  await expect(page.getByText("Hover flow acceptance-route")).toBeVisible();

  await page.mouse.click(overlayBox!.x + flowPosition.x, overlayBox!.y + flowPosition.y);
  await expect(interaction).toHaveText("flow:click:acceptance-flow");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Flow acceptance-route");
  await page.keyboard.press("Escape");

  const pointPosition = await overlayPointPosition(page);
  await page.mouse.move(overlayBox!.x + pointPosition.x, overlayBox!.y + pointPosition.y);
  await expect(interaction).toHaveText("point:hover:acceptance-berlin");
  await expect(page.getByText("Hover Berlin")).toBeVisible();

  await page.mouse.click(overlayBox!.x + pointPosition.x, overlayBox!.y + pointPosition.y);
  await expect(interaction).toHaveText("point:click:acceptance-berlin");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Selected Berlin");
  await page.keyboard.press("Escape");

  await page.mouse.click(overlayBox!.x + pointPosition.x, overlayBox!.y + pointPosition.y, {
    button: "right",
  });
  await expect(interaction).toHaveText("point:context-menu:acceptance-berlin");
  await expect(
    page.getByRole("button", { name: /Context Berlin at 13\.405,52\.520/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const polygonPosition = await polygonPickPosition(page);
  await page.mouse.click(overlayBox!.x + polygonPosition.x, overlayBox!.y + polygonPosition.y);
  await expect(interaction).toHaveText("geojson:click:acceptance-zone");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText(
    "GeoJSON acceptance-zone",
  );
  await page.keyboard.press("Escape");

  const initialViewState = await viewState.textContent();
  const initialPointPosition = await overlayPointPosition(page);
  const initialPolygonBounds = await overlayPolygonBounds(page);
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.35);
  await page.mouse.wheel(0, -240);

  await expect.poll(async () => viewState.textContent()).not.toBe(initialViewState);
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(initialPointPosition);
  await expect.poll(async () => overlayPolygonBounds(page)).not.toEqual(initialPolygonBounds);

  const zoomedViewState = await viewState.textContent();
  const zoomedPointPosition = await overlayPointPosition(page);
  const cdp = await page.context().newCDPSession(page);
  const dragStart = {
    x: box!.x + box!.width * 0.8,
    y: box!.y + box!.height * 0.75,
  };
  const dragEnd = { x: dragStart.x + 96, y: dragStart.y + 36 };
  const dragTimestamp =
    (await page.evaluate(() => performance.timeOrigin + performance.now() - 200)) / 1000;

  // Start well outside the application overlays so the Milestone B gesture host,
  // not the feature-picking boundary, owns this pointer sequence. Give Chromium explicit
  // 16 ms input timestamps so the velocity tracker sees deterministic positive sample gaps
  // inside its 80 ms acceptance window, independent of CI scheduling latency.
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: dragStart.x,
    y: dragStart.y,
    timestamp: dragTimestamp,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: dragStart.x,
    y: dragStart.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    timestamp: dragTimestamp + 0.016,
  });
  for (let step = 1; step <= 4; step += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dragStart.x + ((dragEnd.x - dragStart.x) * step) / 4,
      y: dragStart.y + ((dragEnd.y - dragStart.y) * step) / 4,
      button: "left",
      buttons: 1,
      timestamp: dragTimestamp + 0.016 * (step + 1),
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: dragEnd.x,
    y: dragEnd.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    timestamp: dragTimestamp + 0.096,
  });
  const releasedViewState = await viewState.textContent();

  await expect.poll(async () => viewState.textContent()).not.toBe(zoomedViewState);
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(zoomedPointPosition);
  await expect.poll(async () => viewState.textContent()).not.toBe(releasedViewState);

  await page.waitForTimeout(850);
  const settledViewState = await viewState.textContent();
  await page.waitForTimeout(120);
  expect(await viewState.textContent()).toBe(settledViewState);

  const draggedViewState = parseViewState(settledViewState);
  const draggedPointPosition = await overlayPointPosition(page);
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
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(draggedPointPosition);

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

test("first-party raster loader requests image tiles and renders them @smoke", async ({ page }) => {
  const acceptedHeaders: string[] = [];

  await page.route("https://tiles.example.test/**", async (route) => {
    const headers = await route.request().allHeaders();
    acceptedHeaders.push(headers.accept ?? "");
    await route.fulfill({
      body: VISIBLE_RASTER_TILE,
      contentType: "image/png",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      status: 200,
    });
  });

  await page.goto("/?acceptance=maps-runtime-raster-fetch");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))
    .toBeGreaterThan(0);
  expect(acceptedHeaders.length).toBeGreaterThan(0);
  expect(acceptedHeaders.every((header) => header.includes("image/"))).toBe(true);
  await expect(canvas).not.toHaveAttribute("data-map-base-tile-error", /.+/);
});

test("ClusterLayer uses Rust aggregation and shared picking @smoke", async ({ page }) => {
  await page.goto("/?acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  const interaction = page.getByTestId("maps-runtime-interaction");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "7");
  await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
    "1 clusters / 3 points",
  );

  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
  const clusterPosition = await overlayClusterPosition(page);
  const initialZoom = parseViewState(await viewState.textContent()).zoom;

  await page.mouse.click(overlayBox!.x + clusterPosition.x, overlayBox!.y + clusterPosition.y);

  await expect(interaction).toHaveText("cluster:click:acceptance-hamburg-cluster");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Cluster 3");
  await expect
    .poll(async () => parseViewState(await viewState.textContent()).zoom)
    .toBeGreaterThan(initialZoom);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

async function overlayPointPosition(page: Page) {
  return projectAcceptanceCoordinate(page, [13.405, 52.52]);
}

async function overlayClusterPosition(page: Page) {
  return projectAcceptanceCoordinate(page, [9.9937, 53.5511]);
}

async function overlayFlowPosition(page: Page) {
  const from = await projectAcceptanceCoordinate(page, [11.8, 52]);
  const to = await projectAcceptanceCoordinate(page, [12.8, 52]);
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

async function overlayPolygonBounds(page: Page) {
  const points = await Promise.all(
    [
      [13.1, 52.35],
      [13.72, 52.35],
      [13.72, 52.7],
      [13.1, 52.7],
    ].map((coordinate) =>
      projectAcceptanceCoordinate(page, coordinate as [longitude: number, latitude: number]),
    ),
  );
  return {
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
  };
}

async function polygonPickPosition(page: Page) {
  return projectAcceptanceCoordinate(page, [13.2, 52.45]);
}

async function projectAcceptanceCoordinate(
  page: Page,
  coordinate: [longitude: number, latitude: number],
) {
  const overlay = page
    .getByLabel("Maps Rust runtime acceptance")
    .locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = await overlay.boundingBox();
  if (!bounds) throw new Error("Maps overlay has no layout bounds.");

  const viewState = parseViewState(
    await page.getByTestId("maps-runtime-view-state").textContent(),
  );
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(viewState.center);
  const worldSize = 512 * 2 ** viewState.zoom;
  let dx = target.x - center.x;
  if (dx >= 0.5) dx -= 1;
  if (dx < -0.5) dx += 1;

  return {
    x: bounds.width / 2 + dx * worldSize,
    y: bounds.height / 2 + (target.y - center.y) * worldSize,
  };
}

function projectWebMercator([longitude, latitude]: [number, number]) {
  const wrappedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
  const clampedLatitude = Math.min(85.0511287798066, Math.max(-85.0511287798066, latitude));
  const radians = (clampedLatitude * Math.PI) / 180;
  return {
    x: (wrappedLongitude + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
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
