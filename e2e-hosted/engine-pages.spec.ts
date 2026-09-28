import { expect, test } from "@playwright/test";
import { createShortbreadTileFixture } from "../e2e/fixtures/shortbread-tile.mjs";

test("standalone engine survives direct navigation and refresh under the Pages base path", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", (route) =>
    route.fulfill({
      body: createShortbreadTileFixture(),
      contentType: "application/vnd.mapbox-vector-tile",
    }),
  );
  await page.goto("/maps/engine/?e2e=1&vectorTiles=fixture");
  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  await expect(page.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/maps/stats/");
  await expect
    .poll(async () =>
      Number(await page.locator("[data-flat-runtime=maps]").getAttribute("data-map-base-tiles")),
    )
    .toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect
    .poll(async () =>
      Number(await page.locator("[data-flat-runtime=maps]").getAttribute("data-map-base-tiles")),
    )
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("stats displays the built engine measurements without inventing missing evidence", async ({
  page,
  request,
}) => {
  // Preserve the shared template's iframe protocol while making unavailable
  // external repository evidence deterministic in this artifact test.
  await page.route("https://moritzbrantner.github.io/coding-tooling/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>parent.postMessage({type:"coding-tooling.analysis.v1",repository:"moritzbrantner/maps",error:{message:"Repository evidence unavailable in this fixture"}}, "*")</script>`,
    }),
  );
  const response = await request.get("/maps/evidence/engine-benchmark.json");
  expect(response.ok()).toBe(true);
  const evidence = await response.json();
  expect(evidence.producer).toBe("maps-engine-benchmark");
  expect(evidence.status).toBe("measured");
  expect(evidence.workload.points).toBe(100000);
  expect(evidence.results).toHaveLength(2);
  for (const result of evidence.results) {
    expect(result.samples).toHaveLength(15);
    expect(result.medianMs).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.medianMs);
  }
  const interactionResponse = await request.get("/maps/evidence/engine-interaction.json");
  expect(interactionResponse.ok()).toBe(true);
  const interaction = await interactionResponse.json();
  expect(interaction.producer).toBe("maps-engine-interaction");
  expect(interaction.workload.scenario).toBe("vector-city-style-v1");
  expect(interaction.results).toHaveLength(5);
  expect(interaction.summary.p95FrameMs).toBeGreaterThan(0);
  await page.goto("/maps/stats/");
  await expect(page.getByRole("heading", { name: "Stats", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Engine benchmark scope" })).toContainText(
    "CPU + WASM bridge only",
  );
  await expect(
    page.getByRole("row").filter({ hasText: "Full map pan/zoom · frame interval · p95" }),
  ).toContainText("measured");
  const row = page
    .getByRole("row")
    .filter({ hasText: "Rust/WASM oriented projection · 100k points · median" });
  await expect(row).toContainText("ms");
  await expect(row).toContainText("measured");
  await expect(row).toContainText("revision unverified");
  await expect(
    row.getByRole("link", { name: "Rust/WASM engine benchmark", exact: true }),
  ).toHaveAttribute("href", "/maps/evidence/engine-benchmark.json");
  await expect(page.getByRole("link", { name: "Engine", exact: true })).toHaveAttribute(
    "href",
    "/maps/engine/",
  );
});
