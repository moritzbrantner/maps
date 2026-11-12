import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type Backend = "canvas2d" | "wgpu";

type MarkerAlignment = {
  marker: [number, number];
  offset: number;
  peak: [number, number];
  peakIntensity: number;
};

type AlignmentMeasurement = {
  densityPeaks: MarkerAlignment[];
  field: {
    centroidOffset: number;
    fieldPixels: number;
    intersection: number;
    iou: number;
    polygonPixels: number;
  };
  height: number;
  width: number;
};

/**
 * Pixel-measured alignment limits. The heat surfaces are rasters at their own resolution:
 * density peaks are sampled on the heat raster grid, and the scalar-field mask clips at
 * grid-cell resolution (96 × 96 cells over the domain). A projection disagreement between the
 * surfaces and the vector layers (an offset, a missed rotation or pitch, a stale size) moves a
 * whole surface by tens of pixels and fails both limits.
 */
const MAX_DENSITY_PEAK_OFFSET_PX = 3;
const MAX_FIELD_CENTROID_OFFSET_PX = 3;
const MIN_FIELD_MASK_IOU = 0.9;

// Canvas is the oracle backend: the same heat surfaces must align with points and polygons
// whichever pixel backend draws the base map and vector layers.
for (const backend of ["wgpu", "canvas2d"] as const) {
  test(`heat and masked scalar surfaces stay aligned with points and polygons on ${backend} @smoke`, async ({
    page,
  }, testInfo) => {
    test.slow();
    if (backend === "canvas2d") {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "gpu", {
          configurable: true,
          get: () => undefined,
        });
      });
    }
    const gpuValidation: string[] = [];
    page.on("console", (message) => {
      if (/WGSL|\[Invalid [A-Za-z]+/.test(message.text())) gpuValidation.push(message.text());
    });

    await page.goto("/e2e/fixtures/heat-alignment.html");
    const map = page.getByLabel("Heat alignment");
    const base = map.locator('canvas[data-flat-runtime="maps"]');
    const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(map).toHaveAttribute("data-map-runtime", "maps");
    await expect(base).toHaveAttribute("data-map-base-renderer", backend);
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
    await expect
      .poll(async () => Number(await overlay.getAttribute("data-map-overlay-heat-layers")))
      .toBe(3);

    await expect(overlay).toHaveAttribute("data-map-overlay-backend", backend);

    const measure = (step: string) =>
      measureAlignment(page, map, base, testInfo, `${backend}-${step}`);

    await measure("initial");

    // Pan: measured while the pointer is still held, mid-gesture.
    const box = (await base.boundingBox())!;
    const dragStart = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.82 };
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 70, dragStart.y - 36, { steps: 8 });
    await measure("pan-held");
    await page.mouse.up();
    await waitForStableCamera(page);
    await measure("pan-released");

    // Zoom: a wheel step at an off-center anchor.
    const zoomBefore = await viewState(page);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await page.mouse.wheel(0, 260);
    await expect.poll(async () => (await viewState(page)).zoom).not.toBe(zoomBefore.zoom);
    await waitForStableCamera(page);
    await measure("zoom");

    // Orientation: bearing alone, then bearing with pitch.
    await page.evaluate(() =>
      window.heatAlignment.setViewState({ bearing: 35, center: [10, 50], pitch: 0, zoom: 4.5 }),
    );
    await waitForStableCamera(page);
    await measure("bearing");
    await page.evaluate(() =>
      window.heatAlignment.setViewState({ bearing: -25, center: [10, 50], pitch: 40, zoom: 4.5 }),
    );
    await waitForStableCamera(page);
    await measure("bearing-pitch");

    // Resize: a narrower, taller Map View with the oriented camera unchanged.
    await page.evaluate(() => window.heatAlignment.setSize({ height: 640, width: 760 }));
    await expect.poll(async () => Math.round((await map.boundingBox())!.width)).toBe(760);
    await waitForStableCamera(page);
    await measure("resize");

    await expect(base).toHaveAttribute("data-map-base-renderer", backend);
    expect(gpuValidation).toEqual([]);
  });
}

