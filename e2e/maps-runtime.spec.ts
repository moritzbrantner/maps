import { expect, test, type Page } from "@playwright/test";

type OverlayArc = { radius: number; x: number; y: number };
type OverlayTrace = {
  arcs: OverlayArc[];
  polygonBounds: { maxX: number; maxY: number; minX: number; minY: number } | null;
};

test("Maps-owned MapView runs the real Rust/WASM flat runtime @smoke", async ({ page }) => {
  await installCanvasOverlayTrace(page);
  await page.goto("/?acceptance=maps-runtime");

  const map = page.getByLabel("Maps Rust runtime acceptance");
  const canvas = map.locator('canvas[data-flat-runtime="maps"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const viewState = page.getByTestId("maps-runtime-view-state");
  const clusterSummary = page.getByTestId("maps-runtime-cluster-summary");
  const interaction = page.getByTestId("maps-runtime-interaction");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(canvas).toBeVisible();
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "canvas2d");
  await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "3");
  await expect(map.locator('svg[data-map-overlay-runtime="maps"]')).toHaveCount(0);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(viewState).toContainText("13.4050,52.5200 | zoom 6.0000");
  await expect(clusterSummary).toHaveText("1/0/3");
  await expect.poll(async () => overlayPointPosition(page)).not.toBeNull();
  await expect.poll(async () => overlayClusterPosition(page)).not.toBeNull();
  await expect.poll(async () => (await readOverlayTrace(page)).polygonBounds).not.toBeNull();

  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
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
  await expect(page.getByRole("button", { name: /Context Berlin at 13\.405,52\.520/ })).toBeVisible();
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

  // Start well outside the application overlays so the Milestone B gesture host,
  // not the feature-picking boundary, owns this pointer sequence.
  await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.8 + 96, box!.y + box!.height * 0.75 + 36, {
    steps: 4,
  });
  await page.mouse.up();

  await expect.poll(async () => viewState.textContent()).not.toBe(zoomedViewState);
  await expect.poll(async () => overlayPointPosition(page)).not.toEqual(zoomedPointPosition);

  const releasedViewState = await viewState.textContent();
  await expect.poll(async () => viewState.textContent()).not.toBe(releasedViewState);

  await page.waitForTimeout(850);
  const settledViewState = await viewState.textContent();
  await page.waitForTimeout(120);
  expect(await viewState.textContent()).toBe(settledViewState);

  const draggedViewState = parseViewState(settledViewState);
  const draggedPointPosition = await overlayPointPosition(page);
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

  await expect(clusterSummary).toHaveText("1/0/3");
  const beforeClusterExpand = parseViewState(await viewState.textContent());
  const clusterPosition = await overlayClusterPosition(page);
  await page.mouse.click(overlayBox!.x + clusterPosition.x, overlayBox!.y + clusterPosition.y);
  await expect(interaction).toHaveText("cluster:click:acceptance-cluster");
  await expect(page.getByTestId("maps-runtime-feature-popup")).toHaveText("Cluster 3");
  await expect
    .poll(async () => parseViewState(await viewState.textContent()).zoom)
    .toBeGreaterThan(beforeClusterExpand.zoom);

  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

async function installCanvasOverlayTrace(page: Page) {
  await page.addInitScript(() => {
    type TraceWindow = Window & { __mapsOverlayTrace?: OverlayTrace };
    const traceWindow = window as TraceWindow;
    const paths = new WeakMap<CanvasRenderingContext2D, Array<{ x: number; y: number }>>();
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    const originalBeginPath = CanvasRenderingContext2D.prototype.beginPath;
    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
    const originalLineTo = CanvasRenderingContext2D.prototype.lineTo;
    const originalMoveTo = CanvasRenderingContext2D.prototype.moveTo;

    function ensureTrace() {
      traceWindow.__mapsOverlayTrace ??= { arcs: [], polygonBounds: null };
      return traceWindow.__mapsOverlayTrace;
    }

    function isOverlay(context: CanvasRenderingContext2D) {
      return context.canvas.dataset.mapOverlayRuntime === "maps";
    }

    function commitPath(context: CanvasRenderingContext2D) {
      if (!isOverlay(context)) return;
      const points = paths.get(context) ?? [];
      if (points.length < 3) return;
      ensureTrace().polygonBounds = {
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
      };
    }

    CanvasRenderingContext2D.prototype.clearRect = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number,
    ) {
      if (isOverlay(this)) {
        traceWindow.__mapsOverlayTrace = { arcs: [], polygonBounds: null };
        paths.set(this, []);
      }
      return originalClearRect.call(this, x, y, width, height);
    };

    CanvasRenderingContext2D.prototype.beginPath = function (this: CanvasRenderingContext2D) {
      commitPath(this);
      if (isOverlay(this)) paths.set(this, []);
      return originalBeginPath.call(this);
    };

    CanvasRenderingContext2D.prototype.moveTo = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
    ) {
      if (isOverlay(this)) paths.get(this)?.push({ x, y });
      return originalMoveTo.call(this, x, y);
    };

    CanvasRenderingContext2D.prototype.lineTo = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
    ) {
      if (isOverlay(this)) paths.get(this)?.push({ x, y });
      return originalLineTo.call(this, x, y);
    };

    CanvasRenderingContext2D.prototype.arc = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      radius: number,
      startAngle: number,
      endAngle: number,
      counterclockwise?: boolean,
    ) {
      if (isOverlay(this)) {
        ensureTrace().arcs.push({ radius, x, y });
      }
      return originalArc.call(this, x, y, radius, startAngle, endAngle, counterclockwise);
    };
  });
}

async function readOverlayTrace(page: Page): Promise<OverlayTrace> {
  return page.evaluate(() => {
    return (
      (window as Window & { __mapsOverlayTrace?: OverlayTrace }).__mapsOverlayTrace ?? {
        arcs: [],
        polygonBounds: null,
      }
    );
  });
}

async function overlayPointPosition(page: Page) {
  const arc = (await readOverlayTrace(page)).arcs.find((candidate) => candidate.radius === 8);
  if (!arc) throw new Error("Canvas overlay point was not drawn.");
  return { x: arc.x, y: arc.y };
}

async function overlayClusterPosition(page: Page) {
  const arcs = (await readOverlayTrace(page)).arcs.filter((candidate) => candidate.radius > 8);
  const arc = arcs.sort((left, right) => right.radius - left.radius)[0];
  if (!arc) throw new Error("Canvas overlay cluster was not drawn.");
  return { x: arc.x, y: arc.y };
}

async function overlayPolygonBounds(page: Page) {
  const bounds = (await readOverlayTrace(page)).polygonBounds;
  if (!bounds) throw new Error("Canvas overlay polygon was not drawn.");
  return bounds;
}

async function polygonPickPosition(page: Page) {
  const point = await overlayPointPosition(page);
  const bounds = await overlayPolygonBounds(page);
  const inset = 4;
  const candidates = [
    { x: bounds.minX + inset, y: bounds.minY + inset },
    { x: bounds.maxX - inset, y: bounds.minY + inset },
    { x: bounds.minX + inset, y: bounds.maxY - inset },
    { x: bounds.maxX - inset, y: bounds.maxY - inset },
  ];

  return candidates.sort((left, right) => {
    const leftDistance = (left.x - point.x) ** 2 + (left.y - point.y) ** 2;
    const rightDistance = (right.x - point.x) ** 2 + (right.y - point.y) ** 2;
    return rightDistance - leftDistance;
  })[0]!;
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
