import { expect, test, type Page } from "@playwright/test";

import {
  MODELED_CONTROL_VALUES,
  UNMODELED_BRANCHES,
  buildEnginePlan,
  engineExpectations,
  readStatePathConfig,
  selectPaths,
  stepTitle,
  type EngineEvent,
  type EngineState,
  type StateInput,
} from "./engine-state-model";

const config = readStatePathConfig(process.env);
const plan = buildEnginePlan(config.tier);
const PMTILES_ARCHIVE = "**/showcase-pmtiles-v1.pmtiles*";
const FLING_SETTLE_MS = 300;
// Cold wasm + PMTiles startup can exceed the 5s default on shared runners.
const READY_TIMEOUT = { timeout: 30_000 };
const HOME_CAMERA: Record<"points" | "west", string> = {
  points: "10.300, 50.400 · z4.10",
  west: "-95.000, 40.000 · z3.10",
};

const surface = (page: Page) => page.locator('canvas[data-flat-runtime="maps"]');
const selection = (page: Page) =>
  page.getByRole("status").filter({ hasText: /^(No selection|Selected .+)$/ });
const camera = (page: Page) => page.getByTestId("engine-camera");
const readCamera = async (page: Page) => (await camera(page).textContent()) ?? "";

function parseCamera(text: string) {
  const match = /^(-?[\d.]+), (-?[\d.]+) · z([\d.]+)$/.exec(text);
  if (!match) throw new Error(`Unreadable camera readout: ${text}`);
  return { center: `${match[1]},${match[2]}`, zoom: Number(match[3]) };
}

/** Gestures can coast; compare only once two sampled readouts agree. */
async function settledCamera(page: Page) {
  let previous: string | null = null;
  let settled = "";
  await expect
    .poll(
      async () => {
        const current = await readCamera(page);
        const unchanged = current !== "" && current === previous;
        previous = current;
        if (unchanged) settled = current;
        return unchanged;
      },
      // Longer than the 700ms sampling interval, so equal reads are two real samples.
      { intervals: [800], timeout: 15_000 },
    )
    .toBe(true);
  return settled;
}

async function expectRenderedTiles(page: Page) {
  const canvas = surface(page);
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready", READY_TIMEOUT);
  // WebGPU retains vector tiles; Canvas2D tracks its drawn basemap tiles separately.
  // Tile counts, not request counts: a valid camera move may be served from cache.
  await expect
    .poll(async () => {
      const backend = await canvas.getAttribute("data-map-base-renderer");
      const counter = backend === "wgpu" ? "data-map-vector-tiles" : "data-map-base-tiles";
      return Number(await canvas.getAttribute(counter));
    })
    .toBeGreaterThan(0);
}

async function expectEngineState(page: Page, state: EngineState) {
  const expected = engineExpectations[state];
  await expect(page.getByRole("combobox", { name: "Tile source" })).toHaveValue(expected.source);
  await expect(page.getByRole("combobox", { name: "Camera scene" })).toHaveValue(expected.scene);
  await expect(surface(page)).toHaveAttribute(
    "data-map-source-id",
    expected.source === "mvt" ? "fixture-pmtiles-xyz" : "maps-showcase",
  );
  await expect(page).toHaveURL(new RegExp(`[?&]source=${expected.source}(?:&|$)`));
  await expect(page).toHaveURL(new RegExp(`[?&]scene=${expected.scene}(?:&|$)`));
  await expect(
    page.getByRole("button", { name: expected.tilted ? "Flatten view" : "Tilt view" }),
  ).toBeVisible();
  await expect(selection(page)).toHaveText(
    expected.selection === "selected" ? /^Selected (cluster|point):/ : "No selection",
  );
  if (expected.unavailable) {
    await expect(surface(page)).toHaveAttribute("data-map-source-state", "error", READY_TIMEOUT);
    await expect(page.getByRole("alert")).toContainText("maps-showcase");
    return;
  }
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectRenderedTiles(page);
  const home = HOME_CAMERA[expected.scene];
  if (expected.camera === "home") await expect(camera(page)).toHaveText(home);
  if (expected.camera === "moved") await expect(camera(page)).not.toHaveText(home);
}

/** The free part of the Map View, clear of the floating panel and hint. */
async function mapRegion(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const map = rect(".engine-map");
    const panel = rect(".engine-panel");
    const hint = rect(".engine-map-hint");
    const left = Math.max(map.left, 0);
    const right = Math.min(map.right, innerWidth);
    const top = Math.max(map.top, 0);
    const bottom = Math.min(map.bottom, innerHeight, hint.top);
    const panelSpansMap = panel.width > (right - left) * 0.6;
    return {
      left: panelSpansMap ? left : Math.max(left, panel.right),
      top: panelSpansMap ? Math.max(top, panel.bottom) : top,
      right,
      bottom,
    };
  });
}

