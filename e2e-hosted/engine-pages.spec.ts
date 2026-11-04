import { expect, test, type Page } from "@playwright/test";

async function expectPaintedEngineTiles(page: Page) {
  const base = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(base).toHaveAttribute("data-map-source-state", "ready");
  // On WebGPU the vector basemap is GPU-retained, so the raster-only
  // data-map-base-tiles counter legitimately remains zero.
  await expect
    .poll(async () => {
      const backend = await base.getAttribute("data-map-base-renderer");
      const counter = backend === "wgpu" ? "data-map-vector-tiles" : "data-map-base-tiles";
      return Number(await base.getAttribute(counter));
    })
    .toBeGreaterThan(0);

  // Verify presented pixels too, on either backend. The committed synthetic
  // fixture puts water and forest in the unobscured right side of this Map View.
  await expect
    .poll(
      async () => {
        const screenshot = await page.screenshot();
        return page.evaluate(async (encoded) => {
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
          const bounds = document
            .querySelector<HTMLElement>('[data-map-runtime="maps"]')!
            .getBoundingClientRect();
          const scaleX = bitmap.width / innerWidth;
          const scaleY = bitmap.height / innerHeight;
          const closeTo = (offset: number, color: readonly number[]) =>
            color.every((channel, index) => Math.abs(pixels[offset + index]! - channel) <= 12);
          let water = 0;
          let forest = 0;
          for (let row = 0; row < 7; row += 1) {
            for (let column = 0; column < 9; column += 1) {
              const x = Math.floor(
                (bounds.left + bounds.width * (0.43 + ((column + 0.5) * 0.52) / 9)) * scaleX,
              );
              const y = Math.floor(
                (bounds.top + bounds.height * (0.2 + ((row + 0.5) * 0.65) / 7)) * scaleY,
              );
              const offset = (y * bitmap.width + x) * 4;
              if (closeTo(offset, [168, 204, 224])) water += 1;
              if (closeTo(offset, [196, 216, 180])) forest += 1;
            }
          }
          bitmap.close();
          return Math.min(water, forest);
        }, screenshot.toString("base64"));
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(8);
}

test("standalone engine survives direct navigation and refresh under the Pages base path", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/maps/engine/?source=pmtiles&e2e=1");
  await expect(page.getByRole("heading", { name: "Maps engine", exact: true })).toBeVisible();
  await expect(page.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  await expectPaintedEngineTiles(page);
  await expect(page.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/maps/stats/");
  await page.reload();
  await expect(page.locator('[data-map-runtime="maps"]')).toBeVisible();
  await expectPaintedEngineTiles(page);
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
