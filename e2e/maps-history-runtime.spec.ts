import { expect, test, type Page } from "@playwright/test";

// #231 phase D: the History demo's integrated journey on flatRuntime="maps". The same History
// composition, one Map-Scoped Timeline clock and historical selection run on the first-party
// runtime with no MapLibre map; on-map labels are read from the first-party label pass.
// Places, names, translations and the competing-source scenario are illustrative fixtures;
// CShapes-Europe snapshots keep the ADR 0005 snap/hold rule.

const MAP_LABEL = "European polity history";
const FORD: [number, number] = [4.2, 46.9];
const AUSTRIA_HUNGARY_INTERIOR: [number, number] = [19, 47.5];
const SYNTHETIC_BORDERLAND_INTERIOR: [number, number] = [7.5, 47.2];
// Inside Sample Upland in 1850, but claimed for Sample Borderland by the synthetic Chronicle B.
const ALTERNATIVE_CLAIM_AREA: [number, number] = [10.5, 47.2];

/** A drawn label: its text, left edge and baseline in client pixels, and its width. */
type DrawnLabel = { text: string; width: number; x: number; y: number };
/** The point marker box a label is laid out in, centred on its pin (as on the MapLibre path). */
const MARKER_LABEL_BOX = 36;

declare global {
  interface Window {
    __historyDrawnLabels?: () => DrawnLabel[];
  }
}

/**
 * Records the text each canvas draws since its last clear, so the test reads the labels the
 * first-party label pass actually drew in its latest frame, with their centres in CSS pixels.
 */
async function recordDrawnLabels(page: Page) {
  await page.addInitScript(() => {
    const frames = new Map<HTMLCanvasElement, DrawnLabel[]>();
    const prototype = CanvasRenderingContext2D.prototype;
    const clearRect = prototype.clearRect;
    const fillText = prototype.fillText;

    prototype.clearRect = function (x, y, width, height) {
      if (x === 0 && y === 0) frames.set(this.canvas, []);
      return clearRect.call(this, x, y, width, height);
    };
    prototype.fillText = function (text, x, y, maxWidth) {
      frames.get(this.canvas)?.push({ text, width: this.measureText(text).width, x, y });
      return fillText.call(this, text, x, y, maxWidth);
    };
    window.__historyDrawnLabels = () => {
      const map = document.querySelector(`[aria-label="European polity history"]`);
      return [...frames.entries()]
        .filter(([canvas]) => canvas.isConnected && map?.contains(canvas))
        .flatMap(([canvas, labels]) => {
          const bounds = canvas.getBoundingClientRect();
          return labels.map((label) => ({
            ...label,
            x: bounds.left + label.x,
            y: bounds.top + label.y,
          }));
        });
    };
  });
}

async function drawnLabelTexts(page: Page) {
  return page.evaluate(() =>
    [...new Set(window.__historyDrawnLabels!().map((label) => label.text))].sort(),
  );
}

/** The names the first-party runtime draws on the map; compared as a set. */
async function expectPlaceLabels(page: Page, names: string[]) {
  await expect.poll(() => drawnLabelTexts(page)).toEqual([...names].sort());
}

function projectWebMercator([longitude, latitude]: [number, number]) {
  const radians = (latitude * Math.PI) / 180;
  return {
    x: (longitude + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  };
}

/** Client position of a coordinate under the Map View's current (north-up, unpitched) camera. */
async function clientPosition(page: Page, coordinate: [number, number]) {
  const viewState = await page.evaluate(() =>
    window.mapsHistoryAcceptance!.controller.getViewState(),
  );
  expect(viewState.bearing ?? 0).toBe(0);
  expect(viewState.pitch ?? 0).toBe(0);
  const overlay = page.getByLabel(MAP_LABEL).locator('canvas[data-map-overlay-runtime="maps"]');
  const bounds = (await overlay.boundingBox())!;
  const target = projectWebMercator(coordinate);
  const center = projectWebMercator(viewState.center);
  const worldSize = 512 * 2 ** viewState.zoom;

  return {
    x: bounds.x + bounds.width / 2 + (target.x - center.x) * worldSize,
    y: bounds.y + bounds.height / 2 + (target.y - center.y) * worldSize,
  };
}

/** The camera once an animated pan or scroll zoom has come to rest. */
async function settledViewState(page: Page) {
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = JSON.stringify(
          await page.evaluate(() => window.mapsHistoryAcceptance!.controller.getViewState()),
        );
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { intervals: [150] },
    )
    .toBe(true);
  return JSON.parse(previous) as { zoom: number };
}

