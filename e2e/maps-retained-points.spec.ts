import { expect, test, type Page } from "@playwright/test";

import { densePointJourney, densePointJourneySteps } from "./fixtures/dense-point-journey";

// #155: GPU-retained application points. Retained WebGPU instances must land where the
// screen-projected Canvas fallback (Rust packed projection) draws the same points, and
// dense camera journeys must not lower, project or upload per point.

type Blob = { x: number; y: number; pixels: number };

async function openRetainedPoints(page: Page, query: string, backend: "wgpu" | "canvas2d") {
  if (backend === "canvas2d") {
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  }
  const gpuValidation: string[] = [];
  page.on("console", (message) => {
    if (/WGSL|\[Invalid [A-Za-z]+/.test(message.text())) gpuValidation.push(message.text());
  });
  await page.goto(`/e2e/fixtures/retained-points.html?${query}`);
  const map = page.getByLabel("Retained points map");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    backend,
  );
  await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveAttribute(
    "data-map-overlay-backend",
    backend === "wgpu" ? "wgpu-retained" : "canvas2d",
  );
  return { gpuValidation, map };
}

/** Centroids of the red point fills in a map screenshot. */
async function redBlobs(page: Page, image: Buffer): Promise<Blob[]> {
  return page.evaluate(async (base64) => {
    const source = new Image();
    source.src = `data:image/png;base64,${base64}`;
    await source.decode();
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(source, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const red = (index: number) =>
      data[index * 4]! > 200 && data[index * 4 + 1]! < 90 && data[index * 4 + 2]! < 90;
    const seen = new Uint8Array(width * height);
    const blobs: { x: number; y: number; pixels: number }[] = [];
    for (let start = 0; start < width * height; start += 1) {
      if (seen[start] || !red(start)) continue;
      let sumX = 0;
      let sumY = 0;
      let pixels = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length > 0) {
        const index = stack.pop()!;
        const x = index % width;
        const y = (index - x) / width;
        sumX += x;
        sumY += y;
        pixels += 1;
        for (const next of [index - 1, index + 1, index - width, index + width]) {
          if (next < 0 || next >= width * height || seen[next]) continue;
          if (Math.abs((next % width) - x) > 1 || !red(next)) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      if (pixels >= 20) blobs.push({ x: sumX / pixels, y: sumY / pixels, pixels });
    }
    return blobs.sort((left, right) => left.x - right.x || left.y - right.y);
  }, image.toString("base64"));
}

const cases = [
  { name: "flat city grid", query: "points=grid&zoom=11" },
  { name: "bearing and pitch", query: "points=grid&zoom=11&bearing=35&pitch=45" },
  { name: "antimeridian", query: "points=antimeridian&lon=180&lat=0&zoom=11&step=0.03" },
  { name: "deep zoom", query: "points=grid&zoom=19&step=0.0001" },
  // Labeled points stay retained; only their labels are projected, for the Canvas pass (#204).
  { name: "labeled points", query: "points=grid&zoom=11&labels=all" },
  { name: "world copies", query: "points=world&lon=170&lat=0&zoom=1.2" },
  // The viewport is wider than one world: retained WebGPU draws every visible world copy,
  // like MapLibre's world copies, while the Canvas fallback projects each point once.
  {
    name: "viewport wider than one world",
    query: "points=world&lon=178&lat=0&zoom=0.2",
    worldWidthPx: 512 * 2 ** 0.2,
  },
];

for (const scenario of cases) {
  test(`retained WebGPU points match the projected Canvas fallback: ${scenario.name} @smoke`, async ({
    browser,
  }, testInfo) => {
    const positions: Record<string, Blob[]> = {};
    for (const backend of ["wgpu", "canvas2d"] as const) {
      const page = await browser.newPage();
      const { gpuValidation, map } = await openRetainedPoints(page, scenario.query, backend);
      let blobs: Blob[] = [];
      await expect
        .poll(async () => {
          blobs = await redBlobs(page, await map.screenshot());
          return blobs.length;
        })
        .toBeGreaterThan(0);
      positions[backend] = blobs;
      expect(gpuValidation).toEqual([]);
      // The screenshot must come from the backend under test, not a later fallback.
      await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
        "data-map-base-renderer",
        backend,
      );
      await page.close();
    }
    await testInfo.attach("point-centroids", {
      body: JSON.stringify(positions, null, 2),
      contentType: "application/json",
    });
    const retained = positions.wgpu!;
    const projected = positions.canvas2d!;
    const distance = (blob: Blob, others: Blob[], shift = 0) =>
      Math.min(...others.map((other) => Math.hypot(other.x + shift - blob.x, other.y - blob.y)));
    // Every projected point is drawn at the same position by the retained path.
    for (const blob of projected) expect(distance(blob, retained)).toBeLessThan(0.75);
    const worldWidth = "worldWidthPx" in scenario ? scenario.worldWidthPx : null;
    if (worldWidth === null) {
      expect(retained.length).toBe(projected.length);
    }
    for (const blob of retained) {
      const nearest = Math.min(
        distance(blob, projected),
        ...(worldWidth === null
          ? []
          : [distance(blob, projected, worldWidth), distance(blob, projected, -worldWidth)]),
      );
      expect(nearest).toBeLessThan(0.75);
    }
  });
}

test("retained points are pickable in every visible world copy @smoke", async ({ page }) => {
  const { map } = await openRetainedPoints(
    page,
    "points=world&lon=178&lat=0&zoom=0.2",
    "wgpu",
  );
  let blobs: Blob[] = [];
  await expect
    .poll(async () => {
      blobs = await redBlobs(page, await map.screenshot());
      return blobs.length;
    })
    .toBe(4);
  const box = (await map.boundingBox())!;
  // The equator point at longitude 0 is drawn twice, one world apart.
  const middle = blobs
    .filter((blob) => blobs.some((other) => other !== blob && Math.abs(other.y - blob.y) < 1))
    .sort((left, right) => left.x - right.x);
  expect(middle).toHaveLength(2);
  for (const copy of middle) {
    await page.mouse.move(box.x + copy.x, box.y + copy.y);
    await expect(page.getByText("Picked middle", { exact: true })).toBeVisible();
    await page.mouse.move(box.x + 2, box.y + 2);
    await expect(page.getByText("Picked middle", { exact: true })).toBeHidden();
  }
  await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    "wgpu",
  );
});

