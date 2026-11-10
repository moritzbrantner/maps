import { expect, test, type Page } from "@playwright/test";

// #231 phase A/B on the real History tab (MapLibre path): illustrative dated place pins and
// CShapes-Europe polity snapshots share one Map-Scoped Timeline clock, and selection, hover
// and popups stay valid for the map year (Decisions 1.3, 1.14, 1.16, 1.18, 1.20).

const MAP_LABEL = "European polity history";
const FORD: [number, number] = [4.2, 46.9];
const AUSTRIA_HUNGARY_INTERIOR: [number, number] = [19, 47.5];

type DemoWindow = Window & {
  __mbMapsDemoMap?: {
    getContainer(): HTMLElement;
    project(coordinate: [number, number]): { x: number; y: number };
  };
};

async function clientPosition(page: Page, coordinate: [number, number]) {
  return page.evaluate((lngLat) => {
    const map = (window as DemoWindow).__mbMapsDemoMap!;
    const point = map.project(lngLat);
    const bounds = map.getContainer().getBoundingClientRect();

    return { x: bounds.left + point.x, y: bounds.top + point.y };
  }, coordinate);
}

async function openHistory(page: Page) {
  await page.goto("/demo-reference/?e2e=1");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByLabel(MAP_LABEL)).toHaveAttribute("data-map-ready", "true");
  await expectPlaceLabels(page, ["Sample Ford", "Sample Beacon"]);
}

function placeLabels(page: Page) {
  return page.getByLabel(MAP_LABEL).locator(".mb-maps__cluster-count");
}

/** The names drawn on the map; marker DOM order is not meaningful, so compare as a set. */
async function expectPlaceLabels(page: Page, names: string[]) {
  await expect
    .poll(async () => (await placeLabels(page).allTextContents()).sort())
    .toEqual([...names].sort());
}