async function openHistory(page: Page) {
  await recordDrawnLabels(page);
  await page.goto("/demo-reference/?e2e=1&acceptance=maps-runtime-history");
  const map = page.getByLabel(MAP_LABEL);
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-runtime", "maps");
  await map.scrollIntoViewIfNeeded();
  await expectPlaceLabels(page, ["Sample Ford", "Sample Beacon"]);
}

/** No MapLibre map exists anywhere behind the History Map View. */
async function expectNoMapLibre(page: Page) {
  const map = page.getByLabel(MAP_LABEL);
  await expect(map.locator(".maplibregl-map, .maplibregl-canvas")).toHaveCount(0);
  await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveCount(1);
}

function activeYear(page: Page) {
  return page
    .locator(".demo-interpolation-facts div")
    .filter({ hasText: "Active year" })
    .locator("dd");
}

async function seek(page: Page, year: number) {
  await page.getByRole("slider", { name: "Historical year" }).fill(String(year));
  await expect(activeYear(page)).toHaveText(`${year} AD`);
}

async function hover(page: Page, coordinate: [number, number]) {
  const position = await clientPosition(page, coordinate);

  await page.mouse.move(position.x + 30, position.y + 30);
  await page.mouse.move(position.x, position.y, { steps: 4 });
}

async function click(page: Page, coordinate: [number, number]) {
  const position = await clientPosition(page, coordinate);

  await page.mouse.click(position.x, position.y);
}

