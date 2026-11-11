import { expect, test } from "@playwright/test";

// Tileset revision diff in the Engine inspector (#276, part 2). The expected differences are
// the ones scripts/tileset-revision-fixture.mjs writes into the committed r1/r2 archives.
test("revision QA compares r1 and r2, shows either revision and focuses a lost tile @smoke", async ({
  page,
}) => {
  await page.goto("/engine/?view=inspector&source=pmtiles&qa=fixture-revision-r1-r2&e2e=1");
  const panel = page.locator('section[aria-labelledby="inspector-revision-qa"]');
  await panel.getByRole("button", { name: "Compare revisions" }).click();
  await expect(panel).toHaveAttribute("data-revision-qa-status", "failed");
  await expect(panel.locator(".engine-inspector__qa-status")).toHaveAttribute(
    "data-relation",
    "revision",
  );
  await expect(panel.locator('tr[data-check="coverage"]')).toHaveAttribute("data-status", "failed");
  await expect(panel.locator('tr[data-check="features"]')).toHaveAttribute("data-status", "passed");
  await expect(panel.locator('dd[data-qa-count="coverage"]')).toHaveText("0 / 1 / 1");
  await expect(panel.locator('dd[data-qa-count="tiles"]')).toHaveText("4 · 1 / 0 / 3");
  await expect(panel.locator('dd[data-qa-count="unmatched"]')).toHaveText("1 / 3 / 3");
  await expect(panel.getByText("fixture-revision / r1", { exact: true })).toBeVisible();
  await expect(panel.getByText("fixture-revision / r2", { exact: true })).toBeVisible();

  // Show the candidate: the Map View switches to the exact revision and, as the QA finding
  // predicts, fails closed on the tile r2 lost.
  await panel.getByRole("button", { name: /^Show B/ }).click();
  const source = page.locator("dl[data-map-source-stats-id]");
  await expect(source).toHaveAttribute("data-map-source-stats-id", "fixture-revision");
  await expect(source).toHaveAttribute("data-map-source-stats-revision", "r2");
  await expect(source).toHaveAttribute("data-map-source-stats-state", "error");
  await expect(
    page.getByText("Maps Tileset fixture-revision: PMTiles missing tile 1/1/1"),
  ).toBeVisible();

  // Focus the tile r2 lost: the camera frames the tile bounds from the Rust tile rule.
  await panel.getByRole("button", { name: "Focus 1/1/1" }).click();
  await expect(panel.locator("[data-focused-tile]")).toHaveAttribute("data-focused-tile", "1/1/1");
  await expect(panel.locator("[data-focused-tile]")).toContainText(
    "fixture-revision / r2: coverage lost",
  );
  const center = page
    .locator("dl.engine-inspector__list")
    .filter({ hasText: "Center" })
    .locator("dd")
    .first();
  await expect(center).toHaveText(/^90\.0000, -6\d\.\d{4}$/);

  // A changed tile names its differences, never a feature identity.
  await expect(
    panel.locator("li").filter({
      hasText: "changed: ambiguous 1; unmatched-added 1; unmatched-removed 1",
    }),
  ).toHaveCount(1);
  // The base revision has every tile.
  await panel.getByRole("button", { name: /^Show A/ }).click();
  await expect(source).toHaveAttribute("data-map-source-stats-revision", "r1");
  await expect(source).toHaveAttribute("data-map-source-stats-state", "ready");
  await expect(page.locator(".maplibregl-map")).toHaveCount(0);
});
