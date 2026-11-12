import { expect, test, type Page } from "@playwright/test";

import type { HeatLayerWorkTotals } from "../src/heat-layer-work";

type Camera = {
  bearing: number;
  center: [number, number];
  pitch: number;
  zoom: number;
};

declare global {
  interface Window {
    heatScalarJourney: {
      controller: { setViewState(viewState: Camera): void } | null;
      seekDensity(step: number): void;
      setStyle(variant: number): void;
      totals(): HeatLayerWorkTotals;
      updateField(step: number): void;
    };
  }
}

/*
 * The invalidation contract of `heat-scalar-journey-v1` (#171 phase 5) on every browser run:
 * the canonical density and masked scalar field in one Map View, read through the production
 * heat/scalar work counters. Frame timing is captured by `verify:engine-heat-scalar-evidence`.
 */
for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`heat/scalar journey on ${backend}: camera frames rebuild no field and data changes only their dependents`, async ({
    page,
  }) => {
    test.slow();
    if (backend === "canvas2d")
      await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
    await page.goto("/e2e/fixtures/heat-scalar-journey.html");
    const map = page.getByLabel("Heat scalar journey");
    const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(overlay).toHaveAttribute("data-map-overlay-heat-layers", "2");
    await expect
      .poll(async () => (await totals(page)).surface.rasterImagesDecoded)
      .toBeGreaterThanOrEqual(2);

    await expect(overlay).toHaveAttribute("data-map-overlay-backend", backend);
    const initial = await totals(page);
    expect(initial.layers).toBe(2);
    expect(initial.data.sourceIndexPoints).toBe(10_000);
    if (backend === "wgpu") expect(initial.surface.textureUploads).toBe(2);

    // Camera only: pan, zoom, bearing and pitch.
    let before = await totals(page);
    for (const camera of [
      { bearing: 0, center: [10, 51], pitch: 0, zoom: 3.6 },
      { bearing: 0, center: [12, 52], pitch: 0, zoom: 4.4 },
      { bearing: 30, center: [12, 52], pitch: 0, zoom: 4.4 },
      { bearing: 30, center: [12, 52], pitch: 40, zoom: 4.4 },
      { bearing: 0, center: [8, 50], pitch: 0, zoom: 3.4 },
    ] satisfies Camera[]) {
      await page.evaluate(
        (view) => window.heatScalarJourney.controller!.setViewState(view),
        camera,
      );
      await frames(page, 6);
    }
    let after = await totals(page);
    for (const key of [
      "sourceIndexBuilds",
      "fieldGridBuilds",
      "fieldImageBuilds",
      "fieldContourBuilds",
    ] as const) {
      expect(after.data[key] - before.data[key], key).toBe(0);
    }
    expect(after.surface.rasterDraws).toBeGreaterThan(before.surface.rasterDraws);
    if (backend === "wgpu") {
      expect(after.surface.rasterGpuDraws).toBeGreaterThan(before.surface.rasterGpuDraws);
      expect(after.surface.rasterDrawTriangles).toBe(0);
    } else {
      expect(after.surface.rasterDrawTriangles).toBeGreaterThan(before.surface.rasterDrawTriangles);
    }

    // A density seek rebuilds the density index and raster, never the scalar field.
    before = after;
    await page.evaluate(() => window.heatScalarJourney.seekDensity(6));
    await expect
      .poll(
        async () =>
          (await totals(page)).surface.rasterImagesDecoded - before.surface.rasterImagesDecoded,
      )
      .toBeGreaterThanOrEqual(1);
    after = await totals(page);
    expect(after.data.sourceIndexBuilds - before.data.sourceIndexBuilds).toBeGreaterThanOrEqual(1);
    expect(after.data.fieldGridBuilds - before.data.fieldGridBuilds).toBe(0);

    // A field refresh re-interpolates once and never re-indexes the density points.
    before = after;
    await page.evaluate(() => window.heatScalarJourney.updateField(3));
    await expect
      .poll(async () => (await totals(page)).data.fieldImageBuilds - before.data.fieldImageBuilds)
      .toBe(1);
    after = await totals(page);
    expect(after.data.fieldGridBuilds - before.data.fieldGridBuilds).toBe(1);
    expect(after.data.fieldContourBuilds - before.data.fieldContourBuilds).toBe(1);
    expect(after.data.sourceIndexPoints - before.data.sourceIndexPoints).toBe(0);

    // A color ramp change reuses the retained grid and the density index.
    before = after;
    await page.evaluate(() => window.heatScalarJourney.setStyle(1));
    await expect
      .poll(
        async () =>
          (await totals(page)).surface.rasterImagesDecoded - before.surface.rasterImagesDecoded,
      )
      .toBeGreaterThanOrEqual(2);
    after = await totals(page);
    expect(after.data.fieldGridBuilds - before.data.fieldGridBuilds).toBe(0);
    expect(after.data.fieldGridReuses - before.data.fieldGridReuses).toBe(1);
    expect(after.data.sourceIndexBuilds - before.data.sourceIndexBuilds).toBe(0);
  });

  function totals(page: Page) {
    return page.evaluate(() => window.heatScalarJourney.totals());
  }

  function frames(page: Page, count: number) {
    return page.evaluate(
      (total) =>
        new Promise<void>((resolve) => {
          let seen = 0;
          const tick = () => (++seen >= total ? resolve() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      count,
    );
  }
}