function activeYear(page: Page) {
  return page.locator(".demo-interpolation-facts div").filter({ hasText: "Active year" }).locator("dd");
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

test("History place pins follow the map year, rename, relabel and leave dated out-of-period context @smoke", async ({
  page,
}) => {
  await openHistory(page);

  const map = page.getByLabel(MAP_LABEL);
  const popup = page.getByTestId("history-popup");
  const tooltip = page.getByTestId("history-tooltip");
  const selected = page.getByRole("region", { name: "Selected feature" });
  const context = page.getByRole("region", { name: "Historical context" });
  const places = page.getByRole("list", { name: "Illustrative places at this date" });

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

  // A supported rename changes the on-map label and the open details, both ways, while the
  // same Map Feature stays selected (1.18).
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

  // The viewer language relabels without changing the date or the selection (1.20), and a
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
  await expect(places.getByRole("button", { name: "Beispielbrücke" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
  await expect(context).toContainText("Sample Bridge");
  await expect(context).toContainText("Details refer to1939 AD (1816–1944)");
  await expect(context).toContainText("Map date1945 AD");
  await expect(context).toContainText("Modern equivalentSample Bridge (illustrative modern name)");
  await expect(context).toContainText("Illustrative place — not historical evidence");
  // Its former location now reports only the polity beneath it.
  await hover(page, FORD);
  await expect(tooltip).toHaveText("France");

  // Rapid out-of-order seeks, including back into the period, restore nothing.
  for (const year of [1830, 1989, 1816, 2019]) {
    await seek(page, year);
    await expect(popup).toHaveCount(0);
    await expect(places.getByRole("button", { pressed: true })).toHaveCount(0);
  }
  await seek(page, 1830);
  await expect(context).toContainText("Applies at the map date — not selected");
  await seek(page, 1989);
  await expect(context).toContainText("Out of period");

  // The mini-timeline lists only supported dates; browsing it changes nothing, and
  // activating one by keyboard seeks the one clock and reselects the same feature (1.16).
  await expect(context.getByRole("navigation", { name: "Supported dates" }).getByRole("button")).toHaveText(
    ["1816", "1886", "1914", "1939"],
  );
  await context.getByRole("button", { name: "1886" }).focus();
  await expect(activeYear(page)).toHaveText("1989 AD");
  await page.keyboard.press("Enter");
  await expect(activeYear(page)).toHaveText("1886 AD");
  await expect(page.getByRole("slider", { name: "Historical year" })).toHaveValue("1886");
  await expect(places.getByRole("button", { name: "Sample Ford" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(selected).toContainText("Sample Ford");
  await expect(context).toHaveCount(0);

  // Camera movement keeps the selection and the pins geographically aligned.
  await map.scrollIntoViewIfNeeded();
  const before = await clientPosition(page, FORD);
  const bounds = (await map.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await clientPosition(page, FORD)).x).not.toBeCloseTo(before.x, 0);
  await expect(places.getByRole("button", { name: "Sample Ford" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(async () => {
      const pin = await clientPosition(page, FORD);
      const label = (await placeLabels(page).filter({ hasText: "Sample Ford" }).boundingBox())!;

      return Math.hypot(label.x + label.width / 2 - pin.x, label.y + label.height / 2 - pin.y);
    })
    .toBeLessThan(3);
  await click(page, FORD);
  await expect(popup).toContainText("Sample Ford");

  // Keyboard selection of another applicable place replaces the selection and its popup.
  await places.getByRole("button", { name: "Sample Market" }).focus();
  await page.keyboard.press("Enter");
  await expect(selected).toContainText("Sample Market");
  await expect(popup).toHaveCount(0);
});

test("History polity selection discloses its source status and never follows a successor @smoke", async ({
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
  await expect(popup).toContainText("not an authoritative historical boundary source");
  await expect(politySelect).toHaveValue("300-austria-hungary");

  // The effective source year stays visible while the held snapshot is shown (ADR 0005).
  await seek(page, 1900);
  await expect(popup).toContainText("Map date 1900 AD · source snapshot 1886 AD");
  await expect(popup).toContainText("Source: CShapes-Europe record 1886–1907");
  await expect(politySelect).toHaveValue("300-austria-hungary");

  // Out of period: no selection, no popup, and the polity now there is not selected for it.
  await seek(page, 1939);
  await expect(popup).toHaveCount(0);
  await expect(politySelect).toHaveValue("");
  await expect(politySelect.getByRole("option", { name: "Austria-Hungary" })).toHaveCount(0);
  await expect(context).toContainText("Out of period");
  await expect(context).toContainText("Austria-Hungary");
  await expect(context).toContainText(
    "Details refer to1900 AD (snapshot held 1816 AD until 1939 AD)",
  );
  await expect(context).toContainText("Map date1939 AD");
  await expect(context).toContainText("Source-derived boundary");
  await expect(context).toContainText("Source: CShapes-Europe record 1886–1907");

  // Only an explicit supported date brings it back.
  await expect(context.getByRole("navigation", { name: "Supported dates" }).getByRole("button")).toHaveText(
    ["1816 AD", "1886 AD", "1914 AD"],
  );
  await context.getByRole("button", { name: "1914 AD" }).click();
  await expect(activeYear(page)).toHaveText("1914 AD");
  await expect(politySelect).toHaveValue("300-austria-hungary");
  await expect(context).toHaveCount(0);

  // Keyboard selection of a polity; other viewer languages get the flagged dataset form.
  await politySelect.selectOption("220-france");
  await expect(selected).toContainText("France");
  await expect(selected).toContainText("Source: CShapes-Europe record 1886–1918");
  await page.getByRole("radio", { name: "Deutsch" }).check();
  await expect(selected).toContainText("No established form in this language");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(politySelect).toHaveValue("");

  // The WWII scenario keeps its illustrative notice and discloses it per selected boundary.
  await politySelect.selectOption("220-france");
  await page.getByRole("button", { name: "Show WWII control" }).click();
  await expect(politySelect).toHaveValue("");
  await expect(context).toHaveCount(0);
  await expect(placeLabels(page)).toHaveCount(0);
  await politySelect.selectOption("control-germany");
  await expect(selected).toContainText("Illustrative boundary");
  await expect(selected).toContainText("moving fronts are not authoritative");
  await expect(
    page.getByText(
      "WWII control uses CShapes-Europe country outlines with illustrative campaign-phase control clipping; internal moving fronts are not authoritative.",
    ),
  ).toBeVisible();
});