async function panMap(page: Page, input: StateInput) {
  const region = await mapRegion(page);
  const x = (region.left + region.right) / 2;
  const y = (region.top + region.bottom) / 2;
  if (input === "desktop") {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 150, y + 40, { steps: 12 });
    // Pausing before release leaves no fling velocity for kinetic panning.
    await page.waitForTimeout(FLING_SETTLE_MS);
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x - step * 12, y: y + step * 4 }],
    });
  }
  await page.waitForTimeout(FLING_SETTLE_MS);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function zoomMap(page: Page, input: StateInput) {
  const region = await mapRegion(page);
  const x = (region.left + region.right) / 2;
  const y = (region.top + region.bottom) / 2;
  if (input === "desktop") {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -320);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const fingers = (spread: number) => [
    { x: x - spread, y, id: 0 },
    { x: x + spread, y, id: 1 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(30) });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: fingers(30 + step * 8),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Clusters have no DOM node: scan the free map centre-outward until one is picked. */
async function selectMapFeature(page: Page, input: StateInput) {
  const region = await mapRegion(page);
  const width = region.right - region.left;
  const height = region.bottom - region.top;
  const candidates: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 11; column += 1) {
      candidates.push({
        x: region.left + (width * (column + 0.5)) / 11,
        y: region.top + (height * (row + 0.5)) / 9,
      });
    }
  }
  const cx = region.left + width / 2;
  const cy = region.top + height / 2;
  candidates.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  for (const { x, y } of candidates) {
    if (input === "desktop") await page.mouse.click(x, y);
    else await page.touchscreen.tap(x, y);
    await page.waitForTimeout(80);
    if ((await selection(page).textContent())?.startsWith("Selected")) return;
  }
  throw new Error("No Map Feature was selectable in the free map region");
}

async function applyEvent(page: Page, event: EngineEvent, input: StateInput) {
  switch (event) {
    case "MVT":
    case "PMTILES": {
      // A source switch must leave the viewer's camera where it was.
      const before = await settledCamera(page);
      await page
        .getByRole("combobox", { name: "Tile source" })
        .selectOption(event === "MVT" ? "mvt" : "pmtiles");
      await expect(surface(page)).toHaveAttribute(
        "data-map-source-id",
        event === "MVT" ? "fixture-pmtiles-xyz" : "maps-showcase",
      );
      await expect(camera(page)).toHaveText(before);
      return;
    }
    case "WEST":
    case "POINTS":
      await page
        .getByRole("combobox", { name: "Camera scene" })
        .selectOption(event === "WEST" ? "west" : "points");
      return;
    case "TILT":
      await page.getByRole("button", { name: "Tilt view" }).click();
      return;
    case "FLATTEN":
      await page.getByRole("button", { name: "Flatten view" }).click();
      return;
    case "RESET":
      await page.getByRole("button", { name: "Reset view" }).click();
      return;
    case "PAN": {
      const before = parseCamera(await settledCamera(page));
      await panMap(page, input);
      const after = parseCamera(await settledCamera(page));
      expect(after.center).not.toBe(before.center);
      return;
    }
    case "ZOOM": {
      const before = parseCamera(await settledCamera(page));
      await zoomMap(page, input);
      await expect
        .poll(async () => parseCamera(await settledCamera(page)).zoom)
        .toBeGreaterThan(before.zoom);
      return;
    }
    case "SELECT":
      await selectMapFeature(page, input);
      await settledCamera(page);
      return;
    case "RELOAD":
      await page.reload();
      return;
    case "BREAK_SOURCE":
      await page.route(PMTILES_ARCHIVE, (route) => route.abort());
      await page.reload();
      return;
    case "RETRY":
      await page.unroute(PMTILES_ARCHIVE);
      await page.reload();
      return;
  }
}

function definePaths(input: StateInput) {
  for (const path of selectPaths(plan, input, config.scope)) {
    test(`@state:maps @${input} ${path.id}: ${path.name}`, async ({ page }) => {
      await page.goto("/maps/engine/?e2e=1&source=pmtiles&scene=points");
      await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
      await test.step(stepTitle(input, "state", plan.initialState), () =>
        expectEngineState(page, plan.initialState as EngineState),
      );
      let from = plan.initialState;
      for (const step of path.steps) {
        const edge = `${from} --${step.event.type}--> ${step.state}`;
        await test.step(stepTitle(input, "edge", edge), async () => {
          await applyEvent(page, step.event.type as EngineEvent, input);
          await expectEngineState(page, step.state as EngineState);
        });
        await test.step(stepTitle(input, "state", step.state), () =>
          expectEngineState(page, step.state as EngineState),
        );
        from = step.state;
      }
    });
  }
}

definePaths("desktop");

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  definePaths("touch");
});

test("@state:maps every page control value is modeled or explicitly unmodeled", async ({
  page,
}) => {
  await page.goto("/maps/engine/?e2e=1&source=pmtiles&scene=points");
  for (const [control, modeled] of Object.entries(MODELED_CONTROL_VALUES)) {
    const options = await page
      .getByRole("combobox", { name: control })
      .locator("option")
      .evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
    const unmodeled = UNMODELED_BRANCHES.filter((item) => item.control === control).map(
      (item) => item.value,
    );
    expect([...options].sort(), control).toEqual([...modeled, ...unmodeled].sort());
  }
});
