import { expect, test, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";

type ViewState = {
  center: [number, number];
  zoom: number;
};

type DemoView =
  | "Clusters"
  | "Points"
  | "Heat"
  | "Flows"
  | "Composed"
  | "Timeline"
  | "Interpolation"
  | "Globe"
  | "GeoJSON"
  | "Editor";

const benignConsolePatterns = [
  /Failed to load resource: net::ERR_ABORTED/,
  /Could not compile fragment shader/,
  /WebGL: INVALID_OPERATION/,
];

test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];

  page.on("close", () => {
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
  });
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }

    const text = message.text();

    if (benignConsolePatterns.some((pattern) => pattern.test(text))) {
      return;
    }

    consoleErrors.push(text);
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto("/?e2e=1");
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }

      .flat-tile-pane {
        opacity: 0 !important;
      }

      .mb-maps {
        background: #eef2f7 !important;
      }
    `,
  });
  await expect(page.locator(".mb-maps").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.exposeFunction("__getConsoleErrors", () => consoleErrors);
});

test.afterEach(async ({ page }) => {
  const consoleErrors = await page.evaluate(async () => {
    const getter = (window as unknown as { __getConsoleErrors?: () => string[] })
      .__getConsoleErrors;

    return getter?.() ?? [];
  });

  expect(consoleErrors).toEqual([]);
});

test("interaction viewport gestures update the Flat Map state @smoke", async ({ page }) => {
  await openView(page, "Clusters");

  const beforePan = await getProbeViewState(page);
  await dragMap(page, { x: 0.62, y: 0.52 }, { x: 0.42, y: 0.52 });
  await expectViewStateChanged(page, beforePan, "pan");

  const beforeWheel = await getProbeViewState(page);
  await wheelMap(page, -500);
  await expectViewStateChanged(page, beforeWheel, "zoom");

  const beforeZoomButton = await getProbeViewState(page);
  await page.locator(".maplibregl-ctrl-zoom-in").first().click();
  await expectViewStateChanged(page, beforeZoomButton, "zoom");

  const beforeDoubleClick = await getProbeViewState(page);
  await doubleClickMap(page, { x: 0.52, y: 0.48 });
  await expectViewStateChanged(page, beforeDoubleClick, "zoom");

  const beforeKeyboard = await getProbeViewState(page);
  await keyboardMap(page, ["ArrowRight", "+"]);
  await expectViewStateChanged(page, beforeKeyboard, "any");

  const beforeBoxZoom = await getProbeViewState(page);
  await shiftDragBoxZoom(page);
  await expectViewStateChanged(page, beforeBoxZoom, "any");
});

test("interaction view switching preserves usable Map View state", async ({ page }) => {
  for (const view of ["Clusters", "Points", "Flows", "Editor", "Clusters"] as const) {
    await openView(page, view);
    await expect(page.locator(".mb-maps").first()).toHaveAttribute("data-map-ready", "true");
    await expect.poll(() => getActiveView(page)).toBe(view.toLowerCase());
  }

  const before = await getProbeViewState(page);
  await dragMap(page, { x: 0.58, y: 0.5 }, { x: 0.48, y: 0.5 });
  await expectViewStateChanged(page, before, "pan");
  await expect(page.locator(".mb-maps__context-menu")).toHaveCount(0);
});

test("selection interaction targets points, flows, and rendered GeoJSON", async ({ page }) => {
  await openView(page, "Points");
  await clickFeatureCoordinate(page, "point", "berlin");
  await expect.poll(() => getSelectedPointId(page)).toBe("berlin");
  await expect(page.locator(".mb-maps__feature-popup")).toContainText("Berlin");

  const box = await mapBox(page);
  await page.mouse.click(box.x + box.width * 0.92, box.y + box.height * 0.88);
  await expect(page.locator(".mb-maps__feature-popup")).toHaveCount(0);

  await openView(page, "Flows");
  await clickFeatureCoordinate(page, "flow", "berlin-paris");
  await expect.poll(() => getSelectedFlowId(page)).toBe("berlin-paris");
  await expect(page.locator(".mb-maps__feature-popup")).toContainText("Berlin to Paris");

  await openView(page, "GeoJSON");
  await clickFeatureCoordinate(page, "geojson", "geojson-point");
  await expect(page.locator(".mb-maps__feature-popup")).toContainText("Paris checkpoint");
});

test("wheel zoom works while hovering rendered GeoJSON features", async ({ page }) => {
  await openView(page, "GeoJSON");

  const feature = await projectFeature(page, await getGeoJsonCenter(page, "geojson-polygon"));
  await page.mouse.move(feature.x, feature.y);
  await expect(page.locator(".mb-maps__feature-tooltip")).toBeVisible();

  const beforeWheel = await getProbeViewState(page);
  await page.mouse.wheel(0, -500);
  await expectViewStateChanged(page, beforeWheel, "zoom");
});

test("interaction point dragging updates coordinates and releases map drag state", async ({ page }) => {
  await openView(page, "Points");

  await clickFeatureCoordinate(page, "point", "berlin");
  await expect.poll(() => getSelectedPointId(page)).toBe("berlin");

  const beforePoint = await getPointCoordinate(page, "berlin");
  const point = await projectFeature(page, beforePoint);

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 90, point.y + 35, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(async () => coordinateMoved(beforePoint, await getPointCoordinate(page, "berlin")))
    .toBe(true);
  await expect.poll(() => getSelectedPointId(page)).toBe("berlin");

  const beforePan = await getProbeViewState(page);
  await dragMap(page, { x: 0.58, y: 0.48 }, { x: 0.5, y: 0.48 });
  await expectViewStateChanged(page, beforePan, "pan");
});

test("measurement interaction creates, cancels, and clears measurements @smoke", async ({ page }) => {
  await openView(page, "Clusters");
  await page.getByRole("button", { name: "Measure" }).click();
  await expect(page.locator(".mb-maps--measuring")).toBeVisible();

  const box = await mapBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.48);
  await expect.poll(() => getMeasurementCount(page)).toBe(0);

  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.52);
  await expect.poll(() => hasMeasurementDraft(page)).toBe(true);
  await page.mouse.click(box.x + box.width * 0.58, box.y + box.height * 0.52);
  await expect.poll(() => getMeasurementCount(page)).toBe(1);

  await page.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.44);
  await expect.poll(() => getMeasurementCount(page)).toBe(1);
  await page.keyboard.press("Escape");
  await expect.poll(() => hasMeasurementDraft(page)).toBe(false);

  await page.getByRole("button", { name: "Clear" }).click();
  await expect.poll(() => getMeasurementCount(page)).toBe(0);
});

test("interaction modes do not leak between measuring and editing", async ({ page }) => {
  await openView(page, "Points");
  await page.getByRole("button", { name: "Measure" }).click();
  await clickFeatureCoordinate(page, "point", "berlin");
  await expect.poll(() => getSelectedPointId(page)).toBe(null);

  await page.getByRole("button", { name: "Measuring" }).click();
  await clickFeatureCoordinate(page, "point", "berlin");
  await expect.poll(() => getSelectedPointId(page)).toBe("berlin");

  await openView(page, "Editor");
  const beforeCount = await getFeatureCount(page);
  await editorToolbarButton(page, "Polygon").click();
  await expect.poll(() => getEditMode(page)).toBe("draw-polygon");
  await clickMapRatios(page, [
    { x: 0.44, y: 0.54 },
    { x: 0.52, y: 0.44 },
    { x: 0.6, y: 0.54 },
  ]);
  await doubleClickMap(page, { x: 0.6, y: 0.54 });
  await expect.poll(() => getFeatureCount(page)).toBeGreaterThan(beforeCount);

  await editorToolbarButton(page, "Select").click();
  await expect.poll(() => getEditMode(page)).toBe("select");
  await clickFeatureCoordinate(page, "geojson", "geojson-point");
  await expect.poll(() => getGeoJsonSelectionCount(page)).toBe(1);
});

test("editor interaction selects, multi-selects, moves, reshapes, deletes, and draws @smoke", async ({
  page,
}) => {
  await openView(page, "Editor");

  await clickFeatureCoordinate(page, "geojson", "geojson-point");
  await expect.poll(() => getGeoJsonSelectionCount(page)).toBe(1);
  await expect(page.locator(".demo-editor-label input")).toHaveValue("Paris checkpoint");

  const linePoint = await projectFeature(page, [7.4653, 50.0014]);
  await page.keyboard.down("Shift");
  await page.mouse.click(linePoint.x, linePoint.y);
  await page.keyboard.up("Shift");
  await expect.poll(() => getGeoJsonSelectionCount(page)).toBeGreaterThan(1);

  await clickFeatureCoordinate(page, "geojson", "geojson-point");
  await editorToolbarButton(page, "Move").click();
  const beforeMoveCenter = await getGeoJsonCenter(page, "geojson-point");
  const movePoint = await projectFeature(page, beforeMoveCenter);
  await page.mouse.move(movePoint.x, movePoint.y);
  await page.mouse.down();
  await page.mouse.move(movePoint.x + 70, movePoint.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => coordinateMoved(beforeMoveCenter, await getGeoJsonCenter(page, "geojson-point")))
    .toBe(true);

  await editorToolbarButton(page, "Select").click();
  await expect.poll(() => getEditMode(page)).toBe("select");
  const visiblePolygonPoint = await projectFeature(page, [10.8, 48.2]);
  await page.mouse.click(visiblePolygonPoint.x, visiblePolygonPoint.y);
  await expect(
    page.getByLabel("Selected GeoJSON element").getByText("Polygon", { exact: true }),
  ).toBeVisible();
  await editorToolbarButton(page, "Reshape").click();
  await expect.poll(() => getEditMode(page)).toBe("reshape");
  await waitForEditorHandleAtCoordinate(page, [6.4, 48.6]);
  await expect(page.getByText("Click midpoint handles to add nodes.")).toBeVisible();

  const beforeDeleteCount = await getFeatureCount(page);
  await page.getByLabel("Selected GeoJSON element").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => getFeatureCount(page)).toBeLessThan(beforeDeleteCount);

  const beforeDrawCount = await getFeatureCount(page);
  await editorToolbarButton(page, "Polygon").click();
  await clickMapRatios(page, [
    { x: 0.4, y: 0.58 },
    { x: 0.48, y: 0.48 },
    { x: 0.56, y: 0.58 },
  ]);
  await doubleClickMap(page, { x: 0.56, y: 0.58 });
  await expect.poll(() => getFeatureCount(page)).toBeGreaterThan(beforeDrawCount);
});

test("globe interaction smoke keeps the Globe Map responsive @smoke", async ({ page }) => {
  await openView(page, "Globe");
  await expect(page.locator(".mb-maps--globe")).toBeVisible();
  await expect.poll(() => getMapProjection(page)).toBe("globe");
  await waitForMapIdle(page);
  await expect.poll(async () => pngHasPixelVariance(await page.locator(".mb-maps--globe").screenshot())).toBe(true);

  const beforeCenter = await getProbeViewState(page);
  await dragMap(page, { x: 0.58, y: 0.5 }, { x: 0.38, y: 0.5 });
  await expectViewStateChanged(page, beforeCenter, "pan");

  await openView(page, "Clusters");
  await openView(page, "Globe");
  await expect.poll(() => getMapProjection(page)).toBe("globe");
});

test("mobile interaction touch pan keeps the map usable @mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openView(page, "Clusters", { clickMethod: "keyboard" });

  const before = await getProbeViewState(page);
  await touchPan(page, { x: 0.66, y: 0.52 }, { x: 0.36, y: 0.52 });
  await expectViewStateChanged(page, before, "pan");
  await expect.poll(() => hasHorizontalOverflow(page)).toBe(false);
  await expect(page.locator(".mb-maps").first()).toHaveAttribute("data-map-ready", "true");
});

test("mobile interaction zoom control remains operable @mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openView(page, "Clusters", { clickMethod: "keyboard" });

  const beforePinch = await getProbeViewState(page);
  await pinchZoom(page);

  const pinchChanged = await viewStateChanged(beforePinch, await getProbeViewState(page), "zoom");
  const beforeFallback = pinchChanged ? null : await getProbeViewState(page);

  if (!pinchChanged && beforeFallback) {
    await page.locator(".maplibregl-ctrl-zoom-in").first().click();
    await expectViewStateChanged(page, beforeFallback, "zoom");
  }
});

test("mobile interaction feature tap survives view switches @mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openView(page, "Points", { clickMethod: "keyboard" });
  await clickFeatureCoordinate(page, "point", "berlin");
  await expect.poll(() => getSelectedPointId(page)).toBe("berlin");
  await expect(page.locator(".mb-maps__feature-popup")).toContainText("Berlin");

  await openView(page, "Editor", { clickMethod: "keyboard" });
  await openView(page, "Points", { clickMethod: "keyboard" });
  await clickFeatureCoordinate(page, "point", "hamburg");
  await expect.poll(() => getSelectedPointId(page)).toBe("hamburg");
});

async function openView(
  page: Page,
  view: DemoView,
  options: { clickMethod?: "keyboard" | "pointer"; force?: boolean } = {},
) {
  const tab = page.getByRole("tab", { name: view });

  if (options.clickMethod === "keyboard") {
    await tab.focus();
    await page.keyboard.press("Enter");
  } else {
    await tab.click({ force: options.force });
  }

  await waitForMapReady(page);
  await waitForMapIdle(page);
  await expect.poll(() => getActiveView(page)).toBe(view.toLowerCase());
}

async function waitForMapReady(page: Page) {
  await expect(page.locator(".mb-maps").first()).toBeVisible();
  await expect(page.locator(".mb-maps").first()).toHaveAttribute("data-map-ready", "true");
}

async function waitForMapIdle(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __mbMapsDemo?: { isMapIdle?: () => boolean | null };
              }
            ).__mbMapsDemo?.isMapIdle?.() ?? false,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

function editorToolbarButton(page: Page, name: string) {
  return page.getByLabel("Add GeoJSON element").getByRole("button", { name });
}

async function getProbeViewState(page: Page): Promise<ViewState> {
  return page.evaluate(() => {
    const viewState = (
      window as typeof window & {
        __mbMapsDemo?: { getViewState?: () => ViewState | null };
      }
    ).__mbMapsDemo?.getViewState?.();

    if (
      !viewState ||
      !Array.isArray(viewState.center) ||
      typeof viewState.center[0] !== "number" ||
      typeof viewState.center[1] !== "number" ||
      typeof viewState.zoom !== "number"
    ) {
      throw new Error("Expected demo e2e probe view state.");
    }

    return viewState;
  });
}

async function expectViewStateChanged(
  page: Page,
  before: ViewState,
  kind: "any" | "pan" | "zoom",
) {
  await expect.poll(async () => viewStateChanged(before, await getProbeViewState(page), kind)).toBe(true);
}

async function viewStateChanged(before: ViewState, after: ViewState, kind: "any" | "pan" | "zoom") {
  const centerChanged =
    Math.abs(after.center[0] - before.center[0]) > 0.005 ||
    Math.abs(after.center[1] - before.center[1]) > 0.005;
  const zoomChanged = Math.abs(after.zoom - before.zoom) > 0.02;

  if (kind === "pan") {
    return centerChanged && !zoomChanged;
  }

  if (kind === "zoom") {
    return zoomChanged;
  }

  return centerChanged || zoomChanged;
}

async function mapBox(page: Page) {
  const box = await page.locator(".mb-maps").first().boundingBox();

  expect(box).not.toBeNull();

  return box!;
}

async function projectFeature(page: Page, coordinate: [number, number]) {
  const point = await page.evaluate((value) => {
    const projected = (
      window as typeof window & {
        __mbMapsDemo?: {
          project?: (coordinate: [number, number]) => { x: number; y: number } | null;
        };
      }
    ).__mbMapsDemo?.project?.(value);

    return projected ?? null;
  }, coordinate);

  expect(point).not.toBeNull();

  const box = await mapBox(page);

  return { x: box.x + point!.x, y: box.y + point!.y };
}

async function waitForEditorHandleAtCoordinate(page: Page, coordinate: [number, number]) {
  await expect
    .poll(
      () =>
        page.evaluate((value) => {
          const probe = (
            window as typeof window & {
              __mbMapsDemo?: {
                project?: (coordinate: [number, number]) => { x: number; y: number } | null;
              };
              __mbMapsDemoMap?: {
                queryRenderedFeatures?: (
                  box: [[number, number], [number, number]],
                ) => Array<{
                  layer?: { metadata?: { flatOptions?: { className?: string } } };
                }>;
              };
            }
          ).__mbMapsDemo;
          const map = (
            window as typeof window & {
              __mbMapsDemoMap?: {
                queryRenderedFeatures?: (
                  box: [[number, number], [number, number]],
                ) => Array<{
                  layer?: { metadata?: { flatOptions?: { className?: string } } };
                }>;
              };
            }
          ).__mbMapsDemoMap;
          const point = probe?.project?.(value);

          if (!point || !map?.queryRenderedFeatures) {
            return false;
          }

          return map
            .queryRenderedFeatures([
              [point.x - 12, point.y - 12],
              [point.x + 12, point.y + 12],
            ])
            .some((feature) =>
              feature.layer?.metadata?.flatOptions?.className?.includes(
                "mb-maps__editor-handle",
              ),
            );
        }, coordinate),
      { timeout: 5_000 },
    )
    .toBe(true);

  return projectFeature(page, coordinate);
}

async function clickFeatureCoordinate(
  page: Page,
  kind: "flow" | "geojson" | "point",
  id: string,
) {
  const coordinate =
    kind === "point"
      ? await getPointCoordinate(page, id)
      : kind === "flow"
        ? await getFlowMidpoint(page, id)
        : await getGeoJsonCenter(page, id);
  const point = await projectFeature(page, coordinate);

  await page.mouse.click(point.x, point.y);
}

async function dragMap(
  page: Page,
  fromRatio: { x: number; y: number },
  toRatio: { x: number; y: number },
) {
  const box = await mapBox(page);
  const from = { x: box.x + box.width * fromRatio.x, y: box.y + box.height * fromRatio.y };
  const to = { x: box.x + box.width * toRatio.x, y: box.y + box.height * toRatio.y };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

async function wheelMap(page: Page, deltaY: number) {
  const box = await mapBox(page);

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, deltaY);
}

async function doubleClickMap(page: Page, ratio: { x: number; y: number }) {
  const box = await mapBox(page);

  await page.mouse.dblclick(box.x + box.width * ratio.x, box.y + box.height * ratio.y);
}

async function keyboardMap(page: Page, keys: string[]) {
  await page.locator(".maplibregl-canvas").first().focus();

  for (const key of keys) {
    await page.keyboard.press(key);
  }
}

async function shiftDragBoxZoom(page: Page) {
  const box = await mapBox(page);
  const from = { x: box.x + box.width * 0.38, y: box.y + box.height * 0.38 };
  const to = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.62 };

  await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

async function clickMapRatios(page: Page, ratios: Array<{ x: number; y: number }>) {
  const box = await mapBox(page);

  for (const ratio of ratios) {
    await page.mouse.click(box.x + box.width * ratio.x, box.y + box.height * ratio.y);
  }
}

async function touchPan(
  page: Page,
  fromRatio: { x: number; y: number },
  toRatio: { x: number; y: number },
) {
  const client = await page.context().newCDPSession(page);
  const box = await mapBox(page);
  const from = { x: box.x + box.width * fromRatio.x, y: box.y + box.height * fromRatio.y };
  const to = { x: box.x + box.width * toRatio.x, y: box.y + box.height * toRatio.y };

  await client.send("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, x: from.x, y: from.y }],
    type: "touchStart",
  });
  await client.send("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, x: to.x, y: to.y }],
    type: "touchMove",
  });
  await client.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
  await client.detach();
}

async function pinchZoom(page: Page) {
  const client = await page.context().newCDPSession(page);
  const box = await mapBox(page);
  const center = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.52 };

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
  await client.detach();
}

async function getActiveView(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { activeView?: () => string };
        }
      ).__mbMapsDemo?.activeView?.() ?? null,
  );
}

async function getSelectedPointId(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getSelectedPointId?: () => string | null };
        }
      ).__mbMapsDemo?.getSelectedPointId?.() ?? null,
  );
}

async function getSelectedFlowId(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getSelectedFlowId?: () => string | null };
        }
      ).__mbMapsDemo?.getSelectedFlowId?.() ?? null,
  );
}

async function getMeasurementCount(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getMeasurementCount?: () => number };
        }
      ).__mbMapsDemo?.getMeasurementCount?.() ?? 0,
  );
}

async function hasMeasurementDraft(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getMeasurementDraft?: () => unknown | null };
        }
      ).__mbMapsDemo?.getMeasurementDraft?.() != null,
  );
}

async function getEditMode(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getEditMode?: () => string };
        }
      ).__mbMapsDemo?.getEditMode?.() ?? null,
  );
}

async function getFeatureCount(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getFeatureCount?: () => number };
        }
      ).__mbMapsDemo?.getFeatureCount?.() ?? 0,
  );
}

async function getGeoJsonSelectionCount(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getGeoJsonSelection?: () => { featureIds?: string[] } };
        }
      ).__mbMapsDemo?.getGeoJsonSelection?.().featureIds?.length ?? 0,
  );
}

async function getMapProjection(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __mbMapsDemo?: { getMapProjection?: () => string | null };
        }
      ).__mbMapsDemo?.getMapProjection?.() ?? null,
  );
}

async function getPointCoordinate(page: Page, id: string): Promise<[number, number]> {
  const coordinate = await page.evaluate((pointId) => {
    return (
      window as typeof window & {
        __mbMapsDemo?: { getPointCoordinate?: (id: string) => [number, number] | null };
      }
    ).__mbMapsDemo?.getPointCoordinate?.(pointId) ?? null;
  }, id);

  expect(coordinate).not.toBeNull();

  return coordinate!;
}

async function getFlowMidpoint(page: Page, id: string): Promise<[number, number]> {
  const coordinate = await page.evaluate((flowId) => {
    return (
      window as typeof window & {
        __mbMapsDemo?: { getFlowMidpoint?: (id: string) => [number, number] | null };
      }
    ).__mbMapsDemo?.getFlowMidpoint?.(flowId) ?? null;
  }, id);

  expect(coordinate).not.toBeNull();

  return coordinate!;
}

async function getGeoJsonCenter(page: Page, id: string): Promise<[number, number]> {
  const coordinate = await page.evaluate((featureId) => {
    return (
      window as typeof window & {
        __mbMapsDemo?: {
          getGeoJsonFeatureCenter?: (id: string) => [number, number] | null;
        };
      }
    ).__mbMapsDemo?.getGeoJsonFeatureCenter?.(featureId) ?? null;
  }, id);

  expect(coordinate).not.toBeNull();

  return coordinate!;
}

function coordinateMoved(before: [number, number], after: [number, number]) {
  return Math.abs(after[0] - before[0]) > 0.001 || Math.abs(after[1] - before[1]) > 0.001;
}

async function hasHorizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

function pngHasPixelVariance(png: Buffer) {
  const { data, height, width } = decodePngRgba(png);
  let brightPixels = 0;
  let darkPixels = 0;
  const startX = Math.floor(width * 0.35);
  const endX = Math.floor(width * 0.65);
  const startY = Math.floor(height * 0.35);
  const endY = Math.floor(height * 0.65);
  let minBrightness = Number.POSITIVE_INFINITY;
  let maxBrightness = 0;
  let saturatedPixels = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3] ?? 0;
      const brightness = (data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0);

      if (alpha > 0 && brightness > 90) {
        brightPixels += 1;
      }

      if (alpha > 0 && brightness < 60) {
        darkPixels += 1;
      }

      if (alpha > 0) {
        minBrightness = Math.min(minBrightness, brightness);
        maxBrightness = Math.max(maxBrightness, brightness);

        const channelSpread =
          Math.max(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0) -
          Math.min(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0);

        if (channelSpread > 20) {
          saturatedPixels += 1;
        }
      }

      if (brightPixels > 20 && darkPixels > 20) {
        return true;
      }
    }
  }

  return saturatedPixels > 100 && maxBrightness - minBrightness > 40;
}

function decodePngRgba(png: Buffer) {
  const signature = "89504e470d0a1a0a";

  if (png.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Expected a PNG screenshot.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9] ?? 0;
    } else if (type === "IDAT") {
      idatChunks.push(chunk);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (width <= 0 || height <= 0 || ![2, 6].includes(colorType)) {
    throw new Error("Expected an 8-bit RGB or RGBA PNG screenshot.");
  }

  const compressed = Buffer.concat(idatChunks);
  const inflated = inflateSync(compressed);
  const sourceBytesPerPixel = colorType === 6 ? 4 : 3;
  const sourceStride = width * sourceBytesPerPixel;
  const sourceData = Buffer.alloc(width * height * sourceBytesPerPixel);
  const data = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset] ?? 0;
    sourceOffset += 1;
    const rowStart = y * sourceStride;
    const previousRowStart = rowStart - sourceStride;

    for (let x = 0; x < sourceStride; x += 1) {
      const raw = inflated[sourceOffset + x] ?? 0;
      const left =
        x >= sourceBytesPerPixel ? (sourceData[rowStart + x - sourceBytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (sourceData[previousRowStart + x] ?? 0) : 0;
      const upLeft =
        y > 0 && x >= sourceBytesPerPixel
          ? (sourceData[previousRowStart + x - sourceBytesPerPixel] ?? 0)
          : 0;

      sourceData[rowStart + x] = unfilterByte(filter, raw, left, up, upLeft);
    }

    sourceOffset += sourceStride;
  }

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceIndex = pixel * sourceBytesPerPixel;
    const targetIndex = pixel * 4;

    data[targetIndex] = sourceData[sourceIndex] ?? 0;
    data[targetIndex + 1] = sourceData[sourceIndex + 1] ?? 0;
    data[targetIndex + 2] = sourceData[sourceIndex + 2] ?? 0;
    data[targetIndex + 3] = colorType === 6 ? (sourceData[sourceIndex + 3] ?? 0) : 255;
  }

  return { data, height, width };
}

function unfilterByte(filter: number, raw: number, left: number, up: number, upLeft: number) {
  switch (filter) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 0xff;
    case 2:
      return (raw + up) & 0xff;
    case 3:
      return (raw + Math.floor((left + up) / 2)) & 0xff;
    case 4:
      return (raw + paethPredictor(left, up, upLeft)) & 0xff;
    default:
      throw new Error(`Unsupported PNG filter ${filter}.`);
  }
}

function paethPredictor(left: number, up: number, upLeft: number) {
  const predictor = left + up - upLeft;
  const leftDistance = Math.abs(predictor - left);
  const upDistance = Math.abs(predictor - up);
  const upLeftDistance = Math.abs(predictor - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }

  if (upDistance <= upLeftDistance) {
    return up;
  }

  return upLeft;
}