async function measureAlignment(
  page: Page,
  map: Locator,
  base: Locator,
  testInfo: TestInfo,
  name: string,
) {
  await setMode(page, base, "vector");
  const vector = await map.screenshot();
  await setMode(page, base, "surfaces");

  let surfaces: Buffer | undefined;
  let measurement: AlignmentMeasurement | undefined;
  // Async surfaces commit after the camera settles. A pending screen-space raster is not drawn
  // at all rather than drawn stale, so wait until every surface is present.
  await expect
    .poll(
      async () => {
        surfaces = await map.screenshot();
        measurement = await analyzeAlignment(page, vector, surfaces);
        return {
          densityPeaks: measurement.densityPeaks.length,
          fieldPresent: measurement.field.fieldPixels > measurement.field.polygonPixels * 0.5,
          peaksPresent: measurement.densityPeaks.every((peak) => peak.peakIntensity >= 200),
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ densityPeaks: 4, fieldPresent: true, peaksPresent: true });

  await setMode(page, base, "composite");
  const composite = await map.screenshot();
  for (const [suffix, body] of [
    ["composite", composite],
    ["vector", vector],
    ["surfaces", surfaces!],
  ] as const) {
    const path = testInfo.outputPath(`${name}-${suffix}.png`);
    await writeFile(path, body);
    await testInfo.attach(`${name}-${suffix}`, { contentType: "image/png", path });
  }

  const result = measurement!;
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(result, null, 2));
  await testInfo.attach(`${name}-measurement`, { contentType: "application/json", path });
  for (const peak of result.densityPeaks) {
    expect(peak.offset, `${name}: density peak at marker ${peak.marker.join(",")}`).toBeLessThan(
      MAX_DENSITY_PEAK_OFFSET_PX,
    );
  }
  expect(result.field.iou, `${name}: masked field vs polygon IoU`).toBeGreaterThan(
    MIN_FIELD_MASK_IOU,
  );
  expect(result.field.centroidOffset, `${name}: masked field centroid`).toBeLessThan(
    MAX_FIELD_CENTROID_OFFSET_PX,
  );
  return result;
}

async function setMode(page: Page, base: Locator, mode: "composite" | "surfaces" | "vector") {
  await page.evaluate((next) => window.heatAlignment.setMode(next), mode);
  await expect(page.locator(`[data-alignment-mode="${mode}"]`)).toHaveCount(1);
  await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
  await settleFrames(page);
}

async function viewState(page: Page) {
  return page.evaluate(() => window.heatAlignment.controller!.getViewState());
}

async function waitForStableCamera(page: Page) {
  let previous = "";
  await expect
    .poll(async () => {
      await settleFrames(page);
      const current = JSON.stringify(await viewState(page));
      const stable = current === previous;
      previous = current;
      return stable;
    })
    .toBe(true);
}

async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * Measures alignment from screenshots alone, independently of the projection code under test.
 *
 * - Point Layer markers are black; each marker's centroid must sit on its density peak, the
 *   centroid of the surface pixels within 10% of the local maximum red intensity.
 * - The GeoJSON polygon (vector screenshot, filled green) and the masked scalar field (surfaces
 *   screenshot, blue to violet) must cover the same pixels, hole included.
 */
