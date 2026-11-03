import { expect, test, type Page } from "@playwright/test";
import { generateStatePaths } from "mobile-analysis/state-paths";
import { createMachine } from "xstate";

// These are independent toolbar transitions; each path begins from the same camera/source.
const engineStates = createMachine({
  id: "maps-engine-toolbar",
  initial: "initial",
  states: {
    initial: { on: { MVT: "mvt", WEST: "west", TILT: "tilted" } },
    mvt: { on: { PMTILES: "initial" } },
    west: { on: { RESET: "initial", POINTS: "initial" } },
    tilted: { on: { FLATTEN: "initial", RESET: "initial" } },
  },
});

const plan = generateStatePaths({
  id: "maps-engine-toolbar",
  model: engineStates,
  events: ["MVT", "PMTILES", "WEST", "POINTS", "TILT", "FLATTEN", "RESET"],
  maxPaths: 10,
});

async function expectRenderedTiles(page: Page) {
  const canvas = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  // WebGPU retains vector tiles; Canvas2D tracks its drawn basemap tiles separately.
  await expect
    .poll(async () => {
      const backend = await canvas.getAttribute("data-map-base-renderer");
      const counter = backend === "wgpu" ? "data-map-vector-tiles" : "data-map-base-tiles";
      return Number(await canvas.getAttribute(counter));
    })
    .toBeGreaterThan(0);
}

async function expectEngineState(page: Page, state: string) {
  const source = page.getByRole("combobox", { name: "Tile source" });
  const scene = page.getByRole("combobox", { name: "Camera scene" });
  await expect(source).toHaveValue(state === "mvt" ? "mvt" : "pmtiles");
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-id",
    state === "mvt" ? "fixture-pmtiles-xyz" : "maps-showcase",
  );
  await expect(scene).toHaveValue(state === "west" ? "west" : "points");
  await expect(
    page.getByRole("button", { name: state === "tilted" ? "Flatten view" : "Tilt view" }),
  ).toBeVisible();
  if (state === "mvt" || state === "initial") {
    await expect(page).toHaveURL(
      new RegExp(`(?:[?&]source=${state === "mvt" ? "mvt" : "pmtiles"})`),
    );
  }
  if (state === "west") await expect(page).toHaveURL(/[?&]scene=west/);
  else await expect(page).toHaveURL(/[?&]scene=points/);
  await expectRenderedTiles(page);
}

async function applyEvent(page: Page, event: string) {
  switch (event) {
    case "MVT":
    case "PMTILES":
      await page
        .getByRole("combobox", { name: "Tile source" })
        .selectOption(event === "MVT" ? "mvt" : "pmtiles");
      return;
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
    default:
      throw new Error(`No Playwright action for ${event}`);
  }
}

for (const path of plan.paths) {
  test(`@state:maps ${path.id}: ${path.name}`, async ({ page }) => {
    await page.goto("/maps/engine/?e2e=1&source=pmtiles&scene=points");
    await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
    await expectEngineState(page, plan.initialState);
    for (const step of path.steps) {
      await applyEvent(page, step.event.type);
      await expectEngineState(page, step.state);
    }
  });
}