test("History journey on the first-party runtime: places rename, relabel, leave their period and return on one clock @smoke", async ({
  page,
}, testInfo) => {
  await openHistory(page);
  await expectNoMapLibre(page);

  const map = page.getByLabel(MAP_LABEL);
  const popup = page.getByTestId("history-popup");
  const tooltip = page.getByTestId("history-tooltip");
  const selected = page.getByRole("region", { name: "Selected feature" });
  const context = page.getByRole("region", { name: "Historical context" });
  const places = page.getByRole("list", { name: "Illustrative places at this date" });

  // Pan and zoom first: picking and labels follow the first-party camera.
  const bounds = (await map.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.7, {
    steps: 6,
  });
  await page.mouse.up();
  const zoomBefore = (await settledViewState(page)).zoom;
  const ford = await clientPosition(page, FORD);
  await page.mouse.move(ford.x, ford.y);
  await page.mouse.wheel(0, -300);
  expect((await settledViewState(page)).zoom).toBeGreaterThan(zoomBefore);
  // The drawn label stays laid out on its pin after the camera moved: a label wider than the
  // marker box grows from the box's left edge, as the MapLibre marker label does (#310).
  await expect
    .poll(async () => {
      const pin = await clientPosition(page, FORD);
      const labels = await page.evaluate(() => window.__historyDrawnLabels!());
      const label = labels.find((candidate) => candidate.text === "Sample Ford");
      const left =
        Math.round(pin.x) -
        MARKER_LABEL_BOX / 2 +
        Math.max(0, (MARKER_LABEL_BOX - (label?.width ?? 0)) / 2);

      return label ? Math.abs(label.x - left) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(2);

  // Pointer hover and selection of a time-relevant pin, with its illustrative provenance.
  await hover(page, FORD);
  await expect(tooltip).toHaveText("Sample Ford");
  await click(page, FORD);
  await expect(popup).toContainText("Sample Ford");
  await expect(popup).toContainText("Illustrative place — not historical evidence");
  await expect(popup).toContainText("Original form: Vadum Exempli (Latin)");
  await expect(popup).toContainText("Modern equivalent: Sample Bridge (illustrative modern name)");
  await expect(popup).toContainText("Map date 1816 AD");
  await expect(places.getByRole("button", { name: "Sample Ford" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(selected).toContainText("Sample Ford");

  // A supported rename changes the drawn label and the open details both ways, while the
  // same Map Feature stays selected (1.18). Boundaries hold their snapshot (ADR 0005).
  await seek(page, 1914);
  await expectPlaceLabels(page, ["Sample Bridge", "Sample Market"]);
  await expect(popup).toContainText("Sample Bridge");
  await expect(popup).toContainText("Map date 1914 AD");
  await expect(places.getByRole("button", { name: "Sample Bridge" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await seek(page, 1900);
  await expectPlaceLabels(page, ["Sample Ford", "Sample Market"]);
  await expect(popup).toContainText("Sample Ford");

  // The viewer language relabels without changing the date or the selection (1.20); a
  // missing form is an identified fallback, not an invented translation.
  await page.getByRole("radio", { name: "Deutsch" }).check();
  await expectPlaceLabels(page, ["Beispielfurt", "Beispielmarkt"]);
  await expect(popup).toContainText("Beispielfurt");
  await expect(activeYear(page)).toHaveText("1900 AD");
  await page.getByRole("radio", { name: "Español" }).check();
  await expectPlaceLabels(page, ["Vado de Ejemplo", "Mercado de Ejemplo"]);
  await seek(page, 1939);
  await expectPlaceLabels(page, ["Beispielbrücke", "Mercado de Ejemplo"]);
  await expect(popup).toContainText("No established form in this language");
  await page.getByRole("radio", { name: "English" }).check();
  await expect(popup).toContainText("Sample Bridge");

  // Leaving the period clears the pin, its selection, hover and popup, and keeps the dated
  // details detached and marked out of period (1.14).
  await hover(page, FORD);
  await expect(tooltip).toHaveText("Sample Bridge");
  await seek(page, 1945);
  await expectPlaceLabels(page, ["Sample Market"]);
  await expect(popup).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
  await expect(places.getByRole("button")).toHaveText(["Sample Market"]);
  await expect(selected).toContainText("Select a polity or an illustrative place");
  await expect(context).toContainText("Out of period");
  await expect(context).toContainText("Details refer to1939 AD (1816–1944)");
  await expect(context).toContainText("Map date1945 AD");
  await expect(context).toContainText("Illustrative place — not historical evidence");
  // Its former location now picks only the polity beneath it.
  await hover(page, FORD);
  await expect(tooltip).toHaveText("France");
  await click(page, FORD);
  await expect(places.getByRole("button", { pressed: true })).toHaveCount(0);
  await expect(popup).toContainText("France");
  // Clearing the selection also closes the popup it opened, as on the MapLibre path.
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(popup).toHaveCount(0);

  // Rapid out-of-order seeks, including back into the period, restore nothing.
  for (const year of [1830, 1989, 1816, 2019]) {
    await seek(page, year);
    await expect(popup).toHaveCount(0);
    await expect(places.getByRole("button", { pressed: true })).toHaveCount(0);
  }

  // Selecting France replaced the retained place context; reopen it from a fresh selection.
  await seek(page, 1939);
  await places.getByRole("button", { name: "Sample Bridge" }).click();
  await seek(page, 1989);
  await expect(context).toContainText("Out of period");

  // The mini-timeline lists only supported dates; browsing it changes nothing, and
  // activating one by keyboard seeks the one clock and reselects the same feature (1.16).
  await expect(
    context.getByRole("navigation", { name: "Supported dates" }).getByRole("button"),
  ).toHaveText(["1816", "1886", "1914", "1939"]);
  await context.getByRole("button", { name: "1886" }).focus();
  await expect(activeYear(page)).toHaveText("1989 AD");
  await page.keyboard.press("Enter");
  await expect(activeYear(page)).toHaveText("1886 AD");
  await expect(page.getByRole("slider", { name: "Historical year" })).toHaveValue("1886");
  await expect(places.getByRole("button", { name: "Sample Ford" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(context).toHaveCount(0);
  await expectPlaceLabels(page, ["Sample Ford", "Sample Market"]);

  // The restored pin is pickable at its date under the moved camera.
  await map.scrollIntoViewIfNeeded();
  await click(page, FORD);
  await expect(popup).toContainText("Sample Ford");

  // Keyboard selection of another applicable place replaces the selection and its popup.
  await places.getByRole("button", { name: "Sample Market" }).focus();
  await page.keyboard.press("Enter");
  await expect(selected).toContainText("Sample Market");
  await expect(popup).toHaveCount(0);
  await expectNoMapLibre(page);
  // A representative frame of the journey, attached as evidence rather than a pixel gate.
  await testInfo.attach("history-maps-runtime", {
    body: await map.screenshot(),
    contentType: "image/png",
  });
});

test("History polity selection on the first-party runtime discloses its source status and never follows a successor @smoke", async ({
  page,
}) => {
  await openHistory(page);

  const popup = page.getByTestId("history-popup");
  const selected = page.getByRole("region", { name: "Selected feature" });
  const context = page.getByRole("region", { name: "Historical context" });
  const politySelect = page.getByRole("combobox", { name: "Select a polity at this date" });

  await click(page, AUSTRIA_HUNGARY_INTERIOR);
  await expect(popup).toContainText("Austria-Hungary");
  await expect(popup).toContainText("Map date 1816 AD · source snapshot 1816 AD");
  await expect(popup).toContainText("Source-derived boundary");
  await expect(popup).toContainText("Source: CShapes-Europe record 1816–1846");
  await expect(politySelect).toHaveValue("300-austria-hungary");

  // The effective source year stays visible while the held snapshot is shown (ADR 0005).
  await seek(page, 1900);
  await expect(popup).toContainText("Map date 1900 AD · source snapshot 1886 AD");
  await expect(popup).toContainText("Source: CShapes-Europe record 1886–1907");

  // Out of period: no selection or popup, and what is drawn there now is not selected for it.
  await seek(page, 1939);
  await expect(popup).toHaveCount(0);
  await expect(politySelect).toHaveValue("");
  await expect(context).toContainText("Out of period");
  await expect(context).toContainText(
    "Details refer to1900 AD (snapshot held 1816 AD until 1939 AD)",
  );
  await expect(context).toContainText("Map date1939 AD");
  await expect(context).toContainText("Source: CShapes-Europe record 1886–1907");
  await hover(page, AUSTRIA_HUNGARY_INTERIOR);
  await expect(page.getByTestId("history-tooltip")).not.toHaveText("Austria-Hungary");

  // Only an explicit supported date brings it back.
  await context.getByRole("button", { name: "1914 AD" }).click();
  await expect(activeYear(page)).toHaveText("1914 AD");
  await expect(politySelect).toHaveValue("300-austria-hungary");
  await expect(context).toHaveCount(0);
  await click(page, AUSTRIA_HUNGARY_INTERIOR);
  await expect(popup).toContainText("Austria-Hungary");

  // The WWII scenario keeps its fractional clock, notice and per-boundary disclosure.
  await page.getByRole("button", { name: "Show WWII control" }).click();
  await expect(politySelect).toHaveValue("");
  await expectPlaceLabels(page, []);
  await page.getByRole("slider", { name: "Historical year" }).fill("1940.5");
  await expect(activeYear(page)).toHaveText("Jun 1940");
  await politySelect.selectOption("control-germany");
  await expect(selected).toContainText("Illustrative boundary");
  await expect(selected).toContainText("moving fronts are not authoritative");
  await expectNoMapLibre(page);
});

test("History competing sources on the first-party runtime draw one chosen reconstruction with attributed alternatives @smoke", async ({
  page,
}) => {
  await openHistory(page);

  const map = page.getByLabel(MAP_LABEL);
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const popup = page.getByTestId("history-popup");
  const tooltip = page.getByTestId("history-tooltip");
  const selected = page.getByRole("region", { name: "Selected feature" });
  const context = page.getByRole("region", { name: "Historical context" });
  const politySelect = page.getByRole("combobox", { name: "Select a polity at this date" });

  await page.getByRole("button", { name: "Show Competing sources (synthetic)" }).click();
  await expect(activeYear(page)).toHaveText("1850 AD");
  await expect(page.getByText(/^Synthetic fixture: these regions/)).toBeVisible();
  await expectPlaceLabels(page, []);

  // Only the chosen geometry is drawn: the area an alternative claims picks the region the
  // chosen reconstruction draws there.
  await expect(politySelect.getByRole("option")).toHaveCount(3);
  const twoRegionPrimitives = Number(await overlay.getAttribute("data-map-overlay-primitives"));
  await hover(page, ALTERNATIVE_CLAIM_AREA);
  await expect(tooltip).toHaveText("Sample Upland (synthetic)");
  await click(page, SYNTHETIC_BORDERLAND_INTERIOR);
  await expect(popup).toContainText("Sample Borderland (synthetic)");
  const source = popup.getByRole("region", { name: "Boundary source" });
  await expect(source).toContainText("Reconstructed boundary");
  await expect(source).toContainText("Illustrative Survey A");
  const disclosure = source.getByText("2 competing interpretations (not drawn)");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(source.getByText("Illustrative Chronicle B", { exact: false })).toBeVisible();

  // Zooming keeps the attribution and the picking of the chosen regions.
  const position = await clientPosition(page, SYNTHETIC_BORDERLAND_INTERIOR);
  await page.mouse.move(position.x, position.y);
  await page.mouse.wheel(0, -400);
  await settledViewState(page);
  await expect(selected).toContainText("Illustrative Survey A");
  await hover(page, ALTERNATIVE_CLAIM_AREA);
  await expect(tooltip).toHaveText("Sample Upland (synthetic)");

  // The next held snapshot has its own chosen reconstruction; earlier alternatives go.
  await seek(page, 1925);
  await expect(selected).toContainText("Documentary boundary");
  await expect(selected).toContainText("Illustrative Treaty Map D");
  await expect(selected).not.toContainText("competing interpretation");

  // Out of period, the retained context keeps its date's attribution, and one region is
  // drawn: half the geometry of the two-region snapshot, so no phantom alternative.
  await seek(page, 1950);
  await expect(popup).toHaveCount(0);
  await expect(context).toContainText("Out of period");
  await expect(context.getByRole("region", { name: "Boundary source" })).toContainText(
    "Illustrative Treaty Map D",
  );
  await expect(politySelect.getByRole("option")).toHaveCount(2);
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-primitives")) * 2)
    .toBe(twoRegionPrimitives);
  await expectNoMapLibre(page);
});