async function analyzeAlignment(
  page: Page,
  vector: Buffer,
  surfaces: Buffer,
): Promise<AlignmentMeasurement> {
  return page.evaluate(
    async ([vectorBase64, surfacesBase64]) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [vectorImage, surfacesImage] = await Promise.all([
        decode(vectorBase64),
        decode(surfacesBase64),
      ]);
      const { height, width } = vectorImage;
      const pixel = (image: ImageData, index: number) =>
        [image.data[index * 4]!, image.data[index * 4 + 1]!, image.data[index * 4 + 2]!] as const;
      const isMarker = ([r, g, b]: readonly number[]) => r! < 70 && g! < 70 && b! < 70;
      const isPolygon = ([r, g, b]: readonly number[]) => g! > r! + 60 && g! > b! + 40;
      const isField = ([r, g, b]: readonly number[]) => b! > r! + 50 && b! > g! + 50;
      const density = ([r, g, b]: readonly number[]) =>
        r! > 200 && r! - b! > 20 && Math.abs(g! - b!) < 40 ? 255 - g! : 0;

      // Markers: 4-connected components of black pixels that are not clipped by the edge.
      const seen = new Uint8Array(width * height);
      const markers: [number, number][] = [];
      for (let start = 0; start < width * height; start += 1) {
        if (seen[start] || !isMarker(pixel(vectorImage, start))) continue;
        const stack = [start];
        seen[start] = 1;
        let count = 0;
        let sumX = 0;
        let sumY = 0;
        let clipped = false;
        while (stack.length > 0) {
          const index = stack.pop()!;
          const x = index % width;
          const y = Math.floor(index / width);
          count += 1;
          sumX += x;
          sumY += y;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) clipped = true;
          for (const [nx, ny] of [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ] as const) {
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (seen[next] || !isMarker(pixel(vectorImage, next))) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
        if (count >= 20 && !clipped) markers.push([sumX / count + 0.5, sumY / count + 0.5]);
      }

      const window = 40;
      const densityPeaks = markers.map((marker) => {
        const left = Math.max(0, Math.floor(marker[0] - window));
        const right = Math.min(width - 1, Math.ceil(marker[0] + window));
        const top = Math.max(0, Math.floor(marker[1] - window));
        const bottom = Math.min(height - 1, Math.ceil(marker[1] + window));
        let peakIntensity = 0;
        for (let y = top; y <= bottom; y += 1) {
          for (let x = left; x <= right; x += 1) {
            peakIntensity = Math.max(peakIntensity, density(pixel(surfacesImage, y * width + x)));
          }
        }
        let count = 0;
        let sumX = 0;
        let sumY = 0;
        for (let y = top; y <= bottom; y += 1) {
          for (let x = left; x <= right; x += 1) {
            if (
              peakIntensity > 0 &&
              density(pixel(surfacesImage, y * width + x)) >= peakIntensity * 0.9
            ) {
              count += 1;
              sumX += x + 0.5;
              sumY += y + 0.5;
            }
          }
        }
        const peak: [number, number] =
          count > 0 ? [sumX / count, sumY / count] : [Number.NaN, Number.NaN];
        return {
          marker,
          offset: Math.hypot(peak[0] - marker[0], peak[1] - marker[1]),
          peak,
          peakIntensity,
        };
      });

      let polygonPixels = 0;
      let fieldPixels = 0;
      let intersection = 0;
      const polygonSum = [0, 0];
      const fieldSum = [0, 0];
      for (let index = 0; index < width * height; index += 1) {
        const inPolygon = isPolygon(pixel(vectorImage, index));
        const inField = isField(pixel(surfacesImage, index));
        const x = (index % width) + 0.5;
        const y = Math.floor(index / width) + 0.5;
        if (inPolygon) {
          polygonPixels += 1;
          polygonSum[0] += x;
          polygonSum[1] += y;
        }
        if (inField) {
          fieldPixels += 1;
          fieldSum[0] += x;
          fieldSum[1] += y;
        }
        if (inPolygon && inField) intersection += 1;
      }
      const union = polygonPixels + fieldPixels - intersection;
      return {
        densityPeaks,
        field: {
          centroidOffset:
            polygonPixels > 0 && fieldPixels > 0
              ? Math.hypot(
                  fieldSum[0]! / fieldPixels - polygonSum[0]! / polygonPixels,
                  fieldSum[1]! / fieldPixels - polygonSum[1]! / polygonPixels,
                )
              : Number.POSITIVE_INFINITY,
          fieldPixels,
          intersection,
          iou: union > 0 ? intersection / union : 0,
          polygonPixels,
        },
        height,
        width,
      };
    },
    [vector.toString("base64"), surfaces.toString("base64")] as const,
  );
}
