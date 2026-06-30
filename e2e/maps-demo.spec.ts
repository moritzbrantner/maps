import { expect, test, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";

const benignConsolePatterns = [
  /Failed to load resource: net::ERR_ABORTED/,
  /Could not compile fragment shader/,
  /WebGL: INVALID_OPERATION/,
];
const visualBaselineViews = [
  "Clusters",
  "Points",
  "Heat",
  "Flows",
  "Composed",
  "Interpolation",
  "History",
  "GeoJSON",
  "Editor",
] as const;
const smokeVisualBaselineViews = new Set<(typeof visualBaselineViews)[number]>([
  "Clusters",
  "Heat",
  "Editor",
]);
const topLevelViews = [
  "Clusters",
  "Points",
  "Heat",
  "Flows",
  "Composed",
  "Timeline",
  "Interpolation",
  "History",
  "Globe",
  "GeoJSON",
  "Editor",
] as const;

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
  await page.waitForTimeout(100);

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

for (const view of visualBaselineViews) {
  test(`${view} view visual baseline${smokeVisualBaselineViews.has(view) ? " @smoke" : ""}`, async ({ page }) => {
    await openView(page, view);
    await expectDemoStageScreenshot(page, `${view.toLowerCase()}-desktop.png`);
  });
}

test("Heat view exposes the temperature map surface", async ({ page }) => {
  await openView(page, "Heat");

  const map = page.locator(".mb-maps").first();

  await expect(map).toBeVisible();
  await expect(page.getByLabel("Europe temperature surface")).toBeVisible();
});

test("Timeline view keeps a stable viewport while seeking through playback", async ({ page }) => {
  await openView(page, "Timeline");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByLabel("European logistics timeline")).toBeVisible();

  const viewportValue = page
    .locator("aside dl > div")
    .filter({ hasText: "Viewport" })
    .locator("dd");
  const initialViewport = await viewportValue.textContent();
  const slider = page.getByRole("slider", { name: "Shipment timeline" });

  await expect(slider).toBeVisible();
  await expect(page.getByText("08:00").first()).toBeVisible();

  const initialTime = await page.locator(".mb-temporal-map__current-time").textContent();

  await slider.fill("70");

  await expect(page.locator(".mb-temporal-map__current-time")).not.toHaveText(initialTime ?? "");
  expect(await viewportValue.textContent()).toBe(initialViewport);
  await expectDemoStageScreenshot(page, "timeline-desktop.png");
});

test("Interpolation view exposes algorithm and keyframe controls", async ({ page }) => {
  await openView(page, "Interpolation");

  const interpolationPanel = page.locator(".demo-interpolation-panel");

  await expect(page.getByLabel("GeoJSON interpolation preview")).toBeVisible();
  const landmassToggle = interpolationPanel.getByLabel("Constrain to landmass");
  await expect(landmassToggle).toBeEnabled();
  await landmassToggle.check();
  await expect(landmassToggle).toBeChecked();
  await interpolationPanel.getByLabel("Example").selectOption("line-density-change");
  await expect(landmassToggle).toBeDisabled();
  await interpolationPanel.getByLabel("Example").selectOption("multipolygon-added-part");
  await expect(page.getByText("polygon count is incompatible")).toBeVisible();
  await interpolationPanel.getByLabel("Algorithm").selectOption("centroid-radial");
  await expect(page.getByText("Samples polygon rings radially")).toBeVisible();

  await page.getByRole("button", { name: "End" }).click();
  await interpolationPanel.getByLabel("Coordinate handle").selectOption("1");
  await interpolationPanel.getByLabel("Longitude").fill("-2.1");
  await expect(interpolationPanel.getByLabel("Longitude")).toHaveValue("-2.1");
  await interpolationPanel.getByLabel("Interpolation progress").fill("74");
  await expect(page.getByText("74%")).toBeVisible();
  await interpolationPanel.getByLabel("Example").selectOption("type-change-fallback");
  await expect(interpolationPanel.getByText("The geometry type changes")).toBeVisible();
});

test("Interpolation view renders every algorithm option without console errors", async ({ page }) => {
  await openView(page, "Interpolation");

  const interpolationPanel = page.locator(".demo-interpolation-panel");
  const algorithmSelect = interpolationPanel.getByLabel("Algorithm");

  await interpolationPanel.getByLabel("Example").selectOption("polygon-concave-extra-vertices");

  for (const algorithm of ["compatible", "resample", "vertex-union", "centroid-radial", "hold"]) {
    await algorithmSelect.selectOption(algorithm);
    await expect(page.getByText("Algorithm").first()).toBeVisible();
  }

  await interpolationPanel.getByLabel("Example").selectOption("topology-polygon-split");
  await interpolationPanel.getByLabel("Topology strategy").selectOption("area-overlap");
  await expect(page.getByText("Topology strategy")).toBeVisible();
  await interpolationPanel.getByLabel("Topology strategy").selectOption("voronoi-partition");
  await expect(page.getByText("Topology strategy")).toBeVisible();
});