for (const count of [10_000, 100_000] as const) {
  test(`a ${count.toLocaleString("en")}-point camera journey does O(1) point work on WebGPU @smoke`, async ({
    page,
  }, testInfo) => {
    // SwiftShader rasterizes 100k instanced points slowly; the evidence is the counters.
    test.setTimeout(180_000);
    const { gpuValidation, map } = await openRetainedPoints(
      page,
      `points=dense&count=${count}&lon=12&lat=50&zoom=5`,
      "wgpu",
    );
    await expect
      .poll(() => page.evaluate(() => window.retainedPoints.stats()?.retainedPoints ?? 0))
      .toBe(count);
    const journey = await page.evaluate(async (cameras) => {
      const probe = window.retainedPoints;
      const frame = () => new Promise(requestAnimationFrame);
      await frame();
      const before = probe.stats()!;
      const steps: { ms: number; upload: number; frames: number }[] = [];
      for (const camera of cameras) {
        const started = performance.now();
        probe.setViewState(camera);
        await frame();
        const stats = probe.stats()!;
        steps.push({
          frames: stats.retainedPointFrames ?? 0,
          ms: performance.now() - started,
          upload: stats.applicationUploadBytes ?? 0,
        });
      }
      return { after: probe.stats()!, before, steps };
    }, densePointJourney(densePointJourneySteps(count)));
    const sorted = journey.steps.map((step) => step.ms).sort((left, right) => left - right);
    await testInfo.attach("retained-point-journey", {
      body: JSON.stringify(
        {
          count,
          before: journey.before,
          after: journey.after,
          presentationMs: {
            p50: sorted[Math.floor(sorted.length * 0.5)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: sorted.at(-1),
          },
          steps: journey.steps,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(gpuValidation).toEqual([]);
    await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
      "data-map-base-renderer",
      "wgpu",
    );
    // Geographic preparation and instance uploads happen only for data changes and
    // deterministic rebases, never per camera frame; screen geometry uploads are zero.
    expect(journey.after.retainedPointPreparations).toBe(journey.before.retainedPointPreparations);
    expect(journey.after.retainedPointRebases).toBe(journey.before.retainedPointRebases);
    expect(journey.after.retainedPointUploadBytes).toBe(journey.before.retainedPointUploadBytes);
    for (const step of journey.steps) {
      expect(step.upload).toBe(0);
      expect(step.frames).toBeGreaterThan(0);
    }
    await expect(map).toBeVisible();
  });
}

test("a mixed point and flow camera journey keeps both retained groups O(1) on WebGPU @smoke", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const count = 10_000;
  const flowCount = 200;
  const { gpuValidation, map } = await openRetainedPoints(
    page,
    `points=dense&count=${count}&flows=${flowCount}&lon=12&lat=50&zoom=5`,
    "wgpu",
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stats = window.retainedPoints.stats();
        return [stats?.retainedPoints ?? 0, stats?.retainedPolygons ?? 0];
      }),
    )
    // Each flow is a line, a direction marker and two endpoint circles in one shape group.
    .toEqual([count, flowCount * 4]);
  // Retained shapes stay on unpitched cameras, so this journey pans, zooms and rotates.
  const journey = await page.evaluate(async (cameras) => {
    const probe = window.retainedPoints;
    const frame = () => new Promise(requestAnimationFrame);
    await frame();
    const before = probe.stats()!;
    const steps: { ms: number; upload: number; pointFrames: number; shapeFrames: number }[] = [];
    for (const camera of cameras) {
      const started = performance.now();
      probe.setViewState(camera);
      await frame();
      const stats = probe.stats()!;
      steps.push({
        ms: performance.now() - started,
        pointFrames: stats.retainedPointFrames ?? 0,
        shapeFrames: stats.retainedPolygonFrames ?? 0,
        upload: stats.applicationUploadBytes ?? 0,
      });
    }
    return { after: probe.stats()!, before, steps };
  }, densePointJourney(30, { pitched: false }));
  const sorted = journey.steps.map((step) => step.ms).sort((left, right) => left - right);
  await testInfo.attach("retained-point-flow-journey", {
    body: JSON.stringify(
      {
        count,
        flowCount,
        before: journey.before,
        after: journey.after,
        presentationMs: {
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          max: sorted.at(-1),
        },
        steps: journey.steps,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(gpuValidation).toEqual([]);
  await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    "wgpu",
  );
  await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveAttribute(
    "data-map-overlay-backend",
    "wgpu-retained",
  );
  for (const counter of [
    "retainedPointPreparations",
    "retainedPointRebases",
    "retainedPointUploadBytes",
    "retainedPolygonPreparations",
    "retainedPolygonRebases",
    "retainedPolygonUploadBytes",
  ] as const) {
    expect(journey.after[counter], counter).toBe(journey.before[counter]);
  }
  for (const step of journey.steps) {
    expect(step.upload).toBe(0);
    expect(step.pointFrames).toBeGreaterThan(0);
    expect(step.shapeFrames).toBeGreaterThan(0);
  }
});


test("labeled retained points are pickable and show their labels @smoke", async ({ page }) => {
  const { map } = await openRetainedPoints(page, "points=grid&zoom=11&labels=all", "wgpu");
  const overlay = map.locator('[data-map-overlay-runtime="maps"]');
  await expect(overlay).toHaveAttribute("data-map-overlay-label-projections", /^[1-9]/);
  let blobs: Blob[] = [];
  await expect
    .poll(async () => {
      blobs = await redBlobs(page, await map.screenshot());
      return blobs.length;
    })
    .toBe(9);
  // The Canvas label pass draws white text over each retained circle.
  const labelPixels = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    const context = canvas.getContext("2d")!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) opaque += 1;
    return opaque;
  });
  expect(labelPixels).toBeGreaterThan(0);
  const box = (await map.boundingBox())!;
  // The middle point of the 3 x 3 grid is the blob nearest to their mean.
  const meanX = blobs.reduce((sum, blob) => sum + blob.x, 0) / blobs.length;
  const meanY = blobs.reduce((sum, blob) => sum + blob.y, 0) / blobs.length;
  const center = blobs.reduce((best, blob) =>
    Math.hypot(blob.x - meanX, blob.y - meanY) < Math.hypot(best.x - meanX, best.y - meanY)
      ? blob
      : best,
  );
  await page.mouse.move(box.x + center.x, box.y + center.y);
  await expect(page.getByText("Picked p-1-1", { exact: true })).toBeVisible();
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "wgpu-retained");
});

