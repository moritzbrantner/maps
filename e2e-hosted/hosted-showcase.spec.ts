import { expect, test } from "@playwright/test";

test("hosted Pages runs the first-party PMTiles engine without external tile requests", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const externalTiles: string[] = [];
  const rangeStatuses: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/openstreetmap\.org|maplibre-gl|unpkg\.com/.test(request.url())) {
      externalTiles.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("showcase-pmtiles-v1.pmtiles")) {
      rangeStatuses.push(response.status());
    }
  });

  await page.goto("/maps/?source=pmtiles&e2e=1");

  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-id",
    "maps-showcase",
  );
  await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-source-state",
    "ready",
    { timeout: 30_000 },
  );
  expect(rangeStatuses.length).toBeGreaterThanOrEqual(3);
  expect(rangeStatuses.every((status) => status === 206)).toBe(true);
  expect(externalTiles).toEqual([]);

  expect(pageErrors).toEqual([]);
});

test("hosted evidence page shows absent evidence as unavailable and never a Moonlight pass without its capture", async ({
  page,
  request,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // A failed point-journey run publishes nothing, so this is a real absent state.
  await page.route("**/maps/evidence/point-journey.json", (route) =>
    route.fulfill({ status: 404, contentType: "text/html", body: "Not found" }),
  );

  await page.goto("/maps/evidence/");

  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  const absentRow = page.getByRole("row").filter({ hasText: "Dense-point camera journey" });
  await expect(absentRow).toContainText("source-unavailable", { timeout: 45_000 });
  await expect(absentRow).toContainText("unavailable");
  await expect(page.getByText(/evidence sources need attention/)).toBeVisible();

  // The Atlas tileset evaluation (#270) is the only Moonlight source. Deploy builds
  // publish Moonlight's actual outcome; a PR preview captures none and must say so.
  const atlasRows = page.getByRole("row").filter({ hasText: "Atlas tileset journey" });
  await expect(page.getByRole("row").filter({ hasText: "Moonlight" })).toHaveCount(
    await atlasRows.count(),
  );
  const atlas = await request.get("/maps/evidence/atlas-tileset-runtime.json");
  if ((atlas.headers()["content-type"] ?? "").includes("json")) {
    const report = await atlas.json();
    expect(["passed", "failed", "inconclusive"]).toContain(report.status);
    expect(report.evaluation.outcome).toBe(report.status);
    expect(report.evaluation.browser.comparability).toMatch(
      /^(comparable|incomparable|insufficient-evidence)$/,
    );
    expect(report.evaluation.rounds.length).toBeGreaterThanOrEqual(2);
    await expect(atlasRows.first()).not.toContainText("source-unavailable");
  } else {
    await expect(atlasRows.first()).toContainText("source-unavailable");
    await expect(atlasRows.first()).not.toContainText("passed");
  }
  const advertised = await page.evaluate(() =>
    (
      window as unknown as { __PROJECT_PAGES_CONFIG__: { evidenceSources: { url: string }[] } }
    ).__PROJECT_PAGES_CONFIG__.evidenceSources.map((source) => source.url),
  );
  expect(advertised).not.toContain("/maps/evidence/runtime.json");
  // GitHub Pages answers 404; the preview server answers with its HTML fallback.
  const runtime = await request.get("/maps/evidence/runtime.json");
  expect(runtime.headers()["content-type"] ?? "").not.toContain("json");

  expect(pageErrors).toEqual([]);
});

test("hosted Pages publishes the benchmark lab as a direct route", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://unpkg.com/**", (route) => route.abort());

  await page.goto("/maps/benchmarks/?e2e=1");

  await expect(page.getByRole("heading", { name: "Renderer benchmark lab" })).toBeVisible();
  await expect(page.getByLabel("Benchmark point count")).toHaveValue("400");
  await expect(page.getByTestId("benchmark-result-maplibre")).toContainText("MapLibre GL 6.4.1");

  await page.getByRole("button", { name: "Run Canvas2D reference" }).click();
  await expect(page.getByTestId("benchmark-result-canvas2d")).toContainText(
    "Complete · pixel-only Canvas2D",
  );
  await expect(page.getByTestId("benchmark-result-leaflet")).toContainText("Unavailable", {
    timeout: 10_000,
  });

  expect(pageErrors).toEqual([]);
});