test("History view exposes polity timeline controls", async ({ page }) => {
  await openView(page, "History");

  await expect(page.getByLabel("European polity history")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Historical year" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show 1816 AD" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show 2019 AD" })).toBeVisible();
  await expect(
    page.getByText(
      "Boundaries derived from CShapes-Europe. Demo snapshots are not an authoritative historical boundary source.",
    ),
  ).toBeVisible();
});

test("History slider updates the active year and keeps the map visible", async ({ page }) => {
  await openView(page, "History");

  const slider = page.getByRole("slider", { name: "Historical year" });

  await expect(page.getByText("1816 AD").first()).toBeVisible();
  await slider.fill("1989");
  await expect(page.getByText("1989 AD").first()).toBeVisible();
  await expect(page.getByLabel("European polity history")).toBeVisible();
});

test("Timeline view samples topology transitions at start, middle, and end", async ({ page }) => {
  await openView(page, "Timeline");
  await page.getByRole("button", { name: "Pause" }).click();

  const nextButton = page.getByRole("button", { name: "Next time step" });

  for (const [steps, label] of [
    [0, /^08:\d{2}$/],
    [3, /^08:\d{2}$/],
    [3, /^08:\d{2}$/],
  ] as const) {
    for (let index = 0; index < steps; index += 1) {
      await nextButton.click();
    }

    await expect(page.locator(".mb-temporal-map__current-time")).toHaveText(label);
    await expect(page.getByLabel("European logistics timeline")).toBeVisible();
  }
});

test("Flows view exposes direction and volume legend", async ({ page }) => {
  await openView(page, "Flows");

  const map = page.locator(".mb-maps").first();

  await expect(map).toBeVisible();
  await expect(page.getByText("Flow volume")).toBeVisible();
});

test("Globe view renders nonblank canvas and responds to dragging @smoke", async ({ page }) => {
  await openView(page, "Globe");

  const globe = page.locator(".mb-maps--globe");
  const canvas = globe.locator(".maplibregl-canvas");
  await expect(globe).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __mbMapsDemo?: { getMapProjection?: () => string | null };
              __mbMapsDemoMap?: { getProjection?: () => { type?: string } };
            }
          ).__mbMapsDemo?.getMapProjection?.() ??
          (
            window as typeof window & {
              __mbMapsDemoMap?: { getProjection?: () => { type?: string } };
            }
          ).__mbMapsDemoMap?.getProjection?.().type,
      ),
    )
    .toBe("globe");
  await waitForDemoMapIdle(page);
  await expect.poll(async () => pngHasPixelVariance(await globe.screenshot())).toBe(true);

  const beforeCenter = await getDemoMapCenter(page);
  const box = await globe.boundingBox();

  expect(beforeCenter).not.toBeNull();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.38, box!.y + box!.height * 0.5, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const center = await getDemoMapCenter(page);

      return Boolean(
        beforeCenter &&
          center &&
          (Math.abs(center.lng - beforeCenter.lng) > 0.01 ||
            Math.abs(center.lat - beforeCenter.lat) > 0.01),
      );
    })
    .toBe(true);
  await waitForDemoMapIdle(page);
  await expect.poll(async () => pngHasPixelVariance(await globe.screenshot())).toBe(true);
  await openView(page, "Clusters");
  await openView(page, "Globe");
  await waitForDemoMapIdle(page);
  await expectDemoStageScreenshot(page, "globe-desktop.png");
});

test("Measurement mode activates measuring state @smoke", async ({ page }) => {
  await openView(page, "Clusters");
  await page.getByRole("button", { name: "Measure" }).click();

  await expect(page.locator(".mb-maps--measuring")).toBeVisible();
  await expectDemoStageScreenshot(page, "measurement-desktop.png");
});

test("Editor mode controls update without visual breakage @smoke", async ({ page }) => {
  await openView(page, "Editor");
  await page.getByRole("button", { name: "Polygon" }).click();
  await expect(
    page.locator(".demo-editor-facts").filter({ hasText: "draw-polygon" }),
  ).toBeVisible();
  await expectDemoStageScreenshot(page, "editor-draw-polygon-desktop.png");
});

test("Editor mode enters polygon drawing mode", async ({ page }) => {
  await openView(page, "Editor");

  await page.getByRole("button", { name: "Polygon" }).click();
  await expect(
    page.locator(".demo-editor-facts").filter({ hasText: "draw-polygon" }),
  ).toBeVisible();
});

test("Primary map controls expose accessible names and keyboard operation @smoke", async ({ page }) => {
  await openView(page, "Clusters");

  const measureButton = page.getByRole("button", { name: "Measure" });

  await expect(measureButton).toBeVisible();
  await measureButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".mb-maps--measuring")).toBeVisible();

  const editorTab = page.getByRole("tab", { name: "Editor" });

  await editorTab.focus();
  await page.keyboard.press("Enter");
  await expect(editorTab).toHaveAttribute("aria-selected", "true");

  const polygonButton = page.getByRole("button", { name: "Polygon" });

  await expect(polygonButton).toBeVisible();
  await polygonButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".demo-editor-facts").filter({ hasText: "draw-polygon" }),
  ).toBeVisible();
});

