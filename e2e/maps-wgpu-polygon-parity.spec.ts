import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { WEBGPU_SWIFTSHADER_ARGS } from "./helpers/webgpu-args";

type Backend = "canvas2d" | "wgpu";

type Overlay = "canvas2d" | "wgpu" | "wgpu-retained";

// Canvas is the polygon correctness oracle (#161). Both backends render the same fixture:
// holes, several exteriors, overlapping holes and self-intersection (even-odd), translucent
// fills and strokes with round joins, painter order with lines and points, and hover/selection
// stroke widths. Frames of polygons (#196), lines, flows and unlabeled points (#195) take the
// GPU-retained path.
async function renderPolygonParity(
  baseURL: string | undefined,
  backend: Backend,
  query: Record<string, string>,
  overlay: Overlay,
  journey?: (page: Page) => Promise<void>,
) {
  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  try {
    const page = await browser.newPage({ viewport: { height: 600, width: 1000 } });
    if (backend === "canvas2d") {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => undefined });
      });
    }
    const gpuValidation: string[] = [];
    page.on("console", (message) => {
      if (/WGSL|\[Invalid [A-Za-z]+/.test(message.text())) gpuValidation.push(message.text());
    });
    const url = new URL("/e2e/fixtures/polygon-parity.html", baseURL ?? "http://127.0.0.1:5181");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    await page.goto(url.toString());

    const map = page.getByLabel("Polygon parity");
    const base = map.locator('canvas[data-flat-runtime="maps"]');
    await expect(base).toHaveAttribute("data-map-base-renderer", backend);
    await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
    await expect(map.locator('canvas[data-map-overlay-runtime="maps"]')).toHaveAttribute(
      "data-map-overlay-backend",
      overlay,
    );
    await settleFrames(page);
    await journey?.(page);
    await expect(base).toHaveAttribute("data-map-base-pending-tiles", "0");
    await settleFrames(page);
    const screenshot = await map.screenshot();
    expect(gpuValidation).toEqual([]);
    return screenshot;
  } finally {
    await browser.close();
  }
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
 * Pixels whose 3×3 neighbourhood in the other image explains neither their color nor an
 * antialiased blend of it. That absorbs Canvas antialiasing and sub-pixel edge placement;
 * filled areas, holes, blending and stroke shape still have to agree.
 */
async function compareScreenshots(expected: Buffer, actual: Buffer) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ([expectedBase64, actualBase64]) => {
        const decode = async (base64: string) => {
          const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const [a, b] = await Promise.all([decode(expectedBase64), decode(actualBase64)]);
        if (a.width !== b.width || a.height !== b.height) {
          return { diff: "", mismatched: Number.POSITIVE_INFINITY, total: 0 };
        }
        const { height, width } = a;
        const tolerance = 12;
        // A pixel matches when a neighbour in the other image has its color, or when it is a
        // blend of two such neighbours: the coverage blend Canvas antialiasing produces.
        const close = (from: ImageData, x: number, y: number, to: ImageData) => {
          const offset = (y * width + x) * 4;
          const color = [from.data[offset]!, from.data[offset + 1]!, from.data[offset + 2]!];
          const neighbours: number[][] = [];
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const other = (ny * width + nx) * 4;
              neighbours.push([to.data[other]!, to.data[other + 1]!, to.data[other + 2]!]);
            }
          }
          for (const [index, p] of neighbours.entries()) {
            for (const q of neighbours.slice(index)) {
              const segment = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
              const length = segment[0]! ** 2 + segment[1]! ** 2 + segment[2]! ** 2;
              const t =
                length === 0
                  ? 0
                  : Math.min(
                      1,
                      Math.max(
                        0,
                        ((color[0]! - p[0]!) * segment[0]! +
                          (color[1]! - p[1]!) * segment[1]! +
                          (color[2]! - p[2]!) * segment[2]!) /
                          length,
                      ),
                    );
              if (
                [0, 1, 2].every(
                  (channel) =>
                    Math.abs(color[channel]! - (p[channel]! + t * segment[channel]!)) <= tolerance,
                )
              ) {
                return true;
              }
            }
          }
          return false;
        };
        const diff = new ImageData(width, height);
        let mismatched = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const matches = close(a, x, y, b) && close(b, x, y, a);
            if (!matches) mismatched += 1;
            diff.data.set(matches ? [255, 255, 255, 255] : [220, 38, 38, 255], offset);
          }
        }
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d")!.putImageData(diff, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const diffBytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of diffBytes) binary += String.fromCharCode(byte);
        return { diff: btoa(binary), mismatched, total: width * height };
      },
      [expected.toString("base64"), actual.toString("base64")] as const,
    );
  } finally {
    await browser.close();
  }
}

