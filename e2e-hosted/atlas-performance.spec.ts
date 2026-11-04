import { expect, test } from "@playwright/test";

// Advisory, real-archive measurements. No unpaired MapLibre/Fast verdict.
test("capture Atlas cold load and warm regional revisit evidence", async ({ page }) => {
  const archiveResponses: Array<{ status: number; range: string; bytes: number }> = [];
  page.on("response", (response) => {
    if (!response.url().includes("/tilesets/liechtenstein-") || !response.url().endsWith(".pmtiles"))
      return;
    archiveResponses.push({
      status: response.status(),
      range: response.request().headers()["range"] ?? "",
      bytes: Number(response.headers()["content-length"] ?? 0),
    });
  });

  const start = Date.now();
  await page.goto("/maps/?source=atlas&scene=liechtenstein&e2e=1");
  const canvas = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready", { timeout: 30_000 });
  await expect.poll(async () => Number(await canvas.getAttribute("data-map-base-tiles"))).toBeGreaterThan(0);
  const coldReadyMs = Date.now() - start;
  const coldRequests = archiveResponses.length;
  const coldTransferredBytes = archiveResponses.reduce((sum, response) => sum + response.bytes, 0);

  await page.getByRole("combobox", { name: "Camera scene" }).selectOption("north");
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  const revisitStart = Date.now();
  await page.getByRole("button", { name: "View covered region" }).click();
  await expect(canvas).toHaveAttribute("data-map-source-state", "ready");
  await expect.poll(async () => Number(await canvas.getAttribute("data-map-base-tiles"))).toBeGreaterThan(0);
  const warmRevisitMs = Date.now() - revisitStart;

  expect(coldRequests).toBeGreaterThan(0);
  expect(archiveResponses.every((response) => response.status === 206 && response.range.startsWith("bytes="))).toBe(true);
  expect(coldTransferredBytes).toBeGreaterThan(0);

  await test.info().attach("atlas-runtime-evidence.json", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({
      source: "published-content-pinned-liechtenstein",
      scope: "Chromium wall-clock to ready decoded Canvas tiles; not first useful paint, GPU frame time, or MapLibre parity",
      coldReadyMs,
      coldRequests,
      coldTransferredBytes,
      warmRevisitMs,
      responses: archiveResponses,
      verdict: "advisory-unpaired",
    }, null, 2)),
  });
});