test("Timeline slider is named and keyboard operable", async ({ page }) => {
  await openView(page, "Timeline");
  await page.getByRole("button", { name: "Pause" }).click();

  const slider = page.getByRole("slider", { name: "Shipment timeline" });
  const initialTime = await page.locator(".mb-temporal-map__current-time").textContent();

  await expect(slider).toBeVisible();
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".mb-temporal-map__current-time")).not.toHaveText(initialTime ?? "");
});

test("Mobile layout does not overflow horizontally @mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/?e2e=1");
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }

      .flat-tile-pane {
        opacity: 0 !important;
      }
    `,
  });
  await openView(page, "Clusters");

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );

  expect(hasHorizontalOverflow).toBe(false);
  await expect(page.locator("main")).toHaveScreenshot("clusters-mobile.png");
});

test("Mobile layout does not overflow horizontally on any top-level tab @mobile", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/?e2e=1");
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }

      .flat-tile-pane {
        opacity: 0 !important;
      }
    `,
  });

  for (const view of topLevelViews) {
    await openView(page, view, { clickMethod: "keyboard" });
    await expect(page.getByRole("tab", { name: view })).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(async () => hasHorizontalOverflow(page), { message: `${view} tab should not overflow` })
      .toBe(false);
  }
});

for (const view of ["Editor", "Globe", "Heat", "Timeline"] as const) {
  test(`${view} mobile visual baseline @mobile`, async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/?e2e=1");
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          transition-duration: 0s !important;
        }

        .flat-tile-pane {
          opacity: 0 !important;
        }

        .mb-maps {
          background: #eef2f7 !important;
        }
      `,
    });

    await openView(page, view, { clickMethod: "keyboard" });
    await expect(page.getByRole("tab", { name: view })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("main")).toHaveScreenshot(`${view.toLowerCase()}-mobile.png`);
  });
}

async function openView(
  page: Page,
  view: string,
  options: { clickMethod?: "keyboard" | "pointer"; force?: boolean } = {},
) {
  const tab = page.getByRole("tab", { name: view });

  if (options.clickMethod === "keyboard") {
    await tab.focus();
    await page.keyboard.press("Enter");
  } else {
    await tab.click({ force: options.force });
  }

  await expect(page.locator(".mb-maps").first()).toBeVisible();
  await page.waitForTimeout(150);
}

async function hasHorizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

async function expectDemoStageScreenshot(page: Page, name: string) {
  await waitForDemoMapIdle(page);
  await expect(page.locator(".demo-stage")).toHaveScreenshot(name, { timeout: 15_000 });
}

async function getDemoMapCenter(page: Page) {
  return page.evaluate(() => {
    const demoWindow = window as typeof window & {
      __mbMapsDemo?: {
        getViewState?: () => { center?: [number, number]; zoom?: number } | null;
      };
      __mbMapsDemoMap?: {
        getCenter?: () => { lat?: number; lng?: number };
      };
    };
    const probeState = demoWindow.__mbMapsDemo?.getViewState?.();

    if (
      Array.isArray(probeState?.center) &&
      typeof probeState.center[0] === "number" &&
      typeof probeState.center[1] === "number"
    ) {
      return { lat: probeState.center[1], lng: probeState.center[0] };
    }

    const map = demoWindow.__mbMapsDemoMap;
    const center = map?.getCenter?.();

    if (typeof center?.lat !== "number" || typeof center.lng !== "number") {
      return null;
    }

    return { lat: center.lat, lng: center.lng };
  });
}

async function waitForDemoMapIdle(page: Page) {
  await page.evaluate(async () => {
    const demoWindow = window as typeof window & {
      __mbMapsDemo?: { isMapIdle?: () => boolean | null };
      __mbMapsDemoMap?: {
        idle?: () => boolean;
        isMoving?: () => boolean;
        loaded?: () => boolean;
        once?: (event: "idle", listener: () => void) => void;
      };
    };

    if (demoWindow.__mbMapsDemo?.isMapIdle?.() === true) {
      return;
    }

    const map = demoWindow.__mbMapsDemoMap;

    if (!map || typeof map.once !== "function") {
      return;
    }

    const isSettled =
      map.idle?.() === true || (map.loaded?.() === true && map.isMoving?.() !== true);

    if (isSettled) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeoutId = window.setTimeout(resolve, 1_000);

      map.once?.("idle", () => {
        window.clearTimeout(timeoutId);
        resolve();
      });
    });
  });
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
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }

  if (upDistance <= upLeftDistance) {
    return up;
  }

  return upLeft;
}