test("a 10,000-point journey with 50 labeled points projects only the labels on WebGPU @smoke", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const count = 10_000;
  const labels = 50;
  const { gpuValidation, map } = await openRetainedPoints(
    page,
    `points=dense&count=${count}&labels=${labels}&lon=12&lat=50&zoom=5`,
    "wgpu",
  );
  await expect
    .poll(() => page.evaluate(() => window.retainedPoints.stats()?.retainedPoints ?? 0))
    .toBe(count);
  const journey = await page.evaluate(async (cameras) => {
    const probe = window.retainedPoints;
    const overlay = document.querySelector<HTMLCanvasElement>('[data-map-overlay-runtime="maps"]')!;
    const projections = () => Number(overlay.dataset.mapOverlayLabelProjections ?? 0);
    const frame = () => new Promise(requestAnimationFrame);
    await frame();
    const before = probe.stats()!;
    const beforeProjections = projections();
    const steps: { ms: number; upload: number; frames: number; labelProjections: number }[] = [];
    let previous = beforeProjections;
    for (const camera of cameras) {
      const started = performance.now();
      probe.setViewState(camera);
      await frame();
      const stats = probe.stats()!;
      const current = projections();
      steps.push({
        frames: stats.retainedPointFrames ?? 0,
        labelProjections: current - previous,
        ms: performance.now() - started,
        upload: stats.applicationUploadBytes ?? 0,
      });
      previous = current;
    }
    return { after: probe.stats()!, before, steps };
  }, densePointJourney(30));
  const sorted = journey.steps.map((step) => step.ms).sort((left, right) => left - right);
  await testInfo.attach("retained-labeled-point-journey", {
    body: JSON.stringify(
      {
        count,
        labels,
        before: journey.before,
        after: journey.after,
        presentationMs: {
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          max: sorted.at(-1),
        },
        steps: journey.steps,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(gpuValidation).toEqual([]);
  await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    "wgpu",
  );
  await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveAttribute(
    "data-map-overlay-backend",
    "wgpu-retained",
  );
  // Labeled points are retained with the others: preparation and upload stay O(1).
  expect(journey.after.retainedPointPreparations).toBe(journey.before.retainedPointPreparations);
  expect(journey.after.retainedPointRebases).toBe(journey.before.retainedPointRebases);
  expect(journey.after.retainedPointUploadBytes).toBe(journey.before.retainedPointUploadBytes);
  for (const step of journey.steps) {
    expect(step.upload).toBe(0);
    expect(step.frames).toBeGreaterThan(0);
    // Each camera frame projects the labeled points only: O(labels), not O(points).
    expect(step.labelProjections).toBe(labels);
  }
});

test("labeled points in a view wider than one world use the projected path @smoke", async ({
  page,
}) => {
  // Retained circles repeat in every world copy, but the label pass places one label per
  // point, so the overlay keeps such frames on the projected path (#204).
  await page.goto("/e2e/fixtures/retained-points.html?points=world&lon=178&lat=0&zoom=0.2&labels=all");
  const map = page.getByLabel("Retained points map");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map.locator('[data-flat-runtime="maps"]')).toHaveAttribute(
    "data-map-base-renderer",
    "wgpu",
  );
  await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveAttribute(
    "data-map-overlay-backend",
    "wgpu",
  );
  // Zooming in to a single world copy returns the frame to the retained path.
  await page.evaluate(() => window.retainedPoints.setViewState({ center: [0, 0], zoom: 4 }));
  await expect(map.locator('[data-map-overlay-runtime="maps"]')).toHaveAttribute(
    "data-map-overlay-backend",
    "wgpu-retained",
  );
});
