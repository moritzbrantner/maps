import { expect, test } from "@playwright/test";

test("retains GeoJSON preparation across pointer hover and selection @smoke", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/overlay-retention.html");
  const work = () => page.evaluate(() => window.mapsRetentionWork);
  await expect.poll(work).toEqual({ projected: 10000, styled: 1 });
  const bounds = await page.getByTestId("surface").boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 331, bounds!.y + 161);
  await expect(page.getByTestId("interaction")).toHaveText("Hovered: true; selected: false");
  expect(await work()).toEqual({ projected: 10000, styled: 1 });
  await page.mouse.click(bounds!.x + 331, bounds!.y + 161);
  await expect(page.getByTestId("interaction")).toHaveText("Hovered: true; selected: true");
  expect(await work()).toEqual({ projected: 10000, styled: 1 });
  await page
    .locator("main")
    .screenshot({ path: testInfo.outputPath("retained-geojson-interaction.png") });
  await page.getByRole("button", { name: "Pan camera" }).click();
  await expect.poll(work).toEqual({ projected: 20000, styled: 1 });
  await page.getByRole("button", { name: "Remove layer" }).click();
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Restore layer" }).click();
  await expect.poll(work).toEqual({ projected: 30000, styled: 2 });
});