async function expectPolygonParity(
  baseURL: string | undefined,
  testInfo: TestInfo,
  query: Record<string, string>,
  overlay: Overlay,
  journey?: { wgpu: (page: Page) => Promise<void>; canvasQuery: Record<string, string> },
) {
  const canvas = await renderPolygonParity(
    baseURL,
    "canvas2d",
    { ...query, ...journey?.canvasQuery },
    "canvas2d",
  );
  const wgpu = await renderPolygonParity(baseURL, "wgpu", query, overlay, journey?.wgpu);
  const comparison = await compareScreenshots(canvas, wgpu);
  for (const [name, body] of [
    ["canvas2d", canvas],
    ["wgpu", wgpu],
    ["diff", Buffer.from(comparison.diff, "base64")],
  ] as const) {
    const path = testInfo.outputPath(`${name}.png`);
    await writeFile(path, body);
    await testInfo.attach(name, { contentType: "image/png", path });
  }
  // A real semantic difference (a hole, an even-odd region, a blend) spans thousands of pixels.
  expect(comparison.mismatched).toBeLessThan(comparison.total * 0.0005);
}

const POLYGON_ONLY_CASES =
  "hole,multiple-exteriors,overlapping-holes,self-intersecting,translucent-stroke,selected,hovered";

test("WebGPU polygons match the Canvas oracle across fill, stroke, order and interaction", async ({
  baseURL,
}, testInfo) => {
  // The line and the point between the polygons are retained in the same painter order.
  await expectPolygonParity(baseURL, testInfo, {}, "wgpu-retained");
});

test("Retained WebGPU lines and flows match the Canvas oracle @smoke", async ({
  baseURL,
}, testInfo) => {
  await expectPolygonParity(
    baseURL,
    testInfo,
    { cases: "line-joins,translucent-line,order-lower,order-line,order-point,hovered", flows: "1" },
    "wgpu-retained",
  );
});

test("A zero-area polygon stays on WebGPU and strokes like Canvas", async ({
  baseURL,
}, testInfo) => {
  await expectPolygonParity(baseURL, testInfo, { cases: "zero-area,hole" }, "wgpu-retained");
});

test("Retained WebGPU polygons match the Canvas oracle @smoke", async ({ baseURL }, testInfo) => {
  await expectPolygonParity(baseURL, testInfo, { cases: POLYGON_ONLY_CASES }, "wgpu-retained");
});

test("Retained WebGPU polygons match the Canvas oracle across the antimeridian", async ({
  baseURL,
}, testInfo) => {
  await expectPolygonParity(
    baseURL,
    testInfo,
    { cases: "antimeridian", lon: "180", zoom: "5" },
    "wgpu-retained",
  );
});

test("A retained polygon camera journey re-lowers and uploads nothing, then matches Canvas @smoke", async ({
  baseURL,
}, testInfo) => {
  const final = { lon: "3.5", lat: "-1.5", zoom: "4.6" };
  await expectPolygonParity(baseURL, testInfo, { cases: POLYGON_ONLY_CASES }, "wgpu-retained", {
    canvasQuery: final,
    async wgpu(page) {
      const journey = await page.evaluate(async (target) => {
        const probe = window.polygonParity;
        const frame = () => new Promise(requestAnimationFrame);
        await frame();
        const before = probe.stats()!;
        const steps: { upload: number; frames: number }[] = [];
        for (let step = 1; step <= 20; step += 1) {
          const t = step / 20;
          probe.setViewState({
            center: [Number(target.lon) * t, Number(target.lat) * t],
            zoom: 4 + (Number(target.zoom) - 4) * t,
          });
          await frame();
          const stats = probe.stats()!;
          steps.push({
            frames: stats.retainedPolygonFrames ?? 0,
            upload: stats.applicationUploadBytes ?? 0,
          });
        }
        return { after: probe.stats()!, before, steps };
      }, final);
      // The MultiPolygon case contributes three polygons.
      expect(journey.before.retainedPolygons).toBe(9);
      expect(journey.after.retainedPolygonPreparations).toBe(
        journey.before.retainedPolygonPreparations,
      );
      expect(journey.after.retainedPolygonRebases).toBe(journey.before.retainedPolygonRebases);
      expect(journey.after.retainedPolygonUploadBytes).toBe(
        journey.before.retainedPolygonUploadBytes,
      );
      for (const step of journey.steps) {
        expect(step.upload).toBe(0);
        expect(step.frames).toBeGreaterThan(0);
      }
    },
  });
});
