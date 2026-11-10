import { expect, test, type Page } from "@playwright/test";

import { HISTORICAL_ACCEPTANCE_POSITIONS } from "../demo/historical-acceptance-data";

const MAP_LABEL = "Maps historical selection acceptance";
const VIEW_STATE = { center: [13, 52] as [number, number], zoom: 7 };

function projectWebMercator([longitude, latitude]: [number, number]) {
  const radians = (latitude * Math.PI) / 180;
  return {
    x: (longitude + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  };
}

async function clientPosition(page: Page, coordinate: [number, number]) {
  const overlay = page.getByLabel(MAP_LABEL).locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = (await overlay.boundingBox())!;
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(VIEW_STATE.center);
  const worldSize = 512 * 2 ** VIEW_STATE.zoom;
  return {
    x: bounds.x + bounds.width / 2 + (target.x - center.x) * worldSize,
    y: bounds.y + bounds.height / 2 + (target.y - center.y) * worldSize,
  };
}

async function seek(page: Page, time: number) {
  await page.getByRole("slider", { name: "Historical timeline" }).fill(String(time));
  await expect(page.getByTestId("historical-time")).toHaveText(String(time));
}

// #170 phase D: Decisions 1.14/1.16/1.18/1.20 on the first-party runtime and one clock.
test("historical selection clears on leaving its period and keeps dated out-of-period context @smoke", async ({
  page,
}) => {
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-historical");

  const map = page.getByLabel(MAP_LABEL);
  const selection = page.getByTestId("historical-selection");
  const hover = page.getByTestId("historical-hover");
  const popup = page.getByTestId("historical-popup");
  const context = page.getByRole("region", { name: "Historical context" });

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);

  // Pointer hover and selection through first-party picking, with the date-appropriate name.
  const harbour = await clientPosition(page, HISTORICAL_ACCEPTANCE_POSITIONS["synthetic-harbour"]!);
  await page.mouse.move(harbour.x, harbour.y);
  await expect(hover).toHaveText("synthetic-harbour");
  await page.mouse.click(harbour.x, harbour.y);
  await expect(selection).toHaveText("synthetic-harbour");
  await expect(popup).toHaveText("Old Harbour");

  // A supported rename keeps the same selection (1.18); the language relabels it (1.20).
  await seek(page, 1860);
  await expect(selection).toHaveText("synthetic-harbour");
  await expect(popup).toHaveText("New Harbour");
  await page.getByRole("radio", { exact: true, name: "DE" }).check();
  await expect(popup).toHaveText("Neuhafen");
  await expect(selection).toHaveText("synthetic-harbour");
  await page.getByRole("radio", { exact: true, name: "EN" }).check();

  // Leaving the period clears selection, hover, popup and pickability (1.14).
  await seek(page, 1910);
  await expect(selection).toHaveText("none");
  await expect(hover).toHaveText("none");
  await expect(popup).toHaveCount(0);
  await expect(context).toContainText("Out of period");
  await expect(context).toContainText("New Harbour");
  await expect(context).toContainText("Details refer to1860 (1800–1899)");
  await expect(context).toContainText("Map date1910");
  // Its former location is no longer pickable (projected after the seek's scroll).
  const former = await clientPosition(page, HISTORICAL_ACCEPTANCE_POSITIONS["synthetic-harbour"]!);
  await page.mouse.move(former.x + 40, former.y + 40);
  await page.mouse.move(former.x, former.y);
  await expect(hover).toHaveText("none");
  await page.mouse.click(former.x, former.y);
  await expect(selection).toHaveText("none");
  await expect(popup).toHaveCount(0);

  // Rapid out-of-order seeks, including back into the period, never restore the selection.
  for (const time of [1830, 1915, 1805, 1912]) {
    await seek(page, time);
    await expect(popup).toHaveCount(0);
  }
  await seek(page, 1840);
  await expect(selection).toHaveText("none");
  await expect(context).toContainText("Applies at the map date — not selected");

  // The mini-timeline is keyboard operable and changes nothing until a date is activated.
  await seek(page, 1910);
  const supported = context.getByRole("button", { name: "1820" });
  await supported.focus();
  await expect(page.getByTestId("historical-time")).toHaveText("1910");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("historical-time")).toHaveText("1820");
  await expect(selection).toHaveText("synthetic-harbour");
  await expect(page.getByTestId("historical-selected-name")).toHaveText("Old Harbour");
  await expect(context).toHaveCount(0);
  // The restored feature is displayed and pickable again at its date.
  // Focusing the mini-timeline may have scrolled the page: project again.
  const restored = await clientPosition(page, HISTORICAL_ACCEPTANCE_POSITIONS["synthetic-harbour"]!);
  await page.mouse.click(restored.x, restored.y);
  await expect(popup).toHaveText("Old Harbour");

  // A newly applicable selection by keyboard replaces the retained context.
  await seek(page, 1905);
  await expect(context).toBeVisible();
  await page.getByRole("button", { name: "Mill" }).focus();
  await page.keyboard.press("Enter");
  await expect(selection).toHaveText("synthetic-mill");
  await expect(context).toHaveCount(0);
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});
