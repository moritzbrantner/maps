import { expect, test } from "@playwright/test";

for (const [renderer, suffix] of [
  ["WebGPU", ""],
  ["Canvas fallback", "&gpu=off"],
] as const) {
  test(`first-party geographic split transitions preserve seek, camera and picking on ${renderer} @smoke`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    const externalTiles: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/tile\.openstreetmap\.org|maplibre-gl/.test(request.url())) {
        externalTiles.push(request.url());
      }
    });

    await page.goto(`/engine/?view=geographic-transition${suffix}`);
    const map = page.getByLabel("Geographic transition acceptance");
    await expect(map).toHaveAttribute("data-map-runtime", "maps");
    await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 30_000 });
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    await expect(page.getByTestId("geographic-transition-feature-count")).toHaveText("1");
    await expect(page.getByRole("list", { name: "Visible regions" })).toContainText(
      "original-region",
    );

    const sourceScreenshot = await map.screenshot();
    await testInfo.attach(`${renderer}-source`, {
      body: sourceScreenshot,
      contentType: "image/png",
    });

    // The first-party geometry overlay owns pointer selection, not a hidden MapLibre map.
    const bounds = await map.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect(page.getByTestId("geographic-transition-selection")).toHaveText("original-region");

    await page.getByRole("button", { name: "Mid-transition" }).click();
    await expect(page.getByTestId("geographic-transition-time")).toHaveText("625");
    await expect(page.getByTestId("geographic-transition-feature-count")).toHaveText("2");
    await expect(page.getByTestId("geographic-transition-selection")).toHaveText("none");
    const firstMidFrame = await page.evaluate(() =>
      JSON.stringify(window.mapsGeometryTransitionAcceptance!.sample(625)),
    );
    const midScreenshot = await map.screenshot();
    await testInfo.attach(`${renderer}-mid-transition`, {
      body: midScreenshot,
      contentType: "image/png",
    });
    expect(midScreenshot.equals(sourceScreenshot)).toBe(false);

    // A camera change must not move geographic source vertices or change the sampled timeline time.
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 45, bounds!.y + bounds!.height / 2 + 24, {
      steps: 6,
    });
    await page.mouse.up();
    await page.mouse.wheel(0, -125);
    await expect(page.getByTestId("geographic-transition-time")).toHaveText("625");
    expect(
      await page.evaluate(() =>
        JSON.stringify(window.mapsGeometryTransitionAcceptance!.sample(625)),
      ),
    ).toBe(firstMidFrame);
    await testInfo.attach(`${renderer}-mid-pan-zoom`, {
      body: await map.screenshot(),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Destination state" }).click();
    await expect(page.getByTestId("geographic-transition-feature-count")).toHaveText("2");
    await expect(page.getByRole("list", { name: "Visible regions" })).toContainText("west-region");
    await expect(page.getByRole("list", { name: "Visible regions" })).toContainText("east-region");
    await page.getByRole("button", { name: "Mid-transition" }).click();
    expect(
      await page.evaluate(() =>
        JSON.stringify(window.mapsGeometryTransitionAcceptance!.sample(625)),
      ),
    ).toBe(firstMidFrame);
    await page.getByRole("button", { name: "Source state" }).click();
    await expect(page.getByRole("list", { name: "Visible regions" })).toContainText(
      "original-region",
    );
    expect(errors).toEqual([]);
    expect(externalTiles).toEqual([]);
  });
}
