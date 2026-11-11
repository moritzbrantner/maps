import { expect, test } from "@playwright/test";

// Tile seam QA in the Engine inspector (#276, part 3). The expected seams are the ones
// scripts/tileset-seam-fixture.mjs breaks in the committed defects archive.
test("seam QA reports the fixture's broken seams, shows the archive and focuses a pair @smoke", async ({
  page,
}) => {
  await page.goto("/engine/?view=inspector&source=pmtiles&seams=fixture-seams-defects&e2e=1");
  const panel = page.locator('section[aria-labelledby="inspector-seam-qa"]');
  await panel.getByRole("button", { name: "Check seams" }).click();
  await expect(panel).toHaveAttribute("data-seam-qa-status", "failed");
  await expect(panel.locator('tr[data-check="archive"]')).toHaveAttribute("data-status", "passed");
  await expect(panel.locator('tr[data-check="line-seams"]')).toHaveAttribute(
    "data-status",
    "failed",
  );
  await expect(panel.locator('tr[data-check="polygon-seams"]')).toHaveAttribute(
    "data-status",
    "failed",
  );
  await expect(panel.locator('dd[data-seam-count="pairs"]')).toHaveText("7 / 7");
  await expect(panel.locator('dd[data-seam-count="lines"]')).toHaveText("2 / 1 / 1 / 2");
  await expect(panel.locator('dd[data-seam-count="polygons"]')).toHaveText("11 / 2");
  await expect(
    panel.locator("li").filter({ hasText: "east seam with 1/1/0: line-interrupted 1" }),
  ).toHaveCount(1);

  // Show the archive: the Map View renders the exact source and revision the QA checked.
  await panel.getByRole("button", { name: /^Show/ }).click();
  const source = page.locator("dl[data-map-source-stats-id]");
  await expect(source).toHaveAttribute("data-map-source-stats-id", "fixture-seams");
  await expect(source).toHaveAttribute("data-map-source-stats-revision", "defects");
  await expect(source).toHaveAttribute("data-map-source-stats-state", "ready");

  // Focus the pair whose island seam breaks: the camera frames both tiles.
  await panel.getByRole("button", { name: "Focus 1/1/0 ↓ 1/1/1" }).click();
  await expect(panel.locator("[data-focused-seam]")).toHaveAttribute("data-focused-seam", "1/1/0");
  await expect(panel.locator("[data-focused-seam]")).toContainText(
    "fixture-seams / defects: south seam with 1/1/1: polygon-edge-mismatch 1",
  );
  const center = page
    .locator("dl.engine-inspector__list")
    .filter({ hasText: "Center" })
    .locator("dd")
    .first();
  await expect(center).toHaveText(/^90\.0000, -?0\.0000$/);
  await expect(page.locator(".maplibregl-map")).toHaveCount(0);
});
